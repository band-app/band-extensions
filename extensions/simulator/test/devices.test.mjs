import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setStateDir } from "../src/config.ts";
import { AndroidBackend, avdPrefix, inputTextArg, parseAdbDevices, parseAvdConfig } from "../src/android.ts";
import { DeviceSet } from "../src/devices.ts";
import { Fleet, NoRoom } from "../src/fleet.ts";
import { makeAndroidSdk, script } from "./fakes.mjs";

// Stand-ins for xcrun, adb, emulator and avdmanager are scripts on disk. They keep their state in
// JSON files, so the tests run without Xcode or an Android SDK, and nothing touches a real device.
const PREFIX = `band-test-${Math.floor(Date.now() / 1000).toString(36)}-${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), "sim-devices-"));
const oldEnv = { ...process.env };

after(() => {
  process.env = oldEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("parsers", () => {
  it("reads adb devices -l", () => {
    const out = parseAdbDevices(
      "List of devices attached\nemulator-5554          device product:sdk_gphone64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\nR58M123ABC             device usb:1-1 product:x model:Pixel_7 device:y transport_id:2\nR5000                  unauthorized usb:2\n\n",
    );
    assert.deepEqual(out.map((d) => [d.serial, d.state, d.model]), [
      ["emulator-5554", "device", "sdk gphone64 arm64"],
      ["R58M123ABC", "device", "Pixel 7"],
      ["R5000", "unauthorized", undefined],
    ]);
  });

  it("reads an AVD config and fits the prefix to what an AVD name allows", () => {
    assert.deepEqual(parseAvdConfig("hw.device.name=pixel_8\nimage.sysdir.1=system-images/android-35/google_apis/arm64-v8a/\ntag.id=google_apis\n"), {
      api: 35,
      model: "Pixel 8",
      tag: "google_apis",
    });
    assert.equal(avdPrefix("Band"), "Band-");
    assert.equal(avdPrefix("my prefix!"), "my-prefix-");
  });

  it("quotes typed text for the device shell and refuses what input text cannot type", () => {
    assert.equal(inputTextArg("hi there"), "'hi%sthere'");
    assert.equal(inputTextArg("it's"), `'it'\\''s'`);
    assert.throws(() => inputTextArg("café"));
  });
});

describe("iOS devices with a stand-in simctl", () => {
  const devicesFile = join(dir, "ios-devices.json");
  before(() => {
    process.env.BAND_SIMULATOR_NAME_PREFIX = PREFIX;
    writeFileSync(
      devicesFile,
      JSON.stringify([
        { udid: "U-MINE", name: "iPhone 15", state: "Shutdown", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-15" },
      ]),
    );
    script(
      join(dir, "ios-bin", "xcrun"),
      `const fs = require("node:fs");
const f = ${JSON.stringify(devicesFile)};
const [, cmd, ...rest] = process.argv.slice(2);
const list = JSON.parse(fs.readFileSync(f, "utf8"));
const RT = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
if (cmd === "list" && rest[0] === "devices") console.log(JSON.stringify({ devices: { [RT]: list } }));
else if (cmd === "list" && rest[0] === "runtimes") console.log(JSON.stringify({ runtimes: [
  { identifier: RT, version: "26.5", isAvailable: true, platform: "iOS", supportedDeviceTypes: [
    { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", name: "iPhone 17 Pro", productFamily: "iPhone" },
    { identifier: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-10", name: "Apple Watch 10", productFamily: "Apple Watch" } ] } ] }));
else if (cmd === "create") { const [name, type] = rest; list.push({ udid: "U-" + list.length, name, state: "Shutdown", deviceTypeIdentifier: type }); fs.writeFileSync(f, JSON.stringify(list)); console.log("U-" + (list.length - 1)); }
else if (cmd === "boot") { list.find((d) => d.udid === rest[0]).state = "Booted"; fs.writeFileSync(f, JSON.stringify(list)); }
else if (cmd === "shutdown") { list.find((d) => d.udid === rest[0]).state = "Shutdown"; fs.writeFileSync(f, JSON.stringify(list)); }
else if (cmd === "bootstatus") {}
else { console.error("unexpected " + cmd); process.exit(1); }
`,
    );
    process.env.PATH = `${join(dir, "ios-bin")}:${oldEnv.PATH}`;
    setStateDir(join(dir, "ios-state"));
  });

  it("lists the person's devices and offers only phones and tablets to create", async () => {
    const set = new DeviceSet();
    const list = await set.list();
    assert.deepEqual(list.map((d) => [d.id, d.name, d.os, d.owned, d.state]), [["ios:U-MINE", "iPhone 15", "iOS 26.5", false, "off"]]);
    const options = await set.options();
    assert.deepEqual(options.runtimes[0].deviceTypes.map((t) => t.name), ["iPhone 17 Pro"]);
  });

  it("creates devices named with the prefix, numbering a repeat, and never creates one by itself", async () => {
    const set = new DeviceSet();
    const spec = { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-5", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro" };
    const a = await set.create(spec);
    const b = await set.create(spec);
    assert.equal(a.name, `${PREFIX} – iPhone 17 Pro`);
    assert.equal(b.name, `${PREFIX} – iPhone 17 Pro 2`);
    assert.ok(a.owned && b.owned);
    await assert.rejects(set.create({ ...spec, deviceType: "x" }), /not supported/);
    assert.equal((await set.list()).length, 3);
  });
});

describe("a simctl that hangs", () => {
  it("S1 kills the hung shutdown by its pid and reports the stuck call; a device shutting down is not off", async () => {
    const pidFile = join(dir, "stuck.pid");
    script(
      join(dir, "stuck-bin", "xcrun"),
      `const fs = require("node:fs");
const [, cmd] = process.argv.slice(2);
if (cmd === "list") { console.log(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [{ udid: "U-S", name: "iPhone", state: "Shutting Down" }] } })); }
else { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
`,
    );
    const oldPath = process.env.PATH;
    const oldLimit = process.env.BAND_SIMULATOR_SHUTDOWN_TIMEOUT_MS;
    process.env.PATH = `${join(dir, "stuck-bin")}:${oldPath}`;
    process.env.BAND_SIMULATOR_SHUTDOWN_TIMEOUT_MS = "300";
    try {
      const set = new DeviceSet();
      const [d] = await set.list();
      assert.equal(d.state, "stopping");
      await assert.rejects(set.shutdown(d), /xcrun simctl shutdown.*did not finish in 300 ms/s);
      const pid = Number(readFileSync(pidFile, "utf8"));
      await new Promise((r) => setTimeout(r, 200));
      assert.throws(() => process.kill(pid, 0), "the stuck process is gone");
    } finally {
      process.env.PATH = oldPath;
      if (oldLimit === undefined) delete process.env.BAND_SIMULATOR_SHUTDOWN_TIMEOUT_MS;
      else process.env.BAND_SIMULATOR_SHUTDOWN_TIMEOUT_MS = oldLimit;
    }
  });
});

describe("Android with stand-ins for adb, emulator and avdmanager", () => {
  const { sdk, avdHome, logFile } = makeAndroidSdk(join(dir, "droid"));
  const android = new AndroidBackend();

  before(() => {
    process.env.BAND_SIMULATOR_NAME_PREFIX = PREFIX;
    process.env.ANDROID_HOME = sdk;
    process.env.ANDROID_AVD_HOME = avdHome;
    process.env.PATH = `${join(dir, "empty-bin")}:${oldEnv.PATH}`;
    setStateDir(join(dir, "android-state"));
  });

  const log = () => readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  const clear = () => writeFileSync(logFile, "");

  it("finds the SDK and lists an AVD that is off, with its model and Android version", async () => {
    assert.deepEqual(await android.available(), { ok: true });
    const [d] = await android.list();
    assert.deepEqual([d.id, d.name, d.state, d.model, d.os, d.owned], ["android:avd:Pixel_8", "Pixel_8", "off", "Pixel 8", "Android 15", false]);
  });

  it("explains how to install a system image instead of downloading one", async () => {
    const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
    const before = await android.options();
    assert.equal(before.reason, undefined);
    assert.deepEqual(before.profiles.map((p) => p.id), ["pixel_8", "pixel_6a"]);
    assert.equal(before.images[0].pkg, `system-images;android-35;google_apis;${abi}`);
    const empty = join(dir, "no-images-sdk");
    mkdirSync(empty, { recursive: true });
    process.env.ANDROID_HOME = empty;
    try {
      const none = await android.options();
      assert.match(none.reason ?? "", /ANDROID_HOME|SDK/);
    } finally {
      process.env.ANDROID_HOME = sdk;
    }
  });

  it("creates an AVD named with the prefix, then boots it and waits for boot_completed", async () => {
    const opts = await android.options();
    const d = await android.create({ profile: "pixel_6a", image: opts.images[0].pkg });
    assert.equal(d.name, `${avdPrefix(PREFIX)}pixel_6a`);
    assert.ok(d.owned);
    await assert.rejects(android.create({ profile: "../x", image: opts.images[0].pkg }), /profile/);
    const target = (await android.list()).find((x) => x.name === "Pixel_8");
    const booted = await android.boot(target);
    assert.equal(booted.state, "on");
    assert.ok(log().some((l) => l.startsWith("emulator -avd Pixel_8 -no-window")));
    assert.equal((await android.list()).find((x) => x.name === "Pixel_8").state, "on");
  });

  it("streams JPEG frames and turns touches into taps and swipes", { skip: !existsSync("/usr/bin/sips") }, async () => {
    const d = (await android.list()).find((x) => x.name === "Pixel_8");
    clear();
    const stream = await android.openStream(d, { profile: "direct" });
    const it = stream.output[Symbol.asyncIterator]();
    const info = JSON.parse((await it.next()).value);
    assert.deepEqual([info.type, info.platform, info.width, info.height], ["info", "android", 1080, 2400]);
    const frame = (await it.next()).value;
    assert.deepEqual([...frame.subarray(0, 2)], [0xff, 0xd8]);
    stream.write(JSON.stringify({ type: "touch", phase: "begin", x: 0.5, y: 0.5 }));
    stream.write(JSON.stringify({ type: "touch", phase: "end", x: 0.5, y: 0.5 }));
    stream.write(JSON.stringify({ type: "touch", phase: "begin", x: 0.25, y: 0.25 }));
    stream.write(JSON.stringify({ type: "touch", phase: "end", x: 0.75, y: 0.25 }));
    stream.write(JSON.stringify({ type: "button", name: "HOME" }));
    stream.write(JSON.stringify({ type: "key", key: "Enter" }));
    for (let i = 0; i < 40 && log().length < 4; i++) await new Promise((r) => setTimeout(r, 100));
    stream.close();
    const lines = log();
    // The stand-in screenshot is 100x200 pixels, so the fractions map onto that.
    assert.deepEqual(lines.slice(0, 4).map((l) => l.replace(/(swipe .*) \d+$/, "$1 <ms>")), [
      "emulator-5554 shell input tap 50 100",
      "emulator-5554 shell input swipe 25 50 75 50 <ms>",
      "emulator-5554 shell input keyevent 3",
      "emulator-5554 shell input keyevent 66",
    ]);
  });

  it("turns the emulator off", async () => {
    const d = (await android.list()).find((x) => x.name === "Pixel_8");
    await android.shutdown(d);
    assert.equal((await android.list()).find((x) => x.name === "Pixel_8").state, "off");
    await android.stopAll();
  });
});

describe("Fleet limits", () => {
  const dev = (id, owned, state = "off", platform = "ios") => ({ id, platform, name: id, state, os: "x", owned });
  function stubBackend(platform, devices, max) {
    const calls = [];
    return {
      calls,
      platform,
      maxBooted: () => max,
      available: async () => ({ ok: true }),
      list: async () => devices.map((d) => ({ ...d })),
      boot: async (d) => {
        devices.find((x) => x.id === d.id).state = "on";
        calls.push(`boot ${d.id}`);
        return { ...d, state: "on" };
      },
      shutdown: async (d) => {
        devices.find((x) => x.id === d.id).state = "off";
        calls.push(`shutdown ${d.id}`);
      },
      release: async () => {},
      stopAll: async () => {},
    };
  }

  it("shuts down the least recently used of Band's own devices first, and never the person's", async () => {
    const devices = [dev("ios:a", true, "on"), dev("ios:b", true, "on"), dev("ios:mine", false, "on"), dev("ios:c", true)];
    const ios = stubBackend("ios", devices, 2);
    const fleet = new Fleet({ ios, android: stubBackend("android", [], 2) });
    fleet.touch("ios:b");
    await new Promise((r) => setTimeout(r, 5));
    fleet.touch("ios:a");
    await fleet.ensureOn(devices.find((d) => d.id === "ios:c"));
    assert.deepEqual(ios.calls, ["shutdown ios:b", "boot ios:c"]);
    assert.equal(devices.find((d) => d.id === "ios:mine").state, "on");
  });

  it("shuts down a device the person booted only after Band booted it, and keeps platforms apart", async () => {
    const devices = [dev("ios:mine", false), dev("ios:d", false), dev("ios:e", false)];
    const ios = stubBackend("ios", devices, 1);
    const droid = [dev("android:avd:A", true, "on", "android"), dev("android:avd:B", true, "off", "android")];
    const android = stubBackend("android", droid, 2);
    const fleet = new Fleet({ ios, android });
    await fleet.ensureOn(devices[0]);
    await fleet.ensureOn(devices[1]);
    assert.deepEqual(ios.calls, ["boot ios:mine", "shutdown ios:mine", "boot ios:d"]);
    await fleet.ensureOn(droid[1]);
    assert.deepEqual(android.calls, ["boot android:avd:B"]);
  });

  describe("lifecycle limits", () => {
    const hang = () => new Promise(() => {});
    const withEnv = async (vars, fn) => {
      const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
      Object.assign(process.env, vars);
      try {
        await fn();
      } finally {
        for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      }
    };

    it("S1 abandons a shutdown that never returns and lets the queue move on", async () => {
      await withEnv({ BAND_SIMULATOR_SHUTDOWN_TIMEOUT_MS: "100" }, async () => {
        const devices = [dev("ios:a", true, "on"), dev("ios:b", true, "on"), dev("ios:c", true)];
        const ios = stubBackend("ios", devices, 2);
        ios.shutdown = hang;
        const fleet = new Fleet({ ios, android: stubBackend("android", [], 2) });
        await assert.rejects(fleet.exclusive(() => fleet.ensureOn(devices[2])), /Shutting down ios:a did not finish in 100 ms.*abandoned.*simctl shutdown/s);
        let ran = false;
        await fleet.exclusive(async () => (ran = true));
        assert.ok(ran, "the queue moved on");
      });
    });

    it("S5 abandons a boot that hangs", async () => {
      await withEnv({ BAND_SIMULATOR_BOOT_TIMEOUT_MS: "100", BAND_SIMULATOR_BOOT_TIMEOUT_ANDROID_MS: "100" }, async () => {
        for (const platform of ["ios", "android"]) {
          const devices = [dev(`${platform}:x`, true, "off", platform)];
          const backend = stubBackend(platform, devices, 2);
          backend.boot = hang;
          const fleet = new Fleet({ ios: stubBackend("ios", [], 2), android: stubBackend("android", [], 2), [platform]: backend });
          await assert.rejects(fleet.ensureOn(devices[0]), /Booting .* did not finish in 100 ms and was abandoned/);
        }
      });
    });

    it("S2 neither counts nor picks a device that is booting or shutting down", async () => {
      const devices = [dev("ios:a", true, "on"), dev("ios:stop", true, "stopping"), dev("ios:start", true, "booting"), dev("ios:c", true)];
      const ios = stubBackend("ios", devices, 2);
      const fleet = new Fleet({ ios, android: stubBackend("android", [], 2) });
      await fleet.ensureOn(devices[3]);
      assert.deepEqual(ios.calls, ["boot ios:c"]);
      const droid = [dev("android:avd:A", true, "booting", "android"), dev("android:avd:B", true, "on", "android"), dev("android:avd:C", true, "off", "android")];
      const android = stubBackend("android", droid, 2);
      await new Fleet({ ios: stubBackend("ios", [], 2), android }).ensureOn(droid[2]);
      assert.deepEqual(android.calls, ["boot android:avd:C"]);
    });

    it("refuses to start a device that is shutting down", async () => {
      const devices = [dev("ios:stop", true, "stopping")];
      const fleet = new Fleet({ ios: stubBackend("ios", devices, 2), android: stubBackend("android", [], 2) });
      await assert.rejects(fleet.ensureOn(devices[0]), /is shutting down/);
    });

    it("S3 never shuts down a shown device and says which ones are shown", async () => {
      const devices = [dev("ios:a", true, "on"), dev("ios:b", true, "on"), dev("ios:c", true)];
      const ios = stubBackend("ios", devices, 2);
      const fleet = new Fleet({ ios, android: stubBackend("android", [], 2) });
      fleet.isWatched = () => true;
      await assert.rejects(fleet.ensureOn(devices[2]), (err) => err instanceof NoRoom && err.shown.map((d) => d.id).join() === "ios:a,ios:b" && /Shut one down/.test(err.message));
      assert.deepEqual(ios.calls, []);
      // Shutting one down (the pane's button) makes room.
      await fleet.turnOff(devices[0]);
      await fleet.ensureOn(devices[2]);
      assert.deepEqual(ios.calls, ["shutdown ios:a", "boot ios:c"]);
    });

    it("S3 shuts down an unwatched device before giving up on a watched one", async () => {
      const devices = [dev("ios:a", true, "on"), dev("ios:b", true, "on"), dev("ios:c", true)];
      const ios = stubBackend("ios", devices, 2);
      const fleet = new Fleet({ ios, android: stubBackend("android", [], 2) });
      fleet.isWatched = (id) => id === "ios:a";
      await fleet.ensureOn(devices[2]);
      assert.deepEqual(ios.calls, ["shutdown ios:b", "boot ios:c"]);
    });

    it("S4 streams a device that is on without waiting for a stuck shutdown in the queue", async () => {
      const devices = [dev("ios:on", true, "on"), dev("ios:off", true)];
      const fleet = new Fleet({ ios: stubBackend("ios", devices, 2), android: stubBackend("android", [], 2) });
      void fleet.exclusive(hang);
      const got = await Promise.race([fleet.open("ios:on"), new Promise((r) => setTimeout(() => r("waited"), 500))]);
      assert.equal(got.id, "ios:on");
      assert.equal(await Promise.race([fleet.open("ios:off"), new Promise((r) => setTimeout(() => r("waited"), 200))]), "waited");
    });
  });

  it("resolves a device by id or by name and refuses an ambiguous name", async () => {
    const ios = stubBackend("ios", [{ ...dev("ios:1", false), name: "iPhone" }, { ...dev("ios:2", false), name: "iphone" }, { ...dev("ios:3", false), name: "Solo" }], 2);
    const fleet = new Fleet({ ios, android: stubBackend("android", [], 2) });
    assert.equal((await fleet.find("ios:1")).id, "ios:1");
    assert.equal((await fleet.find("solo")).id, "ios:3");
    await assert.rejects(fleet.find("iPhone"), /names 2 devices/);
    await assert.rejects(fleet.find("nope"), /No device/);
  });
});
