"""Create a relative inverse-depth guide using an explicit Depth Anything V2 ONNX model.
No downloads, uploads, grayscale fallback, or paid calls. See the skill reference.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time


def probe(exe, path):
    if exe == 'pyav':
        import av
        with av.open(str(path)) as container:
            streams = []
            for stream in container.streams:
                entry = {'codec_type': stream.type}
                if stream.duration is not None and stream.time_base is not None:
                    entry['duration'] = str(float(stream.duration * stream.time_base))
                if stream.type == 'video':
                    rate = stream.average_rate or stream.guessed_rate
                    if rate is None:
                        raise ValueError('Video frame rate could not be determined')
                    entry.update(width=stream.codec_context.width, height=stream.codec_context.height,
                                 r_frame_rate=str(rate), avg_frame_rate=str(rate))
                    if '/' not in entry['r_frame_rate']:
                        entry['r_frame_rate'] += '/1'
                        entry['avg_frame_rate'] += '/1'
                streams.append(entry)
            if container.duration is None:
                durations = [float(s['duration']) for s in streams if 'duration' in s]
                if not durations:
                    raise ValueError('Video duration could not be determined')
                duration = max(durations)
            else:
                duration = container.duration / av.time_base
        return {'streams': streams, 'format': {'duration': str(duration)}}
    return json.loads(subprocess.check_output([exe, '-v', 'error', '-show_streams',
        '-show_format', '-of', 'json', str(path)], text=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--model', required=True, help='Depth Anything V2 Small FP32 ONNX')
    parser.add_argument('--python-deps', help='Optional existing dependency directory')
    parser.add_argument('--ffmpeg', default='ffmpeg')
    parser.add_argument('--ffprobe', default='ffprobe')
    parser.add_argument('--size', type=int, default=518, help='Inference square side, multiple of 14')
    parser.add_argument('--threads', type=int, default=4)
    args = parser.parse_args()
    if args.python_deps:
        sys.path.insert(0, str(Path(args.python_deps).resolve()))
    import numpy as np
    import onnxruntime as ort
    from PIL import Image

    source, output, model = map(lambda p: Path(p).resolve(), [args.input, args.output, args.model])
    if not source.is_file() or not model.is_file():
        raise ValueError('Input video and local model must exist')
    if source == output or output.exists():
        raise ValueError('Choose a new output path; originals are never overwritten')
    if args.size < 224 or args.size > 1036 or args.size % 14:
        raise ValueError('--size must be a multiple of 14 from 224 through 1036')
    info = probe(args.ffprobe, source)
    video = next(s for s in info['streams'] if s['codec_type'] == 'video')
    width, height = int(video['width']), int(video['height'])
    # Apply an explicit constant frame rate; source and result durations are verified below.
    rate = video.get('avg_frame_rate', video['r_frame_rate'])
    num, den = map(int, rate.split('/'))
    fps = num / den
    if not 1 <= fps <= 60:
        raise ValueError('Unsupported source frame rate')
    duration = float(video.get('duration', info['format']['duration']))
    iw = max(14, round(width / max(width, height) * args.size / 14) * 14)
    ih = max(14, round(height / max(width, height) * args.size / 14) * 14)
    top, left = (args.size - ih) // 2, (args.size - iw) // 2
    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
    inp = session.get_inputs()[0]
    if inp.type != 'tensor(float)':
        raise ValueError('Use the documented FP32 model, not an incompatible export')
    mean = np.array([.485, .456, .406], dtype=np.float32)
    std = np.array([.229, .224, .225], dtype=np.float32)
    output.parent.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    stats, samples = [], []
    with tempfile.TemporaryDirectory(prefix='depth-', dir=str(output.parent)) as temp:
        temp = Path(temp)
        with (temp / 'decode.log').open('wb') as err:
            decoder = subprocess.Popen([args.ffmpeg, '-v', 'error', '-i', str(source), '-an',
                '-vf', f'fps={rate},scale={iw}:{ih}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                stdout=subprocess.PIPE, stderr=err)
            count = 0
            try:
                while True:
                    raw = bytearray()
                    while len(raw) < iw * ih * 3:
                        chunk = decoder.stdout.read(iw * ih * 3 - len(raw))
                        if not chunk:
                            break
                        raw.extend(chunk)
                    if not raw:
                        break
                    if len(raw) != iw * ih * 3:
                        raise RuntimeError('Truncated decoded frame')
                    rgb = np.frombuffer(raw, np.uint8).reshape(ih, iw, 3)
                    x = (rgb.astype(np.float32) / 255.0 - mean) / std
                    x = np.pad(x, ((top, args.size-ih-top), (left, args.size-iw-left), (0, 0)), mode='reflect')
                    x = x.transpose(2, 0, 1)[None].copy()
                    predicted = np.asarray(session.run(None, {inp.name: x})[0]).squeeze()
                    if predicted.ndim != 2 or not np.isfinite(predicted).all():
                        raise RuntimeError('Model returned invalid depth')
                    if predicted.shape != (args.size, args.size):
                        predicted = np.asarray(Image.fromarray(predicted.astype(np.float32)).resize((args.size, args.size), Image.Resampling.BILINEAR))
                    depth = predicted[top:top+ih, left:left+iw]
                    np.save(temp / f'{count:06d}.npy', depth.astype(np.float16))
                    samples.append(depth[::8, ::8].reshape(-1))
                    stats.append(float(depth.std()))
                    count += 1
                    if count % 24 == 0:
                        print(f'Depth inferred: {count} frames; {time.monotonic()-start:.1f}s elapsed', flush=True)
            except BaseException:
                decoder.kill()
                raise
            finally:
                decoder.stdout.close()
                decoder.wait(timeout=30)
            if decoder.returncode:
                raise RuntimeError((temp / 'decode.log').read_text(errors='replace'))
        if count < 2 or min(stats) < 1e-6:
            raise RuntimeError('Empty or flat depth output')
        low, high = map(float, np.percentile(np.concatenate(samples), [2, 98]))
        if high <= low:
            raise RuntimeError('No usable depth range')
        # One normalization range for the full clip prevents per-frame contrast pumping.
        pending = temp / 'depth.mp4'
        with (temp / 'encode.log').open('wb') as err:
            encoder = subprocess.Popen([args.ffmpeg, '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray',
                '-s', f'{iw}x{ih}', '-r', rate, '-i', '-', '-an', '-vf', f'scale={width}:{height}',
                '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                str(pending)], stdin=subprocess.PIPE, stderr=err)
            try:
                for index in range(count):
                    depth = np.load(temp / f'{index:06d}.npy').astype(np.float32)
                    gray = (np.clip((depth-low)/(high-low), 0, 1)*255).astype(np.uint8)
                    encoder.stdin.write(gray.tobytes())
            except BaseException:
                encoder.kill()
                raise
            finally:
                encoder.stdin.close()
                encoder.wait(timeout=60)
            if encoder.returncode:
                raise RuntimeError((temp / 'encode.log').read_text(errors='replace'))
        result = probe(args.ffprobe, pending)
        out_video = next(s for s in result['streams'] if s['codec_type'] == 'video')
        measured = float(out_video.get('duration', result['format']['duration']))
        if abs(measured - duration) > max(2/fps, .15):
            raise RuntimeError(f'Duration mismatch: source {duration}, depth {measured}')
        if any(s['codec_type'] == 'audio' for s in result['streams']):
            raise RuntimeError('Depth guide unexpectedly contains audio')
        # Exclusive creation also protects against a concurrent output writer.
        with pending.open('rb') as src, output.open('xb') as dst:
            shutil.copyfileobj(src, dst)
    report = {'method': 'Depth Anything V2 Small monocular relative inverse-depth, FP32 ONNX',
        'model_sha256': hashlib.file_digest(model.open('rb'), 'sha256').hexdigest(),
        'input': str(source), 'output': str(output), 'polarity': 'near=white, far=black',
        'metric_depth': False, 'grayscale_conversion_only': False, 'frames_inferred': count,
        'inference_square': args.size, 'output_width': width, 'output_height': height,
        'fps': fps, 'source_video_seconds': duration, 'depth_video_seconds': measured,
        'normalization': {'scope': 'whole_clip', 'percentiles': [2,98], 'low': low, 'high': high},
        'audio': False, 'elapsed_seconds': round(time.monotonic()-start,2),
        'limitations': 'Relative per-frame estimates; no metric scale or temporal-consistency guarantee. Inspect hands, transparent objects, cuts and depth flicker.'}
    output.with_suffix('.depth.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == '__main__':
    main()
