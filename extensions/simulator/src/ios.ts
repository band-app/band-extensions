import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { getStateDir } from "./config.ts";
import { DeviceSet, maxBooted, udidOf } from "./devices.ts";
import { ServeSimHelpers } from "./servesim.ts";
import { jpegSize, openScreenStream, serveSimButton, ORIENTATIONS } from "./stream.ts";
import { run } from "./tools.ts";
import type { Backend, CreateSpec, SimDevice } from "./types.ts";

/** An image block in a tool result may hold at most 5 MB decoded; stay under it with room to spare. */
const MAX_IMAGE_BYTES = 4_500_000;

/** Width and height in pixels, from a PNG's IHDR chunk. */
export function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const text = (spec: CreateSpec, key: string): string => {
  const v = spec[key];
  if (typeof v !== "string" || v === "") throw new Error(`${key} must be a non-empty string`);
  return v;
};

/** iOS simulators through simctl, with capture and input from serve-sim. */
export class IosBackend implements Backend {
  readonly platform = "ios" as const;
  readonly installExt = ".app";
  readonly set = new DeviceSet();
  readonly helpers = new ServeSimHelpers();

  async available() {
    if (process.platform !== "darwin") return { ok: false as const, reason: "iOS simulators need a Mac." };
    try {
      await run("xcrun", ["simctl", "help"], { timeoutMs: 20_000 });
      return { ok: true as const };
    } catch {
      return { ok: false as const, reason: "Xcode is not installed (xcrun simctl failed)." };
    }
  }

  list() {
    return this.set.list();
  }

  maxBooted() {
    return maxBooted();
  }

  async boot(device: SimDevice): Promise<SimDevice> {
    await this.set.boot(device);
    return { ...device, state: "on" };
  }

  async shutdown(device: SimDevice) {
    await this.release(device);
    await this.set.shutdown(device);
  }

  options() {
    return this.set.options();
  }

  create(spec: CreateSpec) {
    return this.set.create({ deviceType: text(spec, "deviceType"), runtime: text(spec, "runtime") });
  }

  screen(device: SimDevice) {
    return this.helpers.screen(udidOf(device));
  }

  /**
   * The PNG is read once and deleted. A PNG over the image limit is taken again as a JPEG.
   */
  async screenshot(device: SimDevice) {
    const udid = udidOf(device);
    const dir = join(getStateDir(), "screenshots");
    await mkdir(dir, { recursive: true });
    const base = join(dir, `shot-${udid}-${Date.now()}`);
    const take = async (type: "png" | "jpeg") => {
      const file = `${base}.${type === "png" ? "png" : "jpg"}`;
      try {
        await run("xcrun", ["simctl", "io", udid, "screenshot", `--type=${type}`, file]);
        return await readFile(file);
      } finally {
        await rm(file, { force: true });
      }
    };
    let data = await take("png");
    let mimeType: "image/png" | "image/jpeg" = "image/png";
    let size = pngSize(data);
    if (data.length > MAX_IMAGE_BYTES) {
      data = await take("jpeg");
      mimeType = "image/jpeg";
      size = jpegSize(data) ?? size;
    }
    const screen = await this.helpers.screen(udid);
    const scale = screen ? Math.round((size.width / screen.width) * 100) / 100 : null;
    return { data, mimeType, width: size.width, height: size.height, scale };
  }

  describe(device: SimDevice) {
    return this.helpers.describe(udidOf(device));
  }

  tap(device: SimDevice, x: number, y: number) {
    return this.helpers.tap(udidOf(device), x, y);
  }

  type(device: SimDevice, text: string) {
    return this.helpers.type(udidOf(device), text);
  }

  button(device: SimDevice, name: string) {
    return this.helpers.button(udidOf(device), serveSimButton(name));
  }

  async openUrl(device: SimDevice, url: string) {
    await run("xcrun", ["simctl", "openurl", udidOf(device), url]);
  }

  async install(device: SimDevice, path: string) {
    await run("xcrun", ["simctl", "install", udidOf(device), path], { timeoutMs: 5 * 60_000 });
  }

  async launch(device: SimDevice, bundleId: string) {
    const { stdout } = await run("xcrun", ["simctl", "launch", udidOf(device), bundleId]);
    return stdout.trim();
  }

  async rotate(device: SimDevice, orientation: string) {
    if (!ORIENTATIONS.includes(orientation)) {
      throw new Error(`orientation must be one of ${ORIENTATIONS.join(", ")}`);
    }
    await this.helpers.rotate(udidOf(device), orientation);
  }

  async openStream(device: SimDevice, params: unknown) {
    const udid = udidOf(device);
    const helper = await this.helpers.helper(udid);
    const screen = (await this.helpers.screen(udid)) ?? { width: 0, height: 0 };
    return openScreenStream(
      helper,
      this.helpers,
      { ...screen, udid: device.id, name: device.name, model: device.model, platform: "ios" },
      params,
    );
  }

  async release(device: SimDevice) {
    await this.helpers.stop(udidOf(device));
  }

  async stopAll() {
    await this.helpers.stopAll();
  }
}
