#!/bin/sh
# macOS / glibc Linux entry point, shell built-ins plus curl or wget and tar.
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cache_path="${XDG_CACHE_HOME:-$HOME/.cache}/topmediai-skills/clone-video-ad/v0.2.0"
offline=0
take_cache=0
for arg in "$@"; do
  if [ "$arg" = '--help' ]; then
    echo 'Usage: sh run_depth.sh --input <video> --output <depth.mp4> [--size 518] [--threads 4] [--cache-dir <path>] [--offline]'
    echo 'Setup only: --setup-only; diagnose: --doctor'
    exit 0
  fi
  if [ "$take_cache" = 1 ]; then cache_path="$arg"; take_cache=0; fi
  if [ "$arg" = '--cache-dir' ]; then take_cache=1; fi
  if [ "$arg" = '--offline' ]; then offline=1; fi
done
[ "$take_cache" = 0 ] || { echo '--cache-dir needs a path' >&2; exit 2; }
os=$(uname -s); arch=$(uname -m)
case "$os/$arch" in
  Darwin/arm64) asset=uv-aarch64-apple-darwin.tar.gz; expected=35572b9619fc14d67fc1cd72582c3cfc5c9c66d97f310192e04f26fb3fe96005 ;;
  Darwin/x86_64) asset=uv-x86_64-apple-darwin.tar.gz; expected=41946d87e1576c297d6d3cca88b089b6942b8777a5a25e70de1ef8c57b94b9cf ;;
  Linux/x86_64) asset=uv-x86_64-unknown-linux-gnu.tar.gz; expected=b26fcc8dfa1c39b5a5613445af3be3eefda45d9a39359bee271eafe34913583e ;;
  Linux/aarch64) asset=uv-aarch64-unknown-linux-gnu.tar.gz; expected=8b3d31a154673c6d357727d2083a33525b515589d153fa5b5455e1db9e9e6363 ;;
  *) echo 'Unsupported platform; macOS or glibc Linux x64/arm64 required' >&2; exit 2 ;;
esac
mkdir -p "$cache_path"
cache_path=$(CDPATH= cd -- "$cache_path" && pwd)
uv_path="$cache_path/uv-0.9.7/uv"
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f1
  else shasum -a 256 "$1" | cut -d ' ' -f1; fi
}
if [ ! -x "$uv_path" ]; then
  [ "$offline" = 0 ] || { echo 'Offline mode: uv is not cached' >&2; exit 2; }
  echo '[setup] Downloading verified portable uv 0.9.7...'
  archive="$cache_path/$asset.$$.part"
  url="https://github.com/astral-sh/uv/releases/download/0.9.7/$asset"
  if command -v curl >/dev/null 2>&1; then curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$url"
  else wget --https-only --output-document="$archive" "$url"; fi
  [ "$(hash_file "$archive")" = "$expected" ] || { echo 'uv archive integrity check failed' >&2; exit 2; }
  mkdir -p "$cache_path/uv-0.9.7"
  tar -xzf "$archive" -C "$cache_path/uv-0.9.7" --strip-components=1
fi
export UV_PYTHON_INSTALL_DIR="$cache_path/python"
export UV_CACHE_DIR="$cache_path/uv-cache"
export UV_PYTHON_PREFERENCE=only-managed
lock_hash=$(hash_file "$script_dir/requirements.lock" | cut -c1-16)
venv_path="$cache_path/env-$lock_hash-py312"
python_path="$venv_path/bin/python"
if [ ! -x "$python_path" ]; then
  [ "$offline" = 0 ] || { echo 'Offline mode: isolated Python is missing' >&2; exit 2; }
  echo '[setup] Preparing isolated Python 3.12.12...'
  "$uv_path" --no-config venv --python 3.12.12 --python-preference only-managed "$venv_path"
fi
exec "$python_path" -I -X utf8 "$script_dir/bootstrap_depth.py" --uv "$uv_path" --cache-dir "$cache_path" "$@"
