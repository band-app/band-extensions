#!/usr/bin/env bash
# Builds an extension and packs it for a Band hub.
#   scripts/package.sh <ext>
# Reads extensions/<ext>/band-extension.json and writes
#   dist/<ext>-<version>.tar.gz         one top-level folder, <ext>/
#   dist/<ext>-<version>.tar.gz.sha256  `sha256sum` format, checked from inside dist/
# The folder holds band-extension.json, tools.json, the web build (each .wasm and .js with a .gz
# copy, and a .br copy when `brotli` is installed), LICENSE-MIT, LICENSE-APACHE and NOTICE.
# SKIP_BUILD=1 reuses extensions/<ext>/dist/web instead of building it.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <ext>" >&2
  exit 2
fi
ext="$1"
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/extensions/$ext"
[ -f "$src/band-extension.json" ] || { echo "no extensions/$ext/band-extension.json" >&2; exit 1; }
version="$(node -p "JSON.parse(require('fs').readFileSync('$src/band-extension.json','utf8')).version")"
id="$(node -p "JSON.parse(require('fs').readFileSync('$src/band-extension.json','utf8')).id")"
[ "$id" = "$ext" ] || { echo "band-extension.json id is '$id', expected '$ext'" >&2; exit 1; }

if [ "${SKIP_BUILD:-}" != "1" ]; then
  (cd "$src/app" && trunk build --release)
fi
build="$src/dist/web"
[ -f "$build/index.html" ] || { echo "no $build/index.html: build first" >&2; exit 1; }

# tools.json comes from the extension's own MCP server; the crate is named <ext>-band.
(cd "$root" && cargo run --quiet --release -p "$ext-band" --bin tools-json) > "$build/tools.json"

stage="$root/dist/stage"
rm -rf "$stage"
mkdir -p "$stage/$ext"
cp "$build"/* "$stage/$ext/"
cp "$src/band-extension.json" "$src/NOTICE" "$root/LICENSE-MIT" "$root/LICENSE-APACHE" "$stage/$ext/"

for f in "$stage/$ext"/*.wasm "$stage/$ext"/*.js; do
  gzip -9 -k -f "$f"
  if command -v brotli >/dev/null; then brotli -q 11 -f -k "$f"; fi
done

name="$ext-$version.tar.gz"
rm -f "$root/dist/$name" "$root/dist/$name.sha256"
# COPYFILE_DISABLE keeps macOS tar from adding ._ files.
COPYFILE_DISABLE=1 tar -czf "$root/dist/$name" -C "$stage" "$ext"
rm -rf "$stage"
(cd "$root/dist" && { sha256sum "$name" 2>/dev/null || shasum -a 256 "$name"; } > "$name.sha256")

echo "packed dist/$name"
tar -tzf "$root/dist/$name"
cat "$root/dist/$name.sha256"
