/**
 * The desktop extension's panel (S1, S4) in a real browser against a real Band hub, with a worker in
 * the band-worker-desktop image (DESKTOP_EXT_IMAGE, docker; see run.sh) or natively on Linux.
 * The Desktop tab opens from the center "+" menu, noVNC draws the worktree's display, the person is
 * in control without pressing anything, a click and a key reach the display, and a second browser
 * context on the same tab sees the display and can send input too.
 * integration/run.sh copies this file into BAND_SRC/apps/web/e2e/. Screenshots go to DESKTOP_EXT_SHOTS.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { expect, type FrameLocator, type Locator, type Page, test } from "@playwright/test";
import { toWorktreeId } from "@/dashboard";
import {
  cleanupTmpHome,
  createTmpHome,
  resetClientState,
  type ServerHandle,
  seedSettings,
  startServer,
} from "./helpers/server";
import { trpcMutate, trpcMutateData, trpcQuery } from "./helpers/trpc";
import { ExtensionPanelPage } from "./pages/ExtensionPanelPage";

test.use({ viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

const TARBALL = process.env.DESKTOP_EXT_TARBALL ?? "";
const IMAGE = process.env.DESKTOP_EXT_IMAGE ?? "";
const WORKER_DIST = process.env.DESKTOP_EXT_WORKER_DIST ?? "";
const SHOTS = process.env.DESKTOP_EXT_SHOTS ?? tmpdir();
const TOKEN = "e2e-desktop-extension-token";
const REPO = "dxrepo";
const LABEL = "band.test=desktop-extension";

let server: ServerHandle;
let tmpHome: string;
let hostId = "";
let worktreeId = "";
let container = "";
const scratch: string[] = [];
const tmpDir = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};
const sh = (script: string) => execFileSync("docker", ["exec", container, "sh", "-c", script], { encoding: "utf8" });

const call = async <T>(method: string, params: unknown = {}): Promise<T> =>
  (
    await trpcMutateData<{ result: T }>(server.url, TOKEN, "extensions.panelCall", {
      extensionId: "desktop",
      panelId: "screen",
      worktreeId,
      method,
      params,
    })
  ).result;

/** The colour at (x, y) of the worktree's display, from the extension's own screenshot tool. */
async function pixel(x: number, y: number): Promise<[number, number, number]> {
  const res = await call<{ content: Array<{ type: string; data?: string }> }>("screenshot");
  const buf = Buffer.from(res.content.find((c) => c.type === "image")?.data as string, "base64");
  let off = 8;
  let width = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    if (type === "IHDR") width = buf.readUInt32BE(off + 8);
    if (type === "IDAT") idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const i = y * (1 + width * 3) + 1 + x * 3;
  return [raw[i] as number, raw[i + 1] as number, raw[i + 2] as number];
}
const isColour = (rgb: [number, number, number], want: [number, number, number]) =>
  rgb.every((v, i) => Math.abs(v - (want[i] as number)) <= 24);

const PAGE =
  "data:text/html," +
  encodeURIComponent(
    `<body style="margin:0;background:red;height:100vh" onclick="document.body.style.background='lime'" onkeydown="if(event.key==='F2')document.body.style.background='purple'"></body>`,
  );

/** The Desktop panel's page inside Band's sandboxed frame. Lives here because the page is the extension's. */
class DesktopPanelFrame {
  readonly status: Locator;
  readonly canvas: Locator;
  readonly resolution: Locator;
  private readonly frame: FrameLocator;
  constructor(private readonly page: Page) {
    this.frame = page.getByTestId("extension-panel").frameLocator('[data-testid="extension-panel__frame"]');
    this.status = this.frame.getByTestId("desktop-panel__status");
    this.canvas = this.frame.locator("canvas");
    this.resolution = this.frame.getByTestId("desktop-panel__resolution");
  }
  async clickScreen(): Promise<void> {
    await this.canvas.click({ position: { x: 100, y: 300 } });
  }
  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  if (!TARBALL) throw new Error("DESKTOP_EXT_TARBALL names the packaged desktop-<version>.tar.gz");
  if (!IMAGE) throw new Error("DESKTOP_EXT_IMAGE names the band-worker-desktop image");
  mkdirSync(SHOTS, { recursive: true });
  tmpHome = createTmpHome();
  seedSettings(tmpHome, { tokenSecret: TOKEN });
  server = await startServer({ tmpHome });
  const issued = await trpcMutateData<{ token: string; hostId: string }>(
    server.url,
    TOKEN,
    "tokens.issueWorkerBootstrap",
    { hostName: "linux", labels: [] },
  );
  hostId = issued.hostId;
  const port = new URL(server.url).port;
  const forwarder =
    `require("net").createServer(c=>{const u=require("net").connect(${port},"host.docker.internal");` +
    `c.pipe(u);u.pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy())}).listen(${port},"127.0.0.1")`;
  container = `dx-e2e-${randomBytes(3).toString("hex")}`;
  execFileSync("docker", [
    "run", "-d", "--name", container, "--label", LABEL,
    "--add-host", "host.docker.internal:host-gateway",
    ...(WORKER_DIST ? ["-v", `${WORKER_DIST}:/opt/band-worker/node_modules/@band-app/worker/dist:ro`] : []),
    "--entrypoint", "sh", IMAGE, "-c",
    `node -e '${forwarder}' & exec band-worker --hub http://127.0.0.1:${port} --token ${issued.token} --root /work --state-dir /home/worker/.band/worker`,
  ]);
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; status: string }> }>(server.url, TOKEN, "hosts.list");
        return hosts.find((h) => h.id === hostId)?.status;
      },
      { timeout: 90_000 },
    )
    .toBe("online");
  sh(
    `mkdir -p /work/${REPO} && cd /work/${REPO} && git init -q -b main && git config user.email t@e.x && git config user.name t && echo hi > hello.txt && git add . && git commit -q -m init`,
  );
  await trpcMutate(server.url, TOKEN, "repos.addFromWorker", { hostId, path: `/work/${REPO}`, addRoot: true });
  await trpcMutate(server.url, TOKEN, "worktrees.create", {
    repo: REPO,
    branch: "wt-dx",
    hostId,
    hostRepoPath: `/work/${REPO}`,
    noOrigin: true,
  });
  worktreeId = toWorktreeId(REPO, "wt-dx", hostId);
  const res = await fetch(`${server.url}/api/extensions/install`, {
    method: "POST",
    headers: { Cookie: `band_token=${TOKEN}` },
    body: readFileSync(TARBALL),
  });
  expect(res.status).toBe(200);
  await expect
    .poll(
      async () => {
        const { hosts } = await trpcQuery<{ hosts: Array<{ id: string; capabilities: string[] }> }>(server.url, TOKEN, "hosts.list");
        return hosts.find((h) => h.id === hostId)?.capabilities.includes("desktop");
      },
      { timeout: 90_000 },
    )
    .toBe(true);
});

test.beforeEach(() => resetClientState(tmpHome));

test.afterAll(async () => {
  if (container) {
    try {
      execFileSync("docker", ["rm", "-f", "-v", container], { stdio: "ignore" });
    } catch {}
  }
  await server?.close();
  cleanupTmpHome(tmpHome);
  for (const dir of scratch) cleanupTmpHome(dir);
});

test("S1: the Desktop tab shows the worktree's display and the person is in control at once", async ({ page }) => {
  test.setTimeout(300_000);
  const panel = new ExtensionPanelPage(page, server.url, TOKEN, "desktop", "screen");
  await panel.open(worktreeId);
  await panel.openFromMenu();
  const desktop = new DesktopPanelFrame(page);
  await expect(desktop.status).toHaveText("In control", { timeout: 60_000 });
  await expect(panel.panel).toHaveAttribute("data-control", "true");
  await expect(desktop.canvas).toBeVisible();
  await expect(desktop.resolution).toHaveText("1280x800");

  await call("openUrl", { url: PAGE });
  await expect.poll(async () => isColour(await pixel(900, 500), [255, 0, 0]), { timeout: 60_000 }).toBe(true);
  await page.screenshot({ path: join(SHOTS, "desktop-panel-red.png") });

  // No Take control press: a click and a key through noVNC reach the display.
  await desktop.clickScreen();
  await expect.poll(async () => isColour(await pixel(900, 500), [0, 255, 0]), { timeout: 30_000 }).toBe(true);
  await desktop.press("F2");
  await expect.poll(async () => isColour(await pixel(900, 500), [128, 0, 128]), { timeout: 30_000 }).toBe(true);
  await page.screenshot({ path: join(SHOTS, "desktop-panel-purple.png") });
});

test("S4: a second browser context on the same tab sees the display and can send input too", async ({ browser, page }) => {
  test.setTimeout(300_000);
  const first = new ExtensionPanelPage(page, server.url, TOKEN, "desktop", "screen");
  await first.open(worktreeId);
  await first.openFromMenu();
  await expect(new DesktopPanelFrame(page).status).toHaveText("In control", { timeout: 60_000 });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const second = await context.newPage();
    const secondPanel = new ExtensionPanelPage(second, server.url, TOKEN, "desktop", "screen");
    await secondPanel.open(worktreeId);
    await secondPanel.openFromMenu();
    const desktop2 = new DesktopPanelFrame(second);
    await expect(desktop2.status).toHaveText("In control", { timeout: 60_000 });
    await expect(desktop2.canvas).toBeVisible();

    await call("openUrl", { url: PAGE });
    await expect.poll(async () => isColour(await pixel(900, 500), [255, 0, 0]), { timeout: 60_000 }).toBe(true);
    // The second viewer's click reaches the display, and the first viewer's key does too.
    await desktop2.clickScreen();
    await expect.poll(async () => isColour(await pixel(900, 500), [0, 255, 0]), { timeout: 30_000 }).toBe(true);
    await new DesktopPanelFrame(page).clickScreen();
    await page.keyboard.press("F2");
    await expect.poll(async () => isColour(await pixel(900, 500), [128, 0, 128]), { timeout: 30_000 }).toBe(true);
    await second.screenshot({ path: join(SHOTS, "desktop-panel-second-viewer.png") });
  } finally {
    await context.close();
  }
});
