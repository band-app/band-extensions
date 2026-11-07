import { setStateDir } from "./config.ts";
import { AndroidBackend } from "./android.ts";
import { Fleet, UnknownDevice } from "./fleet.ts";
import { IosBackend } from "./ios.ts";
import { type DeviceRef, deviceIds, emptyLayout, type LayoutNode, panes } from "./layout.ts";
import { defineWorkerService, type ServiceStream, type WorkerServiceDefinition } from "./sdk/index.mjs";
import { LayoutStore } from "./store.ts";
import type { ScreenStream } from "./stream.ts";
import type { Platform, SimDevice } from "./types.ts";
import { pickPane, Watchers } from "./watch.ts";

function obj(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

function str(params: unknown, key: string): string {
  const v = obj(params)[key];
  if (typeof v !== "string" || v === "") throw new Error(`${key} must be a non-empty string`);
  return v;
}

function optStr(params: unknown, key: string): string | undefined {
  const v = obj(params)[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new Error(`${key} must be a string`);
  return v;
}

/**
 * The simulator as a worker service. The Simulator tab is a viewer: a canvas of panes, each
 * showing one iOS simulator or Android emulator. A person picks or creates a device in a pane,
 * and an agent or script calls `show` to put the device it ran on in a pane. Band creates nothing
 * on its own, and runs no app: agents use simctl, adb and their own test tools for that.
 */
const ios = new IosBackend();
const fleet = new Fleet({ ios, android: new AndroidBackend() });
const store = new LayoutStore();
const watchers = new Watchers(() => fleet.list());

/** One open screen stream: a pane of a worktree's tab. */
interface View {
  worktreeKey: string;
  deviceId: string;
  focusAt: number;
  stream: ServiceStream;
  live: ScreenStream | null;
}
const views = new Set<View>();

fleet.isWatched = (id) => [...views].some((v) => v.deviceId === id);
fleet.onShutdown = (device) => {
  // Tell the viewers the device is off, so the pane shows Off instead of reconnecting and booting it again.
  for (const v of [...views]) {
    if (v.deviceId !== device.id) continue;
    v.stream.send(JSON.stringify({ type: "off" }));
    v.live?.close();
    v.live = null;
    views.delete(v);
    v.stream.end();
  }
};

/** The device a pane of this worktree has focused most recently, or null when the tab shows none. */
function focusedId(worktreeKey: string): string | null {
  let best: View | null = null;
  for (const v of views) {
    if (v.worktreeKey === worktreeKey && (!best || v.focusAt >= best.focusAt)) best = v;
  }
  return best?.deviceId ?? null;
}

/** An agent tool had no device to act on. The answer lists the devices and how to pick one. */
class NeedDevice extends Error {}

const summary = (d: SimDevice) =>
  `${d.name} (${d.os}${d.model && d.model !== d.name ? `, ${d.model}` : ""}, ${d.state === "on" ? "on" : d.state === "booting" ? "booting" : "off"}) id ${d.id}`;

async function deviceListMessage(): Promise<string> {
  const list = await fleet.list();
  return `Devices on this worker:\n${list.length ? list.map((d) => `- ${summary(d)}`).join("\n") : "- none found"}`;
}

/** The `show` answer: which pane has the device, and whether an open tab switched to it. */
function reply(text: string) {
  return { content: [{ type: "text", text }] };
}

function setPaneDevice(node: LayoutNode, paneId: string, device: DeviceRef): LayoutNode {
  if (node.type === "pane") return node.id === paneId ? { ...node, device } : node;
  return { ...node, a: setPaneDevice(node.a, paneId, device), b: setPaneDevice(node.b, paneId, device) };
}

async function needDeviceMessage(): Promise<string> {
  const list = await fleet.list();
  const lines = list.length ? list.map((d) => `- ${summary(d)}`).join("\n") : "- none found";
  return [
    "No device is open in this worktree's Simulator tab, and no device was named.",
    "Pass `device` (an id or a name from this list) to act on one, or open the Simulator tab and pick or create a device in a pane. Band does not create devices on its own.",
    "Devices on this worker:",
    lines,
  ].join("\n");
}

async function target(params: unknown, worktreeKey: string): Promise<SimDevice> {
  const wanted = optStr(params, "device") ?? focusedId(worktreeKey);
  if (!wanted) throw new NeedDevice(await needDeviceMessage());
  try {
    return await fleet.find(wanted);
  } catch (err) {
    if (err instanceof UnknownDevice && optStr(params, "device") === undefined) throw new NeedDevice(await needDeviceMessage());
    throw err;
  }
}

const ok = { ok: true };

const SWEEP_EVERY_MS = 24 * 3600_000;
let sweepTimer: NodeJS.Timeout | undefined;

/**
 * Deletes the iOS devices that earlier versions made for worktrees whose folder is gone. A device
 * a saved layout shows, or a pane watches, is never deleted. A failure only means the next sweep tries again.
 */
function sweep(): Promise<void> {
  return fleet
    .exclusive(async () =>
      ios.set.sweepRemoved({
        protectedIds: await store.savedDeviceIds(),
        isWatched: fleet.isWatched,
        beforeDelete: (d) => ios.release(d),
      }),
    )
    .then(
      (names) => {
        if (names.length > 0) console.error(`simulator: deleted ${names.length} device(s) of removed worktrees`);
      },
      (err: Error) => console.error(`simulator sweep: ${err.message}`),
    );
}

/** Every call and stream notes the worktree's folder first, so a later removal finds its legacy device even after a restart. */
function withFolders(def: WorkerServiceDefinition): WorkerServiceDefinition {
  const remember = ({ worktreeKey, worktreePath }: { worktreeKey: string; worktreePath: string }) => {
    void ios.set.rememberFolder(worktreeKey, worktreePath);
  };
  const calls = Object.fromEntries(
    Object.entries(def.calls ?? {}).map(([name, fn]) => [
      name,
      (params: unknown, scope: Parameters<typeof fn>[1]) => {
        remember(scope);
        return fn(params, scope);
      },
    ]),
  );
  const streams = Object.fromEntries(
    Object.entries(def.streams ?? {}).map(([name, fn]) => [
      name,
      (params: Parameters<typeof fn>[0], scope: Parameters<typeof fn>[1], stream: Parameters<typeof fn>[2]) => {
        remember(scope);
        return fn(params, scope, stream);
      },
    ]),
  );
  return { ...def, calls, streams };
}

defineWorkerService(withFolders({
  onInit({ stateDir }) {
    setStateDir(stateDir);
    // Behind the start, so a slow simctl never delays the first call.
    void sweep();
    sweepTimer = setInterval(() => void sweep(), SWEEP_EVERY_MS);
    sweepTimer.unref();
  },

  calls: {
    /** Every device on the worker, for the picker, with whether each platform can run here. */
    async devices() {
      const [devices, platforms] = await Promise.all([fleet.list(), fleet.platforms()]);
      return { devices, platforms };
    },

    /** The choices of the "New ..." forms. */
    async options() {
      const [ios, android] = await Promise.all([
        fleet.backends.ios.options().catch((err: Error) => ({ runtimes: [], error: err.message })),
        fleet.backends.android.options(),
      ]);
      return { ios, android };
    },

    async create(params) {
      const platform = str(params, "platform");
      if (platform !== "ios" && platform !== "android") throw new Error("platform must be ios or android");
      const device = await fleet.exclusive(() => fleet.create(platform as Platform, obj(params)));
      return { device };
    },

    /** The worktree's canvas: its own, else its repo's, else none (one empty pane). */
    async layout(_params, { worktreeKey, worktreePath }) {
      return store.get(worktreeKey, worktreePath);
    },

    async saveLayout(params, { worktreeKey, worktreePath }) {
      await store.save(worktreeKey, worktreePath, obj(params).layout);
      return ok;
    },

    /** Turns a device off. The Power button of a pane calls this for the pane's device. */
    async shutdown(params) {
      const id = str(params, "device");
      await fleet.exclusive(async () => {
        const device = await fleet.find(id);
        if (device.state !== "off") await fleet.turnOff(device);
      });
      return ok;
    },

    async rotate(params) {
      const orientation = str(params, "orientation");
      const id = str(params, "device");
      await fleet.exclusive(async () => {
        const device = await fleet.ensureOn(await fleet.find(id));
        await fleet.backend(device).rotate(device, orientation);
      });
      return ok;
    },

    /** The devices, and the one the focused pane shows; the answer to "what can I act on". */
    async list(_params, { worktreeKey }) {
      const devices = await fleet.list();
      return { focused: focusedId(worktreeKey), devices };
    },

    /** The device the tools mean, whether it is on, and its screen size. Turns nothing on. */
    async status(params, { worktreeKey }) {
      try {
        const device = await target(params, worktreeKey);
        const screen = device.state === "on" ? await fleet.backend(device).screen(device) : null;
        return { device, screen };
      } catch (err) {
        if (err instanceof NeedDevice) return { content: [{ type: "text", text: err.message }] };
        throw err;
      }
    },

    /**
     * Puts a device in a pane of this worktree's saved layout: the pane focused last, else the
     * first pane, else a new single-pane layout. An open Simulator tab switches over `events`.
     * An unknown device is a tool error that lists the devices.
     */
    async show(params, { worktreeKey, worktreePath }) {
      const wanted = str(params, "device");
      let device: SimDevice;
      try {
        device = await fleet.find(wanted);
      } catch (err) {
        if (!(err instanceof UnknownDevice)) throw err;
        throw new Error(`${err.message}\n${await deviceListMessage()}`);
      }
      const ref: DeviceRef = { id: device.id, platform: device.platform, name: device.name };
      const saved = (await store.get(worktreeKey, worktreePath)).layout ?? emptyLayout();
      const list = panes(saved);
      const already = list.find((p) => p.device?.id === device.id);
      const open = watchers.isOpen(worktreeKey);
      const where = (id: string) => `pane ${list.findIndex((p) => p.id === id) + 1} of ${list.length}`;
      if (already) {
        return reply(`${device.name} is already shown in ${where(already.id)} of the Simulator tab.`);
      }
      const paneId = pickPane(saved, watchers.focusPane(worktreeKey), focusedId(worktreeKey));
      const layout = setPaneDevice(saved, paneId, ref);
      await store.save(worktreeKey, worktreePath, layout);
      watchers.push(worktreeKey, { type: "show", paneId, device: ref, layout });
      return reply(
        `Showing ${device.name} in ${where(paneId)} of the Simulator tab. ${open ? "The open tab switched to it." : "The tab shows it when it opens."}`,
      );
    },

    /**
     * What the open tab polls about every 2 seconds: layout changes made by `show`, and offers
     * for devices that started. `since` is the last `seq` seen; `focus` is the focused pane's id
     * and `shown` the device ids in the panes. The poll is also how the service knows a tab is open.
     */
    async events(params, { worktreeKey }) {
      const p = obj(params);
      return watchers.poll(worktreeKey, {
        since: typeof p.since === "number" ? p.since : undefined,
        focus: typeof p.focus === "string" ? p.focus : null,
        shown: Array.isArray(p.shown) ? p.shown.filter((x): x is string => typeof x === "string") : [],
      });
    },
  },

  streams: {
    /**
     * The live screen of one pane. `params.device` is the device id. Messages to the viewer are
     * text `{"type":"booting"}`, `{"type":"info"}` and `{"type":"off"}` (the device was turned
     * off), then one binary JPEG per frame. Messages from the viewer are JSON: `focus`, `touch`,
     * `button`, `key` and `text`.
     */
    screen(params, { worktreeKey }, stream) {
      const deviceRef = str(params, "device");
      const view: View = { worktreeKey, deviceId: deviceRef, focusAt: Date.now(), stream, live: null };
      views.add(view);
      let closed = false;
      // Band waits only a few seconds for stream.open to answer and a first boot takes minutes, so
      // the handlers are returned at once and the device boots behind them.
      void (async () => {
        try {
          stream.send(JSON.stringify({ type: "booting" }));
          const device = await fleet.exclusive(async () =>
            fleet.ensureOn(await fleet.find(deviceRef), (p) => {
              if (!closed) stream.send(JSON.stringify({ type: "booting", ...p }));
            }),
          );
          view.deviceId = device.id;
          if (closed) return;
          const live = await fleet.backend(device).openStream(device, params);
          if (closed) {
            live.close();
            return;
          }
          view.live = live;
          for await (const message of live.output) {
            if (closed || view.live !== live) break;
            stream.send(message);
          }
        } catch (err) {
          console.error(`simulator screen: ${err instanceof Error ? err.message : err}`);
          if (!closed) stream.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
        } finally {
          // The service ends the stream, so Band will not call onClose: the pane is gone from the registry here.
          if (!closed) {
            views.delete(view);
            stream.end();
          }
        }
      })();
      return {
        onMessage: (message) => {
          if (typeof message === "string" && message.startsWith('{"type":"focus"')) {
            view.focusAt = Date.now();
            fleet.touch(view.deviceId);
            return;
          }
          view.live?.write(message);
        },
        onClose: () => {
          closed = true;
          views.delete(view);
          view.live?.close();
        },
      };
    },
  },

  async onRelease(worktreeKey, reason) {
    if (reason === "removed") {
      await store.forget(worktreeKey);
      await removeLegacy(worktreeKey);
      return;
    }
    // The worktree lets go of its screens: turn off the devices Band booted that nobody else watches.
    const layout = await store.own(worktreeKey);
    const mine = new Set(layout ? deviceIds(layout) : []);
    await fleet.exclusive(() =>
      fleet.shutdownOurs((d) => mine.has(d.id) && ![...views].some((v) => v.deviceId === d.id && v.worktreeKey !== worktreeKey)),
    );
  },

  /**
   * A worktree was removed that this run of the service never served. The folder index in the
   * state dir says which worktree keys lived there.
   */
  async onReleasePath(worktreePath) {
    for (const key of await ios.set.keysAt(worktreePath)) {
      await store.forget(key);
      await removeLegacy(key);
    }
  },

  async onStop() {
    if (sweepTimer) clearInterval(sweepTimer);
    await fleet.exclusive(() => fleet.shutdownOurs());
    await Promise.all(Object.values(fleet.backends).map((b) => b.stopAll()));
  },
}));

/** Deletes the device an earlier version made for a removed worktree, unless a saved layout shows it. */
async function removeLegacy(worktreeKey: string): Promise<void> {
  await fleet.exclusive(async () =>
    ios.set.deleteWorktree(worktreeKey, await store.savedDeviceIds(), (d) => ios.release(d)),
  );
}
