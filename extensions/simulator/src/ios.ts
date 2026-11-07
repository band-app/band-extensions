import { DeviceSet, maxBooted, udidOf } from "./devices.ts";
import { ServeSimHelpers } from "./servesim.ts";
import { openScreenStream, ORIENTATIONS } from "./stream.ts";
import { run } from "./tools.ts";
import type { Backend, CreateSpec, SimDevice } from "./types.ts";

const text = (spec: CreateSpec, key: string): string => {
  const v = spec[key];
  if (typeof v !== "string" || v === "") throw new Error(`${key} must be a non-empty string`);
  return v;
};

/** iOS simulators through simctl, with capture and input from serve-sim. */
export class IosBackend implements Backend {
  readonly platform = "ios" as const;
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
