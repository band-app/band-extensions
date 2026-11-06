import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * serve-sim runs `open -a Simulator` to attach Simulator.app to a device, which puts a visible
 * window in front of the person. The panel already shows the device, so the helper gets a shim
 * `open` first on its PATH that turns that call into `open -gj -a Simulator`: launch in the
 * background (`-g`) and hidden (`-j`). Any other `open` call, and any call that does not name
 * Simulator, goes to the real `open` unchanged. Ported from Orca's serve-sim wrapper.
 */
export function openShimScript(realOpen = "/usr/bin/open"): string {
  return `#!/bin/sh
has_simulator_target=0
for arg in "$@"; do
  case "$arg" in
    Simulator|Simulator.app|com.apple.iphonesimulator|*Simulator.app*)
      has_simulator_target=1
      ;;
  esac
done
if [ "$has_simulator_target" = "1" ]; then
  ${realOpen} -gj -a Simulator 2>/dev/null || ${realOpen} "$@"
  exit 0
fi
exec ${realOpen} "$@"
`;
}

/**
 * Writes the shim to `<dir>/open` (mode 0755) and returns `dir`, or null when it cannot. The
 * folder is in the service's own state dir, never a shared /tmp path another user could replace.
 */
export function ensureOpenShim(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "open");
    const script = openShimScript();
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {}
    if (current !== script) writeFileSync(file, script, { mode: 0o755 });
    chmodSync(file, 0o755);
    return dir;
  } catch {
    return null;
  }
}
