"""Prepare an isolated depth runtime and run the real estimator; no uploads or generation."""
import argparse
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request

HERE = Path(__file__).resolve().parent
MODEL_SHA256 = 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c'
MODEL_URL = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx'


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


@contextlib.contextmanager
def setup_lock(path):
    with path.open('a+b') as stream:
        stream.seek(0)
        if not stream.read(1):
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError('Another setup is using this cache. Wait for it to finish and retry.') from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == 'nt':
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def download_model(path, offline):
    if path.exists():
        if sha(path) != MODEL_SHA256:
            if offline:
                raise RuntimeError('Offline mode: cached model is corrupt. Run setup online to repair it automatically.')
            quarantined = path.with_name(path.name + f'.corrupt-{time.time_ns()}')
            path.rename(quarantined)
            print('[setup] Preserved corrupt model cache; downloading a verified replacement.', flush=True)
        else:
            print('[setup] Verified cached depth model.', flush=True)
            return
    if offline:
        raise RuntimeError('Offline mode: depth model is missing. Run setup once online.')
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix('.onnx.part')
    print('[setup] Downloading Depth Anything V2 Small FP32 model (~99 MB)...', flush=True)
    for attempt in range(2):
        try:
            req = urllib.request.Request(MODEL_URL, headers={'User-Agent': 'clone-video-ad/0.2.0'})
            with urllib.request.urlopen(req, timeout=90) as response, part.open('wb') as dest:
                total = 0
                next_report = 20_000_000
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    dest.write(chunk)
                    total += len(chunk)
                    if total >= next_report:
                        print(f'[setup] Model downloaded: {total // 1_000_000} MB', flush=True)
                        next_report += 20_000_000
            if sha(part) != MODEL_SHA256:
                raise RuntimeError('Downloaded model hash mismatch; model was not executed.')
            part.replace(path)
            return
        except (OSError, TimeoutError) as exc:
            if attempt:
                raise RuntimeError('Model download failed twice. Check network/proxy and run setup again; no media was uploaded.') from exc
            print('[setup] Model download interrupted; retrying this download once.', flush=True)


def runtime_test(model, full_test):
    import importlib.metadata
    import av
    import imageio_ffmpeg
    import numpy as np
    import onnxruntime as ort
    import PIL

    # Select the wheel's binary explicitly, independent of PATH and host overrides.
    binaries = Path(imageio_ffmpeg.__file__).parent / 'binaries'
    executables = [p for p in binaries.glob('ffmpeg-*') if p.is_file() and p.suffix not in {'.txt', '.md'}]
    if len(executables) != 1:
        raise RuntimeError('FFmpeg wheel does not contain exactly one portable executable for this platform.')
    ffmpeg = executables[0]
    completed = subprocess.run([str(ffmpeg), '-version'], check=True, capture_output=True, text=True)
    if full_test:
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
        prediction = np.asarray(session.run(None, {session.get_inputs()[0].name: np.zeros((1, 3, 224, 224), dtype=np.float32)})[0])
        if prediction.size == 0 or not np.isfinite(prediction).all():
            raise RuntimeError('Depth inference self-test failed.')
        encoded = subprocess.run([str(ffmpeg), '-v', 'error', '-f', 'rawvideo',
            '-pix_fmt', 'rgb24', '-s', '224x224', '-r', '24', '-i', '-', '-frames:v', '2',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov',
            '-f', 'mp4', '-'], input=bytes(224*224*3*2), check=True, capture_output=True)
        with av.open(io.BytesIO(encoded.stdout)) as video:
            if len(list(video.decode(video=0))) != 2:
                raise RuntimeError('Portable video encode/decode self-test failed.')
    return {'python': sys.version.split()[0], 'python_executable': sys.executable,
        'versions': {name: importlib.metadata.version(name) for name in ['numpy', 'Pillow', 'onnxruntime', 'av', 'imageio-ffmpeg']},
        'ffmpeg': str(ffmpeg), 'ffmpeg_version': completed.stdout.splitlines()[0],
        'probe_backend': 'PyAV', 'model': str(model), 'model_sha256': MODEL_SHA256,
        'self_test_version': 2,
        'model_self_test': 'passed' if full_test else 'previously passed; current model hash verified'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--uv', required=True, help=argparse.SUPPRESS)
    parser.add_argument('--cache-dir', required=True)
    parser.add_argument('--setup-only', action='store_true')
    parser.add_argument('--doctor', action='store_true')
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--input')
    parser.add_argument('--output')
    parser.add_argument('--size', type=int, default=518)
    parser.add_argument('--threads', type=int, default=4)
    args = parser.parse_args()
    if not (args.setup_only or args.doctor):
        if not args.input or not args.output:
            parser.error('Specify --input and --output, or use --setup-only / --doctor.')
        if not Path(args.input).is_file():
            parser.error('Input video does not exist.')
        if Path(args.output).exists():
            parser.error('Output already exists; choose a new path. Originals will not be overwritten.')
        if args.size < 224 or args.size > 1036 or args.size % 14:
            parser.error('--size must be a multiple of 14 from 224 to 1036.')
    cache = Path(args.cache_dir).expanduser().resolve()
    if sys.prefix == sys.base_prefix or not Path(sys.prefix).resolve().is_relative_to(cache):
        raise RuntimeError('Use run_depth.ps1 or run_depth.sh; refusing to install dependencies into a system Python.')
    cache.mkdir(parents=True, exist_ok=True)
    lockfile = HERE / 'requirements.lock'
    fingerprint = sha(lockfile)
    ready = Path(sys.prefix) / 'clone-depth-ready.json'
    model = cache / 'models' / 'depth-anything-v2-small-fp32.onnx'
    with setup_lock(cache / 'setup.lock'):
        previous = {}
        if ready.is_file():
            try:
                previous = json.loads(ready.read_text(encoding='utf-8'))
            except (ValueError, OSError):
                pass
        install_needed = previous.get('requirements_sha256') != fingerprint
        if not install_needed:
            try:
                import importlib.metadata
                install_needed = any(importlib.metadata.version(k) != v for k, v in previous['versions'].items())
            except (ImportError, KeyError):
                install_needed = True
        if install_needed:
            if args.offline:
                raise RuntimeError('Offline mode: runtime dependencies are not ready. Run setup once online.')
            print('[setup] Installing isolated, hash-locked binary dependencies...', flush=True)
            subprocess.run([args.uv, '--quiet', '--no-config', 'pip', 'install', '--python', sys.executable,
                '--index-url', 'https://pypi.org/simple', '--require-hashes', '--only-binary', ':all:',
                '-r', str(lockfile)], check=True)
        download_model(model, args.offline)
        result = runtime_test(model, full_test=install_needed or args.doctor or previous.get('self_test_version') != 2)
        result['requirements_sha256'] = fingerprint
        result['status'] = 'ready'
        ready.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        (cache / 'runtime.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print('[setup] Isolated depth environment is ready.', flush=True)
    if args.setup_only or args.doctor:
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
        return
    subprocess.run([sys.executable, '-I', '-X', 'utf8', str(HERE / 'make_depth_video.py'),
        '--input', str(Path(args.input).resolve()), '--output', str(Path(args.output).resolve()),
        '--model', str(model), '--ffmpeg', result['ffmpeg'], '--ffprobe', 'pyav',
        '--size', str(args.size), '--threads', str(args.threads)], check=True)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print(f'[setup error] {exc}', file=sys.stderr, flush=True)
        raise SystemExit(1)
