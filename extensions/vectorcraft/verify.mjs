// Protocol test for the VectorCraft extension build, in headless Chrome.
//   PLAYWRIGHT=<path to playwright-core> node extensions/vectorcraft/verify.mjs [outdir]
// Tests extensions/vectorcraft/dist/web (with tools.json, written by scripts/package.sh), or DIST.
//
// The test page (origin A) frames the build from another server (origin B) in
// <iframe sandbox="allow-scripts">, as Band does, so the frame has a null origin. The page plays
// Band: it sends band:hello with a MessagePort, then init, and speaks the editor protocol on the
// port. Edits are made through window.vectorcraft inside the frame, which Playwright reaches over
// CDP. Checks S1 (init, ready, dirty, save, saved, saveFailed, reload, mcp) for .svg, .svgz and
// .vectorcraft, and S6 (forged messages).
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";
import { compactScenarios } from "../../scripts/verify-compact.mjs";
import { gunzipSync, gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright-core");
const root = join(import.meta.dirname, "../..");
const dist = process.env.DIST ?? join(import.meta.dirname, "dist/web");
const out = process.argv[2] ?? join(root, "dist/verify");
mkdirSync(out, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json" };

const listen = (handler) =>
  new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });

// Origin B serves the build with CORS open, like Band's /ext/<id>/ route: a null-origin frame
// makes every fetch (the wasm, the module script) a CORS request.
const build = await listen((req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/\.\./g, "");
  const file = join(dist, rel === "/" ? "index.html" : rel);
  if (!existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "access-control-allow-origin": "*" });
  res.end(readFileSync(file));
});
const buildBase = `http://127.0.0.1:${build.address().port}`;

// The test page plays Band's tab. Every function returns plain data so Playwright can read it.
const PAGE = `<!DOCTYPE html><meta charset="utf-8"><style>iframe{width:1000px;height:640px;border:1px solid #888}</style>
<body><script>
const BUILD = ${JSON.stringify(buildBase)};
const sessions = {};
let nextId = 1;
const buf = (a) => new Uint8Array(a).buffer;

// A new editor frame. With hello=false the page sends nothing yet.
window.frame = (hello = true) => {
  // A frame scrolled out of view stops drawing, and so stops answering. One editor at a time.
  document.querySelectorAll("iframe[data-editor]").forEach((f) => f.remove());
  const id = nextId++;
  const el = document.createElement("iframe");
  el.dataset.editor = "1";
  el.setAttribute("sandbox", "allow-scripts");
  const s = (sessions[id] = { id, el, log: [], pending: new Map(), nextRpc: 1, port: null });
  el.src = BUILD + "/index.html";
  document.body.appendChild(el);
  s.helloSent = new Promise((resolve) => el.addEventListener("load", () => { if (hello) window.hello(id); resolve(); }));
  return id;
};

window.whenHello = (id) => sessions[id].helloSent;

window.hello = (id) => {
  const s = sessions[id];
  const ch = new MessageChannel();
  s.port = ch.port1;
  s.port.onmessage = (e) => {
    const m = e.data;
    if (m.type === "mcp" && s.pending.has(m.message?.id)) {
      s.pending.get(m.message.id)(m.message);
      s.pending.delete(m.message.id);
      return;
    }
    s.log.push({ ...m, bytes: m.bytes ? Array.from(new Uint8Array(m.bytes)) : undefined, at: Date.now() });
  };
  s.el.contentWindow.postMessage({ type: "band:hello", extensionApi: 1 }, "*", [ch.port2]);
};

window.send = (id, msg, bytes) => {
  const m = { ...msg };
  if (bytes) m.bytes = buf(bytes);
  if (m.file && m.file.bytes) m.file = { ...m.file, bytes: buf(m.file.bytes) };
  const transfer = [];
  if (m.bytes) transfer.push(m.bytes);
  if (m.file && m.file.bytes) transfer.push(m.file.bytes);
  sessions[id].port.postMessage(m, transfer);
};

window.init = (id, name, bytes) =>
  window.send(id, { type: "init", file: { name, path: name, mime: "", bytes, readOnly: false }, theme: { tokens: {} } });

window.log = (id) => sessions[id].log;

// An mcp request on the port, answered by the editor (or not at all).
window.mcp = (id, method) =>
  new Promise((resolve) => {
    const s = sessions[id];
    const rpc = s.nextRpc++;
    s.pending.set(rpc, resolve);
    s.port.postMessage({ type: "mcp", message: { jsonrpc: "2.0", id: rpc, method } });
    setTimeout(() => resolve({ timeout: true }), 15000);
  });

// Another frame next to the editor, trying to take over: it sends band:hello with its own port
// to the editor's window, then init on that port.
window.forger = (id) => {
  const target = Array.from(document.querySelectorAll("iframe")).indexOf(sessions[id].el);
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", "allow-scripts");
  el.srcdoc = "<script>" +
    "const ch = new MessageChannel(); const got = [];" +
    "ch.port1.onmessage = (e) => parent.postMessage({ forgedReply: e.data.type }, '*');" +
    "parent.postMessage({ forgerRan: true }, '*');" +
    "const t = parent.frames[" + target + "];" +
    "t.postMessage({ type: 'band:hello', extensionApi: 1 }, '*', [ch.port2]);" +
    "ch.port1.postMessage({ type: 'init', file: { name: 'evil.svg', bytes: new TextEncoder().encode('<svg/>').buffer } });" +
    "<\\/script>";
  window.addEventListener("message", (e) => { if (e.data && e.data.forgerRan) window.forgerRan = true; if (e.data && e.data.forgedReply) sessions[id].log.push({ type: "FORGED:" + e.data.forgedReply }); });
  document.body.appendChild(el);
};

// Messages from the parent that are not a valid band:hello.
window.junk = (id) => {
  const w = sessions[id].el.contentWindow;
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => sessions[id].log.push({ type: "JUNK:" + e.data.type });
  w.postMessage({ type: "init", file: { name: "x.svg", bytes: new ArrayBuffer(0) } }, "*");
  w.postMessage({ type: "band:hello", extensionApi: 2 }, "*", [ch.port2]);
  w.postMessage({ type: "band:hello", extensionApi: 1 }, "*");
  w.postMessage({ type: "vectorcraft:mcp", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } }, "*");
  ch.port1.postMessage({ type: "init", file: { name: "x.svg", bytes: new ArrayBuffer(0) } });
};
</script></body>`;
const pageSrv = await listen((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(PAGE);
});
const pageUrl = `http://127.0.0.1:${pageSrv.address().port}/`;

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const results = {};
const check = (name, ok, detail) => {
  detail = detail?.replace(/\s+/g, " ");
  results[name] = { ok, detail };
  console.log(ok ? "PASS" : "FAIL", name, detail ?? "");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const newPage = async () => {
  const page = await browser.newPage({ viewport: { width: 1040, height: 700 } });
  page.on("console", (m) => console.log("  [page]", m.text().slice(0, 200)));
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));
  await page.goto(pageUrl);
  return page;
};
const waitLog = (page, id, type, n = 1, timeout = 120000) =>
  page.waitForFunction(([i, t, k]) => window.log(i).filter((m) => m.type === t).length >= k, [id, type, n], { timeout });
const logOf = (page, id) => page.evaluate((i) => window.log(i), id);
const dirties = async (page, id) => (await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty);
const open = async (page, name, bytes) => {
  const id = await page.evaluate(() => window.frame());
  await page.evaluate((i) => window.whenHello(i), id);
  await page.evaluate(([i, n, b]) => window.init(i, n, b), [id, name, Array.from(bytes)]);
  await waitLog(page, id, "ready");
  return id;
};
// The editor frame is the one iframe with a data-editor attribute; the page reaches window.vectorcraft in it.
const editorFrame = (page) => page.frames().filter((f) => f.url().startsWith(buildBase)).at(-1);
const inFrame = (page, fn, arg) => editorFrame(page).evaluate(fn, arg);
const nodes = (page) => inFrame(page, async () => (JSON.stringify(await window.vectorcraft.request("document.inspect", {})).match(/"id"/g) ?? []).length);
const draw = (page) => inFrame(page, () => window.vectorcraft.execute("shape.rectangle", { x: 20, y: 20, width: 120, height: 60 }));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Fixtures. The .vectorcraft one is made by the build itself, in an unframed page.
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><circle cx="100" cy="60" r="30" fill="#c33"/></svg>',
);
const nativeFixture = async () => {
  const page = await browser.newPage({ viewport: { width: 1040, height: 700 } });
  await page.goto(`${buildBase}/index.html`);
  await page.waitForFunction(() => window.vectorcraft, null, { timeout: 120000 });
  const bytes = await page.evaluate(async () => {
    window.vectorcraft.captureDownloads(true);
    await window.vectorcraft.execute("file.new", { width: 200, height: 120 });
    await window.vectorcraft.execute("shape.rectangle", { x: 10, y: 10, width: 50, height: 30 });
    await window.vectorcraft.execute("file.saveAs", { path: "seed.vectorcraft" });
    return Array.from(await window.vectorcraft.readFile("seed.vectorcraft"));
  });
  await page.close();
  return Buffer.from(bytes);
};

const FORMATS = [
  { ext: "svg", bytes: () => svg, magic: (b) => b.toString("utf8").includes("<svg") && b.toString("utf8").includes("<rect") },
  { ext: "svgz", bytes: () => gzipSync(svg), magic: (b) => b[0] === 0x1f && b[1] === 0x8b && gunzipSync(b).toString().includes("<rect") },
  { ext: "vectorcraft", bytes: null, magic: (b) => b.toString("utf8", 0, 200).includes('"format": "vectorcraft"') },
];

try {
  const native = await nativeFixture();
  writeFileSync(join(out, "seed.vectorcraft"), native);
  FORMATS[2].bytes = () => native;

  for (const f of FORMATS) {
    const tag = f.ext;
    const page = await newPage();
    const t0 = Date.now();
    const id = await open(page, `drawing.${f.ext}`, f.bytes());
    console.log("  hello to ready:", Date.now() - t0, "ms");
    await sleep(2500);
    await page.screenshot({ path: join(out, `s1-${tag}-opened.png`) });
    const before = await nodes(page);
    check(`S1-${tag}-ready`, before > 0 && !(await logOf(page, id)).some((m) => m.type === "dirty"), `ready; ${before} nodes; no dirty before an edit`);

    // An edit sends dirty.
    await draw(page);
    await waitLog(page, id, "dirty");
    check(`S1-${tag}-dirty`, sameJson(await dirties(page, id), [true]), JSON.stringify(await dirties(page, id)));
    await page.screenshot({ path: join(out, `s1-${tag}-edited.png`) });

    // requestSave gives the file's own format holding the edit; saved clears dirty.
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save");
    const bytes = Buffer.from((await logOf(page, id)).find((m) => m.type === "save").bytes);
    writeFileSync(join(out, `saved.${f.ext}`), bytes);
    check(`S1-${tag}-save`, f.magic(bytes), `${bytes.length} bytes`);
    check(`S1-${tag}-save-dirty`, (await dirties(page, id)).length === 1, "still dirty until saved");
    await page.evaluate((i) => window.send(i, { type: "saved" }), id);
    await waitLog(page, id, "dirty", 2);
    check(`S1-${tag}-saved`, sameJson(await dirties(page, id), [true, false]), JSON.stringify(await dirties(page, id)));

    // saveFailed keeps it dirty.
    await draw(page);
    await waitLog(page, id, "dirty", 3);
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save", 2);
    await page.evaluate((i) => window.send(i, { type: "saveFailed", error: "disk full" }), id);
    await sleep(1500);
    check(`S1-${tag}-saveFailed`, sameJson(await dirties(page, id), [true, false, true]), JSON.stringify(await dirties(page, id)));

    // The saved bytes reopen with the edit.
    const id2 = await open(page, `reopen.${f.ext}`, bytes);
    await sleep(2000);
    const after = await nodes(page);
    check(`S1-${tag}-reopen`, after > before, `nodes ${before} -> ${after}`);
    await page.screenshot({ path: join(out, `s1-${tag}-reopened.png`) });

    // VectorCraft's own File > Save (Cmd+S in the UI) also sends save, without a dialog.
    const id3 = await open(page, `ui.${f.ext}`, f.bytes());
    await sleep(2000);
    await draw(page);
    await waitLog(page, id3, "dirty");
    await inFrame(page, () => window.vectorcraft.execute("file.save", {}));
    await waitLog(page, id3, "save");
    const uiBytes = Buffer.from((await logOf(page, id3)).find((m) => m.type === "save").bytes);
    check(`S1-${tag}-ui-save`, f.magic(uiBytes), `file.save inside VectorCraft sent ${uiBytes.length} bytes in the file's format`);

    // reload replaces the document.
    const id4 = await open(page, `r.${f.ext}`, f.bytes());
    await sleep(2000);
    const pre = await nodes(page);
    await page.evaluate(([i, b]) => window.send(i, { type: "reload" }, b), [id4, Array.from(bytes)]);
    await sleep(3000);
    const post = await nodes(page);
    check(`S1-${tag}-reload`, post > pre, `nodes ${pre} -> ${post}`);
    await page.screenshot({ path: join(out, `s1-${tag}-reload.png`) });

    // mcp: the extension lists no tools, so tools.json is empty and a request gets an error reply.
    const listed = JSON.parse(readFileSync(join(dist, "tools.json"), "utf8")).tools;
    const reply = await page.evaluate(([i]) => window.mcp(i, "tools/list"), [id4]);
    check(`S1-${tag}-mcp`, listed.length === 0 && !!reply.error && !reply.timeout, `tools.json ${listed.length} tools; reply ${JSON.stringify(reply).slice(0, 100)}`);
    await page.close();
  }

  // S6: forged and junk messages change nothing.
  {
    const page = await newPage();
    const id = await page.evaluate(() => window.frame(false));
    await sleep(8000); // the frame is up and waiting for band:hello
    await page.evaluate((i) => window.forger(i), id);
    await page.evaluate((i) => window.junk(i), id);
    await sleep(4000);
    const quiet = await logOf(page, id);
    const ran = await page.evaluate(() => window.forgerRan === true);
    check("S6a", ran && quiet.length === 0, `nothing came back to the forger or the parent: ${JSON.stringify(quiet)}`);
    await page.evaluate((i) => window.hello(i), id);
    await page.evaluate(([i, b]) => window.init(i, "real.svg", b), [id, Array.from(svg)]);
    await waitLog(page, id, "ready");
    await sleep(1500);
    check("S6b", (await nodes(page)) > 0, "the real hello still works afterwards");
    await page.close();
  }

  // Compact layout, touch and selection (shared scenarios in scripts/verify-compact.mjs). The web build
  // lists no MCP tools, so the address is checked against the control channel instead.
  {
    await compactScenarios(
      { browser, pageUrl, out, check, sleep, waitLog, logOf, call: null, text: null },
      {
        ext: "vectorcraft",
        noLayoutTolerance: 0.15,
        file: { name: "drawing.svg", bytes: svg },
        // Compact opens on the preview; Edit leads to the editor the touch scenarios test.
        prepare: async ({ page }) => {
          await editorFrame(page).evaluate(() => document.querySelector("[data-band-native] button").click());
        },
        tap: [137, 440],
        clear: [60, 750],
        drag: { from: [300, 700], to: [250, 680] },
        wantSelection: (s) => (/^[0-9]+$/.test(s.address) && s.kind === "element" ? null : `unexpected address/kind ${s.address} ${s.kind}`),
        useAddress: async ({ page, selection }) => {
          const inspected = JSON.stringify(await inFrame(page, () => window.vectorcraft.request("document.inspect", {})));
          const sel = JSON.parse(inspected).selection;
          const ok = JSON.stringify(sel).includes(selection.address);
          return { ok, detail: `document.inspect selection ${JSON.stringify(sel).slice(0, 100)} holds node ${selection.address}` };
        },
      },
    );
  }

  // Preview (compact layout): the drawing as HTML built from the engine's SVG.
  {
    const PHONE = { width: 390, height: 844 };
    const tall = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="800" viewBox="0 0 200 800"><rect x="10" y="10" width="180" height="780" fill="#3a7"/><circle cx="100" cy="700" r="40" fill="#c33"/></svg>',
    );
    const reloaded = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect x="20" y="20" width="160" height="80" fill="#36c"/></svg>',
    );
    const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));
    await page.goto(pageUrl);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i })) });
    const openAt = async (name, bytes, layout, size = [PHONE.width, PHONE.height]) => {
      const id = await page.evaluate(() => window.frame());
      await page.evaluate(([w, h]) => {
        document.body.style.margin = "0";
        document.querySelector("iframe[data-editor]").style.cssText = `width:${w}px;height:${h}px;border:0;display:block`;
      }, size);
      await page.evaluate((i) => window.whenHello(i), id);
      await page.evaluate(([i, n, b, l]) => {
        const msg = { type: "init", file: { name: n, path: n, mime: "", bytes: b, readOnly: false }, theme: { mode: "dark", tokens: {} } };
        if (l) msg.layout = l;
        window.send(i, msg);
      }, [id, name, Array.from(bytes), layout]);
      await waitLog(page, id, "ready");
      await sleep(2500);
      return id;
    };
    const ui = () =>
      inFrame(page, () => {
        const root = document.querySelector("[data-band-native]");
        const img = root.querySelector("img");
        const scroller = root.children[1];
        const back = document.querySelector("body > button");
        return {
          shown: getComputedStyle(root).display !== "none",
          backShown: getComputedStyle(back).display !== "none",
          bg: getComputedStyle(root).backgroundColor,
          decoded: img.complete && img.naturalWidth > 0,
          svg: decodeURIComponent(img.getAttribute("src") ?? "").replace(/^data:image\/svg\+xml;charset=utf-8,/, ""),
          pageWidth: root.querySelector("img").parentElement.getBoundingClientRect().width,
          scrollTop: scroller.scrollTop,
          scrollable: scroller.scrollHeight > scroller.clientHeight,
          topIsPreview: !!document.elementFromPoint(195, 422)?.closest("[data-band-native]"),
        };
      });
    const shot = (name) => page.screenshot({ path: join(out, `preview-${name}.png`) });
    const click = (sel) => inFrame(page, (s) => document.querySelector(s).click(), sel);

    // S1: compact opens on the preview, which scrolls and zooms by touch.
    const id = await openAt("tall.svg", tall, "compact");
    const a = await ui();
    await shot("opened");
    check("preview:S1a", a.shown && a.decoded && a.topIsPreview && !a.backShown && a.svg.includes("<rect"), `preview shown over the editor; image decoded; svg ${a.svg.length} chars`);
    check("preview:S1b", a.scrollable, "a tall drawing is taller than the frame");
    await touch("touchStart", [[195, 700]]);
    for (let i = 1; i <= 14; i++) { await sleep(16); await touch("touchMove", [[195, 700 - i * 30]]); }
    await touch("touchEnd", []);
    await sleep(500);
    const b = await ui();
    await shot("scrolled");
    check("preview:S1c", b.scrollTop > 100, `one finger scrolled the preview to ${b.scrollTop}px`);
    await touch("touchStart", [[155, 400], [235, 400]]);
    for (let i = 1; i <= 10; i++) { await sleep(16); await touch("touchMove", [[155 - i * 8, 400], [235 + i * 8, 400]]); }
    await touch("touchEnd", []);
    await sleep(500);
    const c = await ui();
    await shot("zoomed");
    check("preview:S1d", c.pageWidth > b.pageWidth * 1.8, `two fingers zoomed the page from ${b.pageWidth.toFixed(0)}px to ${c.pageWidth.toFixed(0)}px`);
    const noSel = (await logOf(page, id)).filter((m) => m.type === "selection" && m.selection);
    check("preview:S1e", noSel.length === 0, "the preview reports no selection");
    await page.evaluate((i) => window.send(i, { type: "theme", mode: "light", tokens: { background: "#ffeedd" } }), id);
    await sleep(500);
    check("preview:S1f", (await ui()).bg === "rgb(255, 238, 221)", "the theme message sets the preview's background");

    // S2: Edit opens the editor, an edit makes it dirty, Back shows the edit, save still works.
    await click("[data-band-native] button");
    await sleep(800);
    const d = await ui();
    await shot("editing");
    check("preview:S2a", !d.shown && d.backShown, "Edit hides the preview and shows Back");
    const nodesBefore = await nodes(page);
    await draw(page);
    await waitLog(page, id, "dirty");
    await click("body > button");
    await sleep(800);
    const e = await ui();
    await shot("back");
    const rects = (e.svg.match(/<rect/g) ?? []).length;
    check("preview:S2b", e.shown && rects > (a.svg.match(/<rect/g) ?? []).length && sameJson(await dirties(page, id), [true]), `Back shows the edit (${rects} rects), still dirty`);
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save");
    const saved = Buffer.from((await logOf(page, id)).find((m) => m.type === "save").bytes);
    await page.evaluate((i) => window.send(i, { type: "saved" }), id);
    await waitLog(page, id, "dirty", 2);
    check("preview:S2c", saved.toString().includes("<rect") && sameJson(await dirties(page, id), [true, false]) && nodesBefore > 0, `save from the preview sends ${saved.length} bytes; dirty ${JSON.stringify(await dirties(page, id))}`);

    // S4: reload shows the new bytes.
    const before = (await ui()).svg;
    await page.evaluate(([i, bytes]) => window.send(i, { type: "reload" }, bytes), [id, Array.from(reloaded)]);
    await sleep(3500);
    const r = await ui();
    await shot("reloaded");
    check("preview:S4", r.shown && r.svg !== before && r.svg.includes("<rect") && !r.svg.includes("<circle"), "reload replaced the preview with the new drawing");

    // S3: the regular layout opens the editor and has no preview.
    await page.close();
    const wide = await ctx.newPage();
    await wide.setViewportSize({ width: 1280, height: 800 });
    await wide.goto(pageUrl);
    const page2 = wide;
    const idW = await page2.evaluate(() => window.frame());
    await page2.evaluate(() => { document.querySelector("iframe[data-editor]").style.cssText = "width:1280px;height:800px;border:0;display:block"; });
    await page2.evaluate((i) => window.whenHello(i), idW);
    await page2.evaluate(([i, b]) => window.init(i, "wide.svg", b), [idW, Array.from(svg)]);
    await waitLog(page2, idW, "ready");
    await sleep(2500);
    const w = await editorFrame(page2).evaluate(() => ({
      shown: getComputedStyle(document.querySelector("[data-band-native]")).display !== "none",
      back: getComputedStyle(document.querySelector("body > button")).display !== "none",
    }));
    await page2.screenshot({ path: join(out, "preview-regular.png") });
    check("preview:S3", !w.shown && !w.back, "a regular frame opens the editor, no preview and no Back");
    await ctx.close();
  }
} catch (e) {
  console.log("ERROR", e);
  results.error = String(e);
} finally {
  writeFileSync(join(out, "verify-results.json"), JSON.stringify(results, null, 1));
  await browser.close();
  build.close();
  pageSrv.close();
}
process.exit(Object.values(results).every((r) => r === results.error || r.ok) && !results.error ? 0 : 1);
