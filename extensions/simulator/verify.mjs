// Headless Chrome check of the Simulator canvas with stand-in streams (no simulator needed).
//   PLAYWRIGHT=<path to playwright-core> node extensions/simulator/verify.mjs [outdir]
// Tests panel/ directly, or DIST. The test page plays Band: it frames the panel from another origin
// in <iframe sandbox="allow-scripts">, sends band:hello with a MessagePort, then init with a theme,
// and plays the worker service: it keeps the saved layout between reloads, lists devices, creates
// devices, opens one stream per pane and draws a different color per device.
import { createServer } from "node:http";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright-core");
const dist = process.env.DIST ?? join(import.meta.dirname, "panel");
const out = process.argv[2] ?? join(import.meta.dirname, "../../.am/evidence");
mkdirSync(out, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript" };

const listen = (handler) =>
  new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });

const build = await listen((req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/\.\./g, "");
  const file = join(dist, rel === "/" ? "panel.html" : rel);
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "access-control-allow-origin": "*" });
  res.end(readFileSync(file));
});
const buildBase = `http://127.0.0.1:${build.address().port}`;

const PAGE = `<!DOCTYPE html><meta charset="utf-8"><style>body{margin:0}iframe{width:1000px;height:760px;border:0}</style>
<body><script>
const BUILD = ${JSON.stringify(buildBase)};
const COLORS = { "ios:U-MINE": "#22aa66", "ios:U-NEW": "#3366cc", "android:avd:Pixel_8": "#cc6633", "ios:U-3": "#aa33aa", "android:avd:Pixel_6": "#aaaa33" };
// The service's state lives on this page, so it survives a reload of the panel like the worker's files do.
window.svc = {
  layout: null,
  from: null,
  saves: [],
  creates: [],
  androidReady: true,
  devices: [
    { id: "ios:U-MINE", platform: "ios", name: "iPhone 15", state: "off", os: "iOS 17.5", model: "iPhone 15", owned: false },
    { id: "ios:U-3", platform: "ios", name: "iPad Air", state: "off", os: "iOS 26.5", owned: false },
    { id: "android:avd:Pixel_8", platform: "android", name: "Pixel_8", state: "off", os: "Android 15", model: "Pixel 8", owned: false },
    { id: "android:avd:Pixel_6", platform: "android", name: "Pixel_6", state: "on", os: "Android 14", model: "Pixel 6", owned: false },
  ],
};
window.log = [];
let port;
async function jpeg(w, h, color) {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext("2d");
  x.fillStyle = color; x.fillRect(0, 0, w, h);
  x.fillStyle = "#fff"; x.fillRect(w / 2 - 20, h / 2 - 20, 40, 40);
  return new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg" })).arrayBuffer());
}
window.sendTheme = (t) => port.postMessage({ type: "theme", ...t });
window.streams = {};
window.frame = (theme) => {
  document.querySelectorAll("iframe").forEach((f) => f.remove());
  window.log = [];
  window.streams = {};
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", "allow-scripts");
  el.src = BUILD + "/panel.html";
  document.body.appendChild(el);
  el.addEventListener("load", () => {
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = async (e) => {
      const m = e.data;
      window.log.push(m);
      if (m.type === "stream.open") {
        const dev = window.svc.devices.find((d) => d.id === m.params.device) ?? window.svc.created?.find((d) => d.id === m.params.device);
        window.streams[m.id] = dev?.id;
        port.postMessage({ type: "stream.opened", id: m.id });
        const msg = (o) => port.postMessage({ type: "stream.message", id: m.id, text: JSON.stringify(o) });
        if (!dev) { msg({ type: "error", message: "No device has the id " + m.params.device }); port.postMessage({ type: "stream.closed", id: m.id, code: 1000, reason: "" }); return; }
        msg({ type: "booting" });
        msg({ type: "booting", phase: "booting", name: dev.name, model: dev.model });
        await new Promise((r) => setTimeout(r, 150));
        const android = dev.platform === "android";
        msg({ type: "info", udid: dev.id, name: dev.name, width: android ? 1080 : 402, height: android ? 2400 : 874, platform: dev.platform });
        const bytes = await jpeg(android ? 540 : 804, android ? 1200 : 1748, COLORS[dev.id] ?? "#555");
        port.postMessage({ type: "stream.frame", id: m.id, data: bytes.buffer }, [bytes.buffer]);
      }
      if (m.type === "call") {
        let result = {};
        const s = window.svc;
        if (m.method === "layout") result = { layout: s.layout, from: s.from };
        if (m.method === "saveLayout") { s.layout = m.params.layout; s.saves.push(m.params.layout); }
        if (m.method === "devices") result = { devices: [...s.devices, ...(s.created ?? [])], platforms: { ios: { ok: true }, android: s.androidReady ? { ok: true } : { ok: false, reason: "The Android SDK was not found. Set ANDROID_HOME." } } };
        if (m.method === "options") result = {
          ios: { runtimes: [{ id: "rt26", version: "26.5", deviceTypes: [{ id: "t15", name: "iPhone 15" }, { id: "t17", name: "iPhone 17 Pro" }, { id: "t16", name: "iPhone 16 Pro" }] }] },
          android: s.noImages
            ? { available: true, reason: "No Android system image is installed. Install one first.", profiles: [{ id: "pixel_8", name: "Pixel 8" }], images: [], hint: 'sdkmanager "system-images;android-35;google_apis;arm64-v8a"' }
            : { available: true, profiles: [{ id: "pixel_8", name: "Pixel 8" }], images: [{ pkg: "system-images;android-35;google_apis;arm64-v8a", label: "Android 15, google apis" }] },
        };
        if (m.method === "create") {
          s.creates.push(m.params);
          const d = { id: "ios:U-NEW", platform: "ios", name: "band – iPhone 17 Pro", state: "off", os: "iOS 26.5", model: "iPhone 17 Pro", owned: true };
          (s.created ??= []).push(d);
          result = { device: d };
        }
        port.postMessage({ type: "call.result", id: m.id, result });
      }
    };
    el.contentWindow.postMessage({ type: "band:hello", extensionApi: 1 }, "*", [ch.port2]);
    port.postMessage({ type: "init", layout: "regular", visible: true, theme });
  });
};
</script></body>`;
const page = await listen((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(PAGE));
const pageUrl = `http://127.0.0.1:${page.address().port}/`;

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1000, height: 760 } });
const tab = await ctx.newPage();
tab.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));
tab.on("console", (m) => { if (m.type() === "error") console.log("  [console]", m.text().slice(0, 200)); });
await tab.goto(pageUrl);
const getFrame = () => tab.frames().filter((f) => !f.isDetached() && f.url().includes("/panel.html")).pop();
const panel = async () => {
  await sleep(200);
  for (let i = 0; i < 50; i++) {
    const f = getFrame();
    if (f) return f;
    await sleep(100);
  }
  throw new Error("no panel frame");
};
const reload = async (theme) => {
  await tab.evaluate((t) => window.frame(t), theme);
  const f = await panel();
  await sleep(900);
  return f;
};
const css = (f, sel, prop) => f.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [sel, prop]);
const paneInfo = (f) =>
  f.evaluate(() =>
    [...document.querySelectorAll(".pane")].map((p) => ({
      id: p.dataset.pane,
      phase: p.dataset.phase,
      name: p.querySelector(".picker-name").textContent,
      platform: p.querySelector(".stage").dataset.platform,
      focused: p.dataset.focused,
      back: !p.querySelector(".back").hidden,
    })),
  );
const sent = () => tab.evaluate(() => window.log.filter((m) => m.type === "stream.send").map((m) => ({ stream: window.streams[m.id], msg: JSON.parse(m.message) })));
const opens = () => tab.evaluate(() => window.log.filter((m) => m.type === "stream.open").map((m) => m.params.device));
const pickDevice = async (f, paneSel, deviceId) => {
  await f.click(`${paneSel} .picker`);
  await sleep(250);
  await f.click(`${paneSel} .menu li[data-id="${deviceId}"]`);
  await sleep(900);
};
const pixel = (f, paneSel) =>
  f.evaluate((sel) => {
    const c = document.querySelector(`${sel} canvas.screen`);
    const d = c.getContext("2d").getImageData(5, 5, 1, 1).data;
    return `${d[0]},${d[1]},${d[2]}`;
  }, paneSel);
const rgbOf = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
/** JPEG shifts colors a little: close enough is within 12 per channel. */
const near = (got, hex) => got.split(",").map(Number).every((v, i) => Math.abs(v - rgbOf(hex)[i]) <= 12);

const DARK = { mode: "dark", tokens: { "--background": "#1a1b26", "--foreground": "#c0caf5", "--muted-foreground": "#7a88b8", "--border": "#2f334d", "--accent": "#292e42" } };

// S5: nothing saved anywhere: one empty pane with the picker, no stream, nothing created.
let f = await reload(DARK);
let panes = await paneInfo(f);
check("S5 nothing saved: one pane in the empty state", panes.length === 1 && panes[0].phase === "empty", JSON.stringify(panes));
check("S5 no stream was opened", (await opens()).length === 0);
check("S5 nothing was created", (await tab.evaluate(() => window.svc.creates.length)) === 0);
check("S3 theme applies: body background", (await css(f, "body", "backgroundColor")) === "rgb(26, 27, 38)");
await tab.screenshot({ path: join(out, "s5-empty.png") });

// S1: pick an existing iOS simulator: it streams, and the choice is saved.
await f.click(".picker");
await sleep(250);
const rows = await f.evaluate(() => [...document.querySelectorAll(".menu li")].map((li) => li.textContent));
console.log("  picker:", JSON.stringify(rows));
check("S1 picker lists iOS then Android with version and state", /iOS simulators/.test(rows[0]) && rows.indexOf("Android emulators") > rows.findIndex((r) => /iPhone 15.*iOS 17\.5.*Off/.test(r)) && rows.findIndex((r) => /iPhone 15/.test(r)) > 0 && rows.some((r) => /Pixel_6.*Android 14.*On/.test(r)), rows.join(" | "));
check("S1 picker offers both New entries", rows.includes("New iOS simulator…") && rows.includes("New Android emulator…"));
await tab.screenshot({ path: join(out, "s1-picker.png") });
await f.click('.menu li[data-id="ios:U-MINE"]');
await sleep(900);
panes = await paneInfo(f);
check("S1 pane is live on the iPhone", panes[0].phase === "live" && panes[0].name === "iPhone 15", JSON.stringify(panes));
check("S1 the stream was opened for that device", (await opens()).join() === "ios:U-MINE");
check("S1 the live frame is the iPhone's", near(await pixel(f, ".pane"), "#22aa66"), await pixel(f, ".pane"));
await sleep(600);
check("S1 the pick was saved with the pane's device", await tab.evaluate(() => window.svc.layout?.type === "pane" && window.svc.layout.device?.id === "ios:U-MINE"));
await tab.screenshot({ path: join(out, "s1-live.png") });
f = await reload(DARK);
panes = await paneInfo(f);
check("S1 reopening restores the same device", panes.length === 1 && panes[0].name === "iPhone 15" && panes[0].phase === "live", JSON.stringify(panes));

// S2: create a new iOS simulator from the picker (model + runtime).
await f.click(".picker");
await sleep(250);
await f.click('.menu li[data-new="ios"]');
await sleep(300);
const formModels = await f.evaluate(() => [...document.querySelectorAll(".menu .newform select")].map((s) => [...s.options].map((o) => o.textContent)));
check("S2 form offers runtime and model", formModels.length === 2 && formModels[0][0] === "iOS 26.5" && formModels[1].includes("iPhone 17 Pro"), JSON.stringify(formModels));
check("S2 the newest iPhone Pro is the default model", (await f.evaluate(() => document.querySelectorAll(".menu .newform select")[1].selectedOptions[0].textContent)) === "iPhone 17 Pro");
await tab.screenshot({ path: join(out, "s2-create-form.png") });
await f.click('.menu .newform .create');
await sleep(1000);
panes = await paneInfo(f);
check("S2 the new simulator is shown and live", panes[0].name === "band – iPhone 17 Pro" && panes[0].phase === "live", JSON.stringify(panes));
check("S2 create was called with the model and runtime", await tab.evaluate(() => JSON.stringify(window.svc.creates[0]) === JSON.stringify({ platform: "ios", runtime: "rt26", deviceType: "t17" })));
await sleep(600);
check("S2 it is remembered", await tab.evaluate(() => window.svc.layout.device?.id === "ios:U-NEW"));

// S3/S4: split in two, an iPhone and an Android emulator, both live.
await f.click(".pane .split-row");
await sleep(300);
panes = await paneInfo(f);
check("S4 split gives two panes, the new one empty and its picker open", panes.length === 2 && panes[1].phase === "empty" && (await f.evaluate(() => !document.querySelectorAll(".pane")[1].querySelector(".menu").hidden)));
const menuRows = await f.evaluate(() => [...document.querySelectorAll(".pane")[1].querySelectorAll(".menu li[role=option]")].map((li) => [li.dataset.id, li.getAttribute("aria-disabled"), li.textContent]));
check("S4 the device in the first pane is marked taken", menuRows.some((r) => r[0] === "ios:U-NEW" && r[1] === "true" && /In another pane/.test(r[2])), JSON.stringify(menuRows.filter((r) => r[0] === "ios:U-NEW")));
await f.click('.pane[data-pane="p2"] .menu li[data-id="android:avd:Pixel_8"]');
await sleep(1000);
panes = await paneInfo(f);
check("S4 both panes are live, the second is an Android phone with a back button", panes.length === 2 && panes.every((p) => p.phase === "live") && panes[1].platform === "android" && panes[1].back && !panes[0].back, JSON.stringify(panes));
check("S4 each pane shows its own device", near(await pixel(f, '.pane[data-pane="p1"]'), "#3366cc") && near(await pixel(f, '.pane[data-pane="p2"]'), "#cc6633"));
await tab.screenshot({ path: join(out, "s4-two-panes.png") });

// Focus and keyboard: the focused pane's stream gets the keys and a focus message.
await f.click('.pane[data-pane="p1"] canvas.screen', { position: { x: 20, y: 40 } });
await sleep(200);
await tab.keyboard.type("a");
await sleep(200);
let s = await sent();
check("focus: a press on pane 1 focuses it", (await paneInfo(f)).find((p) => p.id === "p1").focused === "true");
check("focus: the typed key went to pane 1's device only", s.some((x) => x.stream === "ios:U-NEW" && x.msg.type === "text" && x.msg.text === "a") && !s.some((x) => x.stream === "android:avd:Pixel_8" && x.msg.type === "text"));
await f.click('.pane[data-pane="p2"] canvas.screen', { position: { x: 20, y: 40 } });
await sleep(200);
await tab.keyboard.type("b");
await f.click('.pane[data-pane="p2"] .back');
await sleep(200);
s = await sent();
check("focus: pane 2 got a focus message, then the key and Back", s.some((x) => x.stream === "android:avd:Pixel_8" && x.msg.type === "focus") && s.some((x) => x.stream === "android:avd:Pixel_8" && x.msg.type === "text" && x.msg.text === "b") && s.some((x) => x.stream === "android:avd:Pixel_8" && x.msg.type === "button" && x.msg.name === "BACK"));
check("focus: pane 1 did not get the second key", !s.some((x) => x.stream === "ios:U-NEW" && x.msg.text === "b"));

// Divider: dragging changes the split ratio, and it is saved.
const div = await f.evaluate(() => { const r = document.querySelector(".divider").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
const fb = await (await tab.$("iframe")).boundingBox();
await tab.mouse.move(fb.x + div.x, fb.y + div.y);
await tab.mouse.down();
await tab.mouse.move(fb.x + 300, fb.y + div.y, { steps: 5 });
await tab.mouse.up();
await sleep(700);
const ratio = await tab.evaluate(() => window.svc.layout.ratio);
check("canvas: dragging the divider resizes the panes and saves the ratio", ratio > 0.2 && ratio < 0.4, String(ratio));
await tab.screenshot({ path: join(out, "s4-resized.png") });

// Up to 4 panes: split until the buttons disable.
await f.click('.pane[data-pane="p1"] .split-column');
await sleep(300);
await tab.keyboard.press("Escape");
await f.click('.pane[data-pane="p2"] .split-column');
await sleep(300);
panes = await paneInfo(f);
check("canvas: 4 panes at most", panes.length === 4 && (await f.evaluate(() => [...document.querySelectorAll(".split-row, .split-column")].every((b) => b.disabled))));
await tab.screenshot({ path: join(out, "s4-four-panes.png") });
// Close the two empty ones again.
for (const id of ["p3", "p4"]) {
  await f.click(`.pane[data-pane="${id}"] .close`);
  await sleep(200);
}
panes = await paneInfo(f);
check("canvas: closing a pane gives its space to the other", panes.length === 2 && panes.every((p) => p.phase === "live"));

// S4: close one, reopen: layout and devices restored.
await f.click('.pane[data-pane="p2"] .close');
await sleep(700);
panes = await paneInfo(f);
check("S4 after closing one pane a single pane is left", panes.length === 1 && panes[0].name === "band – iPhone 17 Pro");
await f.click('.pane[data-pane="p1"] .split-row');
await sleep(300);
await f.click('.pane[data-pane="p2"] .menu li[data-id="android:avd:Pixel_8"]');
await sleep(1000);
await sleep(600);
f = await reload(DARK);
panes = await paneInfo(f);
check("S4 reopening restores both panes and devices", panes.length === 2 && panes[0].name === "band – iPhone 17 Pro" && panes[1].name === "Pixel_8" && panes.every((p) => p.phase === "live"), JSON.stringify(panes));
await tab.screenshot({ path: join(out, "s4-restored.png") });

// S5: a worktree with nothing of its own starts from the repo's layout (the service answers from: "repo").
await tab.evaluate(() => { window.svc.from = "repo"; });
f = await reload(DARK);
panes = await paneInfo(f);
check("S5 a layout from the repo opens like a saved one", panes.length === 2 && panes.every((p) => p.phase === "live"));

// Android: the picker explains a missing SDK and a missing system image.
await f.click('.pane[data-pane="p2"] .picker');
await sleep(250);
await f.click('.pane[data-pane="p2"] .menu li[data-new="android"]');
await sleep(300);
check("S3 the Android form offers device profile and system image", await f.evaluate(() => document.querySelectorAll(".menu .newform select").length === 2));
await tab.screenshot({ path: join(out, "s3-android-form.png") });
await tab.evaluate(() => { window.svc.noImages = true; });
await f.click('.pane[data-pane="p2"] .menu .newform button[type="button"]');
await f.click('.pane[data-pane="p2"] .menu li[data-new="android"]');
await sleep(300);
const hint = await f.evaluate(() => document.querySelector(".menu .newform .hint").textContent);
check("S3 with no system image the form says how to install one and does not download", /No Android system image/.test(hint) && /sdkmanager "system-images/.test(hint) && (await f.evaluate(() => document.querySelector('.menu .newform .create').disabled)), hint);
await tab.screenshot({ path: join(out, "s3-android-no-image.png") });
await tab.evaluate(() => { window.svc.androidReady = false; });
await tab.keyboard.press("Escape");
await f.click('.pane[data-pane="p2"] .picker');
await sleep(250);
await f.click('.pane[data-pane="p2"] .picker');
await f.click('.pane[data-pane="p2"] .picker');
await sleep(250);
const note = await f.evaluate(() => [...document.querySelectorAll(".pane[data-pane='p2'] .menu .note")].map((n) => n.textContent));
check("S3 with no SDK the picker says so", note.some((n) => /Android SDK was not found/.test(n)) && !(await f.evaluate(() => !!document.querySelector(".pane[data-pane='p2'] .menu li[data-new='android']"))), JSON.stringify(note));

await browser.close();
build.close();
page.close();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
