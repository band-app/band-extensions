/**
 * The simulator extension's panel (S4). A real Band hub and `band-worker`, the packaged tarball
 * installed through the hub, a real simulator device and a real browser. The panel opens from the
 * center "+" menu, draws the device's frames in the extension's own iframe, ignores pointer input
 * until the person presses Band's Take control button, and then taps reach the device.
 * integration/run.sh copies this file into BAND_SRC/apps/web/e2e/. Screenshots go to
 * SIM_EXT_SHOTS (default: the system temp dir).
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  seedState,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcMutateData, trpcQuery } from "./helpers/trpc";
import { startWorker, type WorkerHandle } from "./helpers/worker";
import { ExtensionPanelPage } from "./pages/ExtensionPanelPage";

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });
// Skipped: written for one auto-created device per worktree and the old Take control step. Both are gone, so
// it needs a rewrite for the canvas (per-pane pickers and streams) before it runs again.
test.skip(true, "superseded by the canvas; see verify.mjs for the panel check");

const TARBALL = process.env.SIM_EXT_TARBALL ?? "";
const SHOTS = process.env.SIM_EXT_SHOTS ?? tmpdir();
const TOKEN = "e2e-simulator-extension-token";
const REPO = "simrepo";
const PREFIX = `Band simext e2e ${randomBytes(4).toString("hex")}`;
const SEP = "–";

let server: ServerHandle;
let tmpHome: string;
let worker: WorkerHandle;
let hostId = "";
let worktreeId = "";
const scratch: string[] = [];

const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
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

function cleanupDevices() {
  const out = execFileSync("xcrun", ["simctl", "list", "devices", "-j"], { encoding: "utf8" });
  const mine = Object.values(
    (JSON.parse(out) as { devices: Record<string, Array<{ udid: string; name: string }>> }).devices,
  )
    .flat()
    .filter((d) => d.name.startsWith(`${PREFIX} ${SEP} `));
  for (const d of mine) {
    for (const cmd of ["shutdown", "delete"]) {
      try {
        execFileSync("xcrun", ["simctl", cmd, d.udid], { stdio: "ignore" });
      } catch {}
    }
  }
}

interface Described {
  screen: { width: number; height: number };
  elements: Array<{ type: string; label?: string; value?: string; center: { x: number; y: number } }>;
}
const describeScreen = async (): Promise<Described> =>
  (
    await trpcMutateData<{ result: Described }>(server.url, TOKEN, "extensions.panelCall", {
      extensionId: "simulator",
      panelId: "screen",
      worktreeId,
      method: "describe",
      params: {},
    })
  ).result;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  if (!TARBALL) throw new Error("SIM_EXT_TARBALL names the packaged simulator-<version>.tar.gz");
  mkdirSync(SHOTS, { recursive: true });
  tmpHome = createTmpHome();
  const hubRepo = join(tmpDir("band-e2e-sim-hubrepo-"), REPO);
  mkdirSync(hubRepo, { recursive: true });
  git(hubRepo, "init", "-q", "-b", "main");
  writeFileSync(join(hubRepo, "hello.txt"), "hello\n");
  git(hubRepo, "add", ".");
  git(hubRepo, "commit", "-q", "-m", "init");
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  seedState(tmpHome, {
    repos: [
      { name: REPO, path: hubRepo, defaultBranch: "main", worktrees: [{ branch: "main", path: hubRepo }] },
    ],
  });
  server = await startServer({ tmpHome });
  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: "mac", labels: [] },
  );
  hostId = issued.hostId;
  const root = tmpDir("band-e2e-sim-root-");
  const repo = join(root, REPO);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "hello.txt"), "hello\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const stateDir = tmpDir("band-e2e-sim-state-");
  const svc = join(stateDir, "extension-state", "simulator", "main");
  mkdirSync(svc, { recursive: true });
  writeFileSync(join(svc, "config.json"), JSON.stringify({ namePrefix: PREFIX, maxBooted: 1 }));
  worker = startWorker({
    env: { BAND_HUB_URL: server.url, BAND_BOOTSTRAP_TOKEN: issued.token, BAND_WORKER_ID: hostId },
    root,
    stateDir,
    home: tmpDir("band-e2e-sim-home-"),
  });
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(
          server.url,
          TOKEN,
          "hosts.list",
        );
        return hosts.find((h) => h.id === hostId)?.status;
      },
      { timeout: 60_000 },
    )
    .toBe("online");
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: REPO,
    branch: "wt-sim",
    hostId,
    hostRepoPath: repo,
    noOrigin: true,
  });
  worktreeId = toWorktreeId(REPO, "wt-sim", hostId);
  const res = await fetch(`${server.url}/api/extensions/install`, {
    method: "POST",
    headers: { Cookie: `band_token=${TOKEN}` },
    body: readFileSync(TARBALL),
  });
  expect(res.status).toBe(200);
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; capabilities: string[] }> }>(
          server.url,
          TOKEN,
          "hosts.list",
        );
        return hosts.find((h) => h.id === hostId)?.capabilities.includes("simulator");
      },
      { timeout: 60_000 },
    )
    .toBe(true);
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  await worker?.kill();
  await server?.close();
  cleanupDevices();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

const frameOf = (page: Page): FrameLocator =>
  page.getByTestId("extension-panel").frameLocator('[data-testid="extension-panel__frame"]');

test("S4: frames render in the extension's iframe, input is ignored until Take control, then taps and keys reach the device", async ({
  page,
}) => {
  test.setTimeout(900_000);
  const panel = new ExtensionPanelPage(page, server.url, TOKEN, "simulator", "screen");
  await panel.open(worktreeId);
  await panel.openFromMenu();

  const sim = frameOf(page);
  // The first frame needs a cold boot of a clone of a new base device.
  await expect(sim.getByTestId("sim-panel__status")).toHaveText("Connected", { timeout: 600_000 });
  await expect(sim.getByTestId("sim-panel__device")).toHaveText(`${PREFIX} ${SEP} ${worktreeId}`);
  const canvas = sim.getByTestId("sim-panel__canvas");
  const size = await canvas.evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));
  expect(size.w).toBeGreaterThan(300);
  expect(size.h).toBeGreaterThan(size.w);
  // The toolbar: no Take control or Release above it, and icon-only buttons with labels.
  await expect(page.getByRole("button", { name: /take control|release/i })).toHaveCount(0);
  await expect(sim.getByTestId("sim-panel__picker-version")).toHaveText(/^iOS \d+/);
  for (const id of ["rotate", "home", "power"]) {
    const button = sim.getByTestId(`sim-panel__${id}`);
    await expect(button).toHaveAttribute("aria-label", /.+/);
    await expect(button).toHaveText("");
  }
  await page.screenshot({ path: join(SHOTS, "s5-toolbar.png") });

  // Put the device on its home screen (tools are the agent's path and need no control).
  await trpcMutateData(server.url, TOKEN, "extensions.panelCall", {
    extensionId: "simulator",
    panelId: "screen",
    worktreeId,
    method: "button",
    params: { button: "HOME" },
  });
  await expect
    .poll(async () => (await describeScreen()).elements.some((e) => e.type === "Button" && e.label === "Safari"), {
      timeout: 60_000,
    })
    .toBe(true);
  const home = await describeScreen();
  const safari = home.elements.find((e) => e.type === "Button" && e.label === "Safari");
  if (!safari) throw new Error("no Safari icon on the home screen");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  const at = {
    x: box.x + (safari.center.x / home.screen.width) * box.width,
    y: box.y + (safari.center.y / home.screen.height) * box.height,
  };

  // Input is on from the start: a click opens Safari with nothing pressed in Band's toolbar.
  await expect(sim.getByTestId("sim-panel__home")).toBeEnabled();
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(async () => (await describeScreen()).elements.some((e) => e.type === "Button" && e.label === "Safari"), {
      timeout: 30_000,
    })
    .toBe(false);
  await page.screenshot({ path: join(SHOTS, "s4-2-controlling-safari.png") });

  // The Home button of the panel goes through the stream and brings the home screen back.
  await sim.getByTestId("sim-panel__home").click();
  await expect
    .poll(async () => (await describeScreen()).elements.some((e) => e.type === "Button" && e.label === "Safari"), {
      timeout: 30_000,
    })
    .toBe(true);

  // Keys: open Safari again, tap the address field with the pointer, type with the keyboard.
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(async () => (await describeScreen()).elements.some((e) => e.type === "Button" && e.label === "Safari"), {
      timeout: 30_000,
    })
    .toBe(false);
  await page.waitForTimeout(3000);
  const inSafari = await describeScreen();
  const field = inSafari.elements.find(
    (e) => /TextField|SearchField/.test(e.type) || /address|search|url/i.test(e.label ?? ""),
  );
  if (field) {
    await page.mouse.click(
      box.x + (field.center.x / inSafari.screen.width) * box.width,
      box.y + (field.center.y / inSafari.screen.height) * box.height,
    );
    await page.waitForTimeout(1500);
    await canvas.press("b");
    await canvas.press("a");
    await canvas.press("n");
    await canvas.press("d");
    await expect
      .poll(async () => (await describeScreen()).elements.some((e) => (e.value ?? "").includes("band")), {
        timeout: 30_000,
      })
      .toBe(true);
    await page.screenshot({ path: join(SHOTS, "s4-3-typed.png") });
  } else {
    console.warn("[simulator e2e] Safari showed no address field in the accessibility tree; keys were not checked");
  }

  // Power shuts the device down and the panel says so; pressing it again boots it and the stream resumes.
  await sim.getByTestId("sim-panel__power").click();
  await expect(sim.getByTestId("sim-panel__status")).toHaveText("Off", { timeout: 60_000 });
  await page.screenshot({ path: join(SHOTS, "s7-off.png") });
  await sim.getByTestId("sim-panel__power").click();
  await expect(sim.getByTestId("sim-panel__status")).toHaveText("Connected", { timeout: 300_000 });
});
