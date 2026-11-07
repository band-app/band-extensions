import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { delimiter, join } from "node:path";
import { createHash } from "node:crypto";
import { parseResolution, readConfig, getStateDir } from "./config.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Programs that hold DISPLAY in their environment without drawing: shells, runtimes and agents. */
const NOT_A_WINDOW = new Set([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "tmux", "screen", "node", "npm", "pnpm", "yarn", "npx",
  "claude", "codex", "gemini", "opencode", "band", "band-worker", "ssh", "sleep", "cat", "tail", "script",
  "git", "make", "sudo", "su", "env", "tsx", "esbuild", "vite", "bun", "deno",
]);

export interface Display {
  key: string;
  /** The X display number, as in `:100`. */
  num: number;
  /** x11vnc's loopback port. */
  vncPort: number;
  width: number;
  height: number;
  /** Open panel streams. */
  viewers: number;
  lastActive: number;
  xvfb: ChildProcess;
  wm: ChildProcess | null;
  vnc: ChildProcess | null;
  /** Programs this service started on the display (the browser). */
  apps: Set<ChildProcess>;
  stopping: boolean;
}

interface Saved {
  key: string;
  num: number;
  pids: number[];
}

function which(bin: string): string | null {
  if (bin.includes("/")) return existsSync(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const full = join(dir, bin);
    try {
      accessSync(full, constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Resolves when something accepts a connection on 127.0.0.1:port; rejects at the deadline or when `dead()`. */
async function waitListening(port: number, dead: () => string | null, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    const gone = dead();
    if (gone) throw new Error(gone);
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ host: "127.0.0.1", port });
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    if (Date.now() > end) throw new Error(`nothing listens on 127.0.0.1:${port}`);
    await sleep(100);
  }
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

/** Every process below `root` in the process tree, read from /proc (Linux). */
function descendants(root: number): number[] {
  const parent = new Map<number, number>();
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        // The command name may hold spaces and parentheses: the fields start after the last ")".
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        parent.set(Number(name), Number(rest[1]));
      } catch {}
    }
  } catch {}
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const next = queue.pop() as number;
    for (const [pid, ppid] of parent) {
      if (ppid === next && !out.includes(pid)) {
        out.push(pid);
        queue.push(pid);
      }
    }
  }
  return out;
}

/** Ends a program and everything it started, including helpers that left its process group. */
function killTreeNow(pid: number): void {
  const below = descendants(pid);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  kill(pid, "SIGKILL");
  for (const p of below) kill(p, "SIGKILL");
}

function kill(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

/**
 * One virtual display per worktree: Xvfb, a window manager when fluxbox is installed, and x11vnc
 * bound to loopback. Displays start on first need and stop when the worktree goes away, the service
 * stops, or nobody has used them for the idle time.
 */
export class Displays {
  private readonly displays = new Map<string, Display>();
  private readonly starting = new Map<string, Promise<Display>>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private readonly log: (message: string) => void = () => undefined) {}

  private get registryFile(): string {
    return join(getStateDir(), "displays.json");
  }

  private save(): void {
    const entries: Saved[] = [...this.displays.values()].map((d) => ({
      key: d.key,
      num: d.num,
      pids: [d.xvfb.pid, d.wm?.pid, d.vnc?.pid, ...[...d.apps].map((a) => a.pid)].filter(
        (p): p is number => typeof p === "number",
      ),
    }));
    try {
      writeFileSync(this.registryFile, JSON.stringify(entries), { mode: 0o600 });
    } catch {}
  }

  /**
   * A service that crashed or was killed leaves its X servers behind. Stops the processes the
   * registry names (when the command line still matches, so a reused pid is left alone) and removes
   * lock files of displays this service started and whose X server is gone. A lock file of any
   * other display is never touched.
   */
  reapOrphans(): void {
    let saved: Saved[] = [];
    try {
      saved = JSON.parse(readFileSync(this.registryFile, "utf8")) as Saved[];
    } catch {
      return;
    }
    for (const entry of saved) {
      for (const pid of entry.pids) {
        const cmd = cmdline(pid);
        if (/Xvfb|x11vnc|fluxbox|chrom|firefox/.test(cmd)) kill(pid, "SIGKILL");
      }
      for (const file of [`/tmp/.X${entry.num}-lock`, `/tmp/.X11-unix/X${entry.num}`]) {
        const owner = file.endsWith("-lock") ? Number(this.readLock(file)) : 0;
        if (owner && cmdline(owner)) continue;
        try {
          rmSync(file, { force: true });
        } catch {}
      }
    }
    try {
      writeFileSync(this.registryFile, "[]", { mode: 0o600 });
    } catch {}
  }

  private readLock(file: string): string {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return "";
    }
  }

  get(key: string): Display | undefined {
    return this.displays.get(key);
  }

  all(): Display[] {
    return [...this.displays.values()];
  }

  /** The display of `key`, started if it is not running. Concurrent calls share one start. */
  ensure(key: string): Promise<Display> {
    const live = this.displays.get(key);
    if (live && !live.stopping) {
      live.lastActive = Date.now();
      return Promise.resolve(live);
    }
    let p = this.starting.get(key);
    if (!p) {
      p = this.start(key).finally(() => this.starting.delete(key));
      this.starting.set(key, p);
    }
    return p;
  }

  touch(key: string): void {
    const d = this.displays.get(key);
    if (d) d.lastActive = Date.now();
  }

  private async start(key: string): Promise<Display> {
    const config = readConfig();
    const res = parseResolution(config.resolution) as { width: number; height: number; depth: number };
    const xvfbBin = which("Xvfb");
    const vncBin = which("x11vnc");
    if (!xvfbBin || !vncBin) throw new Error(`this worker has no ${xvfbBin ? "x11vnc" : "Xvfb"}`);

    // -displayfd makes Xvfb pick a free display number and tell us, so two services never race.
    const xvfb = spawn(
      xvfbBin,
      ["-displayfd", "3", "-screen", "0", `${res.width}x${res.height}x${res.depth}`, "-nolisten", "tcp", "-noreset"],
      { stdio: ["ignore", "ignore", "pipe", "pipe"], env: this.childEnv() },
    );
    let xvfbError = "";
    xvfb.stderr?.on("data", (c: Buffer) => {
      xvfbError = (xvfbError + c.toString()).slice(-2000);
    });
    let exited: string | null = null;
    xvfb.once("exit", (code, signal) => {
      exited = `Xvfb exited (${signal ?? code})${xvfbError ? `: ${xvfbError.trim().split("\n").pop()}` : ""}`;
    });
    const num = await new Promise<number>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("Xvfb did not report a display number")), 15_000);
      (xvfb.stdio[3] as NodeJS.ReadableStream).on("data", (c: Buffer) => {
        buf += c.toString();
        const m = /^(\d+)\n/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      xvfb.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(exited ?? "Xvfb exited"));
      });
      xvfb.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    }).catch((err) => {
      kill(xvfb.pid ?? 0, "SIGKILL");
      throw err;
    });

    const display: Display = {
      key,
      num,
      vncPort: 0,
      width: res.width,
      height: res.height,
      viewers: 0,
      lastActive: Date.now(),
      xvfb,
      wm: null,
      vnc: null,
      apps: new Set(),
      stopping: false,
    };
    this.displays.set(key, display);
    xvfb.once("exit", () => {
      if (!display.stopping) {
        this.log(`Xvfb :${num} of ${key} exited`);
        void this.stop(key);
      }
    });
    try {
      const fluxbox = which("fluxbox");
      if (fluxbox) {
        display.wm = spawn(fluxbox, ["-display", `:${num}`], { stdio: "ignore", env: this.childEnv(num) });
        display.wm.once("error", () => undefined);
      }
      await this.startVnc(display, vncBin);
    } catch (err) {
      await this.stop(key);
      throw err;
    }
    this.save();
    this.ensureSweeper();
    this.log(`display :${num} for ${key} on 127.0.0.1:${display.vncPort}`);
    return display;
  }

  private async startVnc(display: Display, vncBin: string): Promise<void> {
    const port = await freePort();
    // -localhost binds loopback only. Never remove it: there is no VNC password, the link is the auth.
    const vnc = spawn(
      vncBin,
      [
        "-display", `:${display.num}`, "-localhost", "-nopw", "-rfbport", String(port),
        "-forever", "-shared", "-noxdamage", "-quiet",
      ],
      { stdio: ["ignore", "ignore", "pipe"], env: this.childEnv(display.num) },
    );
    let tail = "";
    vnc.stderr?.on("data", (c: Buffer) => {
      tail = (tail + c.toString()).slice(-1000);
    });
    let gone: string | null = null;
    vnc.once("exit", (code, signal) => {
      gone = `x11vnc exited (${signal ?? code})${tail ? `: ${tail.trim().split("\n").pop()}` : ""}`;
      if (!display.stopping && display.vnc === vnc) {
        display.vnc = null;
        // Restart it on the same display, so the programs on it keep their DISPLAY.
        void this.startVnc(display, vncBin).then(() => this.save()).catch((err) => {
          this.log(`x11vnc of ${display.key} did not restart: ${(err as Error).message}`);
          void this.stop(display.key);
        });
      }
    });
    display.vnc = vnc;
    display.vncPort = port;
    await waitListening(port, () => gone);
  }

  /** The environment of a program started on a display: the service's own, with DISPLAY set. */
  childEnv(num?: number): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (num === undefined) delete env.DISPLAY;
    else env.DISPLAY = `:${num}`;
    return env;
  }

  /** Records a program started on the display so it stops with it. */
  track(display: Display, child: ChildProcess): void {
    display.apps.add(child);
    child.once("exit", () => {
      display.apps.delete(child);
      this.save();
    });
    this.save();
  }

  async stop(key: string): Promise<void> {
    const d = this.displays.get(key);
    if (!d || d.stopping) return;
    d.stopping = true;
    this.displays.delete(key);
    for (const app of d.apps) if (app.pid) killTreeNow(app.pid);
    for (const p of [d.vnc, d.wm, d.xvfb]) if (p?.pid) kill(p.pid);
    await Promise.race([
      Promise.all(
        [d.vnc, d.wm, d.xvfb].map((p) =>
          p && p.exitCode === null && p.signalCode === null
            ? new Promise<void>((r) => p.once("exit", () => r()))
            : undefined,
        ),
      ),
      sleep(3000),
    ]);
    for (const p of [d.vnc, d.wm, d.xvfb]) if (p?.pid && p.exitCode === null) kill(p.pid, "SIGKILL");
    // A browser's helper processes may outlive the main one: end the whole tree now.
    for (const app of d.apps) if (app.pid) killTreeNow(app.pid);
    // Xvfb removes its own lock and socket when it exits cleanly; do it for a killed one, for this display only.
    if (d.xvfb.exitCode === null || d.xvfb.signalCode !== null) {
      for (const f of [`/tmp/.X${d.num}-lock`, `/tmp/.X11-unix/X${d.num}`]) rmSync(f, { force: true });
    }
    this.save();
    this.log(`display :${d.num} of ${key} stopped`);
    if (this.displays.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.displays.keys()].map((k) => this.stop(k)));
  }

  /** Synchronous last resort for the `exit` event. */
  killAllNow(): void {
    for (const d of this.displays.values()) {
      for (const app of d.apps) if (app.pid) killTreeNow(app.pid);
      for (const p of [d.vnc, d.wm, d.xvfb]) if (p?.pid) kill(p.pid, "SIGKILL");
    }
  }

  /**
   * Whether a program other than the display's own processes has this display in its environment
   * and is not a shell, runtime or agent: a window may be open. Reads /proc, so it is Linux only.
   */
  hasWindowPrograms(d: Display): boolean {
    const ours = new Set<number>(
      [d.xvfb.pid, d.wm?.pid, d.vnc?.pid, process.pid].filter((p): p is number => typeof p === "number"),
    );
    const needle = `DISPLAY=:${d.num}\0`;
    let pids: string[];
    try {
      pids = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
    } catch {
      return false;
    }
    for (const name of pids) {
      const pid = Number(name);
      if (ours.has(pid)) continue;
      let comm = "";
      try {
        comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (NOT_A_WINDOW.has(comm)) continue;
        if (readFileSync(`/proc/${pid}/environ`, "latin1").includes(needle)) return true;
      } catch {
        // The process ended, or belongs to someone else.
      }
    }
    return false;
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    const every = Math.max(1000, Math.min(30_000, (readConfig().idleSeconds * 1000) / 3));
    this.sweeper = setInterval(() => {
      const idleMs = readConfig().idleSeconds * 1000;
      for (const d of [...this.displays.values()]) {
        if (d.viewers > 0 || this.hasWindowPrograms(d)) {
          d.lastActive = Date.now();
        } else if (Date.now() - d.lastActive > idleMs) {
          this.log(`display :${d.num} of ${d.key} is idle`);
          void this.stop(d.key);
        }
      }
    }, every);
    this.sweeper.unref();
  }
}

/** A stable short name for a worktree key, for folder names. */
export function slug(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}
