import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, getStateDir } from "./config.ts";
import { ensureOpenShim } from "./shim.ts";
import { run } from "./tools.ts";

/** One serve-sim helper: the process that captures a booted device and takes HID input for it. */
export interface Helper {
  udid: string;
  port: number;
  streamUrl: string;
  wsUrl: string;
  axUrl: string;
}

export interface Screen {
  /** Width and height in points. */
  width: number;
  height: number;
}

/** The part of serve-sim's accessibility tree the screen size comes from. */
interface AxNode {
  frame?: { x: number; y: number; width: number; height: number };
}

/** The serve-sim this extension ships (pinned in package.json), unless the config names another. */
function serveSimEntry(): string {
  const override = config().serveSimEntry;
  if (override) return override;
  return fileURLToPath(new URL("./node_modules/serve-sim/dist/serve-sim.js", import.meta.url));
}

/** Runs the serve-sim CLI with this process's own Node (Electron runs as Node in the desktop app). */
function serveSim(args: string[], options: { stdin?: string; timeoutMs?: number } = {}) {
  return run(process.execPath, [serveSimEntry(), ...args], {
    ...options,
    // The helper outlives the call and runs third-party code, so it gets no Band or credential variables.
    env: childEnv(),
  });
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "DEVELOPER_DIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // serve-sim opens Simulator.app with `open -a Simulator`. The shim, first on PATH, keeps that
  // window hidden and in the background: the Simulator tab is how a person sees the device.
  if (process.platform === "darwin") {
    let shimDir: string | null = null;
    try {
      shimDir = ensureOpenShim(join(getStateDir(), "bin"));
    } catch {
      // No state dir yet (the service runs outside a worker): the real `open` is used.
    }
    if (shimDir) env.PATH = `${shimDir}${delimiter}${env.PATH ?? ""}`;
  }
  return env;
}

/**
 * Capture and input for booted simulators, through serve-sim (npm, pinned by this extension; it drives
 * the simulator's private HID and framebuffer APIs). One detached helper runs per device. The
 * helper serves an MJPEG stream and the accessibility tree over HTTP and takes input on a
 * WebSocket. Starting a helper that already runs returns the running one.
 */
export class ServeSimHelpers {
  private readonly helpers = new Map<string, Promise<Helper>>();

  /** The helper for a booted device, started on first use. */
  helper(udid: string): Promise<Helper> {
    let existing = this.helpers.get(udid);
    if (!existing) {
      existing = this.start(udid);
      this.helpers.set(udid, existing);
      existing.catch(() => this.helpers.delete(udid));
    }
    return existing;
  }

  private async start(udid: string): Promise<Helper> {
    const { stdout } = await serveSim(
      ["--detach", "-q", "--no-preview", "--exit-on-simulator-shutdown", udid],
      { timeoutMs: 90_000 },
    );
    const line = stdout.trim().split("\n").pop() ?? "";
    let info: { port?: unknown; streamUrl?: unknown; wsUrl?: unknown; device?: unknown };
    try {
      info = JSON.parse(line);
    } catch {
      throw new Error(`serve-sim did not report its endpoints: ${line.slice(0, 200)}`);
    }
    if (
      typeof info.port !== "number" ||
      typeof info.streamUrl !== "string" ||
      typeof info.wsUrl !== "string"
    ) {
      throw new Error("serve-sim did not report its endpoints");
    }
    return {
      udid,
      port: info.port,
      streamUrl: info.streamUrl,
      wsUrl: info.wsUrl,
      axUrl: info.streamUrl.replace(/\/stream\.mjpeg$/, "/ax"),
    };
  }

  /** Forgets a helper whose process died, so the next call starts a new one. */
  forget(udid: string): void {
    this.helpers.delete(udid);
  }

  private async tree(udid: string): Promise<AxNode[]> {
    let helper = await this.helper(udid);
    let res: Response;
    try {
      res = await fetch(helper.axUrl, { signal: AbortSignal.timeout(20_000) });
    } catch {
      // The helper died (its device was shut down elsewhere): start a new one once.
      this.forget(udid);
      helper = await this.helper(udid);
      res = await fetch(helper.axUrl, { signal: AbortSignal.timeout(20_000) });
    }
    if (!res.ok) {
      this.forget(udid);
      throw new Error(`serve-sim accessibility request failed: ${res.status}`);
    }
    const body = (await res.json()) as AxNode[] | { error?: string };
    if (!Array.isArray(body)) throw new Error(body.error ?? "Accessibility unavailable");
    return body;
  }

  /** The screen size in points, from the accessibility tree's root. */
  async screen(udid: string): Promise<Screen | null> {
    try {
      const frame = (await this.tree(udid))[0]?.frame;
      return frame ? { width: frame.width, height: frame.height } : null;
    } catch {
      return null;
    }
  }

  async type(udid: string, text: string): Promise<void> {
    await this.helper(udid);
    await serveSim(["type", "-d", udid, "--stdin"], { stdin: text });
  }

  async rotate(udid: string, orientation: string): Promise<void> {
    await this.helper(udid);
    await serveSim(["rotate", "-d", udid, orientation]);
  }

  /** Stops the device's helper. */
  async stop(udid: string): Promise<void> {
    this.helpers.delete(udid);
    await serveSim(["--kill", udid], { timeoutMs: 20_000 }).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    const udids = [...this.helpers.keys()];
    this.helpers.clear();
    await Promise.all(
      udids.map((udid) => serveSim(["--kill", udid], { timeoutMs: 20_000 }).catch(() => undefined)),
    );
  }
}
