import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { setStateDir } from "./config.ts";
import { AndroidBackend } from "./android.ts";
import { Fleet, UnknownDevice } from "./fleet.ts";
import { IosBackend } from "./ios.ts";
import { deviceIds } from "./layout.ts";
import { defineWorkerService, type ServiceStream, type WorkerServiceDefinition } from "./sdk/index.mjs";
import { LayoutStore } from "./store.ts";
import type { ScreenStream } from "./stream.ts";
import type { Platform, SimDevice } from "./types.ts";

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

function num(params: unknown, key: string): number {
  const v = obj(params)[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
  return v;
}

/**
 * The simulator as a worker service. The Simulator tab is a canvas of panes, each showing one
 * iOS simulator or Android emulator the person picked or created. Band creates nothing on its
 * own. Agent tools act on the device they name, or else on the device in the pane the person
 * focused last.
 */
const ios = new IosBackend();
const fleet = new Fleet({ ios, android: new AndroidBackend() });
const store = new LayoutStore();

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

/** Runs a tool call on its device, turned on first, and answers with the device list when there is none. */
function onDevice<T>(
  work: (device: SimDevice, params: unknown, scope: { worktreeKey: string; worktreePath: string }) => Promise<T>,
) {
  return async (params: unknown, scope: { worktreeKey: string; worktreePath: string }) => {
    try {
      return await fleet.exclusive(async () => {
        const device = await fleet.ensureOn(await target(params, scope.worktreeKey));
        return work(device, params, scope);
      });
    } catch (err) {
      if (err instanceof NeedDevice) return { content: [{ type: "text", text: err.message }] };
      throw err;
    }
  };
}

const ok = { ok: true };

async function insideWorktree(path: string, worktreePath: string, ext: string): Promise<string> {
  const real = await realpath(path).catch(() => {
    throw new Error(`${path} does not exist`);
  });
  const wt = await realpath(worktreePath);
  if (!real.startsWith(wt + sep) || !real.endsWith(ext)) {
    throw new Error(`path must be an ${ext} ${ext === ".app" ? "folder" : "file"} inside this worktree`);
  }
  return real;
}

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

    status: onDevice(async (device) => {
      const screen = await fleet.backend(device).screen(device);
      return { device, screen };
    }),

    /** Answers with an image block, which Band passes to the agent as an image, and a short text block. */
    screenshot: onDevice(async (device) => {
      const shot = await fleet.backend(device).screenshot(device);
      const unit = device.platform === "ios" ? "points: pixels divided by scale" : "pixels";
      return {
        content: [
          {
            type: "text",
            text: `${device.name}: screenshot ${shot.width}x${shot.height} pixels, scale ${shot.scale ?? "unknown"}. Coordinates for simulator_tap are in ${unit}.`,
          },
          { type: "image", data: shot.data.toString("base64"), mimeType: shot.mimeType },
        ],
      };
    }),

    describe: onDevice((device) => fleet.backend(device).describe(device)),

    tap: onDevice(async (device, params) => {
      await fleet.backend(device).tap(device, num(params, "x"), num(params, "y"));
      return ok;
    }),

    type: onDevice(async (device, params) => {
      await fleet.backend(device).type(device, str(params, "text"));
      return ok;
    }),

    button: onDevice(async (device, params) => {
      await fleet.backend(device).button(device, str(params, "button"));
      return ok;
    }),

    openUrl: onDevice(async (device, params) => {
      const url = str(params, "url");
      if (url.startsWith("-")) throw new Error("url must not start with -");
      await fleet.backend(device).openUrl(device, url);
      return ok;
    }),

    install: onDevice(async (device, params, { worktreePath }) => {
      const backend = fleet.backend(device);
      const real = await insideWorktree(str(params, "path"), worktreePath, backend.installExt);
      await backend.install(device, real);
      return ok;
    }),

    launch: onDevice(async (device, params) => {
      const id = str(params, "bundleId");
      if (id.startsWith("-")) throw new Error("bundleId must not start with -");
      return { output: await fleet.backend(device).launch(device, id) };
    }),
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
