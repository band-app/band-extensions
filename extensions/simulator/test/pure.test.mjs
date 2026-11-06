import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { config, setStateDir } from "../src/config.ts";
import { ensureOpenShim, openShimScript } from "../src/shim.ts";
import { compactTree } from "../src/servesim.ts";
import { jpegSize, mjpegFrames, serveSimButton, streamProfile } from "../src/stream.ts";

describe("compactTree", () => {
  it("keeps elements with a label, a value or a control type, with a tap point in points", () => {
    const tree = [
      {
        type: "Application",
        frame: { x: 0, y: 0, width: 402, height: 874 },
        children: [
          { type: "StaticText", AXLabel: "Hello", frame: { x: 10, y: 20, width: 100, height: 20 } },
          { type: "Button", AXLabel: "OK", AXUniqueId: "ok", frame: { x: 100, y: 200, width: 60, height: 40 }, enabled: false },
          { type: "Other", frame: { x: 0, y: 0, width: 5, height: 5 } },
          { type: "Switch", frame: { x: 0, y: 0, width: 0, height: 10 } },
        ],
      },
    ];
    const out = compactTree(tree);
    assert.deepEqual(
      out.map((e) => [e.type, e.label, e.id, e.enabled, e.center]),
      [
        ["StaticText", "Hello", undefined, true, { x: 60, y: 30 }],
        ["Button", "OK", "ok", false, { x: 130, y: 220 }],
      ],
    );
  });
});

describe("serve-sim stream parsing", () => {
  const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 1), Buffer.from([0xff, 0xd9])]);
  const part = (frame) =>
    Buffer.concat([Buffer.from(`--b\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`), frame, Buffer.from("\r\n")]);

  it("splits a multipart MJPEG body by Content-Length, even when chunks cut a part", async () => {
    const a = jpeg(10);
    const b = jpeg(300);
    const body = Buffer.concat([part(a), part(b)]);
    async function* chunks() {
      for (let i = 0; i < body.length; i += 7) yield body.subarray(i, i + 7);
    }
    const got = [];
    for await (const f of mjpegFrames(chunks())) got.push(f);
    assert.equal(got.length, 2);
    assert.ok(got[0].equals(a) && got[1].equals(b));
  });

  it("reads a JPEG's size from its start-of-frame marker", () => {
    const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x04, 0xb6, 0x02, 0xd6, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    assert.deepEqual(jpegSize(sof), { width: 726, height: 1206 });
    assert.equal(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  });

  it("maps button names and profiles", () => {
    assert.equal(serveSimButton("HOME"), "home");
    assert.equal(serveSimButton("SIDE_BUTTON"), "side_button");
    assert.throws(() => serveSimButton("POWER"), /must be one of/);
    assert.equal(streamProfile({ profile: "hub" }), "hub");
    assert.equal(streamProfile({ profile: "direct" }), "direct");
    // A stream with no profile (or an unknown one) gets the cheaper half-size profile.
    assert.equal(streamProfile({}), "hub");
    assert.equal(streamProfile(null), "hub");
  });
});

describe("config", () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-config-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults, then config.json in the state dir, read on every call, then the environment", () => {
    const keys = ["BAND_SIMULATOR_NAME_PREFIX", "BAND_SIMULATOR_MAX_BOOTED"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      setStateDir(dir);
      assert.deepEqual([config().namePrefix, config().maxBooted], ["Band", 2]);
      process.env.BAND_SIMULATOR_NAME_PREFIX = "Env";
      process.env.BAND_SIMULATOR_MAX_BOOTED = "3";
      assert.deepEqual([config().namePrefix, config().maxBooted], ["Env", 3]);
      writeFileSync(join(dir, "config.json"), JSON.stringify({ namePrefix: "File", maxBooted: 1 }));
      assert.deepEqual([config().namePrefix, config().maxBooted], ["File", 1]);
      writeFileSync(join(dir, "config.json"), JSON.stringify({ maxBooted: 0 }));
      assert.deepEqual([config().namePrefix, config().maxBooted], ["Env", 3]);
      writeFileSync(join(dir, "config.json"), "not json");
      assert.equal(config().namePrefix, "Env");
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("the open shim", () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-shim-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  // A stand-in for /usr/bin/open that records its arguments, one per line.
  const fake = join(dir, "real-open");
  const log = join(dir, "calls.log");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
  const shim = join(dir, "open");
  writeFileSync(shim, openShimScript(fake), { mode: 0o755 });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

  it("turns `open -a Simulator` into `open -gj -a Simulator`", () => {
    rmSync(log, { force: true });
    execFileSync(shim, ["-a", "Simulator"]);
    assert.deepEqual(calls(), ["-gj -a Simulator"]);
  });

  it("does the same when serve-sim passes arguments or names the app by path or bundle id", () => {
    for (const args of [
      ["-a", "Simulator", "--args", "-CurrentDeviceUDID", "X"],
      ["/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"],
      ["-b", "com.apple.iphonesimulator"],
    ]) {
      rmSync(log, { force: true });
      execFileSync(shim, args);
      assert.deepEqual(calls(), ["-gj -a Simulator"], args.join(" "));
    }
  });

  it("passes every other call through unchanged", () => {
    rmSync(log, { force: true });
    execFileSync(shim, ["-a", "Safari", "https://example.com"]);
    execFileSync(shim, ["-n", "/tmp/file.txt"]);
    assert.deepEqual(calls(), ["-a Safari https://example.com", "-n /tmp/file.txt"]);
  });

  it("ensureOpenShim writes an executable open into the folder it is given", () => {
    const where = join(dir, "state", "bin");
    assert.equal(ensureOpenShim(where), where);
    assert.equal(readFileSync(join(where, "open"), "utf8"), openShimScript());
    assert.ok(statSync(join(where, "open")).mode & 0o100);
  });
});
