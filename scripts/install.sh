#!/usr/bin/env bash
# Installs an extension into a Band home from a local build.
#   scripts/install.sh <ext> <BAND_HOME>
# Packs the extension (scripts/package.sh), or reuses dist/<ext>-<version>.tar.gz with REUSE=1,
# then unpacks it into <BAND_HOME>/extensions/<ext>/. Run `band extensions reload` afterwards.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <ext> <BAND_HOME>" >&2
  exit 2
fi
ext="$1"
home="$2"
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "JSON.parse(require('fs').readFileSync('$root/extensions/$ext/band-extension.json','utf8')).version")"
tarball="$root/dist/$ext-$version.tar.gz"

if [ "${REUSE:-}" != "1" ] || [ ! -f "$tarball" ]; then
  "$root/scripts/package.sh" "$ext"
fi

mkdir -p "$home/extensions"
rm -rf "${home:?}/extensions/$ext"
tar -xzf "$tarball" -C "$home/extensions"
echo "installed $home/extensions/$ext"
