import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { HUB_MAX_FPS, jpegSize, Latest, pumpLatest, scaleFrame } from "../src/stream.ts";

const fixture = () =>
  sharp({ create: { width: 726, height: 1206, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .jpeg({ quality: 90 })
    .toBuffer();

describe("hub frame encoder", () => {
  it("halves a JPEG in process", async () => {
    const out = await scaleFrame(await fixture());
    assert.deepEqual(jpegSize(out), { width: 363, height: 603 });
  });

  it("returns the input when it is not a decodable JPEG", async () => {
    const junk = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02]);
    assert.equal(await scaleFrame(junk), junk);
  });
});

describe("pumpLatest", () => {
  it("keeps one frame in flight, drops older ones and never exceeds the rate", async () => {
    const source = new Latest();
    const sink = new Latest();
    let inFlight = 0;
    let maxInFlight = 0;
    const encoded = [];
    const encode = async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40)); // slower than the 15 fps budget
      inFlight--;
      encoded.push(n);
      return n;
    };
    const done = pumpLatest(source, sink, encode, HUB_MAX_FPS);
    const received = [];
    const times = [];
    const reader = (async () => {
      for await (const n of sink) {
        received.push(n);
        times.push(Date.now());
        await new Promise((r) => setTimeout(r, 120)); // a slow viewer
      }
    })();
    const started = Date.now();
    let produced = 0;
    while (Date.now() - started < 1000) {
      source.push(produced++); // 60 fps
      await new Promise((r) => setTimeout(r, 1000 / 60));
    }
    source.end();
    await done;
    await reader;
    assert.equal(maxInFlight, 1);
    assert.ok(produced > 40);
    assert.ok(encoded.length < produced / 2, `encoded ${encoded.length} of ${produced}`);
    assert.deepEqual(encoded, [...encoded].sort((a, b) => a - b));
    // Frames that reach the viewer are always newer than the one before.
    assert.deepEqual(received, [...received].sort((a, b) => a - b));
    for (let i = 1; i < encoded.length; i++) assert.ok(encoded[i] > encoded[i - 1]);
  });

  it("spaces output at least 1/HUB_MAX_FPS apart", async () => {
    const source = new Latest();
    const sink = new Latest();
    const stamps = [];
    const done = pumpLatest(source, sink, async (n) => {
      stamps.push(Date.now());
      return n;
    });
    const drain = (async () => {
      for await (const _ of sink);
    })();
    const started = Date.now();
    while (Date.now() - started < 600) {
      source.push(1);
      await new Promise((r) => setTimeout(r, 5));
    }
    source.end();
    await done;
    await drain;
    for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i] - stamps[i - 1] >= 1000 / HUB_MAX_FPS - 3);
    const span = stamps.at(-1) - stamps[0];
    assert.ok(stamps.length <= Math.floor((span * HUB_MAX_FPS) / 1000) + 2, `${stamps.length} frames in ${span} ms`);
  });
});

describe("openScreenStream hub profile", () => {
  it("serves half-size frames from an MJPEG source and full-size ones on direct", async () => {
    const { createServer } = await import("node:http");
    const { openScreenStream } = await import("../src/stream.ts");
    const jpeg = await fixture();
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=b" });
      const timer = setInterval(() => {
        res.write(`--b\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write("\r\n");
      }, 1000 / 60);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    const helper = { udid: "U", streamUrl: `http://127.0.0.1:${port}/`, wsUrl: `ws://127.0.0.1:${port}/` };
    try {
      for (const [profile, expected] of [["hub", { width: 363, height: 603 }], ["direct", { width: 726, height: 1206 }]]) {
        const stream = openScreenStream(helper, {}, { width: 1, height: 2, udid: "U", name: "x" }, { profile });
        const it = stream.output[Symbol.asyncIterator]();
        const info = await it.next();
        assert.equal(JSON.parse(info.value).type, "info");
        const frame = await it.next();
        assert.deepEqual(jpegSize(Buffer.from(frame.value)), expected, profile);
        stream.close();
      }
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
