import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { config, setStateDir } from "../src/config.ts";
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
    assert.equal(streamProfile({}), "direct");
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
