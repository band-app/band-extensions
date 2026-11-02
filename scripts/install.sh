#!/usr/bin/env bash
# Builds the web build and installs it as the Band extension "gridcraft".
#   scripts/install.sh <BAND_HOME>
# Result: <BAND_HOME>/extensions/gridcraft/ with band-extension.json, tools.json, index.html, the
# wasm and JS (each with a .gz copy, and a .br copy when `brotli` is installed), LICENSE-MIT,
# LICENSE-APACHE and NOTICE. Run `band extensions reload` afterwards.
# SKIP_BUILD=1 reuses the existing dist/web instead of building it.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <BAND_HOME>" >&2
  exit 2
fi
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$1/extensions/gridcraft"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  (cd "$root/app" && trunk build --release)
fi
[ -f "$root/dist/web/index.html" ] || { echo "no dist/web/index.html: build first" >&2; exit 1; }

cargo run --quiet --release -p gridcraft-webmcp --bin tools-json > "$root/dist/web/tools.json"

rm -rf "$dest"
mkdir -p "$dest"
# host.html is the same-origin test host for ?host=parent, not part of the extension.
for f in "$root"/dist/web/*; do
  [ "$(basename "$f")" = host.html ] || cp "$f" "$dest/"
done
cp "$root/band-extension.json" "$root/LICENSE-MIT" "$root/LICENSE-APACHE" "$root/NOTICE" "$dest/"

for f in "$dest"/*.wasm "$dest"/*.js; do
  gzip -9 -k -f "$f"
  if command -v brotli >/dev/null; then brotli -q 11 -f -k "$f"; fi
done

echo "installed $dest"
ls -l "$dest"
