#!/usr/bin/env bash
# Runs the desktop extension against a real Band hub and worker (S1 to S6) and in a real browser
# (S1, S4). Needs a Band checkout of the desktop-as-extension branch (the first release to contain
# it is 0.64.0), installed and built:
#   cd "$BAND_SRC"; pnpm install; pnpm build:web; pnpm --filter @band-app/server build; pnpm --filter @band-app/worker build
#   BAND_SRC=/path/to/band extensions/desktop/integration/run.sh [hub|e2e|all]
#
# The worker needs Linux with Xvfb and x11vnc. On a Linux machine that has them it runs natively.
# Anywhere else (a Mac) point DESKTOP_EXT_IMAGE at the band-worker-desktop image
# (docker build -f docker/worker-desktop.Dockerfile --build-arg BASE_IMAGE=<band-worker image> in
# the Band checkout). The hub then runs here and the worker in a container labelled
# band.test=desktop-extension, started with this checkout's apps/worker/dist mounted over the
# image's worker, and removed at the end. Only containers with that label are ever touched.
# The packaged tarball comes from scripts/package.sh desktop (dist/desktop-<version>.tar.gz).
set -euo pipefail

src="${BAND_SRC:?set BAND_SRC to a Band checkout of the desktop-as-extension branch (installed and built)}"
which="${1:-all}"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
version="$(node -p "require('$root/extensions/desktop/band-extension.json').version")"
export DESKTOP_EXT_TARBALL="$root/dist/desktop-$version.tar.gz"
export DESKTOP_EXT_SHOTS="${DESKTOP_EXT_SHOTS:-$root/dist/verify/desktop}"
export DESKTOP_EXT_WORKER_DIST="${DESKTOP_EXT_WORKER_DIST:-$src/apps/worker/dist}"
[ -f "$DESKTOP_EXT_TARBALL" ] || { echo "no $DESKTOP_EXT_TARBALL: run scripts/package.sh desktop first" >&2; exit 1; }
[ -f "$src/apps/hub/dist/start-server.mjs" ] || { echo "the hub is not built in $src" >&2; exit 1; }
[ -f "$src/apps/worker/dist/band-worker.mjs" ] || { echo "the worker is not built in $src (pnpm --filter @band-app/worker build)" >&2; exit 1; }

# A checkout that still bundles the viewer would not have the panel's binaryInput.
if [ -f "$src/apps/hub/src/server/infra/host/desktop-proxy.ts" ]; then
  echo "$src still bundles the desktop viewer: use the desktop-as-extension branch of Band" >&2
  exit 1
fi

# Test hubs and workers run with a temp HOME and no BAND_* variable from the Band worker this may run in.
for v in $(env | sed -n 's/^\(BAND_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

cleanup() {
  rm -f "$src/apps/hub/tests/desktop-extension.test.ts" "$src/apps/web/e2e/desktop-extension-panel.spec.ts"
  ids="$(docker ps -aq --filter label=band.test=desktop-extension 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker rm -f -v $ids >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "$which" = hub ] || [ "$which" = all ]; then
  cp "$here/desktop-extension.test.ts" "$src/apps/hub/tests/desktop-extension.test.ts"
  (cd "$src/apps/hub" && pnpm exec vitest run tests/desktop-extension.test.ts)
fi
if [ "$which" = e2e ] || [ "$which" = all ]; then
  cp "$here/desktop-extension-panel.spec.ts" "$src/apps/web/e2e/desktop-extension-panel.spec.ts"
  (cd "$src/apps/web" && pnpm exec playwright test e2e/desktop-extension-panel.spec.ts --project=chromium)
fi
