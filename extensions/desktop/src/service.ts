import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { getStateDir, readConfig, setStateDir } from "./config.ts";
import { Displays, slug } from "./displays.ts";
import { keysymOfChar, parseKeys } from "./keys.ts";
import { encodePng, halve } from "./png.ts";
import { click, press, typeKeys, withRfb } from "./rfb.ts";
import { defineWorkerService } from "./sdk/index.mjs";

/** An image block in a tool result may hold at most 5 MB decoded; stay under it with room to spare. */
const MAX_IMAGE_BYTES = 4_500_000;
const BROWSERS = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

function obj(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

function num(params: unknown, key: string): number {
  const v = obj(params)[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
  return v;
}

function str(params: unknown, key: string): string {
  const v = obj(params)[key];
  if (typeof v !== "string" || v === "") throw new Error(`${key} must be a non-empty string`);
  return v;
}

const log = (message: string) => console.error(`[desktop] ${message}`);
const displays = new Displays(log);

/** Only these can be opened. A page that is not one of them is refused before a browser starts. */
export function urlAllowed(url: string): boolean {
  if (url === "about:blank") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return ["http:", "https:", "file:", "data:"].includes(parsed.protocol);
}

function findBrowser(): string {
  const config = readConfig();
  for (const name of config.browser ? [config.browser] : BROWSERS) {
    for (const dir of name.includes("/") ? [""] : (process.env.PATH ?? "").split(":")) {
      const full = name.includes("/") ? name : join(dir, name);
      if (dir !== undefined && full && existsSync(full)) return full;
    }
  }
  throw new Error("No browser found on this worker. Install chromium, or set \"browser\" in the Desktop config.json.");
}

defineWorkerService({
  onInit({ stateDir }) {
    setStateDir(stateDir);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    displays.reapOrphans();
  },

  // The worker asks before it starts an agent or a terminal in a worktree: its DISPLAY is this one.
  async worktreeEnv({ worktreeKey }) {
    const d = await displays.ensure(worktreeKey);
    return { DISPLAY: `:${d.num}` };
  },

  calls: {
    async status(_params, { worktreeKey }) {
      const d = await displays.ensure(worktreeKey);
      return {
        display: `:${d.num}`,
        width: d.width,
        height: d.height,
        viewers: d.viewers,
        programs: displays.hasWindowPrograms(d),
      };
    },

    async screenshot(_params, { worktreeKey }) {
      const d = await displays.ensure(worktreeKey);
      let img = await withRfb(d.vncPort, (c) => c.screenshot());
      const fullWidth = img.width;
      let png = encodePng(img);
      let scale = 1;
      while (png.length > MAX_IMAGE_BYTES && img.width > 64) {
        img = halve(img);
        scale *= 2;
        png = encodePng(img);
      }
      displays.touch(worktreeKey);
      const note =
        scale === 1
          ? `Screen ${fullWidth}x${img.height} pixels on display :${d.num}.`
          : `Screen ${fullWidth}x${img.height * scale} pixels on display :${d.num}; this image is ${img.width}x${img.height}, so multiply its coordinates by ${scale} for desktop_click.`;
      return {
        content: [
          { type: "text", text: note },
          { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        ],
      };
    },

    async click(params, { worktreeKey }) {
      const x = num(params, "x");
      const y = num(params, "y");
      const b = obj(params).button ?? "left";
      if (b !== "left" && b !== "middle" && b !== "right") throw new Error("button must be left, middle or right");
      const d = await displays.ensure(worktreeKey);
      await withRfb(d.vncPort, (c) => click(c, x, y, b, obj(params).double === true));
      displays.touch(worktreeKey);
      return { ok: true };
    },

    async type(params, { worktreeKey }) {
      const text = str(params, "text");
      if (text.length > 10_000) throw new Error("text is longer than 10000 characters");
      const d = await displays.ensure(worktreeKey);
      await withRfb(d.vncPort, (c) => typeKeys(c, [...text].map(keysymOfChar)));
      displays.touch(worktreeKey);
      return { ok: true };
    },

    async key(params, { worktreeKey }) {
      const { modifiers, key } = parseKeys(str(params, "keys"));
      const d = await displays.ensure(worktreeKey);
      await withRfb(d.vncPort, (c) => press(c, modifiers, key));
      displays.touch(worktreeKey);
      return { ok: true };
    },

    async openUrl(params, { worktreeKey }) {
      const url = str(params, "url");
      if (!urlAllowed(url)) throw new Error("Only http, https, file, data and about:blank URLs are opened");
      const d = await displays.ensure(worktreeKey);
      const config = readConfig();
      const browser = findBrowser();
      const profile = join(getStateDir(), "browser", slug(worktreeKey));
      mkdirSync(profile, { recursive: true, mode: 0o700 });
      const sandbox = config.noSandbox ?? existsSync("/.dockerenv");
      const child = spawn(
        browser,
        [
          `--user-data-dir=${profile}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-crash-reporter",
          "--disable-breakpad",
          "--start-maximized",
          ...(sandbox ? ["--no-sandbox"] : []),
          url,
        ],
        { stdio: "ignore", detached: true, env: displays.childEnv(d.num) },
      );
      child.unref();
      child.once("error", (err) => log(`browser did not start: ${err.message}`));
      displays.track(d, child);
      displays.touch(worktreeKey);
      return { ok: true, display: `:${d.num}` };
    },
  },

  streams: {
    // The RFB bytes between the panel's noVNC and this worktree's x11vnc, both ways. x11vnc listens
    // on loopback only; this connection is the only way to it from outside the machine.
    screen: async (_params, { worktreeKey }, stream) => {
      const d = await displays.ensure(worktreeKey);
      const socket = connect({ host: "127.0.0.1", port: d.vncPort });
      socket.setNoDelay(true);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
      });
      d.viewers += 1;
      let counted = true;
      const release = () => {
        if (!counted) return;
        counted = false;
        d.viewers = Math.max(0, d.viewers - 1);
        displays.touch(worktreeKey);
      };
      socket.on("data", (chunk) => stream.send(chunk));
      socket.on("error", () => undefined);
      socket.on("close", () => {
        release();
        stream.end();
      });
      return {
        onMessage(message) {
          if (typeof message !== "string") socket.write(message);
        },
        onClose() {
          release();
          socket.destroy();
        },
      };
    },
  },

  onRelease(worktreeKey) {
    // Removed, fenced or shut down: the X servers must not outlive their reason to exist.
    return displays.stop(worktreeKey);
  },

  async onStop() {
    await displays.stopAll();
  },
});

process.on("exit", () => displays.killAllNow());
process.on("SIGTERM", () => {
  displays.killAllNow();
  process.exit(0);
});
