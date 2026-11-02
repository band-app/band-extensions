#!/usr/bin/env bash
# Checks a release tag against the extension's manifest. Prints the extension name and version.
#   scripts/check-tag.sh <tag>      tag is <ext>-v<version>, for example gridcraft-v0.7.0-1
# Fails when the tag does not have that shape, the extension does not exist, or the version in the
# tag differs from the version in extensions/<ext>/band-extension.json.
set -euo pipefail

tag="${1:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ ! "$tag" =~ ^([a-z0-9][a-z0-9-]*)-v([0-9].*)$ ]]; then
  echo "tag '$tag' must look like <extension>-v<version>, for example gridcraft-v0.7.0-1" >&2
  exit 1
fi
ext="${BASH_REMATCH[1]}"
version="${BASH_REMATCH[2]}"
manifest="$root/extensions/$ext/band-extension.json"
[ -f "$manifest" ] || { echo "tag '$tag' names the extension '$ext', but extensions/$ext/band-extension.json does not exist" >&2; exit 1; }
declared="$(node -p "JSON.parse(require('fs').readFileSync('$manifest','utf8')).version")"
if [ "$declared" != "$version" ]; then
  echo "tag '$tag' says version $version, but extensions/$ext/band-extension.json says $declared. Change one so they match." >&2
  exit 1
fi
echo "$ext $version"
