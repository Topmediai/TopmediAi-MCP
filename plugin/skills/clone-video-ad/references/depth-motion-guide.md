# Depth-guided reference adaptation

Use this route when the user requests a genuine black-and-white depth guide or
deliberately wants motion/composition separated from source appearance. It is an
experimental guidance technique, not a native depth-control API or a guaranteed
fix for a failed Seedance generation.

Before preprocessing, use [scene-routing-and-quality.md](scene-routing-and-quality.md)
for category suitability, motion/pose/camera/focus distinctions, the local quality
gate and fallback selection. One local showcase generated successfully with this
route and revised wording; no cross-category reliability is established.

## Separate the evidence and the inputs

- Inspect the original RGB video locally for action, shot timing, camera movement,
  light, color and sound. Keep this analysis even when only depth is uploaded.
- A grayscale/luma filter encodes brightness, not distance. Never call it depth.
  Canny outlines, Sobel edges, contrast inversion and blurred grayscale are not
  depth estimation either. If no real estimator/model is available, explain the
  dependency and stop this preprocessing step rather than silently substituting.
- Run a monocular depth estimator over the video. The bundled script supports
  Depth Anything V2 Small FP32 ONNX. This produces estimated relative inverse depth,
  near white and far black, not measured meters or guaranteed depth accuracy.
- Original product labels, clothing patterns and faces may become less apparent,
  but depth maps are not anonymization and cannot be used to bypass a provider's
  content, identity or permission restrictions. If a service returns a concrete
  restriction, respect it; do not repeatedly transform/retry to evade rejection.

## Local preparation

Use [automatic-setup.md](automatic-setup.md) and invoke the OS entry point.
The agent prepares Python, dependencies, portable FFmpeg and weights automatically
in a private cache. Do not ask users to install software or locate model/tool paths.
The estimator is local and performs no uploads or paid generation. The bootstrap
alone downloads verified public runtime/model assets when missing.

Windows agent invocation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<skill>/scripts/run_depth.ps1' --input '<original.mp4>' --output '<new-depth.mp4>'
```

macOS/Linux agent invocation:

```sh
sh '<skill>/scripts/run_depth.sh' --input '<original.mp4>' --output '<new-depth.mp4>'
```

The [ONNX model export](https://huggingface.co/onnx-community/depth-anything-v2-small)
is based on [Depth Anything V2 Small](https://huggingface.co/depth-anything/Depth-Anything-V2-Small),
Apache-2.0. Runtime/model versions and digests are pinned in the helper/lockfile.
Direct low-level invocation remains available for debugging, not required user setup.

`--python-deps` adds an existing package directory. `--size` controls inference
resolution (multiple of 14, default 518); 322 is a faster CPU preview, not a promise
of fine hand/finger depth. All decoded frames are inferred at the source average
frame rate, then encoded at the original dimensions. Inspect the sidecar's measured
duration and frame count. VFR sources are resampled to CFR and need extra sync review.

Use a clip-wide depth scale to limit brightness pumping. Do not apply heavy temporal
averaging that trails moving objects or blends depth across cuts. Independent-frame
inference can still flicker or drift in scale. If unacceptable, use an available
video-depth estimator, infer separate shots, or choose text/shot-plan guidance; do
not claim temporal stabilization merely because the file was successfully encoded.

Inspect source/depth pairs at the opening, each cut, occlusion/contact changes,
closest product position and final landing. Verify product contour and movement,
hand-object separation, near/far polarity, black-white range, lack of flat frames,
duration, aspect and usable resolution. Transparent packaging may have uncertain
depth; record that limitation. The converter removes the depth guide's audio, leaving
final generation audio preferences unchanged.

## New-video prompt and asset responsibilities

Describe a new film in full. Assign each asset exactly one clear job:

1. `@Video1`: the depth guide supplies camera path, timing, rough geometry, occlusion
   and motion only. It is a reference video, not a native depth tensor/control input.
2. `@Image1`: the user's product image supplies product identity, geometry, materials,
   cap, logo and label. Identity/reference images for people or scene are separate
   optional inputs, only if necessary and available; do not add paid image creation
   automatically. Describe missing scene appearance, wardrobe and lighting in text.
3. Text supplies the final RGB appearance, acting, lighting, color and audio. State
   that the output is a full-color new video. Do not reproduce depth shading in the
   finished advertisement. Keep verified product facts and avoid invented effects.

Example core phrasing (adapt to the specific observed motion):

```text
Generate a new full-color product film. @Video1 is a relative-depth motion guide:
use its camera trajectory, object travel, timing and occlusion relationships.
@Image1 defines the final product's appearance and packaging. Reconstruct the
scene from the following written description. [Complete scene, timing, light and
audio instructions.] The final image has natural RGB surfaces and readable packaging.
```

Avoid framing an adaptation as "edit this video", "replace the original product",
"keep every other pixel identical" or "retain the original performer exactly".
This clarifies the intended operation; it does not establish why a prior job failed
or guarantee backend classification. Use an actual editing workflow when editing
is what the user requests. BytePlus's [reference prompt guide](https://docs.byteplus.com/en/docs/modelark/seedance-2-0-prompt-guide)
distinguishes borrowing motion/style to create a new video from modifying a source.
No cited contract establishes a dedicated depth-control parameter in TopMediai MCP.

## TopMediai quote and retry handling

For production follow the installed `topmediai-mcp` skill and the actual schemas.
Read the selected model's `omni_reference_to_video` catalog. Upload only the chosen
depth MP4 and authorized product/scene references through the configured upload
directory, with selected `model_type` (Seedance 2.5 currently 38). When this route is
selected, do not also upload the RGB source by default; it is used locally for analysis.
Use returned `reference_media_id` in `reference_video_ids`, and account-scoped
`reference_image_id` in `reference_images`, ordered to match the prompt tags.

Quote the actual depth guide's normalized duration, output duration and settings;
never reuse the RGB source's quote or task as if the media were unchanged. Audio
generation remains on unless the user requested silence. Changing the guide is a
changed input requiring an exact quote, full-flow review, and applicable approval.
For recovery of an existing failed flow, preserve its original `flow_id` and include
the failed original request in `submitted_steps`; use a distinct request ID only
for a separately authorized new paid attempt. Do not omit the earlier attempt to
reduce the flow total or imply a refund. Skill optimization/preprocessing permission
does not authorize upload, a fresh quote submission or a paid retry on its own.

After a failure with no returned reason, label cause unknown. Do not present the
depth route as a proven remedy, guarantee success or automatically batch retries.
