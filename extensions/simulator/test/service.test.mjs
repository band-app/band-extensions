import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { readFileSync as read } from "node:fs";
import { encodeStreamFrame, StreamFrameReader } from "../src/sdk/protocol.mjs";
import { makeAndroidSdk, script } from "./fakes.mjs";

// The real service process, speaking Band's stdio protocol, with stand-ins for xcrun, adb,
// emulator and avdmanager. It checks `show`, the tools that remain, and what an open tab is told.
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

const p = (id, device = null) => ({ type: "pane", id, device });
const ref = (id, platform, name) => ({ id, platform, name });
const PIXEL8 = ref("android:avd:Pixel_8", "android", "Pixel_8");
const text = (res) => res.content[0].text;
const setState = (entries) => writeFileSync(droid.stateFile, JSON.stringify(entries));
const manifest = JSON.parse(read(new URL("../band-extension.json", import.meta.url), "utf8"));

describe("the manifest", () => {
  it("contributes exactly devices, status and show, each backed by a method the service has", async () => {
    const tools = manifest.contributes.tools;
    assert.deepEqual(tools.map((t) => t.name), ["devices", "status", "show"]);
    // The service's method table: the three methods answer, the removed ones do not exist.
    assert.deepEqual(tools.map((t) => t.method), ["list", "status", "show"]);
    await call("list");
    await call("status");
    await assert.rejects(call("show", { device: "nothing" }), /No device has the id or name/);
    for (const gone of ["tap", "type", "button", "openUrl", "install", "launch", "describe", "screenshot"]) {
      await assert.rejects(call(gone, {}), /./, gone);
    }
  });

  it("tells an agent to call simulator_show after booting, installing or launching", () => {
    const show = manifest.contributes.tools.find((t) => t.name === "show").description;
    assert.match(show, /After you boot a simulator or emulator, or install or launch an app on one, call simulator_show/);
    assert.match(show, /xcrun simctl list devices booted/);
    assert.match(show, /adb devices/);
    assert.match(show, /band tools call simulator_show --json/);
    assert.match(read(new URL("../README.md", import.meta.url), "utf8"), /band tools call simulator_show --json/);
  });
});

describe("the service", () => {
  it("lists the devices of both platforms and says none is focused", async () => {
    const res = await call("list");
    assert.equal(res.focused, null);
    assert.deepEqual(res.devices.map((d) => d.id).sort(), ["android:avd:Pixel_6", "android:avd:Pixel_8", "ios:U-MINE"]);
  });

  it("with no device named and no pane open, status answers with the list and boots nothing", async () => {
    const res = await call("status");
    assert.match(text(res), /No device is open in this worktree's Simulator tab/);
    assert.match(text(res), /android:avd:Pixel_8/);
    assert.deepEqual(adbLog(), []);
  });

  it("show with an unknown device is an error that lists the devices", async () => {
    await assert.rejects(call("show", { device: "nope" }), (e) => /No device has the id or name "nope"/.test(e.message) && /Devices on this worker/.test(e.message) && /ios:U-MINE/.test(e.message) && /android:avd:Pixel_6/.test(e.message));
    assert.deepEqual(await call("layout"), { layout: null, from: null });
  });

  it("show with nothing saved makes a single-pane layout, and takes a UDID", async () => {
    const res = await call("show", { device: "U-MINE" });
    assert.match(text(res), /Showing iPhone 15 in pane 1 of 1 of the Simulator tab\. The tab shows it when it opens\./);
    assert.deepEqual((await call("layout")).layout, p("p1", ref("ios:U-MINE", "ios", "iPhone 15")));
    assert.match(text(await call("show", { device: "iPhone 15" })), /already shown in pane 1 of 1/);
  });

  it("show takes an adb serial of a running emulator and the first pane when none is focused", async () => {
    await call("saveLayout", { layout: { type: "split", dir: "row", ratio: 0.5, a: p("p1", ref("ios:U-MINE", "ios", "iPhone 15")), b: p("p2") } });
    setState([{ serial: "emulator-5554", avd: "Pixel_8" }]);
    const res = await call("show", { device: "emulator-5554" });
    assert.match(text(res), /Showing Pixel_8 in pane 1 of 2/);
    const layout = (await call("layout")).layout;
    assert.deepEqual([layout.a.device.id, layout.b.device], ["android:avd:Pixel_8", null]);
    setState([]);
  });

  it("show uses the pane of the stream focused last", { skip: !HAS_SIPS }, async () => {
    await call("saveLayout", { layout: { type: "split", dir: "row", ratio: 0.5, a: p("p1"), b: p("p2", PIXEL8) } });
    await openStream(1, PIXEL8.id);
    await until(() => hasFrame(1), "the pane's frame");
    const res = await call("show", { device: "ios:U-MINE" });
    assert.match(text(res), /Showing iPhone 15 in pane 2 of 2/);
    assert.equal((await call("layout")).layout.b.device.id, "ios:U-MINE");
    await request("stream.close", { streamId: 1 });
  });
});

describe("what an open tab is told", () => {
  const layout = { type: "split", dir: "row", ratio: 0.5, a: p("p1", ref("ios:U-MINE", "ios", "iPhone 15")), b: p("p2") };
  const tab = (args = {}) => call("events", { shown: ["ios:U-MINE"], focus: "p1", ...args });

  it("a show reaches the open tab as an event, in the pane the tab reported as focused", async () => {
    await call("saveLayout", { layout });
    const first = await tab({ focus: "p2" });
    assert.deepEqual(first.events, []);
    const res = await call("show", { device: "Pixel_6" });
    assert.match(text(res), /Showing Pixel_6 in pane 2 of 2 of the Simulator tab\. The open tab switched to it\./);
    const next = await tab({ since: first.seq, focus: "p2" });
    assert.equal(next.events.length, 1);
    assert.deepEqual([next.events[0].type, next.events[0].paneId, next.events[0].device.id], ["show", "p2", "android:avd:Pixel_6"]);
    assert.equal(next.events[0].layout.b.device.id, "android:avd:Pixel_6");
  });

  it("a device that starts is offered once, never shown on its own, and withdrawn when it turns off", async () => {
    await call("saveLayout", { layout });
    setState([]);
    await new Promise((r) => setTimeout(r, 2100));
    let seen = await tab({ shown: ["ios:U-MINE"] });
    await new Promise((r) => setTimeout(r, 2100));
    setState([{ serial: "emulator-5554", avd: "Pixel_8" }]);
    seen = await tab({ since: seen.seq });
    assert.deepEqual(seen.events.map((e) => [e.type, e.device?.id]), [["offer", "android:avd:Pixel_8"]]);
    assert.equal(seen.events[0].device.name, "Pixel_8");
    assert.equal((await call("layout")).layout.b.device, null, "the layout is untouched");
    await new Promise((r) => setTimeout(r, 2100));
    const again = await tab({ since: seen.seq });
    assert.deepEqual(again.events, [], "no second offer for the same run");
    setState([]);
    await new Promise((r) => setTimeout(r, 2100));
    const off = await tab({ since: again.seq });
    assert.deepEqual(off.events.map((e) => [e.type, e.id]), [["withdraw", "android:avd:Pixel_8"]]);
  });

  it("a device already shown in a pane is not offered", async () => {
    setState([]);
    await new Promise((r) => setTimeout(r, 2100));
    let seen = await tab({ shown: ["android:avd:Pixel_8"] });
    await new Promise((r) => setTimeout(r, 2100));
    setState([{ serial: "emulator-5554", avd: "Pixel_8" }]);
    seen = await tab({ since: seen.seq, shown: ["android:avd:Pixel_8"] });
    assert.deepEqual(seen.events, []);
    setState([]);
  });
});
