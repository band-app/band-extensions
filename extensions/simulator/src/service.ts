import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, sep } from "node:path";
import { DeviceSet, maxBooted } from "./devices.ts";
import { getStateDir, setStateDir } from "./config.ts";
import { defineWorkerService, type WorkerServiceDefinition } from "./sdk/index.mjs";
import { ServeSimHelpers } from "./servesim.ts";
import {
  jpegSize,
  ORIENTATIONS,
  openScreenStream,
  type ScreenStream,
  serveSimButton,
} from "./stream.ts";
import { run } from "./tools.ts";

function obj(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

function str(params: unknown, key: string): string {
  const v = obj(params)[key];
  if (typeof v !== "string" || v === "") throw new Error(`${key} must be a non-empty string`);
  return v;
}

function num(params: unknown, key: string): number {
  const v = obj(params)[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
  return v;
}

/** Width and height in pixels, from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** An image block in a tool result may hold at most 5 MB decoded; stay under it with room to spare. */
const MAX_IMAGE_BYTES = 4_500_000;

/**
 * The simulator as a worker service. Every worktree gets one device named "Band – <worktree id>"
 * in the machine's default device set, where serve-sim can see it. The person may pick any other
 * iOS device in the panel; the worktree's stream and agent tools then act on it. Band shuts down
 * or deletes only its own devices, except for an explicit Power press on the device shown.
 */
const devices = new DeviceSet();
const helpers = new ServeSimHelpers();
devices.onShutdown = (udid) => helpers.stop(udid);

/** Devices with a viewer on the screen stream now, by udid. */
const watched = new Map<string, number>();
devices.hasLiveStream = (udid) => (watched.get(udid) ?? 0) > 0;

const SWEEP_EVERY_MS = 24 * 3600_000;
let sweepTimer: NodeJS.Timeout | undefined;

/** Deletes the devices of worktrees whose folder is gone. A failure only means the next sweep tries again. */
function sweep(): Promise<void> {
  return devices
    .exclusive(() => devices.sweepRemoved())
    .then(
      (names) => {
        if (names.length > 0) console.error(`simulator: deleted ${names.length} device(s) of removed worktrees`);
      },
      (err: Error) => console.error(`simulator sweep: ${err.message}`),
    );
}

/** Notes where the worktree lives, so a later removal finds its device even after a restart. */
function remember({ worktreeKey, worktreePath }: { worktreeKey: string; worktreePath: string }): void {
  void devices.rememberFolder(worktreeKey, worktreePath);
}

/** Every call and stream notes the worktree's folder before it runs. */
function withFolders(def: WorkerServiceDefinition): WorkerServiceDefinition {
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
    async status(_params, { worktreeKey }) {
      const device = await devices.exclusive(() => devices.current(worktreeKey));
      const screen = device.state === "Booted" ? await helpers.screen(device.udid) : null;
      return {
        udid: device.udid,
        name: device.name,
        state: device.state,
        screen,
        maxBooted: maxBooted(),
      };
    },

    async boot(_params, { worktreeKey }) {
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      return { udid: device.udid, name: device.name, state: device.state };
    },

    /** Every available iOS device, for the panel's picker, with the one this worktree acts on marked. */
    async devices(_params, { worktreeKey }) {
      const current = await devices.exclusive(() => devices.current(worktreeKey));
      const list = await devices.listAll();
      return { current: current.udid, devices: list };
    },

    /** Makes a device the one the panel streams and the agent tools act on, for this worktree. */
    async select(params, { worktreeKey }) {
      const udid = str(params, "udid");
      const device = await devices.exclusive(() => devices.select(worktreeKey, udid));
      return { udid: device.udid, name: device.name, state: device.state };
    },

    /** Shuts down the device shown in the panel: the one this worktree acts on, nothing else. */
    async shutdown(_params, { worktreeKey }) {
      const device = await devices.exclusive(async () => {
        const d = await devices.current(worktreeKey);
        if (d.state !== "Shutdown") await devices.shutdown(d.udid);
        return d;
      });
      return { udid: device.udid, name: device.name, state: "Shutdown" };
    },

    /** Turns the device to an orientation (portrait or landscape_left). */
    async rotate(params, { worktreeKey }) {
      const orientation = str(params, "orientation");
      if (!ORIENTATIONS.includes(orientation)) {
        throw new Error(`orientation must be one of ${ORIENTATIONS.join(", ")}`);
      }
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      await helpers.rotate(device.udid, orientation);
      return { ok: true };
    },

    /**
     * Answers with an image block, which Band passes to the agent as an image, and a short text
     * block with the size and scale. The PNG is read once and deleted. A PNG over the image limit
     * is taken again as a JPEG.
     */
    async screenshot(_params, { worktreeKey }) {
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      const dir = join(getStateDir(), "screenshots");
      await mkdir(dir, { recursive: true });
      const base = join(dir, `shot-${device.udid}-${Date.now()}`);
      const take = async (type: "png" | "jpeg") => {
        const file = `${base}.${type === "png" ? "png" : "jpg"}`;
        try {
          await run("xcrun", ["simctl", "io", device.udid, "screenshot", `--type=${type}`, file]);
          return await readFile(file);
        } finally {
          await rm(file, { force: true });
        }
      };
      let image = await take("png");
      let mimeType: "image/png" | "image/jpeg" = "image/png";
      let size: { width: number; height: number } | null = pngSize(image);
      if (image.length > MAX_IMAGE_BYTES) {
        image = await take("jpeg");
        mimeType = "image/jpeg";
        size = jpegSize(image) ?? size;
      }
      const screen = await helpers.screen(device.udid);
      const scale = screen && size ? Math.round((size.width / screen.width) * 100) / 100 : null;
      return {
        content: [
          {
            type: "text",
            text: `Screenshot ${size?.width ?? "?"}x${size?.height ?? "?"} pixels, scale ${scale ?? "unknown"}. Coordinates for simulator_tap are in points: pixels divided by scale.`,
          },
          { type: "image", data: image.toString("base64"), mimeType },
        ],
      };
    },

    async describe(_params, { worktreeKey }) {
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      return helpers.describe(device.udid);
    },

    async tap(params, { worktreeKey }) {
      const x = num(params, "x");
      const y = num(params, "y");
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      await helpers.tap(device.udid, x, y);
      return { ok: true };
    },

    async type(params, { worktreeKey }) {
      const text = str(params, "text");
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      await helpers.type(device.udid, text);
      return { ok: true };
    },

    async button(params, { worktreeKey }) {
      const name = serveSimButton(str(params, "button"));
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      await helpers.button(device.udid, name);
      return { ok: true };
    },

    async openUrl(params, { worktreeKey }) {
      const url = str(params, "url");
      if (url.startsWith("-")) throw new Error("url must not start with -");
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      await run("xcrun", ["simctl", "openurl", device.udid, url]);
      return { ok: true };
    },

    async install(params, { worktreeKey, worktreePath }) {
      const path = str(params, "path");
      const app = await realpath(path).catch(() => {
        throw new Error(`${path} does not exist`);
      });
      const wt = await realpath(worktreePath);
      if (!app.startsWith(wt + sep) || !app.endsWith(".app")) {
        throw new Error("path must be an .app folder inside this worktree");
      }
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      await run("xcrun", ["simctl", "install", device.udid, app], { timeoutMs: 5 * 60_000 });
      return { ok: true };
    },

    async launch(params, { worktreeKey }) {
      const bundleId = str(params, "bundleId");
      if (bundleId.startsWith("-")) throw new Error("bundleId must not start with -");
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      const { stdout } = await run("xcrun", ["simctl", "launch", device.udid, bundleId]);
      return { output: stdout.trim() };
    },
  },

  streams: {
    /**
     * The live screen. Messages to the viewer are one text `{"type":"info"}` and then one binary
     * JPEG per frame. Messages from the viewer are JSON: `touch`, `button`, `key` and `text`.
     * The stream acts on the worktree's current device, so the panel reopens it after a pick.
     */
    screen(params, { worktreeKey }, stream) {
      // Band waits only a few seconds for stream.open to answer, and a first boot takes minutes
      // (a clone of a new base device). So the handlers are returned at once and the device boots
      // behind them. The viewer sees a text "booting" message, then info, then frames.
      let live: ScreenStream | null = null;
      let closed = false;
      let watching: string | null = null;
      const unwatch = () => {
        if (watching === null) return;
        const left = (watched.get(watching) ?? 1) - 1;
        if (left > 0) watched.set(watching, left);
        else watched.delete(watching);
        watching = null;
      };
      void (async () => {
        try {
          stream.send(JSON.stringify({ type: "booting" }));
          const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
          watching = device.udid;
          watched.set(watching, (watched.get(watching) ?? 0) + 1);
          const helper = await helpers.helper(device.udid);
          const screen = (await helpers.screen(device.udid)) ?? { width: 0, height: 0 };
          if (closed) return;
          live = openScreenStream(
            helper,
            helpers,
            { ...screen, udid: device.udid, name: device.name },
            // Band sets `profile`: "direct" for the desktop app on this machine (full size and
            // rate), "hub" when the hub carries the frames (half size, 15 fps at most).
            obj(params),
          );
          for await (const message of live.output) {
            if (closed) break;
            stream.send(message);
          }
        } catch (err) {
          console.error(`simulator screen: ${err instanceof Error ? err.message : err}`);
        } finally {
          unwatch();
          if (!closed) stream.end();
        }
      })();
      return {
        onMessage: (message) => live?.write(message),
        onClose: () => {
          closed = true;
          unwatch();
          live?.close();
        },
      };
    },
  },

  async onRelease(worktreeKey, reason) {
    await devices.exclusive(() =>
      reason === "removed"
        ? devices.deleteWorktree(worktreeKey)
        : devices.shutdownWorktree(worktreeKey),
    );
  },

  /**
   * A worktree was removed that this run of the service never served. The folder index in the
   * state dir says which worktree keys lived there, so the device goes even after a restart.
   */
  async onReleasePath(worktreePath) {
    await devices.exclusive(async () => {
      for (const key of await devices.keysAt(worktreePath)) await devices.deleteWorktree(key);
    });
  },

  async onStop() {
    if (sweepTimer) clearInterval(sweepTimer);
    await devices.exclusive(() => devices.shutdownAll());
    await helpers.stopAll();
  },
}));
