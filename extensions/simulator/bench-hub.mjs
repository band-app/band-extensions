// Compares the hub profile's frame encoder (sharp, in process) with the old per-frame `sips` process.
//   node bench-hub.mjs [frames] [sharp|sips]
// With a mode, only that path runs, so `/usr/bin/time -l node bench-hub.mjs 200 sips` includes the
// CPU of the sips child processes, which the in-process figure leaves out.
// Uses a synthetic 726x1206 JPEG with noise, as a simulator screen. Prints ms per frame, the
// frame rate the encoder can sustain and CPU time (user+system) per frame for each path.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { scaleFrame } from "./src/stream.ts";

const frames = Number(process.argv[2] ?? 120);
const noise = Buffer.alloc(726 * 1206 * 3);
for (let i = 0; i < noise.length; i++) noise[i] = (i * 31 + ((i / 726) | 0) * 7) & 255;
const frame = await sharp(noise, { raw: { width: 726, height: 1206, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();

const dir = await mkdtemp(join(tmpdir(), "bench-hub-"));
const sips = async (f) => {
  await writeFile(join(dir, "in.jpg"), f);
  await new Promise((res, rej) =>
    execFile("/usr/bin/sips", ["-z", "603", "363", "-s", "formatOptions", "70", join(dir, "in.jpg"), "--out", join(dir, "out.jpg")], (e) => (e ? rej(e) : res())),
  );
  return readFile(join(dir, "out.jpg"));
};

async function run(name, fn) {
  await fn(frame); // warm up
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) await fn(frame);
  const ms = (performance.now() - t0) / frames;
  const cpu = process.cpuUsage(cpu0);
  console.log(`${name}: ${ms.toFixed(2)} ms/frame, ${(1000 / ms).toFixed(0)} fps max, CPU in this process ${((cpu.user + cpu.system) / 1000 / frames).toFixed(2)} ms/frame`);
}

const mode = process.argv[3];
if (!mode || mode === "sharp") await run("sharp (in process)", scaleFrame);
if (!mode || mode === "sips") await run("sips (process per frame)", sips);
