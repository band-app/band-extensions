import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config, getStateDir } from "./config.ts";
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
  /** The folder each worktree was last served from, by worktree key. Loaded from the state dir on first use. */
  private folders: Map<string, string> | null = null;

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

  private async loadFolders(): Promise<Map<string, string>> {
    if (this.folders) return this.folders;
    const map = new Map<string, string>();
    try {
      const parsed = JSON.parse(await readFile(join(getStateDir(), "worktrees.json"), "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") map.set(k, v);
      }
    } catch {
      // No file yet, or no state dir (tests): nothing is known.
    }
    this.folders = map;
    return map;
  }

  private async saveFolders(): Promise<void> {
    try {
      const dir = getStateDir();
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "worktrees.json"), JSON.stringify(Object.fromEntries(this.folders ?? [])));
    } catch {
      // The sweep then skips worktrees it cannot place.
    }
  }

  /**
   * Remembers where a worktree lives. The worker's list of served worktrees is in memory and
   * gone after a restart, so this index in the state dir is how a removed worktree is found later.
   */
  async rememberFolder(worktreeKey: string, folder: string): Promise<void> {
    const map = await this.loadFolders();
    if (map.get(worktreeKey) === folder) return;
    map.set(worktreeKey, folder);
    await this.saveFolders();
  }

  /** The keys of the worktrees last served from `folder`. */
  async keysAt(folder: string): Promise<string[]> {
    return [...(await this.loadFolders())].filter(([, f]) => f === folder).map(([k]) => k);
  }

  /**
   * Deletes the device earlier versions made for a worktree, named "<prefix> \u2013 <key>", and
   * forgets the worktree's folder. A device in `protectedIds` (one a saved layout shows) stays.
   */
  async deleteWorktree(
    worktreeKey: string,
    protectedIds: ReadonlySet<string> = new Set(),
    beforeDelete: (d: SimDevice) => Promise<void> | void = () => {},
  ): Promise<string | null> {
    const folders = await this.loadFolders();
    if (folders.delete(worktreeKey)) await this.saveFolders();
    const name = `${namePrefix()}${SEP}${worktreeKey}`;
    const device = (await this.list()).find((d) => d.name === name);
    if (!device || protectedIds.has(device.id)) return null;
    await beforeDelete(device);
    await this.shutdown(device);
    await this.delete(device);
    return device.name;
  }

  /**
   * Deletes the device of every worktree whose folder is gone. Only a device named
   * "<prefix> \u2013 <worktree key>" whose key has a known folder that no longer exists is deleted.
   * A device without the prefix, one of a worktree whose folder exists, one with no known folder,
   * one a saved layout shows, and a device someone is watching all stay. The devices people create
   * in the picker are named "<prefix> \u2013 <model>", whose "key" has no folder, so they stay too.
   */
  async sweepRemoved(
    options: {
      exists?: (folder: string) => Promise<boolean>;
      protectedIds?: ReadonlySet<string>;
      isWatched?: (id: string) => boolean;
      beforeDelete?: (d: SimDevice) => Promise<void> | void;
    } = {},
  ): Promise<string[]> {
    const { exists = folderExists, protectedIds = new Set<string>(), isWatched = () => false, beforeDelete } = options;
    const folders = await this.loadFolders();
    const owned = `${namePrefix()}${SEP}`;
    const deleted: string[] = [];
    for (const d of await this.list()) {
      if (!d.name.startsWith(owned)) continue;
      const key = d.name.slice(owned.length);
      const folder = folders.get(key);
      if (folder === undefined || (await exists(folder))) continue;
      if (protectedIds.has(d.id) || (d.state === "on" && isWatched(d.id))) continue;
      const name = await this.deleteWorktree(key, protectedIds, beforeDelete);
      if (name) deleted.push(name);
    }
    return deleted;
  }
}

/** Whether a folder exists. Only a missing folder counts as gone; any other error keeps the device. */
async function folderExists(folder: string): Promise<boolean> {
  try {
    await stat(folder);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}
