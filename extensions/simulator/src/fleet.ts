import { config } from "./config.ts";
import { CallTimeout, span } from "./tools.ts";
import type { Backend, CreateSpec, OnPhase, Platform, SimDevice } from "./types.ts";

export class UnknownDevice extends Error {}

/** A boot or shutdown that did not finish in time and was abandoned. */
export class LifecycleTimeout extends Error {}

/**
 * Every booted Band device is shown in a pane, so none can be shut down to make room. `shown`
 * lists them, so the pane can offer to shut one down.
 */
export class NoRoom extends Error {
  readonly shown: Array<{ id: string; name: string }>;
  constructor(message: string, shown: Array<{ id: string; name: string }>) {
    super(message);
    this.shown = shown;
  }
}

const RESTART_HINT =
  "If it stays stuck, restart the simulator service in a terminal with: sudo killall -9 com.apple.CoreSimulator.CoreSimulatorService (this stops every simulator on the Mac).";

/** Rejects with `LifecycleTimeout` when `work` does not settle within `ms`. The work is left behind. */
function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LifecycleTimeout(message)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        // The child's own limit equals ours and fires first: report it with the device name and hint.
        reject(e instanceof CallTimeout ? new LifecycleTimeout(message) : e);
      },
    );
  });
}

/**
 * Every device on the worker, iOS and Android, behind one set of lifecycle rules. Creating,
 * booting and shutting down never overlap (`exclusive`). Each platform has a limit of devices
 * booted at once. Booting past it shuts down the least recently used device that no pane shows, and
 * only a device Band created or booted itself is ever shut down this way. A boot or shutdown that
 * runs past its time limit is abandoned, so one stuck call cannot hold the queue.
 */
export class Fleet {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lastUsed = new Map<string, number>();
  /** Devices that were off when Band booted them. A device the person had already booted is not here. */
  private readonly bootedByBand = new Set<string>();
  /** Called after a device shut down, so its viewers are told and its helpers stop. */
  onShutdown: (device: SimDevice) => void = () => {};
  /** Whether a viewer shows the device. A shown device is never shut down to make room. */
  isWatched: (id: string) => boolean = () => false;

  readonly backends: Record<Platform, Backend>;

  constructor(backends: Record<Platform, Backend>) {
    this.backends = backends;
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Every device. A platform that fails to list (no SDK, no Xcode) contributes none. */
  async list(): Promise<SimDevice[]> {
    const lists = await Promise.all(
      Object.values(this.backends).map((b) => b.list().catch(() => [] as SimDevice[])),
    );
    return lists.flat();
  }

  async platforms(): Promise<Record<Platform, { ok: boolean; reason?: string }>> {
    const [ios, android] = await Promise.all([this.backends.ios.available(), this.backends.android.available()]);
    return { ios, android };
  }

  /**
   * The device with this id, an iOS UDID or an adb serial, or the one device with this name (case
   * does not matter). An agent has the UDID from `simctl` or the serial from `adb devices`.
   */
  async find(ref: string, devices?: SimDevice[]): Promise<SimDevice> {
    const all = devices ?? (await this.list());
    const byId = all.find((d) => d.id === ref);
    if (byId) return byId;
    const byRaw = all.find((d) => d.id === `ios:${ref}` || d.serial === ref);
    if (byRaw) return byRaw;
    const byName = all.filter((d) => d.name.toLowerCase() === ref.toLowerCase());
    if (byName.length === 1) return byName[0] as SimDevice;
    if (byName.length > 1) {
      throw new UnknownDevice(`"${ref}" names ${byName.length} devices. Use an id: ${byName.map((d) => d.id).join(", ")}`);
    }
    throw new UnknownDevice(`No device has the id or name "${ref}".`);
  }

  touch(id: string): void {
    this.lastUsed.set(id, Date.now());
  }

  backend(device: SimDevice): Backend {
    return this.backends[device.platform];
  }

  /**
   * The device in a state a pane can stream. A device that is already on skips the lifecycle
   * queue, so a stuck boot or shutdown of another device does not hold it up.
   */
  async open(ref: string, onPhase?: OnPhase): Promise<SimDevice> {
    const device = await this.find(ref);
    if (device.state === "on") {
      this.touch(device.id);
      return device;
    }
    return this.exclusive(async () => this.ensureOn(await this.find(ref), onPhase));
  }

  /** Turns the device on if it is off, first making room under its platform's limit. */
  async ensureOn(device: SimDevice, onPhase?: OnPhase): Promise<SimDevice> {
    this.touch(device.id);
    const backend = this.backend(device);
    const fresh = (await backend.list()).find((d) => d.id === device.id) ?? device;
    if (fresh.state === "on") return fresh;
    if (fresh.state === "stopping") {
      throw new Error(`${fresh.name} is shutting down and cannot be started yet. Try again in a moment.`);
    }
    onPhase?.({ phase: "booting", name: fresh.name, model: fresh.model });
    if (fresh.state === "off") await this.makeRoom(backend, fresh);
    const wasOff = fresh.state === "off";
    const cfg = config();
    const limit = device.platform === "android" ? cfg.bootTimeoutAndroidMs : cfg.bootTimeoutMs;
    const booted = await within(
      backend.boot(fresh, onPhase),
      limit,
      `Booting ${fresh.name} did not finish in ${span(limit)} and was abandoned. ${
        device.platform === "ios" ? RESTART_HINT : "Close the emulator and try again."
      }`,
    );
    if (wasOff) this.bootedByBand.add(device.id);
    return booted;
  }

  /**
   * Shuts down devices of the platform until booting one more fits under the limit. A device that
   * is booting or shutting down neither counts nor gets picked. A device a pane shows is never
   * picked: when only shown devices are left to free, this throws `NoRoom`.
   */
  private async makeRoom(backend: Backend, incoming: SimDevice): Promise<void> {
    const on = (await backend.list()).filter(
      (d) =>
        d.state === "on" &&
        d.id !== incoming.id &&
        // Only Band's own devices, or ones Band booted. A phone or an emulator the person runs stays.
        (d.owned || this.bootedByBand.has(d.id)) &&
        !d.id.startsWith("android:serial:"),
    );
    const keep = Math.max(0, backend.maxBooted() - 1);
    const excess = on.length - keep;
    if (excess <= 0) return;
    const free = on.filter((d) => !this.isWatched(d.id)).sort((a, b) => (this.lastUsed.get(a.id) ?? 0) - (this.lastUsed.get(b.id) ?? 0));
    if (free.length < excess) {
      const shown = on.filter((d) => this.isWatched(d.id)).map((d) => ({ id: d.id, name: d.name }));
      throw new NoRoom(
        `${incoming.name} cannot start: ${backend.maxBooted()} ${backend.platform === "ios" ? "iOS simulators" : "Android emulators"} are on and ${shown.map((d) => d.name).join(", ")} ${shown.length === 1 ? "is" : "are"} shown in a pane. Shut one down to make room.`,
        shown,
      );
    }
    for (const victim of free.slice(0, excess)) await this.turnOff(victim);
  }

  /** Shuts a device down. Used for the person's Power press as well, on any device they can see. */
  async turnOff(device: SimDevice): Promise<void> {
    const limit = config().shutdownTimeoutMs;
    await within(
      this.backend(device).shutdown(device),
      limit,
      `Shutting down ${device.name} did not finish in ${span(limit)} and was abandoned (the ${device.platform === "ios" ? "simctl shutdown" : "emulator kill"} call is stuck). ${
        device.platform === "ios" ? RESTART_HINT : "Close the emulator by hand."
      }`,
    );
    this.bootedByBand.delete(device.id);
    this.onShutdown(device);
  }

  async create(platform: Platform, spec: CreateSpec): Promise<SimDevice> {
    const device = await this.backends[platform].create(spec);
    this.touch(device.id);
    return device;
  }

  /** Shuts down the devices Band booted or created that are on. The service stopping calls this. */
  async shutdownOurs(only?: (d: SimDevice) => boolean): Promise<void> {
    for (const d of await this.list()) {
      if (d.state === "off" || d.id.startsWith("android:serial:")) continue;
      if (!(d.owned || this.bootedByBand.has(d.id))) continue;
      if (only && !only(d)) continue;
      await this.turnOff(d).catch(() => undefined);
    }
  }
}
