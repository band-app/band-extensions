// Deletes simulator devices that tests left behind: names that start with
// `band-test-<seconds in base 36>-<pid> <en dash> `, the prefix the tests give their devices.
// Without `--all` only those older than 3 hours go, so a run in progress is safe. With
// `--prefix <name>` that run's devices go too. A device whose name does not start with
// `band-test-` is never touched, so a person's simulators stay.
//   node scripts/sweep-test-simulators.mjs [--prefix band-test-xyz-123] [--max-age-hours 3]
import { spawnSync } from "node:child_process";

const DEVICE = /^(band-test-([0-9a-z]+)-\d+) – /;

/** Test devices in `simctl list devices -j` output, filtered by run prefix or age. */
export function testDevicesIn(listJson, { prefix, olderThanMs, now = Date.now() } = {}) {
  const out = [];
  for (const list of Object.values(listJson?.devices ?? {})) {
    for (const d of list) {
      const m = DEVICE.exec(d.name ?? "");
      if (!m) continue;
      const own = prefix !== undefined && m[1] === prefix;
      const stale =
        olderThanMs !== undefined && now - Number.parseInt(m[2], 36) * 1000 >= olderThanMs;
      if (own || stale) out.push({ udid: d.udid, name: d.name });
    }
  }
  return out;
}

const simctl = (args) => spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8" });

export function sweep({ prefix, olderThanMs = 3 * 3600_000 } = {}) {
  const r = simctl(["list", "devices", "-j"]);
  if (r.error || r.status !== 0) return [];
  const deleted = [];
  for (const d of testDevicesIn(JSON.parse(r.stdout), { prefix, olderThanMs })) {
    simctl(["shutdown", d.udid]);
    if (simctl(["delete", d.udid]).status === 0) deleted.push(d.name);
  }
  return deleted;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const hours = Number(arg("--max-age-hours") ?? 3);
  const names = sweep({ prefix: arg("--prefix"), olderThanMs: hours * 3600_000 });
  for (const n of names) console.log(`deleted simulator device: ${n}`);
}
