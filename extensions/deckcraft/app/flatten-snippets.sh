#!/bin/sh
# Trunk post_build hook. wasm-bindgen puts the JavaScript snippets of dependencies (eframe's text
# agent) in snippets/<crate>/, and scripts/package.sh copies only the files at the top of dist/web.
# This moves each snippet next to the main script and points the `import` lines and the preload link in index.html at it. The
# import-object keys stay as they are, because they must match the module names inside the wasm.
set -eu
cd "$TRUNK_STAGING_DIR"
[ -d snippets ] || exit 0
for f in snippets/*/*.js; do
  flat="$(echo "${f#snippets/}" | tr / -)"
  mv "$f" "$flat"
  for js in ./*.js; do
    sed -i.bak "s#^\\(import .* from ['\"]\\./\\)$f#\\1$flat#" "$js"
    rm -f "$js.bak"
  done
  sed -i.bak "s#\\./$f#./$flat#" index.html
  rm -f index.html.bak
done
rm -rf snippets
