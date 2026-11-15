// The Desktop panel in a real browser against a stub of Band's host side (the stream and secret.*
// messages of the extension panel port). Skips when playwright-core or a Chromium is missing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const web = join(root, "dist", "web");

function findChromium() {
  if (process.env.DESKTOP_TEST_CHROMIUM) return process.env.DESKTOP_TEST_CHROMIUM;
  const base = join(homedir(), "Library", "Caches", "ms-playwright");
  const linux = join(homedir(), ".cache", "ms-playwright");
  for (const dir of [base, linux]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      for (const rel of [
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "chrome-linux/chrome",
        "chrome-linux64/chrome",
      ]) {
        if (existsSync(join(dir, name, rel))) return join(dir, name, rel);
      }
    }
  }
  return null;
}

let chromium = null;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  // Not installed.
}
const executablePath = findChromium();
const skip = !chromium || !executablePath ? "playwright-core or a Chromium is not available" : false;

const HOST = `<!doctype html><body style="margin:0"><iframe id="f" src="panel.html" style="width:900px;height:600px;border:0"></iframe><script>
const q = new URLSearchParams(location.search);
const secrets = new Map(q.get("saved") ? [["mac:w1:agent", q.get("saved")]] : []);
window.log = [];
window.opens = 0;
let streamId = "";
const ch = new MessageChannel();
window.service = (obj) => ch.port1.postMessage({ type: "stream.message", id: streamId, text: JSON.stringify(obj) });
window.closeStream = (reason) => ch.port1.postMessage({ type: "stream.closed", id: streamId, code: 1000, reason });
ch.port1.onmessage = (e) => {
  const m = e.data;
  window.log.push(m);
  if (m.type === "stream.open") { window.opens++; streamId = m.id; ch.port1.postMessage({ type: "stream.opened", id: m.id }); }
  else if (m.type === "secret.get") ch.port1.postMessage({ type: "secret.result", id: m.id, value: secrets.get(m.key) ?? null });
  else if (m.type === "secret.set") { secrets.set(m.key, m.value); ch.port1.postMessage({ type: "secret.result", id: m.id, value: null }); }
  else if (m.type === "secret.delete") { secrets.delete(m.key); ch.port1.postMessage({ type: "secret.result", id: m.id, value: null }); }
};
document.getElementById("f").addEventListener("load", () => {
  document.getElementById("f").contentWindow.postMessage({ type: "band:hello", extensionApi: 1 }, "*", [ch.port2]);
  const init = { type: "init", worktreeId: "wt", layout: "regular", visible: true };
  if (q.get("secrets")) init.secrets = q.get("secrets");
  ch.port1.postMessage(init);
});
</script></body>`;

let server;
let browser;
let base = "";

before(async () => {
  if (skip) return;
  execFileSync(process.execPath, [join(root, "build.mjs")], { cwd: root, stdio: "ignore" });
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/host.html") return res.writeHead(200, { "content-type": "text/html" }).end(HOST);
    try {
      const body = readFileSync(join(web, path.slice(1)));
      res.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function open(query) {
  const page = await browser.newPage();
  await page.goto(`${base}/host.html${query}`);
  const frame = page.frameLocator("#f");
  await frame.getByTestId("desktop-panel__status").waitFor();
  return { page, frame, log: () => page.evaluate(() => window.log) };
}

const passwordsSent = (log) =>
  log
    .filter((m) => m.type === "stream.send" && typeof m.message === "string")
    .map((m) => JSON.parse(m.message))
    .filter((m) => m.type === "password")
    .map((m) => m.password);

test("S1: the panel shows a password form, sends the password, and asks again with the reason when refused", { skip }, async () => {
  const { page, frame, log } = await open("");
  await page.waitForFunction(() => window.opens === 1);
  await page.evaluate(() => window.service({ type: "need-password", user: "agent", worker: "w1", reason: "" }));
  const form = frame.getByTestId("desktop-panel__login");
  await form.waitFor({ state: "visible" });
  assert.match(await frame.getByTestId("desktop-panel__login-title").innerText(), /Sign in to the Mac as agent/);
  assert.equal(await frame.getByTestId("desktop-panel__login-remember").isVisible(), false);
  await frame.getByTestId("desktop-panel__login-password").fill("wrong");
  await frame.getByTestId("desktop-panel__login-submit").click();
  await form.waitFor({ state: "hidden" });
  await page.evaluate(() =>
    window.service({ type: "need-password", user: "agent", worker: "w1", reason: "the Mac refused the login for agent" }),
  );
  await form.waitFor({ state: "visible" });
  assert.match(await frame.getByTestId("desktop-panel__login-reason").innerText(), /the Mac refused the login/);
  await frame.getByTestId("desktop-panel__login-password").fill("right");
  await frame.getByTestId("desktop-panel__login-submit").click();
  await page.waitForFunction(() => window.log.filter((m) => m.type === "stream.send").length === 2);
  await page.evaluate(() => window.service({ type: "signed-in" }));
  await form.waitFor({ state: "hidden" });
  assert.deepEqual(passwordsSent(await log()), ["wrong", "right"]);
  // Nothing is saved when the host keeps no secrets.
  assert.equal((await log()).some((m) => String(m.type).startsWith("secret.")), false);
  await page.close();
});

test("S2: with a saved password the form never shows; a refused one is deleted and the form shows with the reason", { skip }, async () => {
  const { page, frame, log } = await open("?secrets=keychain&saved=old");
  await page.waitForFunction(() => window.opens === 1);
  await page.evaluate(() => window.service({ type: "need-password", user: "agent", worker: "w1", reason: "" }));
  await page.waitForFunction(() => window.log.some((m) => m.type === "stream.send"));
  assert.deepEqual(passwordsSent(await log()), ["old"]);
  const form = frame.getByTestId("desktop-panel__login");
  assert.equal(await form.isVisible(), false);

  await page.evaluate(() =>
    window.service({ type: "need-password", user: "agent", worker: "w1", reason: "the Mac refused the login for agent" }),
  );
  await form.waitFor({ state: "visible" });
  const entries = await log();
  assert.ok(entries.some((m) => m.type === "secret.delete" && m.key === "mac:w1:agent"));
  assert.equal(await frame.getByTestId("desktop-panel__login-remember").isVisible(), true);
  await frame.getByTestId("desktop-panel__login-password").fill("new");
  await frame.getByTestId("desktop-panel__login-submit").click();
  await page.evaluate(() => window.service({ type: "signed-in" }));
  await page.waitForFunction(() => window.log.some((m) => m.type === "secret.set"));
  const set = (await log()).find((m) => m.type === "secret.set");
  assert.deepEqual([set.key, set.value], ["mac:w1:agent", "new"]);
  await page.close();
});

test("S2: a wrong password is never saved", { skip }, async () => {
  const { page, frame, log } = await open("?secrets=keychain");
  await page.waitForFunction(() => window.opens === 1);
  await page.evaluate(() => window.service({ type: "need-password", user: "agent", worker: "w1", reason: "" }));
  await frame.getByTestId("desktop-panel__login-password").fill("wrong");
  await frame.getByTestId("desktop-panel__login-submit").click();
  await page.evaluate(() => window.service({ type: "need-password", user: "agent", worker: "w1", reason: "refused" }));
  await frame.getByTestId("desktop-panel__login").waitFor({ state: "visible" });
  assert.equal((await log()).some((m) => m.type === "secret.set"), false);
  await page.close();
});

test("S5: an error from the service shows as it is and the panel does not reconnect", { skip }, async () => {
  const { page, frame } = await open("");
  await page.waitForFunction(() => window.opens === 1);
  await page.evaluate(() => {
    window.service({ type: "error", message: "Desktop cannot open the Mac session of agent: Screen Sharing is not answering" });
    window.closeStream("");
  });
  const error = frame.getByTestId("desktop-panel__error");
  await error.waitFor({ state: "visible" });
  assert.match(await error.innerText(), /Screen Sharing is not answering/);
  await frame.getByTestId("desktop-panel__reconnect").waitFor({ state: "visible" });
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.opens), 1);
  await page.close();
});
