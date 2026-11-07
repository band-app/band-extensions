// Headless Chrome check of the Simulator panel with a stand-in stream (no simulator needed).
//   PLAYWRIGHT=<path to playwright-core> node extensions/simulator/verify.mjs [outdir]
// Tests panel/ directly, or DIST. The test page plays Band like the other extensions' verify.mjs:
// it frames the panel from another origin in <iframe sandbox="allow-scripts">, sends band:hello with
// a MessagePort, then init with a theme, and answers stream.open and call on the port.
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

const DEVICES = [
  { udid: "U-MINE", name: "iPhone 15", runtime: "17.5", state: "Shutdown", owned: false, group: "mine" },
  { udid: "U-OTHER", name: "Band – borko-main", runtime: "26.5", state: "Booted", owned: true, group: "other" },
  { udid: "U-THIS", name: "Band – band-main", runtime: "26.5", state: "Booted", owned: true, group: "this" },
];

const PAGE = `<!DOCTYPE html><meta charset="utf-8"><style>body{margin:0}iframe{width:700px;height:760px;border:0}</style>
<body><script>
const BUILD = ${JSON.stringify(buildBase)};
const DEVICES = ${JSON.stringify(DEVICES)};
window.log = [];
window.state = { portrait: true, bootDelay: 0, sandbox: "" };
let port;
// A JPEG of the given size with a marker square, drawn by the browser.
async function jpeg(w, h) {
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext("2d");
  x.fillStyle = "#2a6"; x.fillRect(0, 0, w, h);
  x.fillStyle = "#fff"; x.fillRect(w / 2 - 20, h / 2 - 20, 40, 40);
  return new Uint8Array(await (await c.convertToBlob({ type: "image/jpeg" })).arrayBuffer());
}
window.sendTheme = (t) => port.postMessage({ type: "theme", ...t });
window.frame = (theme) => {
  document.querySelectorAll("iframe").forEach((f) => f.remove());
  window.log = [];
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", window.state.sandbox || "allow-scripts");
  el.src = BUILD + "/panel.html";
  document.body.appendChild(el);
  el.addEventListener("load", () => {
    const ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = async (e) => {
      const m = e.data;
      window.log.push(m);
      if (m.type === "stream.open") {
        port.postMessage({ type: "stream.opened", id: m.id });
        const msg = (o) => port.postMessage({ type: "stream.message", id: m.id, text: JSON.stringify(o) });
        if (window.state.bootDelay) {
          msg({ type: "booting" });
          msg({ type: "booting", phase: "cloning" });
          await new Promise((r) => setTimeout(r, 400));
          msg({ type: "booting", phase: "booting", name: "Band \\u2013 band-main", model: "iPhone 17 Pro" });
          await new Promise((r) => setTimeout(r, window.state.bootDelay));
        }
        msg({ type: "info", udid: "U-THIS", name: "Band \\u2013 band-main", width: 402, height: 874, model: "iPhone 17 Pro" });
        window.sendFrame = async () => {
          const [w, h] = window.state.portrait ? [804, 1748] : [1748, 804];
          const bytes = await jpeg(w, h);
          port.postMessage({ type: "stream.frame", id: m.id, data: bytes.buffer }, [bytes.buffer]);
        };
        await window.sendFrame();
      }
      if (m.type === "call") {
        let result = {};
        if (m.method === "devices") result = { current: "U-THIS", devices: DEVICES };
        if (m.method === "rotate") { window.state.portrait = m.params.orientation === "portrait"; setTimeout(window.sendFrame, 50); }
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
const ctx = await browser.newContext({ viewport: { width: 700, height: 760 } });
const tab = await ctx.newPage();
tab.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));
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
const css = (f, sel, prop) => f.evaluate(([s, p]) => getComputedStyle(document.querySelector(s))[p], [sel, prop]);
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};

const DARK = { mode: "dark", tokens: { "--background": "#1a1b26", "--foreground": "#c0caf5", "--muted-foreground": "#7a88b8", "--border": "#2f334d", "--accent": "#292e42" } };
const LIGHT = { mode: "light", tokens: { "--background": "#fafafa", "--foreground": "#202020", "--muted-foreground": "#707070", "--border": "#dddddd", "--accent": "#ececec" } };

// S2: a device that is booting shows the shell with the spinner and the phase text, then the screen.
await tab.evaluate(([t]) => { window.state.bootDelay = 3000; window.frame(t); }, [DARK]);
let f = await panel();
await sleep(100);
check("S2 spinner visible while cloning", await f.evaluate(() => getComputedStyle(document.getElementById("boot")).display === "flex"));
check("S2 text says Creating device", (await f.textContent("#boot-text")) === "Creating device…", await f.textContent("#boot-text"));
await tab.screenshot({ path: join(out, "s2-creating.png") });
await sleep(900);
check("S2 text says Booting <model>", (await f.textContent("#boot-text")) === "Booting iPhone 17 Pro…", await f.textContent("#boot-text"));
await tab.screenshot({ path: join(out, "s2-booting.png") });
await sleep(3200);
check("S2 spinner gone when frames arrive", await f.evaluate(() => getComputedStyle(document.getElementById("boot")).display === "none"));
check("S2 phase is live", (await f.evaluate(() => document.body.dataset.phase)) === "live");
await tab.screenshot({ path: join(out, "s2-live-dark.png") });

// S3: colors equal the tokens, dark then light.
for (const [name, theme] of [["dark", DARK], ["light", LIGHT]]) {
  await tab.evaluate(([t]) => { window.state.bootDelay = 0; window.frame(t); }, [theme]);
  f = await panel();
  await sleep(800);
  const t = theme.tokens;
  check(`S3 ${name} body background`, (await css(f, "body", "backgroundColor")) === rgb(t["--background"]), await css(f, "body", "backgroundColor"));
  check(`S3 ${name} main background`, (await css(f, "main", "backgroundColor")) === rgb(t["--background"]));
  check(`S3 ${name} header border`, (await css(f, "header", "borderBottomColor")) === rgb(t["--border"]));
  check(`S3 ${name} toolbar text`, (await css(f, "#rotate", "color")) === rgb(t["--foreground"]));
  check(`S3 ${name} status muted`, (await css(f, "#status", "color")) === rgb(t["--muted-foreground"]));
  check(`S3 ${name} color-scheme`, (await css(f, "html", "colorScheme")) === name);
  await f.hover("#rotate");
  check(`S3 ${name} button hover`, (await css(f, "#rotate", "backgroundColor")) === rgb(t["--accent"]), await css(f, "#rotate", "backgroundColor"));
  await tab.screenshot({ path: join(out, `s3-${name}.png`) });
}

// S3 live: a "theme" message re-applies the tokens, and a token the new theme lacks falls back.
await tab.evaluate(([t]) => window.frame(t), [DARK]);
f = await panel();
await sleep(600);
await tab.evaluate(([t]) => window.sendTheme(t), [LIGHT]);
await sleep(200);
check("S3 live theme message: background", (await css(f, "body", "backgroundColor")) === rgb(LIGHT.tokens["--background"]), await css(f, "body", "backgroundColor"));
check("S3 live theme message: color-scheme", (await css(f, "html", "colorScheme")) === "light");
await tab.evaluate(() => window.sendTheme({ mode: "dark", tokens: { background: "#000000" } }));
await sleep(200);
check("S3 live theme: new token applies", (await css(f, "body", "backgroundColor")) === "rgb(0, 0, 0)");
check("S3 live theme: missing token falls back", (await css(f, "#rotate", "color")) !== rgb(LIGHT.tokens["--foreground"]));
await tab.screenshot({ path: join(out, "s3-live-theme.png") });
await tab.evaluate(([t]) => window.frame(undefined), [DARK]);
f = await panel();
await sleep(600);
check("S3 init without a theme still works", (await f.evaluate(() => document.body.dataset.phase)) === "live");

// S1: a tap on the screen reaches the device at the same fraction, inside the shell.
await tab.evaluate(([t]) => window.frame(t), [DARK]);
f = await panel();
await sleep(1000);
const box = await f.evaluate(() => {
  const r = document.getElementById("screen").getBoundingClientRect();
  const s = document.getElementById("shell").getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, sx: s.x, sy: s.y, sw: s.width, sh: s.height };
});
check("S1 shell is larger than the screen", box.sw > box.w && box.sh > box.h, JSON.stringify(box));
check("S1 screen keeps the device aspect", Math.abs(box.w / box.h - 402 / 874) < 0.01, String(box.w / box.h));
const frameEl = await tab.$("iframe");
const fb = await frameEl.boundingBox();
const px = box.x + box.w * 0.25, py = box.y + box.h * 0.75;
await tab.mouse.move(fb.x + px, fb.y + py);
await tab.mouse.down();
await tab.mouse.up();
await sleep(200);
const sent = await tab.evaluate(() => window.log.filter((m) => m.type === "stream.send").map((m) => JSON.parse(m.message)));
const begin = sent.find((m) => m.type === "touch" && m.phase === "begin");
check("S1 tap lands at (0.25, 0.75)", !!begin && Math.abs(begin.x - 0.25) < 0.01 && Math.abs(begin.y - 0.75) < 0.01, JSON.stringify(begin));
// A tap on the bezel is not on the screen: the canvas does not receive it.
const before = sent.length;
await tab.mouse.move(fb.x + box.sx + 2, fb.y + box.sy + box.sh / 2);
await tab.mouse.down();
await tab.mouse.up();
await sleep(200);
const after = await tab.evaluate(() => window.log.filter((m) => m.type === "stream.send").length);
check("S1 a press on the bezel sends no touch", after === before, `${before} -> ${after}`);
await tab.screenshot({ path: join(out, "s1-live-framed.png") });

// S5: toggle hides and restores the shell, rotate works with and without it.
await f.click("#frame-toggle");
check("S5 shell hidden", await f.evaluate(() => getComputedStyle(document.getElementById("shell")).display === "none"));
const plain = await f.evaluate(() => document.getElementById("screen").getBoundingClientRect().height);
check("S5 screen is larger without the frame", plain > box.h, `${plain} vs ${box.h}`);
await tab.screenshot({ path: join(out, "s5-unframed.png") });
await f.click("#rotate");
await sleep(500);
let dims = await f.evaluate(() => [document.getElementById("screen").width, document.getElementById("screen").height]);
check("S5 rotate without frame: landscape", dims[0] > dims[1], dims.join("x"));
await tab.screenshot({ path: join(out, "s5-landscape-unframed.png") });
await f.click("#frame-toggle");
check("S5 shell restored", await f.evaluate(() => getComputedStyle(document.getElementById("shell")).display !== "none"));
const lb = await f.evaluate(() => {
  const r = document.getElementById("screen").getBoundingClientRect();
  const s = document.getElementById("shell").getBoundingClientRect();
  return r.width > r.height && s.width > r.width;
});
check("S5 rotate with frame: landscape fits in the shell", lb);
await tab.screenshot({ path: join(out, "s5-landscape-framed.png") });
// Remembered per device: with storage blocked (Band's sandbox) the choice lasts for the session, and
// with storage it survives a reload of the panel.
await f.click("#frame-toggle");
await tab.evaluate(() => { window.state.sandbox = "allow-scripts allow-same-origin"; window.frame(undefined); });
f = await panel();
await sleep(800);
await f.click("#frame-toggle");
await tab.evaluate(() => window.frame(undefined));
f = await panel();
await sleep(800);
check("S5 hidden frame is remembered across a reload", await f.evaluate(() => getComputedStyle(document.getElementById("shell")).display === "none"));
await f.click("#frame-toggle");
check("S5 shown again, stored 1", (await f.evaluate(() => localStorage.getItem("sim-frame:U-THIS"))) === "1");
await tab.evaluate(() => { window.state.sandbox = ""; window.frame(undefined); });
f = await panel();
await sleep(800);
await f.click("#rotate");
await sleep(500);

// S4: the picker.
await f.click("#picker");
await sleep(300);
const rows = await f.evaluate(() => [...document.querySelectorAll("#menu li")].map((li) => [li.className || li.getAttribute("role"), li.textContent]));
console.log("  picker:", JSON.stringify(rows));
const order = rows.map((r) => r[1]);
check("S4 groups in order", order[0] === "This worktree" && order.findIndex((t) => t === "Other worktrees") === 2 && order.findIndex((t) => t === "My devices") === 4, order.join(" | "));
check("S4 this worktree's device first", /band-main/.test(order[1]) && /borko-main/.test(order[3]) && /iPhone 15/.test(order[5]));
check("S4 rows keep version and state", /iOS 26\.5.*On/.test(order[1]) && /iOS 17\.5.*Off/.test(order[5]));
await tab.screenshot({ path: join(out, "s4-picker.png") });

await browser.close();
build.close();
page.close();
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
