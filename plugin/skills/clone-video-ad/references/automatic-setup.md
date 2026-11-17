# Automatic local depth environment (v0.2.0)

## Agent behavior

When this skill selects real depth preprocessing, run the OS entry point below.
It prepares its own runtime automatically, then runs conversion. Do not ask the
user to install Python, run pip, download weights, edit PATH, create an environment,
or enter model/FFmpeg paths. Do not assume the author's machine-specific directories.
Pure analysis, prompting, and routes that do not use depth need no depth setup.

Downloading/installing a ZIP does not execute code by itself. After installation,
Codex invokes this entry point on the first relevant task. Network or executable
permissions may still require the host's approval; explain the actual request.
An offline or restricted host cannot promise downloads succeeded. Preserve task
inputs and resume setup after the actual permission/network issue is resolved.

Windows (PowerShell 5.1+; no preinstalled Python required):

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<skill>/scripts/run_depth.ps1' --input '<reference.mp4>' --output '<new-depth.mp4>'
```

macOS / glibc Linux (standard shell, tar, SHA-256 tool, curl or wget):

```sh
sh '<skill>/scripts/run_depth.sh' --input '<reference.mp4>' --output '<new-depth.mp4>'
```

Replace `<skill>` with the actual discovered skill directory. Use direct arguments,
not shell-evaluated strings containing product names. The PowerShell execution
policy option is scoped to this process; do not change machine/user policy.

The user can simply request “use clone-video-ad to make a depth-guided version.”
These commands are for the agent and troubleshooting, not required manual setup.

## What happens automatically

1. Download portable uv 0.9.7 from its official release, verify the platform archive's
   pinned SHA-256, and extract into a user cache.
2. uv downloads managed CPython 3.12.12 and creates a private virtual environment
   keyed by the dependency lock's digest. It does not use the user's system Python.
3. Install binary wheels from official PyPI using `requirements.lock`, with exact
   versions and wheel hashes. It includes NumPy, Pillow, ONNX Runtime, PyAV, and
   imageio-ffmpeg's portable FFmpeg. No compiler or GPU driver is required.
4. Download the Depth Anything V2 Small FP32 ONNX model (~99 MB), verify its pinned
   SHA-256, and reuse it on later calls. A corrupt cached model is preserved under
   a `.corrupt-*` name and replaced online; offline mode stops with a clear message.
5. Check imports, model inference and a small video encode/decode cycle. Only then
   record readiness and run the real estimator. Metadata probing uses PyAV, so the
   local converter does not need a separately installed ffprobe executable.

The runtime typically downloads a few hundred MB on first use and needs additional
disk space for caches, unpacked libraries and temporary depth frames. Actual sizes
depend on platform. No media is uploaded by setup or local conversion. Packages and
the model are not bundled in the small skill ZIP; their download is automatic.

Windows default cache: `%LOCALAPPDATA%/TopMediaiSkills/clone-video-ad/v0.2.0`.
macOS/Linux default: `${XDG_CACHE_HOME:-~/.cache}/topmediai-skills/clone-video-ad/v0.2.0`.
Use `--cache-dir '<directory>'` to choose a writable task-specific cache when needed.
No administrator install, PATH edits, shell-profile edits, OS package manager, registry
setting or global Python package changes are made. Standard OS permissions still apply.

## Reuse, diagnostics and recovery

The same entry point supports:

- `--setup-only`: prepare and verify the environment without converting media.
- `--doctor`: verify the cached model and repeat inference/video self-tests.
- `--offline`: require existing verified caches; do not download uv, Python, packages
  or weights. An incomplete cache fails clearly rather than silently using another runtime.
- `--size 322`: faster CPU depth preview; default is 518. `--threads 4` controls CPU inference.
- `--help`: show usage without preparing an environment or using the network.

Read `runtime.json` in the selected cache for actual versions, paths and readiness.
Agent tooling may use those returned paths for local media work instead of guessing.
Never interpret a ready runtime as proof that depth geometry is good or a backend
generation will succeed. Run the scene-specific visual quality gate afterward.

Interrupted downloads/setup can be re-run without configuring an environment.
Model downloads have one bounded retry; cached completed assets are reused.
Do not delete a user's entire cache or reinstall system Python to solve a failure.
If a wheel is unavailable for the platform, report the exact unsupported platform /
dependency instead of starting a source compilation or pretending setup completed.

Windows x64 cold setup, offline reuse and real conversion are release validation
targets. macOS/Linux/other architectures have entry points but must be identified
as unverified until actually tested there; do not claim all-platform acceptance.

## TopMediai remains a connected service

This setup prepares the local depth converter. It does not install or log in to
TopMediai MCP, read credentials, change the MCP server's launch configuration, upload
the source, or grant paid-generation approval. Use the connected plugin's readiness
and setup/login tools as appropriate. The MCP's own upload runtime may have separate
FFmpeg/FFprobe requirements; a local converter self-test is not proof of that server's
readiness. Resolve an actual plugin error using its supported setup workflow instead
of asking the user to invent paths or silently editing unrelated configuration.

Source/model: [uv managed Python](https://docs.astral.sh/uv/guides/install-python/),
[uv 0.9.7](https://github.com/astral-sh/uv/releases/tag/0.9.7),
[imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg),
[Depth Anything V2 ONNX](https://huggingface.co/onnx-community/depth-anything-v2-small).
