import { type DeviceRef, type LayoutNode, panes } from "./layout.ts";
import type { SimDevice } from "./types.ts";

/** What the open Simulator tab learns by polling `events`. */
export type WatchEvent =
  /** `show` put a device in a pane of the saved layout. The tab switches that pane to it. */
  | { seq: number; type: "show"; paneId: string; device: DeviceRef; layout: LayoutNode }
  /** A device started that the tab does not show. The tab asks the person whether to show it. */
  | { seq: number; type: "offer"; device: DeviceRef & { os: string } }
  /** An offered device turned off again, so the offer no longer applies. */
  | { seq: number; type: "withdraw"; id: string };

interface Watch {
  lastPoll: number;
  seq: number;
  events: WatchEvent[];
  /** The state of each device at the last check. Null until the first check, which only sets the baseline. */
  known: Map<string, SimDevice["state"]> | null;
  /** Devices already offered for their current run. Cleared when the device turns off. */
  offered: Set<string>;
  /** The pane the person focused last, as the tab reported it. */
  focusPane: string | null;
}

/** A tab that has not polled for this long is closed: its baseline and events are dropped. */
const IDLE_MS = 10_000;
const KEEP_EVENTS = 50;

/**
 * What the Simulator tab of each worktree is told while it is open. The tab polls `events` about
 * every 2 seconds. That poll is the only thing that makes the service look at the devices, so
 * nothing runs while no tab is open, and the device list is read at most once per `minGapMs` for
 * all tabs together.
 */
export class Watchers {
  private readonly watches = new Map<string, Watch>();
  private cache: { at: number; list: SimDevice[] } | null = null;

  private readonly listDevices: () => Promise<SimDevice[]>;
  private readonly minGapMs: number;
  private readonly now: () => number;

  constructor(listDevices: () => Promise<SimDevice[]>, minGapMs = 2000, now: () => number = Date.now) {
    this.listDevices = listDevices;
    this.minGapMs = minGapMs;
    this.now = now;
  }

  private active(key: string): Watch | null {
    const w = this.watches.get(key);
    return w && this.now() - w.lastPoll <= IDLE_MS ? w : null;
  }

  /** Whether a tab of the worktree polled recently. */
  isOpen(key: string): boolean {
    return this.active(key) !== null;
  }

  /** The pane the open tab reported as focused, or null when no tab is open. */
  focusPane(key: string): string | null {
    return this.active(key)?.focusPane ?? null;
  }

  /** Tells the open tab of a worktree something. With no tab open nothing is kept: the tab reads the saved layout when it opens. */
  push(key: string, event: DistributiveOmit<WatchEvent, "seq">): boolean {
    const w = this.active(key);
    if (!w) return false;
    w.events.push({ ...event, seq: ++w.seq } as WatchEvent);
    if (w.events.length > KEEP_EVENTS) w.events.splice(0, w.events.length - KEEP_EVENTS);
    return true;
  }

  private async devices(): Promise<SimDevice[]> {
    const t = this.now();
    if (!this.cache || t - this.cache.at >= this.minGapMs) {
      this.cache = { at: t, list: await this.listDevices().catch(() => this.cache?.list ?? []) };
    }
    return this.cache.list;
  }

  /**
   * One poll of an open tab. `since` is the last `seq` it has (omit it on the first poll).
   * `shown` are the device ids in its panes and `focus` its focused pane's id. A device that was
   * off or unknown at the last check and is on now, and is in no pane, is offered once.
   */
  async poll(
    key: string,
    args: { since?: number; focus?: string | null; shown?: string[] },
  ): Promise<{ seq: number; events: WatchEvent[] }> {
    let w = this.watches.get(key);
    const t = this.now();
    if (!w || t - w.lastPoll > IDLE_MS) {
      w = { lastPoll: t, seq: w?.seq ?? 0, events: [], known: null, offered: new Set(), focusPane: null };
      this.watches.set(key, w);
    }
    w.lastPoll = t;
    w.focusPane = typeof args.focus === "string" ? args.focus : null;

    const list = await this.devices();
    const shown = new Set(args.shown ?? []);
    const before = w.known;
    w.known = new Map(list.map((d) => [d.id, d.state]));
    if (before) {
      for (const d of list) {
        const was = before.get(d.id);
        const running = d.state !== "off";
        if (!running) {
          if (w.offered.delete(d.id)) this.push(key, { type: "withdraw", id: d.id });
        } else if ((was === undefined || was === "off") && !shown.has(d.id) && !w.offered.has(d.id)) {
          w.offered.add(d.id);
          this.push(key, { type: "offer", device: { id: d.id, platform: d.platform, name: d.name, os: d.os } });
        }
      }
    }
    const since = typeof args.since === "number" ? args.since : w.seq;
    return { seq: w.seq, events: w.events.filter((e) => e.seq > since) };
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/** The pane that should take a device `show` puts on screen, and a human description of it. */
export function pickPane(layout: LayoutNode, focusPaneId: string | null, focusedDeviceId: string | null): string {
  const list = panes(layout);
  if (focusPaneId && list.some((p) => p.id === focusPaneId)) return focusPaneId;
  const byDevice = focusedDeviceId ? list.find((p) => p.device?.id === focusedDeviceId) : undefined;
  return (byDevice ?? list[0]!).id;
}
