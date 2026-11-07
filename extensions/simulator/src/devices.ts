import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config, getStateDir } from "./config.ts";
import { run } from "./tools.ts";

export interface Device {
  udid: string;
  name: string;
  state: string;
  /** The hardware model, such as "iPhone 17 Pro", when simctl names the device type. */
  model?: string;
}

/** What the service tells the panel while a device is made ready. */
export type BootPhase = { phase: "creating" | "cloning" | "booting"; name?: string; model?: string };
export type OnPhase = (phase: BootPhase) => void;

/** "iPhone 17 Pro" from "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro". */
export function modelFromType(identifier: string | undefined): string | undefined {
  const m = /SimDeviceType\.(.+)$/.exec(identifier ?? "");
  return m ? (m[1] as string).replace(/-/g, " ") : undefined;
}

/** A device the picker offers: Band's own or the person's. `runtime` is the iOS version, such as "26.5". */
export interface PickerDevice extends Device {
  runtime: string;
  /** Whether Band created it (its name starts with the prefix). */
  owned: boolean;
}

/** Where the picker lists a device: this worktree's own, another worktree's, or the person's. */
export type PickerGroup = "this" | "other" | "mine";

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
    platform?: string;
    isAvailable: boolean;
    supportedDeviceTypes?: Array<{ identifier: string; name: string; productFamily?: string }>;
  }>;
}

/** The prefix of every device name Band creates. Tests set their own, so they never match a person's devices. */
export function namePrefix(): string {
  return config().namePrefix;
}

function baseName(): string {
  return `${namePrefix()} \u2013 base`;
}

/** The most devices that may be booted at once. Read on every call. */
export function maxBooted(): number {
  return config().maxBooted;
}

/** The device name of a worktree: "Band \u2013 <worktree id>", the way Simulator.app lists it. */
export function deviceName(worktreeKey: string): string {
  return `${namePrefix()} \u2013 ${worktreeKey}`;
}

function versionParts(v: string): number[] {
  return v.split(".").map((p) => Number.parseInt(p, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The worktrees' devices, in the machine's default device set because serve-sim sees only that
 * set. Band owns the devices whose name starts with "Band \u2013 " (`namePrefix()`) and never
 * lists, shuts down or deletes any other. One device per worktree is cloned from a base device,
 * and at most `maxBooted()` are booted at once; the least recently used one is shut down, never
 * deleted.
 */
export class DeviceSet {
  /** The device each worktree chose in the panel's picker, by worktree key. Loaded from the state dir on first use. */
  private selection: Map<string, string> | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lastUsed = new Map<string, number>();
  /** Called after a device shuts down, so its serve-sim helper goes too. */
  onShutdown: (udid: string) => Promise<void> | void = () => {};
  /** Whether a viewer is watching the device now. A booted device with one is never swept. */
  hasLiveStream: (udid: string) => boolean = () => false;
  /** The folder each worktree was last served from, by worktree key. Loaded from the state dir on first use. */
  private folders: Map<string, string> | null = null;

  /** Runs `fn` after every earlier lifecycle operation, so creates, boots and shutdowns never overlap. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private simctl(args: string[], timeoutMs?: number) {
    return run("xcrun", ["simctl", ...args], { timeoutMs });
  }

  async list(): Promise<Device[]> {
    const { stdout } = await this.simctl(["list", "devices", "-j"]);
    const parsed = JSON.parse(stdout) as SimctlDevices;
    const owned = `${namePrefix()} \u2013 `;
    return Object.values(parsed.devices)
      .flat()
      .filter((d) => d.isAvailable !== false && d.name.startsWith(owned))
      .map(({ udid, name, state, deviceTypeIdentifier }) => ({
        udid,
        name,
        state,
        model: modelFromType(deviceTypeIdentifier),
      }));
  }

  /**
   * Every available iOS device on the machine with its iOS version, Band's and the person's,
   * except the base device Band clones from. Sorted by name.
   */
  async listAll(): Promise<PickerDevice[]> {
    const { stdout } = await this.simctl(["list", "devices", "-j"]);
    const parsed = JSON.parse(stdout) as SimctlDevices;
    const owned = `${namePrefix()} \u2013 `;
    const out: PickerDevice[] = [];
    for (const [runtimeId, list] of Object.entries(parsed.devices)) {
      const m = /SimRuntime\.iOS-(\d+(?:-\d+)*)$/.exec(runtimeId);
      if (!m) continue;
      const runtime = (m[1] as string).replace(/-/g, ".");
      for (const d of list) {
        if (d.isAvailable === false || d.name === baseName()) continue;
        out.push({
          udid: d.udid,
          name: d.name,
          state: d.state,
          model: modelFromType(d.deviceTypeIdentifier),
          runtime,
          owned: d.name.startsWith(owned),
        });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.udid.localeCompare(b.udid));
  }

  /** The picker's group of a device for a worktree. */
  group(d: PickerDevice, worktreeKey: string): PickerGroup {
    if (d.name === deviceName(worktreeKey)) return "this";
    return d.owned ? "other" : "mine";
  }

  private async loadSelection(): Promise<Map<string, string>> {
    if (this.selection) return this.selection;
    const map = new Map<string, string>();
    try {
      const parsed = JSON.parse(await readFile(join(getStateDir(), "selection.json"), "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") map.set(k, v);
      }
    } catch {
      // No file yet, or no state dir (tests): nothing is selected.
    }
    this.selection = map;
    return map;
  }

  private async saveSelection(): Promise<void> {
    try {
      const dir = getStateDir();
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "selection.json"), JSON.stringify(Object.fromEntries(this.selection ?? [])));
    } catch {
      // The choice then lasts until the service restarts.
    }
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
   * Deletes the device of every worktree whose folder is gone. Only a device named
   * "<prefix> \u2013 <worktree key>" whose key has a known folder that no longer exists is deleted.
   * The base device, a device without the prefix, a device of a worktree whose folder exists, a
   * device with no known folder and a booted device someone is watching all stay.
   */
  async sweepRemoved(exists: (folder: string) => Promise<boolean> = folderExists): Promise<string[]> {
    const folders = await this.loadFolders();
    const owned = `${namePrefix()} \u2013 `;
    const deleted: string[] = [];
    for (const d of await this.list()) {
      if (!d.name.startsWith(owned) || d.name === baseName()) continue;
      const key = d.name.slice(owned.length);
      const folder = folders.get(key);
      if (folder === undefined || (await exists(folder))) continue;
      if (d.state === "Booted" && this.hasLiveStream(d.udid)) continue;
      await this.deleteWorktree(key);
      deleted.push(d.name);
    }
    return deleted;
  }

  /** Makes `udid` the device of the worktree, or goes back to the worktree's own device when `udid` is null. */
  async select(worktreeKey: string, udid: string | null): Promise<Device> {
    const map = await this.loadSelection();
    if (udid === null) {
      map.delete(worktreeKey);
      await this.saveSelection();
      return this.ensureDevice(worktreeKey);
    }
    const found = (await this.listAll()).find((d) => d.udid === udid);
    if (!found) throw new Error(`No available iOS simulator has the id ${udid}`);
    if (found.name === deviceName(worktreeKey)) map.delete(worktreeKey);
    else map.set(worktreeKey, udid);
    await this.saveSelection();
    return found;
  }

  /**
   * The device the worktree acts on: the one picked in the panel while it still exists, otherwise
   * the worktree's own device (cloned on first use).
   */
  async current(worktreeKey: string, onPhase?: OnPhase): Promise<Device> {
    const map = await this.loadSelection();
    const udid = map.get(worktreeKey);
    if (udid) {
      const found = (await this.listAll()).find((d) => d.udid === udid);
      if (found) return found;
      map.delete(worktreeKey);
      await this.saveSelection();
    }
    return this.ensureDevice(worktreeKey, onPhase);
  }

  /** The newest available iOS runtime and the newest iPhone Pro it supports, unless the env names them. */
  private async pickBase(): Promise<{ type: string; runtime: string }> {
    const envType = config().deviceType;
    const envRuntime = config().runtime;
    const { stdout } = await run("xcrun", ["simctl", "list", "runtimes", "-j"]);
    const runtimes = (JSON.parse(stdout) as SimctlRuntimes).runtimes
      .filter((r) => r.isAvailable && (r.platform ?? "iOS") === "iOS")
      .sort((a, b) => compareVersions(b.version, a.version));
    const runtime = envRuntime
      ? runtimes.find((r) => r.identifier === envRuntime || r.version === envRuntime)
      : runtimes[0];
    if (!runtime) throw new Error("No iOS simulator runtime is installed on this worker");
    if (envType) return { type: envType, runtime: runtime.identifier };
    const iphones = (runtime.supportedDeviceTypes ?? []).filter((t) => /^iPhone /.test(t.name));
    const pros = iphones
      .map((t) => ({ t, m: /^iPhone (\d+) Pro$/.exec(t.name) }))
      .filter((x): x is { t: (typeof iphones)[number]; m: RegExpExecArray } => x.m !== null)
      .sort((a, b) => Number(b.m[1]) - Number(a.m[1]));
    const chosen = pros[0]?.t ?? iphones[0];
    if (!chosen) throw new Error(`Runtime ${runtime.identifier} supports no iPhone`);
    return { type: chosen.identifier, runtime: runtime.identifier };
  }

  private async baseDevice(onPhase?: OnPhase): Promise<Device> {
    const existing = (await this.list()).find((d) => d.name === baseName());
    if (existing) return existing;
    onPhase?.({ phase: "creating" });
    const { type, runtime } = await this.pickBase();
    const { stdout } = await this.simctl(["create", baseName(), type, runtime]);
    return { udid: stdout.trim(), name: baseName(), state: "Shutdown" };
  }

  /** The worktree's device, cloned from the base device on first use. */
  async ensureDevice(worktreeKey: string, onPhase?: OnPhase): Promise<Device> {
    const name = deviceName(worktreeKey);
    const found = (await this.list()).find((d) => d.name === name);
    if (found) return found;
    const base = await this.baseDevice(onPhase);
    if (base.state !== "Shutdown") await this.simctl(["shutdown", base.udid]);
    onPhase?.({ phase: "cloning" });
    const { stdout } = await this.simctl(["clone", base.udid, name], 5 * 60_000);
    return { udid: stdout.trim(), name, state: "Shutdown", model: base.model };
  }

  /**
   * Boots the worktree's device, first shutting down the least recently used booted devices until
   * there is room under the cap.
   */
  async ensureBooted(worktreeKey: string, onPhase?: OnPhase): Promise<Device> {
    return this.bootDevice(await this.current(worktreeKey, onPhase), onPhase);
  }

  /**
   * Boots a device. Only Band's own devices are shut down to make room; a device of the person's
   * counts for nothing and is never evicted.
   */
  async bootDevice(device: Device, onPhase?: OnPhase): Promise<Device> {
    this.lastUsed.set(device.udid, Date.now());
    if (device.state === "Booted") return device;
    onPhase?.({ phase: "booting", name: device.name, model: device.model });
    const booted = (await this.list()).filter(
      (d) => d.state === "Booted" && d.udid !== device.udid && d.name !== baseName(),
    );
    booted.sort((a, b) => (this.lastUsed.get(a.udid) ?? 0) - (this.lastUsed.get(b.udid) ?? 0));
    const room = maxBooted() - 1;
    for (const victim of booted.slice(0, Math.max(0, booted.length - room))) {
      await this.shutdown(victim.udid);
    }
    if (device.state !== "Shutting Down") await this.simctl(["boot", device.udid]);
    await this.simctl(["bootstatus", device.udid, "-b"], 5 * 60_000);
    return { ...device, state: "Booted" };
  }

  async shutdown(udid: string): Promise<void> {
    await this.onShutdown(udid);
    await this.simctl(["shutdown", udid]).catch((err: Error) => {
      // Shutting down a device that is already off is not a failure.
      if (
        !/current state: Shutdown|Unable to shutdown device in current state/i.test(err.message)
      ) {
        throw err;
      }
    });
  }

  /** Shuts down the worktree's device if it is booted. */
  async shutdownWorktree(worktreeKey: string): Promise<void> {
    const name = deviceName(worktreeKey);
    const device = (await this.list()).find((d) => d.name === name);
    if (device && device.state !== "Shutdown") await this.shutdown(device.udid);
  }

  /** Forgets the worktree's picked device. */
  async forgetSelection(worktreeKey: string): Promise<void> {
    const map = await this.loadSelection();
    if (map.delete(worktreeKey)) await this.saveSelection();
  }

  /** Shuts down and deletes the worktree's device. */
  async deleteWorktree(worktreeKey: string): Promise<void> {
    await this.forgetSelection(worktreeKey);
    const folders = await this.loadFolders();
    if (folders.delete(worktreeKey)) await this.saveFolders();
    const name = deviceName(worktreeKey);
    const device = (await this.list()).find((d) => d.name === name);
    if (!device) return;
    await this.shutdown(device.udid);
    await this.simctl(["delete", device.udid]);
    this.lastUsed.delete(device.udid);
  }

  /** Shuts down every booted device in the set. */
  async shutdownAll(): Promise<void> {
    for (const d of await this.list().catch(() => [])) {
      if (d.state === "Booted") await this.shutdown(d.udid).catch(() => undefined);
    }
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
