#!/usr/bin/env bash
# Runs the simulator extension against a real Band hub and worker (S2, S3, S5) and in a real
# browser (S4). Needs a Mac with Xcode and a Band checkout of the simulator-as-extension branch (the
# first release to contain it is 0.62.0), installed and built:
#   cd "$BAND_SRC"; pnpm install; pnpm build:web
#   BAND_SRC=/path/to/band extensions/simulator/integration/run.sh [hub|e2e|all]
# That Band has no bundled simulator, so the checkout needs no patching.
# The packaged tarball comes from scripts/package.sh simulator (dist/simulator-<version>.tar.gz).
# The tests give the worker a device name prefix of their own and delete every device with it, so
# a person's simulators are never touched. They need about 6 GB of free disk.
set -euo pipefail

src="${BAND_SRC:?set BAND_SRC to a Band checkout of the simulator-as-extension branch (installed, with pnpm build:web run)}"
which="${1:-all}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
version="$(node -p "require('$root/extensions/simulator/band-extension.json').version")"
export SIM_EXT_TARBALL="$root/dist/simulator-$version.tar.gz"
export SIM_EXT_SHOTS="${SIM_EXT_SHOTS:-$root/dist/verify/simulator}"
[ -f "$SIM_EXT_TARBALL" ] || { echo "no $SIM_EXT_TARBALL: run scripts/package.sh simulator first" >&2; exit 1; }
[ -f "$src/apps/hub/dist/start-server.mjs" ] || { echo "the hub is not built in $src (pnpm build:web)" >&2; exit 1; }

# A checkout that still bundles the simulator plugin would answer in the extension's place.
if [ -f "$src/apps/worker/src/bundled-worker-plugins.ts" ] && grep -q plugin-simulator "$src/apps/worker/src/bundled-worker-plugins.ts"; then
  echo "$src still bundles the simulator plugin: use the simulator-as-extension branch of Band" >&2
  exit 1
fi

# Test hubs and workers run with a temp HOME and no BAND_* variable from the Band worker this may run in.
for v in $(env | sed -n 's/^\(BAND_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

if [ "$which" = hub ] || [ "$which" = all ]; then
  cp "$here/simulator-extension.test.ts" "$src/apps/hub/tests/simulator-extension.test.ts"
  trap 'rm -f "$src/apps/hub/tests/simulator-extension.test.ts" "$src/apps/web/e2e/simulator-extension-panel.spec.ts"' EXIT
  (cd "$src/apps/hub" && pnpm exec vitest run tests/simulator-extension.test.ts)
fi
if [ "$which" = e2e ] || [ "$which" = all ]; then
  cp "$here/simulator-extension-panel.spec.ts" "$src/apps/web/e2e/simulator-extension-panel.spec.ts"
  trap 'rm -f "$src/apps/hub/tests/simulator-extension.test.ts" "$src/apps/web/e2e/simulator-extension-panel.spec.ts"' EXIT
  (cd "$src/apps/web" && pnpm exec playwright test e2e/simulator-extension-panel.spec.ts --project=chromium)
fi
