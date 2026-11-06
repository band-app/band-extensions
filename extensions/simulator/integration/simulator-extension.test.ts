// Integration test for the simulator extension (S2, S3, S5). A real Band hub and real `band-worker`
// processes from a Band checkout of the simulator-as-extension branch (BAND_SRC), the packaged tarball installed through the
// hub's install route, and a real Xcode on this Mac. integration/run.sh copies this file into
// BAND_SRC/apps/hub/tests/ and runs it with that checkout's vitest.
//
// Devices: the worker's service reads `config.json` in its state dir (the worker gives a service
// no BAND_* variable), so the test writes a name prefix of its own there. Only devices with that
// prefix are created, booted or deleted, and the test deletes every one of them at the end.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { openStream, STUB_AGENT_PATH, TEST_TOKEN, turnEnded } from "./helpers/acp-chat";
import { startCuttableProxy } from "./helpers/cuttable-proxy";
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

const TARBALL = process.env.SIM_EXT_TARBALL ?? "";
const hasSimctl = (() => {
  try {
    execFileSync("xcrun", ["simctl", "help"], { stdio: "ignore" });
    return process.platform === "darwin";
  } catch {
    return false;
  }
})();
const CAN_RUN = hasSimctl && TARBALL !== "" && existsSync(TARBALL);

/** The prefix of every device this run creates. A person's devices never start with it. */
const PREFIX = `Band simext ${randomBytes(4).toString("hex")}`;
const SEP = "–";

/** Whether Simulator.app was open and visible before this run, so the window check can stand aside. */
const simulatorAppWasVisible = (() => {
  if (process.platform !== "darwin") return false;
  try {
    return execFileSync(
      "osascript",
      ["-e", 'tell application "System Events" to get visible of (processes whose name is "Simulator")'],
      { encoding: "utf8", timeout: 20_000 },
    ).includes("true");
  } catch {
    return false;
  }
})();

const scratch: string[] = [];
const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

interface Worker {
  hostId: string;
  child: ChildProcess;
  state: string;
  repo: string;
  httpLog: string;
  scenario: string;
}

let server: ServerHandle;
let mac: Worker;
let restricted: Worker;
let fenced: Worker;
let proxy: Awaited<ReturnType<typeof startCuttableProxy>>;
let chatCount = 0;
let a: string;
let b: string;
let fencedWorktree: string;

const m = <T>(procedure: string, input: unknown) =>
  trpcMutate(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });
const q = <T>(procedure: string, input?: unknown) =>
  trpcQuery(server.url, procedure, input, TEST_TOKEN).then(async (res) => {
    if (res.status !== 200) throw new Error(`${procedure}: HTTP ${res.status} ${await res.text()}`);
    return trpcData<T>(res);
  });

interface SimDevice {
  udid: string;
  name: string;
  state: string;
}
const allDevices = (): SimDevice[] => {
  const out = execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" });
  return Object.values((JSON.parse(out) as { devices: Record<string, SimDevice[]> }).devices).flat();
};
/** The devices of this run, in the default device set. */
const listDevices = () => allDevices().filter((d) => d.name.startsWith(`${PREFIX} ${SEP} `));
/** Every device that is not this run's, as name and state, to prove the run left them alone. */
const othersSnapshot = () =>
  allDevices()
    .filter((d) => !d.name.startsWith(`${PREFIX} ${SEP} `))
    .map((d) => `${d.udid} ${d.name} ${d.state}`)
    .sort();

async function startWorker(
  name: string,
  opts: { hub?: string; config?: Record<string, unknown> } = {},
): Promise<Worker> {
  const issued = await m<{ token: string; hostId: string }>("tokens.issueWorkerBootstrap", {
    hostName: name,
    labels: [],
  });
  const home = tmp(`band-simext-${name}-home-`);
  const root = tmp(`band-simext-${name}-root-`);
  const state = tmp(`band-simext-${name}-state-`);
  const repo = join(root, "proj");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const stateDir = join(state, "extension-state", "simulator", "main");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "config.json"),
    JSON.stringify({ namePrefix: PREFIX, maxBooted: 1, ...opts.config }),
  );
  const httpLog = join(home, "http-log.jsonl");
  const scenario = join(home, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ turns: [] }));
  // No BAND_* from the Band worker this test runs in.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("BAND_")),
  );
  const child = spawn(
    process.execPath,
    [
      WORKER_BIN,
      "--hub",
      opts.hub ?? server.url,
      "--token",
      issued.token,
      "--root",
      root,
      "--state-dir",
      state,
    ],
    {
      env: {
        ...baseEnv,
        HOME: home,
        BAND_HOME: join(home, ".band"),
        BAND_TERMINAL_DAEMON: "0",
        BAND_TEST_ACP_AGENT: STUB_AGENT_PATH,
        BAND_TEST_ACP_STATE: join(home, "acp-state"),
        BAND_TEST_ACP_LOG: join(home, "stub-log.jsonl"),
        BAND_TEST_ACP_HTTP_LOG: httpLog,
        BAND_TEST_ACP_SCENARIO: scenario,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", () => undefined);
  child.stderr?.on("data", () => undefined);
  await waitFor(
    async () => {
      const { hosts } = await q<{ hosts: Array<{ id: string; status: string }> }>("hosts.list");
      return hosts.find((h) => h.id === issued.hostId)?.status === "online" ? true : undefined;
    },
    { label: `${name} online`, timeoutMs: 30_000 },
  );
  return { hostId: issued.hostId, child, state, repo, httpLog, scenario };
}

interface HostView {
  id: string;
  status: string;
  capabilities: string[];
  extensionServices: Array<{ extensionId: string; state: string; reason?: string; version: string }>;
}
const hostOf = async (w: Worker) =>
  (await q<{ hosts: HostView[] }>("hosts.list")).hosts.find((h) => h.id === w.hostId) as HostView;

async function createWorktree(w: Worker, branch: string): Promise<string> {
  await m("worktrees.create", { repo: "proj", branch, hostId: w.hostId, hostRepoPath: w.repo });
  return toWorktreeId("proj", branch, w.hostId);
}

interface ToolReply {
  status: number;
  rpc: {
    result?: { content?: Array<Record<string, string>>; isError?: boolean; tools?: { name: string }[] };
  };
}

/** Sends one prompt on a worktree's chat; the stub runs the matching scenario turn and logs each tool reply. */
async function turn(
  w: Worker,
  worktreeId: string,
  prompt: string,
  steps: Array<Record<string, unknown>>,
): Promise<Record<string, ToolReply>> {
  const prior = existsSync(w.scenario)
    ? (JSON.parse(readFileSync(w.scenario, "utf8")) as { turns: unknown[] }).turns
    : [];
  writeFileSync(
    w.scenario,
    JSON.stringify({ turns: [...prior, { match: `^${prompt}$`, steps: [...steps, { say: "done" }] }] }),
  );
  // A kept-alive connection the hub closed between two turns fails the first request on it with
  // ECONNRESET. Nothing was sent, so the turn starts again on a fresh chat id.
  for (let attempt = 0; ; attempt++) {
    const chatId = `simext-chat-${chatCount++}`;
    try {
      const stream = await openStream(server.url, chatId, { until: turnEnded, timeoutMs: 400_000 });
      const res = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `band_token=${TEST_TOKEN}` },
        body: JSON.stringify({ worktreeId, text: prompt }),
      });
      if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
      await stream.events;
      break;
    } catch (err) {
      const reset = /fetch failed|ECONNRESET/.test(String(err) + String((err as Error)?.cause));
      if (!reset || attempt >= 2) throw err;
    }
  }
  const lines = readFileSync(w.httpLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { name: string; status: number; body: string });
  const out: Record<string, ToolReply> = {};
  for (const l of lines) {
    const data = l.body.split("\n").find((x) => x.startsWith("data:"));
    out[l.name] = { status: l.status, rpc: JSON.parse(data ? data.slice(5) : l.body || "{}") };
  }
  return out;
}

const call = (name: string, tool: string, args: Record<string, unknown> = {}) => ({
  mcpCall: { name, server: "band", tool, args, fullBody: true },
});
const textOf = (r: ToolReply | undefined) =>
  JSON.parse(r?.rpc.result?.content?.find((c) => c.type === "text")?.text ?? "{}") as Record<
    string,
    unknown
  >;
const failed = (r: ToolReply | undefined) => r?.rpc.result?.isError === true;
/** The image block of a tool reply and the text block that goes with it. */
const imageOf = (r: ToolReply | undefined) => {
  const content = r?.rpc.result?.content ?? [];
  const image = content.find((c) => c.type === "image");
  const text = content.find((c) => c.type === "text")?.text ?? "";
  const bytes = Buffer.from(image?.data ?? "", "base64");
  return {
    mimeType: image?.mimeType,
    bytes,
    text,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
};

function cleanupDevices() {
  for (const d of listDevices()) {
    for (const cmd of ["shutdown", "delete"]) {
      try {
        execFileSync("xcrun", ["simctl", cmd, d.udid], { stdio: "ignore" });
      } catch {}
    }
  }
}

/** A minimal simulator app: a C program that sleeps, signed ad hoc. */
function buildApp(dir: string): string {
  const app = join(dir, "Probe.app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(dir, "main.c"), "#include <unistd.h>\nint main(void){for(;;)sleep(100);}\n");
  execFileSync("xcrun", [
    "--sdk",
    "iphonesimulator",
    "clang",
    "-arch",
    "arm64",
    "-target",
    "arm64-apple-ios17.0-simulator",
    "-o",
    join(app, "Probe"),
    join(dir, "main.c"),
  ]);
  writeFileSync(
    join(app, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.band.simext.probe</string>
<key>CFBundleExecutable</key><string>Probe</string>
<key>CFBundleName</key><string>Probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
<key>MinimumOSVersion</key><string>17.0</string>
<key>UIDeviceFamily</key><array><integer>1</integer></array>
</dict></plist>
`,
  );
  execFileSync("codesign", ["-f", "-s", "-", app]);
  return app;
}

beforeAll(async () => {
  if (!CAN_RUN) return;
  const free = execFileSync("df", ["-k", tmpdir()], { encoding: "utf8" }).split("\n")[1]?.split(/\s+/)[3];
  if (Number(free) < 6 * 1024 * 1024) throw new Error("less than 6 GB of free disk for the simulator test");
  const hubHome = createTmpHome("band-simext-hub-");
  scratch.push(hubHome);
  const hubRepo = join(tmp("band-simext-hubrepo-"), "proj");
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  seedSettings(hubHome, {
    tokenSecret: TEST_TOKEN,
    codingAgents: [{ id: "claude-code", type: "claude-code", label: "Claude Code" }],
    defaultCodingAgent: "claude-code",
  });
  seedState(hubHome, {
    repos: [
      { name: "proj", path: hubRepo, defaultBranch: "main", worktrees: [{ branch: "main", path: hubRepo }] },
    ],
  });
  server = await startServer({
    tmpHome: hubHome,
    remoteHost: false,
    // A 10 s lease makes the fence quick. The workers are the only thing that reads it.
    env: { BAND_SERVE_UI: "false", BAND_WORKER_LEASE_MS: "10000" },
  });
  mac = await startWorker("mac");
  restricted = await startWorker("restricted");
  await m("hosts.setTrust", { hostId: restricted.hostId, trust: "restricted" });
  const res = await fetch(`${server.url}/api/extensions/install`, {
    method: "POST",
    headers: { Cookie: `band_token=${TEST_TOKEN}` },
    body: readFileSync(TARBALL),
  });
  if (res.status !== 200) throw new Error(`install: HTTP ${res.status} ${await res.text()}`);
  a = await createWorktree(mac, "a");
  b = await createWorktree(mac, "b");
  await waitFor(async () => ((await hostOf(mac)).capabilities.includes("simulator") ? true : undefined), {
    label: "the simulator capability on the Mac worker",
    timeoutMs: 60_000,
  });
}, 300_000);

afterAll(async () => {
  for (const w of [mac, restricted, fenced]) w?.child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 3000));
  for (const w of [mac, restricted, fenced]) w?.child.kill("SIGKILL");
  await proxy?.close();
  if (CAN_RUN) cleanupDevices();
  await server?.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
}, 120_000);

describe.skipIf(!CAN_RUN)("simulator extension", () => {
  it("S2: extensions.list shows it; the Mac worker reports the capability; a restricted worker never gets it", async () => {
    const { extensions } = await q<{
      extensions: Array<{
        id: string;
        version: string;
        contributes: { panels: unknown[]; tools: Array<{ name: string }>; workerServices: unknown[] };
      }>;
    }>("extensions.list");
    const ext = extensions.find((e) => e.id === "simulator");
    expect(ext?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ext?.contributes.panels).toHaveLength(1);
    expect(ext?.contributes.tools.map((t) => t.name).sort()).toEqual(
      ["button", "describe", "install", "launch", "open_url", "screenshot", "status", "tap", "type"].sort(),
    );

    const macHost = await hostOf(mac);
    expect(macHost.capabilities).toContain("simulator");
    expect(macHost.extensionServices).toMatchObject([{ extensionId: "simulator", state: "running" }]);

    const r = await hostOf(restricted);
    expect(r.capabilities).not.toContain("simulator");
    expect(r.extensionServices).toMatchObject([{ state: "not-eligible", reason: "restricted" }]);
    expect(existsSync(join(restricted.state, "extensions", "simulator"))).toBe(false);

    // A tool call from a chat on the restricted worker names the worker and boots nothing.
    const w = await createWorktree(restricted, "r");
    const reply = await turn(restricted, w, "r-status", [call("rs", "simulator_status")]);
    expect(failed(reply.rs)).toBe(true);
    expect(JSON.stringify(reply.rs?.rpc)).toContain(restricted.hostId);
    expect(listDevices()).toHaveLength(0);
  }, 120_000);

  it("S3: the band MCP server lists the nine simulator tools", async () => {
    const r = await turn(mac, a, "a-list", [
      { mcpCall: { name: "list", server: "band", tool: "", method: "tools/list", fullBody: true } },
    ]);
    const names = (r.list?.rpc.result?.tools ?? []).map((t) => t.name).filter((n) => n.startsWith("simulator_"));
    expect(names.sort()).toEqual(
      [
        "simulator_button",
        "simulator_describe",
        "simulator_install",
        "simulator_launch",
        "simulator_open_url",
        "simulator_screenshot",
        "simulator_status",
        "simulator_tap",
        "simulator_type",
      ].sort(),
    );
  }, 120_000);

  it("S3: each worktree gets its own device under the run's prefix, and an argument cannot name another worktree", async () => {
    const before = othersSnapshot();
    const ra = await turn(mac, a, "a-status", [
      call("a-status", "simulator_status"),
      call("a-status-spoof", "simulator_status", { worktreeId: b }),
    ]);
    const rb = await turn(mac, b, "b-status", [call("b-status", "simulator_status")]);
    const ua = textOf(ra["a-status"]).udid;
    const ub = textOf(rb["b-status"]).udid;
    expect(ua).toBeTruthy();
    expect(ub).toBeTruthy();
    expect(ua).not.toBe(ub);
    expect(textOf(ra["a-status-spoof"]).udid).toBe(ua);
    expect(textOf(ra["a-status"]).state).toBe("Shutdown");
    expect(textOf(ra["a-status"]).maxBooted).toBe(1);
    const names = listDevices().map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining([`${PREFIX} ${SEP} ${a}`, `${PREFIX} ${SEP} ${b}`, `${PREFIX} ${SEP} base`]));
    expect(othersSnapshot()).toEqual(before);
  }, 400_000);

  it("S3: screenshot, launch, home, describe, tap, type, open_url and install answer; the cap of one booted device holds", async () => {
    const before = othersSnapshot();
    const app = buildApp(tmp("band-simext-app-"));
    const r = await turn(mac, a, "a-drive", [
      call("shot1", "simulator_screenshot"),
      call("launch", "simulator_launch", { bundleId: "com.apple.Preferences" }),
      { sleep: 3000 },
      call("shot2", "simulator_screenshot"),
      call("home", "simulator_button", { button: "HOME" }),
      { sleep: 1500 },
      call("describe", "simulator_describe"),
      call("shot3", "simulator_screenshot"),
    ]);
    for (const name of ["shot1", "shot2", "shot3"]) {
      expect(failed(r[name]), JSON.stringify(r[name]?.rpc)).toBe(false);
      // An image block, not a file path, plus a text block with the pixel size and the scale.
      const shot = imageOf(r[name]);
      expect(shot.mimeType).toBe("image/png");
      expect(shot.bytes.subarray(1, 4).toString()).toBe("PNG");
      const size = /Screenshot (\d+)x(\d+) pixels, scale ([\d.]+)/.exec(shot.text);
      expect(size, shot.text).not.toBeNull();
      expect(Number(size?.[1])).toBeGreaterThan(300);
      expect(Number(size?.[3])).toBeGreaterThanOrEqual(2);
    }
    const hash = (n: string) => imageOf(r[n]).hash;
    expect(hash("shot1")).not.toBe(hash("shot2"));
    expect(hash("shot3")).not.toBe(hash("shot2"));
    expect(failed(r.launch), JSON.stringify(r.launch?.rpc)).toBe(false);
    expect(failed(r.home)).toBe(false);

    const tree = textOf(r.describe) as {
      screen: { width: number; height: number };
      elements: Array<{ type: string; label?: string; center: { x: number; y: number } }>;
    };
    expect(tree.screen.width).toBeGreaterThan(200);
    const icon = tree.elements.find((e) => e.type === "Button" && e.label === "Safari");
    expect(icon).toBeTruthy();

    // The cap: a is booted, so booting b shuts a down. Both are checked after the turn.
    expect(listDevices().filter((d) => d.state === "Booted")).toHaveLength(1);

    const home = hash("shot3");
    const tapped = await turn(mac, a, "a-tap", [
      call("tap", "simulator_tap", { x: icon?.center.x, y: icon?.center.y }),
      { sleep: 2500 },
      call("shot4", "simulator_screenshot"),
      call("type", "simulator_type", { text: "band" }),
      call("outside", "simulator_tap", { x: 99999, y: 99999 }),
    ]);
    expect(imageOf(tapped.shot4).hash).not.toBe(home);
    expect(failed(tapped.tap)).toBe(false);
    expect(failed(tapped.type)).toBe(false);
    expect(failed(tapped.outside)).toBe(true);

    const hits: string[] = [];
    const web = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.setHeader("content-type", "text/html");
      res.end("<h1>band</h1>");
    });
    await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
    try {
      const port = (web.address() as { port: number }).port;
      const opened = await turn(mac, a, "a-open-url", [
        call("openurl", "simulator_open_url", { url: `http://127.0.0.1:${port}/band` }),
      ]);
      expect(failed(opened.openurl), JSON.stringify(opened.openurl?.rpc)).toBe(false);
      await waitFor(async () => (hits.includes("/band") ? true : undefined), {
        label: "Safari requested the page",
        timeoutMs: 60_000,
      });
    } finally {
      await new Promise<void>((resolve) => web.close(() => resolve()));
    }

    // install takes an .app inside the worktree only: refused outside, installed and launched inside.
    const outsideRefused = await turn(mac, a, "a-install-outside", [
      call("install", "simulator_install", { path: app }),
    ]);
    expect(failed(outsideRefused.install)).toBe(true);
    expect(JSON.stringify(outsideRefused.install?.rpc)).toContain("inside this worktree");
    const wtPath = git(mac.repo, "worktree", "list", "--porcelain")
      .split("\n\n")
      .map((block) => block.split("\n"))
      .find((lines) => lines.some((l) => l === "branch refs/heads/a"))?.[0]
      ?.replace("worktree ", "");
    expect(wtPath).toBeTruthy();
    execFileSync("cp", ["-R", app, join(wtPath as string, "Probe.app")]);
    const installed = await turn(mac, a, "a-install-inside", [
      call("install", "simulator_install", { path: join(wtPath as string, "Probe.app") }),
      call("launchProbe", "simulator_launch", { bundleId: "dev.band.simext.probe" }),
    ]);
    expect(failed(installed.install), JSON.stringify(installed.install?.rpc)).toBe(false);
    expect(failed(installed.launchProbe), JSON.stringify(installed.launchProbe?.rpc)).toBe(false);
    expect(String(textOf(installed.launchProbe).output)).toContain("dev.band.simext.probe");

    // Nothing but this run's devices changed.
    expect(othersSnapshot()).toEqual(before);
  }, 900_000);

  it("S3: a second worktree boots over the cap by shutting the first down, never deleting it", async () => {
    const r = await turn(mac, b, "b-shot", [call("shot", "simulator_screenshot")]);
    expect(failed(r.shot), JSON.stringify(r.shot?.rpc)).toBe(false);
    const devices = listDevices();
    expect(devices.filter((d) => d.state === "Booted").map((d) => d.name)).toEqual([`${PREFIX} ${SEP} ${b}`]);
    expect(devices.find((d) => d.name === `${PREFIX} ${SEP} ${a}`)?.state).toBe("Shutdown");
  }, 600_000);

  /** Opens the panel stream as a person's device token would. */
  async function openScreen(worktreeId: string) {
    const params = encodeURIComponent(JSON.stringify({}));
    const ws = new WebSocket(
      `${server.url.replace(/^http/, "ws")}/api/extensions/simulator/worktrees/${encodeURIComponent(worktreeId)}/stream?panel=screen&name=screen&params=${params}`,
      { headers: { Cookie: `band_token=${TEST_TOKEN}` } },
    );
    const frames: Buffer[] = [];
    const texts: string[] = [];
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) frames.push(data);
      else texts.push(data.toString("utf8"));
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    });
    return { ws, frames, texts };
  }

  it("the panel stream sends an info message and half-size JPEG frames", async () => {
    const screen = await openScreen(b);
    await waitFor(async () => (screen.frames.length > 2 ? true : undefined), {
      label: "frames",
      timeoutMs: 120_000,
    });
    expect(screen.frames[0]?.subarray(0, 2).toString("hex")).toBe("ffd8");
    const info = JSON.parse(screen.texts.find((t) => t.includes('"info"')) ?? "{}") as { name?: string };
    expect(info.name).toBe(`${PREFIX} ${SEP} ${b}`);
    screen.ws.close();
  }, 200_000);

  /** A call a panel makes: the service method on the worktree's worker, as a person's device token. */
  const panelCall = async (worktreeId: string, method: string, params: Record<string, unknown> = {}) =>
    (
      await m<{ result: Record<string, unknown> }>("extensions.panelCall", {
        extensionId: "simulator",
        panelId: "screen",
        worktreeId,
        method,
        params,
      })
    ).result;

  it("S6: picking the other device makes the panel stream and the agent tools act on it, and picking back returns", async () => {
    const list = (await panelCall(a, "devices")) as {
      current: string;
      devices: Array<{ udid: string; name: string; runtime: string; state: string; owned: boolean }>;
    };
    const own = list.devices.find((d) => d.name === `${PREFIX} ${SEP} ${a}`);
    const other = list.devices.find((d) => d.name === `${PREFIX} ${SEP} ${b}`);
    if (!own || !other) throw new Error("the picker list misses a device of this run");
    expect(list.current).toBe(own.udid);
    expect(own.runtime).toMatch(/^\d+(\.\d+)*$/);
    expect(own.owned).toBe(true);
    expect(list.devices.some((d) => d.name === `${PREFIX} ${SEP} base`)).toBe(false);

    await panelCall(a, "select", { udid: other.udid });
    const status = await turn(mac, a, "a-picked", [call("picked", "simulator_status")]);
    expect(textOf(status.picked).udid).toBe(other.udid);
    const screen = await openScreen(a);
    await waitFor(async () => (screen.texts.some((t) => t.includes('"info"')) ? true : undefined), {
      label: "info",
      timeoutMs: 300_000,
    });
    expect((JSON.parse(screen.texts.find((t) => t.includes('"info"')) ?? "{}") as { udid?: string }).udid).toBe(other.udid);
    screen.ws.close();

    await panelCall(a, "select", { udid: own.udid });
    const back = await turn(mac, a, "a-back", [call("back", "simulator_status")]);
    expect(textOf(back.back).udid).toBe(own.udid);
  }, 600_000);

  it("S8: Rotate swaps the device's pixel size and turning back restores it; S7: Power shuts the shown device down", async () => {
    const size = async () => {
      const r = await turn(mac, b, `b-size-${Date.now()}`, [call("s", "simulator_screenshot")]);
      const m = /Screenshot (\d+)x(\d+)/.exec(JSON.stringify(r.s));
      if (!m) throw new Error("no size in the screenshot answer");
      return { w: Number(m[1]), h: Number(m[2]) };
    };
    const start = await size();
    expect(start.h).toBeGreaterThan(start.w);
    await panelCall(b, "rotate", { orientation: "landscape_left" });
    await waitFor(async () => {
      const s = await size();
      return s.w > s.h ? s : undefined;
    }, { label: "landscape", timeoutMs: 30_000 });
    await panelCall(b, "rotate", { orientation: "portrait" });
    await waitFor(async () => {
      const s = await size();
      return s.h > s.w ? s : undefined;
    }, { label: "portrait", timeoutMs: 30_000 });

    await panelCall(b, "shutdown");
    expect(listDevices().find((d) => d.name === `${PREFIX} ${SEP} ${b}`)?.state).toBe("Shutdown");
  }, 300_000);

  /** Pixel width of a JPEG, from its start-of-frame marker. */
  const jpegWidth = (jpeg: Buffer): number => {
    for (let i = 2; i + 9 < jpeg.length; ) {
      if (jpeg[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = jpeg[i + 1] as number;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return jpeg.readUInt16BE(i + 7);
      }
      i += 2 + jpeg.readUInt16BE(i + 2);
    }
    return 0;
  };

  it("S5: the loopback listener streams full-size frames (profile direct), the hub half-size ones (profile hub)", async () => {
    const hubScreen = await openScreen(b);
    await waitFor(async () => (hubScreen.frames.length > 2 ? true : undefined), {
      label: "hub frames",
      timeoutMs: 120_000,
    });
    const hubWidth = jpegWidth(hubScreen.frames[0] as Buffer);
    hubScreen.ws.close();

    const access = await m<{ port: number; token: string } | null>("worktree.directAccess", {
      worktreeId: b,
      hostId: mac.hostId,
    });
    if (!access) throw new Error("no direct access for the worktree");
    const direct = new WebSocket(
      `ws://127.0.0.1:${access.port}/plugins/simulator/stream?worktreeId=${encodeURIComponent(b)}&name=screen`,
      ["band", `band-token.${access.token}`],
      { headers: { origin: "app://h-0123456789ab" } },
    );
    const frames: Buffer[] = [];
    direct.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) frames.push(data);
    });
    await waitFor(async () => (frames.length > 2 ? true : undefined), {
      label: "direct frames",
      timeoutMs: 120_000,
    });
    const directWidth = jpegWidth(frames[0] as Buffer);
    direct.close();
    expect(hubWidth).toBeGreaterThan(100);
    // The hub profile halves each side; allow rounding.
    expect(directWidth).toBeGreaterThanOrEqual(hubWidth * 2 - 2);
  }, 300_000);

  it("S5: Simulator.app has no window in front after the simulator started", () => {
    // Only meaningful when Simulator.app was not already open and visible before the run.
    if (simulatorAppWasVisible) return;
    let visible = "";
    try {
      visible = execFileSync(
        "osascript",
        ["-e", 'tell application "System Events" to get visible of (processes whose name is "Simulator")'],
        { encoding: "utf8", timeout: 20_000 },
      ).trim();
    } catch (err) {
      console.warn(`window check skipped (osascript failed): ${err instanceof Error ? err.message : err}`);
      return;
    }
    console.log(`Simulator.app visible: ${JSON.stringify(visible) || "(not running)"}`);
    // "" means the process is not running, "false" means it runs hidden. Both are fine.
    expect(visible).not.toContain("true");
  });

  it("S5: when the lease runs out the service shuts its devices down, and the next call after renewal works", async () => {
    proxy = await startCuttableProxy(server.url);
    fenced = await startWorker("fenced", { hub: proxy.url });
    fencedWorktree = await createWorktree(fenced, "f");
    await waitFor(async () => ((await hostOf(fenced)).capabilities.includes("simulator") ? true : undefined), {
      label: "the capability on the fenced worker",
      timeoutMs: 60_000,
    });
    const first = await turn(fenced, fencedWorktree, "f-shot", [call("shot", "simulator_screenshot")]);
    expect(failed(first.shot), JSON.stringify(first.shot?.rpc)).toBe(false);
    const mine = () => listDevices().filter((d) => d.name === `${PREFIX} ${SEP} ${fencedWorktree}`);
    expect(mine()[0]?.state).toBe("Booted");

    // The link goes away; the hub stops renewing; after 10 s the worker fences.
    await proxy.cut();
    await waitFor(async () => (mine()[0]?.state === "Shutdown" ? true : undefined), {
      label: "the fence shuts the device down",
      timeoutMs: 90_000,
    });
    expect(mine()).toHaveLength(1);

    await proxy.restore();
    await waitFor(async () => ((await hostOf(fenced)).status === "online" ? true : undefined), {
      label: "the worker is back",
      timeoutMs: 60_000,
    });
    const again = await turn(fenced, fencedWorktree, "f-status", [call("status", "simulator_status")]);
    expect(failed(again.status), JSON.stringify(again.status?.rpc)).toBe(false);
    expect(textOf(again.status).udid).toBe(mine()[0]?.udid);
  }, 600_000);

  it("S2: removing the worktree deletes its device", async () => {
    await m("worktrees.remove", { repo: "proj", name: "b", hostId: mac.hostId });
    await waitFor(
      async () => (!listDevices().some((d) => d.name === `${PREFIX} ${SEP} ${b}`) ? true : undefined),
      { label: "the device of the removed worktree is gone", timeoutMs: 120_000 },
    );
  }, 200_000);
});
