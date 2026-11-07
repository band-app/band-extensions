import type { Backend, CreateSpec, OnPhase, Platform, SimDevice } from "./types.ts";

export class UnknownDevice extends Error {}

/**
 * Every device on the worker, iOS and Android, behind one set of lifecycle rules. Creating,
 * booting and shutting down never overlap (`exclusive`). Each platform has a limit of devices
 * booted at once. Booting past it shuts down the least recently used device first, and only a
 * device Band created or booted itself is ever shut down this way.
 */
export class Fleet {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly lastUsed = new Map<string, number>();
  /** Devices that were off when Band booted them. A device the person had already booted is not here. */
  private readonly bootedByBand = new Set<string>();
  /** Called after a device shut down, so its viewers are told and its helpers stop. */
  onShutdown: (device: SimDevice) => void = () => {};
  /** Whether a viewer watches the device. Unwatched devices are shut down before watched ones. */
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

  /** The device with this id, or the one device with this name (case does not matter). */
  async find(ref: string, devices?: SimDevice[]): Promise<SimDevice> {
    const all = devices ?? (await this.list());
    const byId = all.find((d) => d.id === ref);
    if (byId) return byId;
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

  /** Turns the device on if it is off, first making room under its platform's limit. */
  async ensureOn(device: SimDevice, onPhase?: OnPhase): Promise<SimDevice> {
    this.touch(device.id);
    const backend = this.backend(device);
    const fresh = (await backend.list()).find((d) => d.id === device.id) ?? device;
    if (fresh.state === "on") return fresh;
    onPhase?.({ phase: "booting", name: fresh.name, model: fresh.model });
    if (fresh.state === "off") await this.makeRoom(backend, fresh);
    const wasOff = fresh.state === "off";
    const booted = await backend.boot(fresh, onPhase);
    if (wasOff) this.bootedByBand.add(device.id);
    return booted;
  }

  /** Shuts down devices of the platform until booting one more fits under the limit. */
  private async makeRoom(backend: Backend, incoming: SimDevice): Promise<void> {
    const on = (await backend.list()).filter(
      (d) =>
        d.state !== "off" &&
        d.id !== incoming.id &&
        // Only Band's own devices, or ones Band booted. A phone or an emulator the person runs stays.
        (d.owned || this.bootedByBand.has(d.id)) &&
        !d.id.startsWith("android:serial:"),
    );
    const rank = (d: SimDevice) => [this.isWatched(d.id) ? 1 : 0, this.lastUsed.get(d.id) ?? 0] as const;
    on.sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1] - rank(b)[1]);
    const keep = Math.max(0, backend.maxBooted() - 1);
    for (const victim of on.slice(0, Math.max(0, on.length - keep))) await this.turnOff(victim);
  }

  /** Shuts a device down. Used for the person's Power press as well, on any device they can see. */
  async turnOff(device: SimDevice): Promise<void> {
    await this.backend(device).shutdown(device);
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
