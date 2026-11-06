import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { DeviceSet, maxBooted } from "./devices.ts";
import { getStateDir, setStateDir } from "./config.ts";
import { defineWorkerService } from "./sdk/index.mjs";
import { ServeSimHelpers } from "./servesim.ts";
import { openScreenStream, type ScreenStream, serveSimButton } from "./stream.ts";
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

/** Screenshots kept per service. Older ones are deleted when a new one is taken. */
const KEEP_SCREENSHOTS = 10;

async function pruneScreenshots(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((n) => n.endsWith(".png"))
      .map(async (n) => ({
        n,
        t: await stat(join(dir, n)).then((s) => s.mtimeMs, () => 0),
      })),
  );
  files.sort((a, b) => b.t - a.t);
  for (const old of files.slice(KEEP_SCREENSHOTS)) await rm(join(dir, old.n), { force: true });
}

/**
 * The simulator as a worker service. Every worktree gets one device named "Band – <worktree id>"
 * in the machine's default device set, where serve-sim can see it. Only devices with that name
 * prefix are ever touched.
 */
const devices = new DeviceSet();
const helpers = new ServeSimHelpers();
devices.onShutdown = (udid) => helpers.stop(udid);

defineWorkerService({
  onInit({ stateDir }) {
    setStateDir(stateDir);
  },

  calls: {
    async status(_params, { worktreeKey }) {
      const device = await devices.exclusive(() => devices.ensureDevice(worktreeKey));
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

    /**
     * A tool result is JSON text, so the PNG goes to a file the agent can open. A base64 string of
     * a full-size screenshot would cost hundreds of thousands of tokens.
     */
    async screenshot(_params, { worktreeKey }) {
      const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
      const dir = join(getStateDir(), "screenshots");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `shot-${device.udid}-${Date.now()}.png`);
      await run("xcrun", ["simctl", "io", device.udid, "screenshot", "--type=png", file]);
      const png = await readFile(file);
      const screen = await helpers.screen(device.udid);
      const { width, height } = pngSize(png);
      await pruneScreenshots(dir);
      return {
        path: file,
        width,
        height,
        scale: screen ? Math.round((width / screen.width) * 100) / 100 : null,
        note: "Open the PNG at path to see the screen. Coordinates for simulator_tap are in points: pixels divided by scale.",
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
     * Band drops them until the person takes control.
     */
    screen(params, { worktreeKey }, stream) {
      // Band waits only a few seconds for stream.open to answer, and a first boot takes minutes
      // (a clone of a new base device). So the handlers are returned at once and the device boots
      // behind them. The viewer sees a text "booting" message, then info, then frames.
      let live: ScreenStream | null = null;
      let closed = false;
      void (async () => {
        try {
          stream.send(JSON.stringify({ type: "booting" }));
          const device = await devices.exclusive(() => devices.ensureBooted(worktreeKey));
          const helper = await helpers.helper(device.udid);
          const screen = (await helpers.screen(device.udid)) ?? { width: 0, height: 0 };
          if (closed) return;
          live = openScreenStream(
            helper,
            helpers,
            { ...screen, udid: device.udid, name: device.name },
            // Every frame crosses the link and the hub, so the half-size 15 fps profile always applies.
            { ...obj(params), profile: "hub" },
          );
          for await (const message of live.output) {
            if (closed) break;
            stream.send(message);
          }
        } catch (err) {
          console.error(`simulator screen: ${err instanceof Error ? err.message : err}`);
        } finally {
          if (!closed) stream.end();
        }
      })();
      return {
        onMessage: (message) => live?.write(message),
        onClose: () => {
          closed = true;
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

  async onStop() {
    await devices.exclusive(() => devices.shutdownAll());
    await helpers.stopAll();
  },
});
