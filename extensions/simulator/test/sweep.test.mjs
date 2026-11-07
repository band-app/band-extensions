import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setStateDir } from "../src/config.ts";
import { DeviceSet } from "../src/devices.ts";

// A fake `xcrun` on PATH keeps a device list in a JSON file, so the sweep runs without a
// simulator. Tests use a prefix of their own and never reach the real default device set.
const D = "–";
const PREFIX = `band-test-${Math.floor(Date.now() / 1000).toString(36)}-${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "sim-sweep-"));
const state = join(dir, "state");
const devicesFile = join(dir, "devices.json");
const oldPath = process.env.PATH;
const oldPrefix = process.env.BAND_SIMULATOR_NAME_PREFIX;

const readDevices = () => JSON.parse(readFileSync(devicesFile, "utf8"));
const names = () => readDevices().map((d) => d.name).sort();
const seed = (list) => writeFileSync(devicesFile, JSON.stringify(list));
const dev = (name, state = "Shutdown") => ({ udid: `U-${name}`, name, state });

before(() => {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "xcrun"),
    `#!${process.execPath}
const fs = require("node:fs");
const f = ${JSON.stringify(devicesFile)};
const [, cmd, ...rest] = process.argv.slice(2);
const list = JSON.parse(fs.readFileSync(f, "utf8"));
if (cmd === "list") {
  console.log(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": list } }));
} else if (cmd === "shutdown") {
  for (const d of list) if (d.udid === rest[0]) d.state = "Shutdown";
  fs.writeFileSync(f, JSON.stringify(list));
} else if (cmd === "delete") {
  fs.writeFileSync(f, JSON.stringify(list.filter((d) => d.udid !== rest[0])));
}
`,
  );
  chmodSync(join(bin, "xcrun"), 0o755);
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.BAND_SIMULATOR_NAME_PREFIX = PREFIX;
  setStateDir(state);
});
after(() => {
  process.env.PATH = oldPath;
  if (oldPrefix === undefined) Reflect.deleteProperty(process.env, "BAND_SIMULATOR_NAME_PREFIX");
  else process.env.BAND_SIMULATOR_NAME_PREFIX = oldPrefix;
  rmSync(dir, { recursive: true, force: true });
});

describe("sweep of removed worktrees", () => {
  it("S4: deletes only the device of a worktree whose folder is gone", async () => {
    const live = join(dir, "live");
    mkdirSync(live);
    const gone = join(dir, "gone");
    seed([
      dev(`${PREFIX} ${D} base`),
      dev(`${PREFIX} ${D} wt-live`),
      dev(`${PREFIX} ${D} wt-gone`),
      dev(`${PREFIX} ${D} wt-unknown`),
      dev(`${PREFIX} ${D} wt-watched`, "Booted"),
      dev(`My own ${D} wt-gone`),
      dev("iPhone 17 Pro"),
    ]);
    const set = new DeviceSet();
    await set.rememberFolder("wt-live", live);
    await set.rememberFolder("wt-gone", gone);
    await set.rememberFolder("wt-watched", gone);
    set.hasLiveStream = (udid) => udid === `U-${PREFIX} ${D} wt-watched`;
    const deleted = await set.sweepRemoved();
    assert.deepEqual(deleted, [`${PREFIX} ${D} wt-gone`]);
    assert.deepEqual(names(), [
      "My own – wt-gone",
      "iPhone 17 Pro",
      `${PREFIX} ${D} base`,
      `${PREFIX} ${D} wt-live`,
      `${PREFIX} ${D} wt-unknown`,
      `${PREFIX} ${D} wt-watched`,
    ].sort());
  });

  it("S5: a new service instance finds a removed worktree's device by folder", async () => {
    const folder = join(dir, "wt-restart");
    seed([dev(`${PREFIX} ${D} wt-restart`), dev(`${PREFIX} ${D} other`)]);
    const before = new DeviceSet();
    await before.rememberFolder("wt-restart", folder);
    // A restart: a fresh DeviceSet reads the index from the state dir.
    const after = new DeviceSet();
    for (const key of await after.keysAt(folder)) await after.deleteWorktree(key);
    assert.deepEqual(names(), [`${PREFIX} ${D} other`]);
    assert.deepEqual(await after.keysAt(folder), []);
    assert.equal(existsSync(join(state, "worktrees.json")), true);
  });
});
