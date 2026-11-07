// Integration test for the desktop extension (S1 to S6, hub side). A real Band hub (from BAND_SRC, a
// checkout with the desktop-as-extension change), the packaged tarball installed through the hub's
// install route, and real `band-worker` processes: one in the band-worker-desktop image (Linux,
// Xvfb, x11vnc, fluxbox, Chromium) and one native on this machine. integration/run.sh copies this
// file into BAND_SRC/apps/hub/tests/ and runs it with that checkout's vitest.
//
// Docker mode (DESKTOP_EXT_IMAGE set, for example on a Mac): the hub runs here and the worker in a
// container labelled band.test=desktop-extension. A small forwarder inside the container makes the
// hub reachable on the container's own loopback, because a worker accepts plain http only for
// loopback. DESKTOP_EXT_WORKER_DIST is this checkout's apps/worker/dist, mounted over the image's
// worker. Native mode (a Linux machine with Xvfb and x11vnc): the worker runs as a child process.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { seedSettings, seedState } from "./helpers/seed-state";
import {
  createTmpHome,
  type ServerHandle,
  startServer,
  trpcData,
  trpcMutate,
  trpcQuery,
} from "./helpers/server";
import { waitFor } from "./helpers/wait-for";
import { WORKER_BIN } from "./helpers/worker-bin";

const TARBALL = process.env.DESKTOP_EXT_TARBALL ?? "";
const IMAGE = process.env.DESKTOP_EXT_IMAGE ?? "";
const WORKER_DIST = process.env.DESKTOP_EXT_WORKER_DIST ?? "";
const TOKEN = "desktop-ext-test-token";
const CAN_RUN = TARBALL !== "" && existsSync(TARBALL) && (IMAGE !== "" || process.platform === "linux");
const LABEL = "band.test=desktop-extension";

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

interface Worker {
  hostId: string;
  /** Runs a command where the worker runs (inside the container, or here). */
  sh(script: string): string;
  stop(): void;
  /** Where the worker keeps the service's config.json. */
  configDir: string;
  repoRoot: string;
}

let server: ServerHandle;
let linux: Worker;
let restricted: Worker | undefined;
let native: Worker | undefined;
const containers: string[] = [];

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

function dockerWorker(label: string, issued: { token: string; hostId: string }): Worker {
  const name = `dx-${label}-${randomBytes(3).toString("hex")}`;
  const port = new URL(server.url).port;
  // The forwarder gives the worker a loopback hub URL; the container reaches the host by name.
  const forwarder =
    `require("net").createServer(c=>{const u=require("net").connect(${port},"host.docker.internal");` +
    `c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy())}).listen(${port},"127.0.0.1")`;
  const args = [
    "run", "-d", "--name", name, "--label", LABEL,
    "--add-host", "host.docker.internal:host-gateway",
    ...(WORKER_DIST ? ["-v", `${WORKER_DIST}:/opt/band-worker/node_modules/@band-app/worker/dist:ro`] : []),
    "--entrypoint", "sh", IMAGE, "-c",
    `node -e '${forwarder}' & exec band-worker --hub http://127.0.0.1:${port} --token ${issued.token} --root /work --state-dir /home/worker/.band/worker`,
  ];
  execFileSync("docker", args, { encoding: "utf8" });
  containers.push(name);
  const sh = (script: string) =>
    execFileSync("docker", ["exec", name, "sh", "-c", script], { encoding: "utf8" });
  return {
    hostId: issued.hostId,
    sh,
    stop: () => {
      try {
        execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore" });
      } catch {}
    },
    configDir: `/home/worker/.band/worker/extension-state/desktop/main`,
    repoRoot: "/work",
  };
}

function nativeWorker(issued: { token: string; hostId: string }): Worker {
  const home = tmp("dx-native-home-");
  const root = tmp("dx-native-root-");
  const state = tmp("dx-native-state-");
  const child = spawn(
    process.execPath,
    [WORKER_BIN, "--hub", server.url, "--token", issued.token, "--root", root, "--state-dir", state],
    {
      env: { ...process.env, HOME: home, BAND_HOME: join(home, ".band"), BAND_TERMINAL_DAEMON: "0" },
      stdio: "ignore",
    },
  );
  return {
    hostId: issued.hostId,
    sh: (script) => execFileSync("sh", ["-c", script], { encoding: "utf8" }),
    stop: () => child.kill("SIGKILL"),
    configDir: join(state, "extension-state", "desktop", "main"),
    repoRoot: root,
  };
}

async function startWorker(label: string, trust?: "restricted"): Promise<Worker> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: `worker-${label}`,
    labels: [],
  });
  const w = IMAGE ? dockerWorker(label, issued) : nativeWorker(issued);
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: `worker ${label} online`, timeoutMs: 60_000 },
  );
  if (trust) await m("hosts.setTrust", { hostId: issued.hostId, trust });
  const repo = `${w.repoRoot}/proj`;
  w.sh(
    `mkdir -p ${repo} && cd ${repo} && git init -q -b main && git config user.email t@e.x && git config user.name t && echo hi > hello.txt && git add . && git commit -q -m init`,
  );
  return w;
}

const worktreeOn = async (w: Worker, branch: string) => {
  await m("worktrees.create", {
    repo: "proj",
    branch,
    hostId: w.hostId,
    hostRepoPath: `${w.repoRoot}/proj`,
  });
  return toWorktreeId("proj", branch, w.hostId);
};

const call = async <T = unknown>(worktreeId: string, method: string, params: unknown = {}): Promise<T> =>
  (await m<{ result: T }>("extensions.callService", { worktreeId, capability: "desktop", method, params }))
    .result;

interface Shot {
  content: Array<{ type: string; text?: string; data?: string }>;
}
interface Pixels {
  width: number;
  height: number;
  at(x: number, y: number): [number, number, number];
}
/** Decodes the RGB, filter-none PNG the service writes. */
function decodePng(base64: string): Pixels {
  const buf = Buffer.from(base64, "base64");
  expect(buf.subarray(1, 4).toString()).toBe("PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
    }
    if (type === "IDAT") idat.push(body);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return {
    width,
    height,
    at: (x, y) => {
      const i = y * (1 + width * 3) + 1 + x * 3;
      return [raw[i] as number, raw[i + 1] as number, raw[i + 2] as number];
    },
  };
}
async function shot(worktreeId: string): Promise<Pixels> {
  const res = await call<Shot>(worktreeId, "screenshot");
  const image = res.content.find((c) => c.type === "image");
  expect(image?.data).toBeTruthy();
  return decodePng(image?.data as string);
}
const near = (rgb: [number, number, number], want: [number, number, number], tol = 24) =>
  rgb.every((v, i) => Math.abs(v - (want[i] as number)) <= tol);
const RED: [number, number, number] = [255, 0, 0];
const LIME: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const PURPLE: [number, number, number] = [128, 0, 128];

/**
 * A page that is red, turns lime on a click, blue when "hi" is typed into its input, and purple on
 * F2. The input is in the top-left corner; the centre is page background.
 */
const PAGE =
  "data:text/html," +
  encodeURIComponent(
    `<body style="margin:0;background:red;height:100vh" onclick="document.body.style.background='lime'" onkeydown="if(event.key==='F2')document.body.style.background='purple'"><input id=i autofocus style="position:fixed;left:0;top:0;width:90px" oninput="if(this.value==='hi')document.body.style.background='blue'"></body>`,
  );

/** The minimal RFB client side: handshake, then input events. Resolves with the server's greeting. */
async function rfbViewer(worktreeId: string, control = true) {
  const url = `${server.url.replace("http", "ws")}/api/extensions/desktop/worktrees/${encodeURIComponent(worktreeId)}/stream?panel=screen&name=screen&params=%7B%7D`;
  const ws = new WebSocket(url, { headers: { Cookie: `band_token=${TOKEN}` } });
  const inbox: Buffer[] = [];
  ws.on("message", (d, isBinary) => {
    if (isBinary) inbox.push(Buffer.from(d as Buffer));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  if (control) ws.send(JSON.stringify({ type: "control", enabled: true }));
  const take = async (n: number): Promise<Buffer> => {
    const got = await waitFor(
      () => {
        const total = inbox.reduce((s, b) => s + b.length, 0);
        return total >= n ? true : undefined;
      },
      { label: `${n} bytes from the display`, timeoutMs: 30_000 },
    );
    void got;
    const all = Buffer.concat(inbox.splice(0));
    inbox.push(all.subarray(n));
    return all.subarray(0, n);
  };
  const greeting = (await take(12)).toString("ascii");
  ws.send(Buffer.from("RFB 003.008\n"));
  const count = (await take(1))[0] as number;
  const types = [...(await take(count))];
  ws.send(Buffer.from([1]));
  const result = (await take(4)).readUInt32BE(0);
  ws.send(Buffer.from([1]));
  const init = await take(24);
  await take(init.readUInt32BE(20));
  const pointer = (x: number, y: number, buttons: number) => {
    const b = Buffer.alloc(6);
    b[0] = 5;
    b[1] = buttons;
    b.writeUInt16BE(x, 2);
    b.writeUInt16BE(y, 4);
    ws.send(b);
  };
  return { ws, greeting, types, result, width: init.readUInt16BE(0), height: init.readUInt16BE(2), pointer };
}

const listeners = (w: Worker): string[] =>
  w
    .sh("cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '$4==\"0A\"{print $2}'")
    .split("\n")
    .filter(Boolean);
/** Loopback in /proc/net/tcp: 0100007F:port, and ::1 or ::ffff:127.0.0.1 in /proc/net/tcp6. */
const isLoopback = (addr: string) =>
  /^0100007F:/.test(addr) ||
  /^00000000000000000000000001000000:/.test(addr) ||
  /^0000000000000000FFFF00000100007F:/.test(addr);
const count = (w: Worker, pattern: string) =>
  Number(w.sh(`ps -eo stat,args | grep -v '^Z' | grep -E '${pattern}' | grep -v grep | wc -l`).trim());

describe.skipIf(!CAN_RUN)("desktop extension", () => {
  let a: string;
  let b: string;

  beforeAll(async () => {
    const hubHome = createTmpHome("dx-hub-");
    scratch.push(hubHome);
    const dir = join(tmp("dx-hub-proj-"), "proj");
    seedSettings(hubHome, {
      tokenSecret: TOKEN,
      codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
      defaultCodingAgent: "claude-code",
    });
    seedState(hubHome, { repos: [] });
    void dir;
    server = await startServer({ tmpHome: hubHome, remoteHost: false, env: { BAND_SERVE_UI: "false" } });
    linux = await startWorker("linux");
    const res = await fetch(`${server.url}/api/extensions/install`, {
      method: "POST",
      headers: { Cookie: `band_token=${TOKEN}` },
      body: readFileSync(TARBALL),
    });
    expect(res.status).toBe(200);
    await waitFor(
      async () => {
        const { hosts } = await q<{ hosts: Array<{ id: string; capabilities: string[] }> }>("hosts.list");
        return hosts.find((h) => h.id === linux.hostId)?.capabilities.includes("desktop") ? true : undefined;
      },
      { label: "the desktop capability on the Linux worker", timeoutMs: 90_000 },
    );
    await m("repos.addFromWorker", { hostId: linux.hostId, path: `${linux.repoRoot}/proj`, addRoot: true });
    a = await worktreeOn(linux, "wt-a");
    b = await worktreeOn(linux, "wt-b");
  }, 300_000);

  afterAll(async () => {
    native?.stop();
    restricted?.stop();
    linux?.stop();
    for (const name of containers) {
      try {
        execFileSync("docker", ["rm", "-f", "-v", name], { stdio: "ignore" });
      } catch {}
    }
    await server?.close();
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  it("S1: the panel stream connects and speaks RFB, and binary input flows in control mode", async () => {
    const v = await rfbViewer(a);
    expect(v.greeting).toMatch(/^RFB 00\d\.00\d\n$/);
    expect(v.types).toContain(1);
    expect(v.result).toBe(0);
    expect([v.width, v.height]).toEqual([1280, 800]);
    v.ws.close();
  }, 120_000);

  it("S2: each worktree has its own display, and its terminals and programs draw on it", async () => {
    const term = async (worktreeId: string, id: string) => {
      await m("terminal.create", {
        worktreeId,
        id,
        command: `echo "D=$DISPLAY;"; echo DONE`,
      });
      const out = await waitFor(
        async () => {
          const r = await q<{ output: string }>("terminal.output", { terminalId: id }).catch(() => undefined);
          return r?.output.includes("DONE") ? r.output : undefined;
        },
        { label: "terminal output", timeoutMs: 40_000 },
      );
      await m("terminal.kill", { terminalId: id });
      return /D=(:\d+);/.exec(out)?.[1];
    };
    const da = await term(a, "6a6a6a6a-0000-4000-8000-000000000001");
    const db = await term(b, "6b6b6b6b-0000-4000-8000-000000000002");
    expect(da).toMatch(/^:\d+$/);
    expect(db).toMatch(/^:\d+$/);
    expect(da).not.toBe(db);
    const status = await call<{ display: string }>(a, "status");
    expect(status.display).toBe(da);

    await call(a, "openUrl", { url: PAGE });
    await waitFor(async () => (near((await shot(a)).at(900, 500), RED) ? true : undefined), {
      label: "the red page on A's display",
      timeoutMs: 40_000,
    });
    // B's display has no browser: not red.
    expect(near((await shot(b)).at(900, 500), RED)).toBe(false);
  }, 240_000);

  it("S3: click, type and key change what the screenshot shows, on one worktree only", async () => {
    const first = await shot(a);
    expect([first.width, first.height]).toEqual([1280, 800]);
    expect(near(first.at(900, 500), RED)).toBe(true);
    await call(a, "click", { x: 640, y: 400 });
    await waitFor(async () => (near((await shot(a)).at(900, 500), LIME) ? true : undefined), {
      label: "the click turned the page lime",
      timeoutMs: 20_000,
    });
    await call(a, "key", { keys: "F2" });
    await waitFor(async () => (near((await shot(a)).at(900, 500), PURPLE) ? true : undefined), {
      label: "F2 turned the page purple",
      timeoutMs: 20_000,
    });
    // Click the input (top-left of the page, below the browser's own toolbar), then type.
    const probe = await shot(a);
    let y = 145;
    for (; y < 260; y++) {
      const p = probe.at(30, y);
      if (near(p, [255, 255, 255], 8)) break; // the input's white box
    }
    expect(y).toBeLessThan(260);
    await call(a, "click", { x: 30, y: y + 6 });
    await call(a, "type", { text: "hi" });
    await waitFor(async () => (near((await shot(a)).at(900, 500), BLUE) ? true : undefined), {
      label: "typing hi turned the page blue",
      timeoutMs: 20_000,
    });
    // Nothing of that reached B.
    const other = (await shot(b)).at(900, 500);
    expect(near(other, BLUE) || near(other, LIME) || near(other, PURPLE)).toBe(false);
    // A bad key name is an error, not a keypress.
    await expect(call(a, "key", { keys: "NotAKey" })).rejects.toThrow(/not a key/i);
    await expect(call(a, "openUrl", { url: "ftp://example.com/x" })).rejects.toThrow(/Only http/);
  }, 240_000);

  it("S4: two viewers of one tab both get the display and both can send input", async () => {
    await call(a, "key", { keys: "F5" }).catch(() => undefined);
    const one = await rfbViewer(a);
    const two = await rfbViewer(a);
    expect(one.greeting).toMatch(/^RFB 00/);
    expect(two.greeting).toMatch(/^RFB 00/);
    // Put the page back to a known colour by reloading it, then click through the second viewer.
    await call(a, "openUrl", { url: PAGE });
    await waitFor(async () => (near((await shot(a)).at(900, 500), RED) ? true : undefined), {
      label: "the page is red again",
      timeoutMs: 40_000,
    });
    two.pointer(640, 400, 1);
    two.pointer(640, 400, 0);
    await waitFor(async () => (near((await shot(a)).at(900, 500), LIME) ? true : undefined), {
      label: "viewer two's click reached the display",
      timeoutMs: 20_000,
    });
    one.ws.close();
    two.ws.close();
  }, 240_000);

  it("S5: nothing listens beyond loopback, and removing the worktree stops its display", async () => {
    for (const addr of listeners(linux)) expect(isLoopback(addr), `listener ${addr}`).toBe(true);
    expect(count(linux, "Xvfb")).toBe(2);
    expect(count(linux, "x11vnc")).toBe(2);
    await m("worktrees.remove", { repo: "proj", name: "wt-b", hostId: linux.hostId });
    await waitFor(() => (count(linux, "Xvfb") === 1 ? true : undefined), {
      label: "B's Xvfb stopped with its worktree",
      timeoutMs: 40_000,
    });
    await waitFor(() => (count(linux, "x11vnc") === 1 ? true : undefined), {
      label: "B's x11vnc stopped",
      timeoutMs: 20_000,
    });
    for (const addr of listeners(linux)) expect(isLoopback(addr), `listener ${addr}`).toBe(true);
  }, 120_000);

  it("S5: the idle timer stops a display nobody uses", async () => {
    linux.sh(`mkdir -p ${linux.configDir} && echo '{"idleSeconds":4}' > ${linux.configDir}/config.json`);
    const c = await worktreeOn(linux, "wt-c");
    const before = count(linux, "Xvfb");
    await call(c, "status");
    expect(count(linux, "Xvfb")).toBe(before + 1);
    // No viewer, no program: the display goes after the idle time.
    await waitFor(() => (count(linux, "Xvfb") === before ? true : undefined), {
      label: "the idle display stopped",
      timeoutMs: 60_000,
    });
    // A viewer keeps it alive past the idle time.
    const v = await rfbViewer(c);
    await new Promise((r) => setTimeout(r, 9000));
    expect(count(linux, "Xvfb")).toBe(before + 1);
    v.ws.close();
    await waitFor(() => (count(linux, "Xvfb") === before ? true : undefined), {
      label: "the display stopped after the viewer left",
      timeoutMs: 60_000,
    });
    linux.sh(`rm -f ${linux.configDir}/config.json`);
  }, 240_000);

  it("S5: removing the extension stops every display and X process", async () => {
    await call(a, "status");
    expect(count(linux, "Xvfb")).toBeGreaterThan(0);
    await m("extensions.remove", { id: "desktop" });
    await waitFor(() => (count(linux, "Xvfb|x11vnc|fluxbox") === 0 ? true : undefined), {
      label: "all display processes stopped",
      timeoutMs: 60_000,
    });
    await waitFor(() => (count(linux, "chromium") === 0 ? true : undefined), {
      label: "the browser stopped",
      timeoutMs: 30_000,
    });
  }, 120_000);

  it("S6: a restricted worker never runs the service; a macOS worker does not offer the tab", async () => {
    // Put the extension back for the remaining checks.
    const res = await fetch(`${server.url}/api/extensions/install`, {
      method: "POST",
      headers: { Cookie: `band_token=${TOKEN}` },
      body: readFileSync(TARBALL),
    });
    expect(res.status).toBe(200);
    restricted = await startWorker("restricted", "restricted");
    const list = await q<{
      hosts: Array<{
        id: string;
        capabilities: string[];
        extensionServices?: Array<{ state: string; reason?: string }>;
      }>;
    }>("hosts.list");
    const row = list.hosts.find((h) => h.id === restricted?.hostId);
    expect(row?.capabilities).not.toContain("desktop");
    expect(row?.extensionServices?.[0]?.state).toBe("not-eligible");
    if (process.platform === "darwin") {
      const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
        hostName: "worker-mac",
        labels: [],
      });
      const mac = nativeWorker(issued);
      native = mac;
      const reason = await waitFor(
        async () => {
          const { hosts } = await q<{
            hosts: Array<{
              id: string;
              status: string;
              capabilities: string[];
              extensionServices?: Array<{ state: string; reason?: string }>;
            }>;
          }>("hosts.list");
          const h = hosts.find((x) => x.id === issued.hostId);
          return h?.status === "online" && h.extensionServices?.[0] ? h : undefined;
        },
        { label: "the Mac worker's service state", timeoutMs: 60_000 },
      );
      expect(reason.capabilities).not.toContain("desktop");
      expect(reason.extensionServices?.[0]?.reason).toMatch(/os=linux/);
      mac.stop();
    }
  }, 240_000);
});
