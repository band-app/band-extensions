import { config } from "./config.ts";
import { run } from "./tools.ts";
import type { SimDevice } from "./types.ts";

/** "iPhone 17 Pro" from "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro". */
export function modelFromType(identifier: string | undefined): string | undefined {
  const m = /SimDeviceType\.(.+)$/.exec(identifier ?? "");
  return m ? (m[1] as string).replace(/-/g, " ") : undefined;
}

interface SimctlDevices {
  devices: Record<
    string,
    Array<{ udid: string; name: string; state: string; isAvailable?: boolean; deviceTypeIdentifier?: string }>
  >;
}

interface SimctlRuntimes {
  runtimes: Array<{
    identifier: string;
    version: string;
    name?: string;
    platform?: string;
    isAvailable: boolean;
    supportedDeviceTypes?: Array<{ identifier: string; name: string; productFamily?: string }>;
  }>;
}

/** What the "New iOS simulator" form offers: each installed iOS runtime with the devices it supports. */
export interface IosOptions {
  runtimes: Array<{ id: string; version: string; deviceTypes: Array<{ id: string; name: string }> }>;
}

/** The prefix of every device name Band creates. Tests set their own, so they never match a person's devices. */
export function namePrefix(): string {
  return config().namePrefix;
}

/** The most iOS simulators that may be booted at once. Read on every call. */
export function maxBooted(): number {
  return config().maxBooted;
}

const SEP = " – ";

export function versionParts(v: string): number[] {
  return v.split(".").map((p) => Number.parseInt(p, 10) || 0);
}

export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const iosId = (udid: string) => `ios:${udid}`;
export const udidOf = (device: Pick<SimDevice, "id">) => device.id.slice("ios:".length);

/**
 * The iOS simulators of the machine's default device set, because serve-sim sees only that set.
 * Band lists every available device, its own (named "<prefix> – <model>") and the person's.
 * It creates one only when the person asks, and boots or shuts down only on request. Making room
 * under the booted limit is the fleet's job, not this class's.
 */
export class DeviceSet {
  private simctl(args: string[], timeoutMs?: number) {
    return run("xcrun", ["simctl", ...args], { timeoutMs });
  }

  /** Every available iOS device with its iOS version. Sorted by name. */
  async list(): Promise<SimDevice[]> {
    const { stdout } = await this.simctl(["list", "devices", "-j"]);
    const parsed = JSON.parse(stdout) as SimctlDevices;
    const owned = `${namePrefix()}${SEP}`;
    const out: SimDevice[] = [];
    for (const [runtimeId, list] of Object.entries(parsed.devices)) {
      const m = /SimRuntime\.iOS-(\d+(?:-\d+)*)$/.exec(runtimeId);
      if (!m) continue;
      const version = (m[1] as string).replace(/-/g, ".");
      for (const d of list) {
        // "<prefix> \u2013 base" is the clone source of earlier versions, which made one device per worktree.
        if (d.isAvailable === false || d.name === `${namePrefix()}${SEP}base`) continue;
        out.push({
          id: iosId(d.udid),
          platform: "ios",
          name: d.name,
          state: d.state === "Booted" ? "on" : d.state === "Booting" ? "booting" : "off",
          model: modelFromType(d.deviceTypeIdentifier),
          os: `iOS ${version}`,
          owned: d.name.startsWith(owned),
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /** The installed iOS runtimes, newest first, with the iPhones and iPads each supports. */
  async options(): Promise<IosOptions> {
    const { stdout } = await this.simctl(["list", "runtimes", "-j"]);
    const runtimes = (JSON.parse(stdout) as SimctlRuntimes).runtimes
      .filter((r) => r.isAvailable && (r.platform ?? "iOS") === "iOS")
      .sort((a, b) => compareVersions(b.version, a.version));
    return {
      runtimes: runtimes.map((r) => ({
        id: r.identifier,
        version: r.version,
        deviceTypes: (r.supportedDeviceTypes ?? [])
          .filter((t) => !t.productFamily || t.productFamily === "iPhone" || t.productFamily === "iPad")
          .map((t) => ({ id: t.identifier, name: t.name })),
      })),
    };
  }

  /**
   * Creates a device named "<prefix> – <model>", with " 2", " 3" ... when that name is taken, so
   * the picker can tell them apart.
   */
  async create(spec: { deviceType: string; runtime: string }): Promise<SimDevice> {
    const options = await this.options();
    const runtime = options.runtimes.find((r) => r.id === spec.runtime);
    if (!runtime) throw new Error(`iOS runtime ${spec.runtime} is not installed`);
    const type = runtime.deviceTypes.find((t) => t.id === spec.deviceType);
    if (!type) throw new Error(`${spec.deviceType} is not supported by iOS ${runtime.version}`);
    const taken = new Set((await this.list()).map((d) => d.name));
    let name = `${namePrefix()}${SEP}${type.name}`;
    for (let n = 2; taken.has(name); n++) name = `${namePrefix()}${SEP}${type.name} ${n}`;
    const { stdout } = await this.simctl(["create", name, type.id, runtime.id]);
    const udid = stdout.trim();
    return {
      id: iosId(udid),
      platform: "ios",
      name,
      state: "off",
      model: type.name,
      os: `iOS ${runtime.version}`,
      owned: true,
    };
  }

  /** Boots a device and waits until it finished booting. */
  async boot(device: SimDevice): Promise<void> {
    const udid = udidOf(device);
    if (device.state === "off") await this.simctl(["boot", udid]);
    await this.simctl(["bootstatus", udid, "-b"], 5 * 60_000);
  }

  async shutdown(device: SimDevice): Promise<void> {
    await this.simctl(["shutdown", udidOf(device)]).catch((err: Error) => {
      // Shutting down a device that is already off is not a failure.
      if (!/current state: Shutdown|Unable to shutdown device in current state/i.test(err.message)) {
        throw err;
      }
    });
  }

  async delete(device: SimDevice): Promise<void> {
    await this.simctl(["delete", udidOf(device)]);
  }
}
