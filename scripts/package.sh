#!/usr/bin/env bash
# Builds an extension and packs it for a Band hub.
#   scripts/package.sh <ext>
# Reads extensions/<ext>/band-extension.json and writes
#   dist/<ext>-<version>.tar.gz         one top-level folder, <ext>/
#   dist/<ext>-<version>.tar.gz.sha256  `sha256sum` format, checked from inside dist/
# The folder holds band-extension.json, catalog.json (the description and minBand the catalog
# generator reads), tools.json, the web build (each .wasm and .js with a .gz copy, also inside
# folders such as snippets/, and a .br copy when `brotli` is installed), LICENSE-MIT, LICENSE-APACHE and NOTICE.
# An extension with a package.json instead of a Cargo workspace (simulator) builds with
# `npm ci && node build.mjs` and has no tools.json (a language server extension builds node_modules/ only), because its manifest declares the tools.
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

node_ext=0
[ -f "$src/package.json" ] && node_ext=1
if [ "${SKIP_BUILD:-}" != "1" ]; then
  if [ "$node_ext" = 1 ]; then
    (cd "$src" && npm ci --ignore-scripts && node build.mjs)
  else
    (cd "$src/app" && trunk build --release)
  fi
fi
build="$src/dist/web"
if [ "$node_ext" = 1 ]; then
  # A worker service builds service.mjs. A language server extension ships npm packages instead.
  # A client mod ships its files as they are: mod.css and optionally mod.mjs.
  [ -f "$build/service.mjs" ] || [ -d "$build/node_modules" ] || [ -f "$build/mod.css" ] || [ -f "$build/mod.mjs" ] || { echo "no $build/service.mjs, node_modules or mod.css: build first" >&2; exit 1; }
else
  [ -f "$build/index.html" ] || { echo "no $build/index.html: build first" >&2; exit 1; }
fi
[ -f "$src/catalog.json" ] || { echo "no extensions/$ext/catalog.json (description and minBand)" >&2; exit 1; }

# tools.json comes from the extension's own MCP server; the crate is named <ext>-band. An extension
# with its own [workspace] in extensions/<ext>/Cargo.toml builds from that folder.
if [ "$node_ext" = 0 ]; then
  cargo_dir="$root"
  if grep -q '^\[workspace\]' "$src/Cargo.toml" 2>/dev/null; then cargo_dir="$src"; fi
  (cd "$cargo_dir" && cargo run --quiet --release -p "$ext-band" --bin tools-json) > "$build/tools.json"
fi

stage="$root/dist/stage"
rm -rf "$stage"
mkdir -p "$stage/$ext"
cp -R "$build"/* "$stage/$ext/"
cp "$src/band-extension.json" "$src/catalog.json" "$src/NOTICE" "$root/LICENSE-MIT" "$root/LICENSE-APACHE" "$stage/$ext/"

while IFS= read -r f; do
  gzip -9 -k -f "$f"
  if command -v brotli >/dev/null; then brotli -q 11 -f -k "$f"; fi
done < <(find "$stage/$ext" -type f \( -name '*.wasm' -o -name '*.js' \) -not -path '*/node_modules/*')

name="$ext-$version.tar.gz"
rm -f "$root/dist/$name" "$root/dist/$name.sha256"
# COPYFILE_DISABLE keeps macOS tar from adding ._ files.
COPYFILE_DISABLE=1 tar -czf "$root/dist/$name" -C "$stage" "$ext"
rm -rf "$stage"
(cd "$root/dist" && { sha256sum "$name" 2>/dev/null || shasum -a 256 "$name"; } > "$name.sha256")

echo "packed dist/$name"
tar -tzf "$root/dist/$name"
cat "$root/dist/$name.sha256"
