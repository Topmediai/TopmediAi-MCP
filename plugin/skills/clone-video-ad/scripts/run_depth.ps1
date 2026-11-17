# Windows PowerShell 5.1+ entry point: no preinstalled Python or admin install.
$ErrorActionPreference = 'Stop'
$taskArguments = @($args)
if ($taskArguments -contains '--help') {
    Write-Output 'Usage: run_depth.ps1 --input <video> --output <depth.mp4> [--size 518] [--threads 4] [--cache-dir <path>] [--offline]'
    Write-Output 'Setup only: run_depth.ps1 --setup-only; diagnose: run_depth.ps1 --doctor'
    exit 0
}
$cachePath = if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'TopMediaiSkills\clone-video-ad\v0.2.0' } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\topmediai-skills\clone-video-ad\v0.2.0' }
$offline = $taskArguments -contains '--offline'
for ($argIndex = 0; $argIndex -lt $taskArguments.Count; $argIndex++) {
    if ($taskArguments[$argIndex] -eq '--cache-dir') {
        if ($argIndex + 1 -ge $taskArguments.Count) { throw '--cache-dir needs a path' }
        $cachePath = [IO.Path]::GetFullPath($taskArguments[$argIndex+1])
    }
}
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($architecture.ToUpperInvariant()) {
    'AMD64' { $asset = 'uv-x86_64-pc-windows-msvc.zip'; $expectedHash = '5d250c32d3604e28dbe18dc65c668ff628c53e00dde2c642576e831e4a60da64' }
    'ARM64' { $asset = 'uv-aarch64-pc-windows-msvc.zip'; $expectedHash = '4482ad2544544e1966b6d933d38e27368ce0307739d293322c10459f698a1629' }
    default { throw 'This bootstrap supports 64-bit Windows only' }
}
[IO.Directory]::CreateDirectory($cachePath) | Out-Null
$uvPath = Join-Path $cachePath 'uv-0.9.7\uv.exe'
if (-not (Test-Path -LiteralPath $uvPath -PathType Leaf)) {
    if ($offline) { throw 'Offline mode: uv has not been cached. Run once online.' }
    Write-Host '[setup] Downloading verified portable uv 0.9.7...'
    $archivePath = Join-Path $cachePath ($asset + '.' + [guid]::NewGuid().ToString('N') + '.part')
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri ('https://github.com/astral-sh/uv/releases/download/0.9.7/' + $asset) -OutFile $archivePath
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'uv archive integrity check failed; executable was not run' }
    $zipPath = $archivePath + '.zip'
    Move-Item -LiteralPath $archivePath -Destination $zipPath
    Expand-Archive -LiteralPath $zipPath -DestinationPath (Join-Path $cachePath 'uv-0.9.7') -Force
    if (-not (Test-Path -LiteralPath $uvPath -PathType Leaf)) { throw 'uv archive did not contain the expected executable' }
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $cachePath 'python'
$env:UV_CACHE_DIR = Join-Path $cachePath 'uv-cache'
$env:UV_PYTHON_PREFERENCE = 'only-managed'
$lockPath = Join-Path $PSScriptRoot 'requirements.lock'
$lockHash = (Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant().Substring(0,16)
$venvPath = Join-Path $cachePath ('env-' + $lockHash + '-py312')
$pythonPath = Join-Path $venvPath 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    if ($offline) { throw 'Offline mode: isolated Python is missing. Run once online.' }
    Write-Host '[setup] Preparing isolated Python 3.12.12...'
    & $uvPath --no-config venv --python 3.12.12 --python-preference only-managed $venvPath
    if ($LASTEXITCODE -ne 0) { throw 'Managed Python preparation failed; no system Python was changed' }
}
& $pythonPath -I -X utf8 (Join-Path $PSScriptRoot 'bootstrap_depth.py') --uv $uvPath --cache-dir $cachePath @taskArguments
exit $LASTEXITCODE
