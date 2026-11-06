#!/usr/bin/env bash
# Takes the bundled simulator plugin out of a THROWAWAY Band v0.61.0 checkout, the way the planned
# follow-up PR in band-app/band does. Without it the integration tests cannot exercise the
# extension: a bundled plugin with the same capability ("simulator") takes precedence on the worker
# (docs/extensions.md), and the hub registers its own simulator_* tools. Never run this on a
# checkout you work in. Idempotent. Rebuilds the hub bundle and the web build.
#   patch-band.sh <band checkout>
set -euo pipefail
src="${1:?usage: patch-band.sh <band checkout>}"
python3 - "$src" <<'PY'
import sys, re, pathlib
src = pathlib.Path(sys.argv[1])
def edit(rel, pairs):
    p = src / rel
    s = p.read_text()
    for old, new in pairs:
        s = s.replace(old, new)
    p.write_text(s)
edit("apps/hub/src/server/services/bundled-plugins.ts", [
    ('import simulatorManifest from "@band-app/plugin-simulator/band-plugin.json" with { type: "json" };\n', ''),
    ('import simulatorServer from "@band-app/plugin-simulator/server";\n', ''),
    ('  { manifest: simulatorManifest, server: simulatorServer },\n', ''),
])
edit("apps/worker/src/bundled-worker-plugins.ts", [
    ('import simulatorManifest from "@band-app/plugin-simulator/band-plugin.json" with { type: "json" };\n', ''),
    ('import simulatorWorker from "@band-app/plugin-simulator/worker";\n', ''),
    ('  { manifest: simulatorManifest, worker: simulatorWorker },\n', ''),
])
edit("apps/web/src/plugins/bundled-client-plugins.ts", [
    ('import simulatorClient from "@band-app/plugin-simulator/client";\n', ''),
    ('[simulatorClient]', '[]'),
])
PY
(cd "$src" && pnpm build:web >/tmp/patch-band-build.log 2>&1) || { tail -20 /tmp/patch-band-build.log; exit 1; }
echo "patched and rebuilt $src"
