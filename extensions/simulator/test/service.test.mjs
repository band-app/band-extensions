import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { encodeStreamFrame, StreamFrameReader } from "../src/sdk/protocol.mjs";
import { makeAndroidSdk, script } from "./fakes.mjs";

// The real service process, speaking Band's stdio protocol, with stand-ins for xcrun, adb,
// emulator and avdmanager. It shows which device an agent tool acts on.
const dir = mkdtempSync(join(tmpdir(), "sim-service-"));
const PREFIX = `band-test-${Math.floor(Date.now() / 1000).toString(36)}-${process.pid}`;
const droid = makeAndroidSdk(join(dir, "droid"), ["Pixel_8", "Pixel_6"]);
// The Android stream turns PNGs into JPEGs with sips, which exists only on macOS (the only system the service runs on).
const HAS_SIPS = existsSync("/usr/bin/sips");
const WT = { worktreeKey: "wt-1", worktreePath: dir };

let child;
let nextId = 1;
const pending = new Map();
const frames = [];
let out = "";

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const call = (method, params = {}, scope = WT) => request("call", { method, params, ...scope });
const adbLog = () => readFileSync(droid.logFile, "utf8").trim().split("\n").filter(Boolean);
const clearLog = () => writeFileSync(droid.logFile, "");
const until = async (fn, what) => {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};
const openStream = async (streamId, device) => {
  await request("stream.open", { streamId, name: "screen", params: { device, profile: "direct" }, ...WT });
};
const sendToStream = (streamId, message) => child.stdio[3].write(encodeStreamFrame(streamId, JSON.stringify(message)));
const texts = (streamId) => frames.filter((f) => f.streamId === streamId && typeof f.message === "string").map((f) => JSON.parse(f.message));
const hasFrame = (streamId) => frames.some((f) => f.streamId === streamId && typeof f.message !== "string");

before(async () => {
  script(
    join(dir, "bin", "xcrun"),
    `const a = process.argv.slice(2);
if (a[1] === "list" && a[2] === "devices") console.log(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "U-MINE", name: "iPhone 15", state: "Shutdown", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15" }] } }));
else if (a[1] === "help") console.log("ok");
else process.exit(1);
`,
  );
  mkdirSync(join(dir, "state"));
  const reader = new StreamFrameReader();
  child = spawn(process.execPath, [new URL("../src/service.ts", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "inherit", "pipe"],
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      HOME: dir,
      BAND_SIMULATOR_NAME_PREFIX: PREFIX,
      ANDROID_HOME: droid.sdk,
      ANDROID_AVD_HOME: droid.avdHome,
    },
  });
  child.stdout.on("data", (chunk) => {
    out += chunk;
    for (;;) {
      const i = out.indexOf("\n");
      if (i < 0) break;
      const msg = JSON.parse(out.slice(0, i));
      out = out.slice(i + 1);
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  child.stdio[3].on("data", (chunk) => frames.push(...reader.push(chunk)));
  await request("init", { worker: "w", version: "0", serviceId: "main", stateDir: join(dir, "state") });
});

after(async () => {
  await request("stop", {}).catch(() => undefined);
  child.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("the service", () => {
  it("lists the devices of both platforms and says none is focused", async () => {
    const res = await call("list");
    assert.equal(res.focused, null);
    assert.deepEqual(res.devices.map((d) => d.id).sort(), ["android:avd:Pixel_6", "android:avd:Pixel_8", "ios:U-MINE"]);
  });

  it("with no device named and no pane open, a tool answers with the list and creates and boots nothing", async () => {
    const res = await call("screenshot");
    const text = res.content[0].text;
    assert.match(text, /No device is open in this worktree's Simulator tab/);
    assert.match(text, /Pass `device`/);
    assert.match(text, /android:avd:Pixel_8/);
    assert.match(text, /ios:U-MINE/);
    assert.deepEqual(adbLog(), []);
    assert.equal(JSON.parse(readFileSync(droid.stateFile, "utf8")).length, 0);
  });

  it("stores the canvas and restores it, and refuses more than 4 panes", async () => {
    assert.deepEqual(await call("layout"), { layout: null, from: null });
    const layout = { type: "pane", id: "p1", device: { id: "android:avd:Pixel_8", platform: "android", name: "Pixel_8" } };
    await call("saveLayout", { layout });
    assert.deepEqual((await call("layout")).layout, layout);
    const p = (id) => ({ type: "pane", id, device: null });
    const s = (a, b) => ({ type: "split", dir: "row", ratio: 0.5, a, b });
    await assert.rejects(call("saveLayout", { layout: s(s(p("a"), p("b")), s(p("c"), s(p("d"), p("e")))) }), /at most 4 panes/);
  });

  it("a tool with `device` boots and acts on that device, found by name or by id", async () => {
    clearLog();
    await call("tap", { x: 10, y: 20, device: "pixel_8" });
    assert.ok(adbLog().some((l) => l.startsWith("emulator -avd Pixel_8")));
    assert.ok(adbLog().includes("emulator-5554 shell input tap 10 20"));
    const tree = await call("describe", { device: "android:avd:Pixel_8" });
    assert.deepEqual(tree.elements.map((e) => e.label), ["OK"]);
    await assert.rejects(call("tap", { x: 1, y: 1, device: "no such device" }), /No device has the id or name/);
  });

  it("without `device` a tool acts on the pane focused last, and `device` still wins", { skip: !HAS_SIPS }, async () => {
    await openStream(1, "android:avd:Pixel_8");
    await until(() => hasFrame(1), "the first pane's frame");
    assert.equal(texts(1).find((t) => t.type === "info").platform, "android");
    clearLog();
    await call("tap", { x: 1, y: 2 });
    assert.deepEqual(adbLog(), ["emulator-5554 shell input tap 1 2"]);

    await openStream(2, "android:avd:Pixel_6");
    await until(() => hasFrame(2), "the second pane's frame");
    // The second pane opened last, so it is the focused one until the person presses the first.
    clearLog();
    await call("tap", { x: 3, y: 4 });
    assert.deepEqual(adbLog(), ["emulator-5556 shell input tap 3 4"]);

    sendToStream(1, { type: "focus" });
    await new Promise((r) => setTimeout(r, 300));
    clearLog();
    await call("tap", { x: 5, y: 6 });
    await call("tap", { x: 7, y: 8, device: "Pixel_6" });
    assert.deepEqual(adbLog(), ["emulator-5554 shell input tap 5 6", "emulator-5556 shell input tap 7 8"]);
    assert.equal((await call("list")).focused, "android:avd:Pixel_8");
  });

  it("keyboard and touch from a pane reach only its own device", { skip: !HAS_SIPS }, async () => {
    clearLog();
    sendToStream(2, { type: "key", key: "Enter" });
    sendToStream(1, { type: "button", name: "BACK" });
    await until(() => adbLog().length >= 2, "the input");
    assert.deepEqual(adbLog().sort(), ["emulator-5554 shell input keyevent 4", "emulator-5556 shell input keyevent 66"]);
  });

  it("turning a device off tells its pane, and closing the focused pane moves the focus", { skip: !HAS_SIPS }, async () => {
    await call("shutdown", { device: "android:avd:Pixel_6" });
    await until(() => texts(2).some((t) => t.type === "off"), "the off message");
    await request("stream.close", { streamId: 2 });
    clearLog();
    await call("tap", { x: 9, y: 9 });
    assert.deepEqual(adbLog(), ["emulator-5554 shell input tap 9 9"]);
  });

  it("with the last pane closed, a tool without `device` answers with the list again", async () => {
    await request("stream.close", { streamId: 1 });
    const res = await call("tap", { x: 1, y: 1 });
    assert.match(res.content[0].text, /No device is open/);
  });
});
