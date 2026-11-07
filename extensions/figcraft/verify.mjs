// Protocol test for the FigCraft extension build, in headless Chrome.
//   PLAYWRIGHT=<path to playwright-core> node extensions/figcraft/verify.mjs [outdir]
// Tests extensions/figcraft/dist/web (with tools.json, written by scripts/package.sh), or DIST.
//
// The test page (origin A) frames the build from another server (origin B) in
// <iframe sandbox="allow-scripts">, as Band does, so the frame has a null origin. The page plays
// Band: it sends band:hello with a MessagePort, then init, and speaks the editor protocol on the
// port. Checks scenarios S1 to S5 (init, save, reload, mcp, forged messages).
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";
import { compactScenarios } from "../../scripts/verify-compact.mjs";

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

window.mcp = (id, method, params) =>
  new Promise((resolve, reject) => {
    const s = sessions[id];
    const rpc = s.nextRpc++;
    s.pending.set(rpc, resolve);
    s.port.postMessage({ type: "mcp", message: { jsonrpc: "2.0", id: rpc, method, params } });
    setTimeout(() => reject(new Error("mcp timeout: " + method)), 60000);
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
    "ch.port1.postMessage({ type: 'init', file: { name: 'evil.figcraft', bytes: new TextEncoder().encode('evil').buffer } });" +
    "<\\/script>";
  window.addEventListener("message", (e) => { if (e.data && e.data.forgerRan) window.forgerRan = true; if (e.data && e.data.forgedReply) sessions[id].log.push({ type: "FORGED:" + e.data.forgedReply }); });
  document.body.appendChild(el);
};

// Messages from the parent that are not a valid band:hello.
window.junk = (id) => {
  const w = sessions[id].el.contentWindow;
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => sessions[id].log.push({ type: "JUNK:" + e.data.type });
  w.postMessage({ type: "init", file: { name: "x.figcraft", bytes: new ArrayBuffer(0) } }, "*");
  w.postMessage({ type: "band:hello", extensionApi: 2 }, "*", [ch.port2]);
  w.postMessage({ type: "band:hello", extensionApi: 1 }, "*");
  w.postMessage({ type: "figcraft:mcp", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } }, "*");
  ch.port1.postMessage({ type: "init", file: { name: "x.figcraft", bytes: new ArrayBuffer(0) } });
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
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("");
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
const mcp = async (page, id, method, params) => {
  const reply = await page.evaluate(([i, m, p]) => window.mcp(i, m, p), [id, method, params]);
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
};
const call = (page, id, name, args) => mcp(page, id, "tools/call", { name, arguments: args });
const open = async (page, name, bytes) => {
  const id = await page.evaluate(() => window.frame());
  await page.evaluate((i) => window.whenHello(i), id);
  await page.evaluate(([i, n, b]) => window.init(i, n, b), [id, name, Array.from(bytes)]);
  await waitLog(page, id, "ready");
  return id;
};
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// A frame's names, from `inspect_document`.
const layerNames = async (page, id) => {
  const t = text(await call(page, id, "inspect_document", {}));
  return Array.from(t.matchAll(/"name":\s*"([^"]*)"/g), (m) => m[1]);
};
const base64Of = (reply) => /"data"\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(text(reply))?.[1];

try {
  // The repo has no FigCraft file, so the build makes the fixtures: an SVG opens through the same
  // file.open, and the build then writes it out as .figcraft and as .fig.
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#3366cc"/></svg>');
  let figcraft, fig;
  {
    const page = await newPage();
    const id = await open(page, "seed.svg", svg);
    await sleep(2000);
    const made = await call(page, id, "run_command", { command: "file.saveAs", params: { data: true } });
    const b64 = base64Of(made);
    figcraft = b64 ? Buffer.from(b64, "base64") : null;
    const madeFig = await call(page, id, "run_command", { command: "file.export", params: { format: "fig" } });
    const b64Fig = base64Of(madeFig);
    fig = b64Fig ? Buffer.from(b64Fig, "base64") : null;
    writeFileSync(join(out, "seed.figcraft"), figcraft ?? Buffer.alloc(0));
    writeFileSync(join(out, "seed.fig"), fig ?? Buffer.alloc(0));
    if (!figcraft) console.log("  saveAs reply:", text(made).slice(0, 300));
    if (!fig) console.log("  export reply:", text(madeFig).slice(0, 300));
    await page.close();
  }
  if (!figcraft || !fig) throw new Error("couldn't make the fixtures");

  // One scenario set per selector format.
  for (const [ext, seed] of [["figcraft", figcraft], ["fig", fig]]) {
    const page = await newPage();
    const t0 = Date.now();
    const id = await open(page, `design.${ext}`, seed);
    console.log(`  [${ext}] hello to ready:`, Date.now() - t0, "ms");
    await sleep(2500);
    await page.screenshot({ path: join(out, `s1-${ext}.png`) });
    const names0 = await layerNames(page, id);
    check(`S1-${ext}`, names0.length > 0, `ready received; layers: ${names0.slice(0, 5).join(", ")}`);
    check(`S1-${ext}-dirty-initial`, !(await logOf(page, id)).some((m) => m.type === "dirty"), "no dirty message before an edit");

    // tools/list equals tools.json, tools/call edits the open file, screenshot is MCP image content.
    const list = (await mcp(page, id, "tools/list", {})).tools;
    const fromFile = JSON.parse(readFileSync(join(dist, "tools.json"), "utf8")).tools;
    const strip = ({ agent, ...t }) => t;
    check(`S1-${ext}-tools`, sameJson(list, fromFile.map(strip)) && fromFile.length === list.length, `${list.length} tools`);
    const hidden = fromFile.filter((t) => t.agent === false).map((t) => t.name);
    check(`S1-${ext}-agent-false`, sameJson(hidden, ["open_file", "save_file"]), JSON.stringify(hidden));
    await call(page, id, "create_node", { type: "frame", name: "EditedByAgent", x: 10, y: 10, width: 100, height: 60 });
    await waitLog(page, id, "dirty");
    const names1 = await layerNames(page, id);
    const dirty1 = (await logOf(page, id)).find((m) => m.type === "dirty");
    check(`S1-${ext}-edit`, names1.includes("EditedByAgent") && dirty1.dirty === true, `dirty ${dirty1.dirty}; layers: ${names1.slice(0, 6).join(", ")}`);
    // export with a path is refused, and without one it returns the bytes.
    const refused = await call(page, id, "export", { format: "svg", path: "/tmp/out.svg" });
    check(`S1-${ext}-export-path`, refused.isError === true && /path/.test(text(refused)), text(refused).slice(0, 100));
    const exported = await call(page, id, "export", { format: "svg" });
    check(`S1-${ext}-export-bytes`, !exported.isError && /<svg/.test(text(exported)), text(exported).slice(0, 60));
    const shot = await call(page, id, "screenshot", {});
    const img = shot.content.find((c) => c.type === "image");
    if (img) writeFileSync(join(out, `s1-${ext}-screenshot.png`), Buffer.from(img.data, "base64"));
    check(`S1-${ext}-screenshot`, !!img && img.mimeType === "image/png", img ? `${img.data.length} base64 chars` : text(shot));

    // requestSave gives the edited bytes; saved clears dirty.
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save");
    const save = (await logOf(page, id)).find((m) => m.type === "save");
    const bytes = Buffer.from(save.bytes);
    writeFileSync(join(out, `saved.${ext}`), bytes);
    check(`S1-${ext}-save`, bytes.length > 0 && !bytes.equals(seed), `${bytes.length} bytes (seed ${seed.length})`);
    check(`S1-${ext}-dirty-until-saved`, (await logOf(page, id)).filter((m) => m.type === "dirty").length === 1, "still dirty until saved");
    await page.evaluate((i) => window.send(i, { type: "saved" }), id);
    await waitLog(page, id, "dirty", 2);
    const dirties = (await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty);
    check(`S1-${ext}-saved`, sameJson(dirties, [true, false]), JSON.stringify(dirties));

    // An edit made after a save stays unsaved when that save is confirmed, and saveFailed keeps it dirty.
    await call(page, id, "create_node", { type: "frame", name: "SecondEdit", x: 0, y: 0, width: 10, height: 10 });
    await waitLog(page, id, "dirty", 3);
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save", 2);
    await page.evaluate((i) => window.send(i, { type: "saveFailed", error: "disk full" }), id);
    await sleep(1500);
    const afterFail = (await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty);
    check(`S1-${ext}-save-failed`, sameJson(afterFail, [true, false, true]), `saveFailed keeps dirty: ${JSON.stringify(afterFail)}`);

    // The saved bytes reopen with the edit.
    const id2 = await open(page, `reopen.${ext}`, bytes);
    await sleep(2000);
    const names2 = await layerNames(page, id2);
    check(`S1-${ext}-reopen`, names2.includes("EditedByAgent"), `layers: ${names2.slice(0, 6).join(", ")}`);

    // FigCraft's own File > Save (Cmd+S in the UI) also sends save.
    const id3 = await open(page, `design.${ext}`, seed);
    await sleep(1500);
    await call(page, id3, "create_node", { type: "frame", name: "ViaMenu", x: 0, y: 0, width: 10, height: 10 });
    await waitLog(page, id3, "dirty");
    await call(page, id3, "key", { key: "s", cmd: true }); // File > Save, as typed on the canvas
    await waitLog(page, id3, "save");
    check(`S1-${ext}-menu-save`, true, "Cmd+S inside FigCraft sent save");

    // reload replaces the document.
    const id4 = await open(page, `design.${ext}`, seed);
    await sleep(1500);
    const pre = await layerNames(page, id4);
    await page.evaluate(([i, b]) => window.send(i, { type: "reload" }, b), [id4, Array.from(bytes)]);
    await sleep(3000);
    const post = await layerNames(page, id4);
    check(`S1-${ext}-reload`, !pre.includes("EditedByAgent") && post.includes("EditedByAgent"), `before: ${pre.slice(0, 4)} | after: ${post.slice(0, 6)}`);
    await page.screenshot({ path: join(out, `s1-${ext}-reload.png`) });
    await page.close();
  }

  // A file FigCraft cannot read is not replaced by an empty design on save.
  {
    const page = await newPage();
    const id = await open(page, "broken.figcraft", Buffer.from("not a figcraft file"));
    await sleep(1500);
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await sleep(2000);
    const sent = (await logOf(page, id)).filter((m) => m.type === "save");
    check("S1-broken-file", sent.length === 0, `${sent.length} save messages for a file that did not open`);
    await page.close();
  }

  // Forged and junk messages change nothing.
  {
    const page = await newPage();
    const id = await page.evaluate(() => window.frame(false));
    await sleep(6000); // the frame is up and waiting for band:hello
    await page.evaluate((i) => window.forger(i), id);
    await page.evaluate((i) => window.junk(i), id);
    await sleep(4000);
    const quiet = await logOf(page, id);
    const ran = await page.evaluate(() => window.forgerRan === true);
    check("S1-forged-a", ran && quiet.length === 0, `nothing came back to the forger or the parent: ${JSON.stringify(quiet)}`);
    // The real hello still works afterwards, so nothing took the port.
    await page.evaluate((i) => window.hello(i), id);
    await page.evaluate(([i, b]) => window.init(i, "real.figcraft", b), [id, Array.from(figcraft)]);
    await waitLog(page, id, "ready");
    const names = await layerNames(page, id);
    check("S1-forged-b", names.length > 0 && !names.includes("evil"), names.slice(0, 5).join(", "));
    await page.close();
  }

  // The compact preview (P1 to P5): plain HTML built from the engine's export, with an Edit button to the editor.
  {
    const inFrame = (page) => page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(buildBase));
    const state = (page) =>
      inFrame(page).evaluate(() => {
        const q = (s) => document.querySelector(s);
        const scroller = q("#fp_scroll");
        return {
          mode: q("#fp").dataset.mode,
          previewShown: !q("#fp").hidden,
          backShown: !q("#fp_back").hidden,
          canvasVisible: getComputedStyle(q("#figcraft_canvas")).visibility,
          cards: document.querySelectorAll(".fp_card").length,
          ready: document.querySelectorAll('.fp_card[data-state="ready"]').length,
          names: Array.from(document.querySelectorAll("#fp_nav button"), (b) => b.textContent),
          contentWidth: q("#fp_content").offsetWidth,
          viewWidth: scroller.clientWidth,
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          background: getComputedStyle(q("#fp")).backgroundColor,
        };
      });
    const waitState = (page, test, what, timeout = 30000) => inFrame(page).waitForFunction(test, undefined, { timeout }).catch(() => console.log("  timeout waiting for", what));
    const send = (page, id, msg) => page.evaluate(([i, m]) => window.send(i, m), [id, msg]);
    const openAs = async (page, name, bytes, layout) => {
      const id = await page.evaluate(() => window.frame());
      await page.evaluate((i) => window.whenHello(i), id);
      await page.evaluate(([i, n, b, l]) => {
        const msg = { type: "init", file: { name: n, path: n, mime: "", bytes: b, readOnly: false }, theme: { mode: "light", tokens: {} } };
        if (l) msg.layout = l;
        window.send(i, msg);
      }, [id, name, Array.from(bytes), layout]);
      await waitLog(page, id, "ready");
      return id;
    };
    const sizeFrame = (page, w, h) =>
      page.evaluate(([w, h]) => {
        document.body.style.margin = "0";
        document.querySelector("iframe[data-editor]").style.cssText = `width:${w}px;height:${h}px;border:0;display:block`;
      }, [w, h]);

    // A second file with one more frame, to tell a reload from the first open.
    let reloaded;
    {
      const page = await newPage();
      const id = await open(page, "again.figcraft", figcraft);
      await sleep(1500);
      await call(page, id, "create_node", { type: "frame", name: "AfterReload", x: 300, y: 0, width: 100, height: 100 });
      const made = await call(page, id, "run_command", { command: "file.saveAs", params: { data: true } });
      reloaded = Buffer.from(base64Of(made) ?? "", "base64");
      await page.close();
    }

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));
    await page.goto(pageUrl);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i })) });
    try {
      const id = await openAs(page, "design.figcraft", figcraft, "compact");
      await sizeFrame(page, 390, 844);
      // Enough frames that the preview scrolls.
      for (let n = 1; n <= 5; n++) await call(page, id, "create_node", { type: "frame", name: `Tall ${n}`, x: 0, y: 200 * n, width: 300, height: 400 });
      await waitState(page, () => document.querySelectorAll(".fp_card").length >= 6 && document.querySelector('.fp_card[data-state="ready"]'), "frames and a ready image");
      await sleep(800);
      let st = await state(page);
      await page.screenshot({ path: join(out, "preview-p1-compact.png") });
      check("P1-preview-first", st.mode === "preview" && st.previewShown && st.canvasVisible === "hidden" && st.cards >= 6 && st.ready >= 1, JSON.stringify(st));
      check("P1-dirty-quiet", !(await logOf(page, id)).some((m) => m.type === "dirty" && m.dirty === false), "opening the preview sends no dirty=false");

      // The page scrolls natively (no script handles it); two fingers zoom it.
      // A wheel scroll: headless Chrome does not turn synthesized touch drags into scrolls inside a frame.
      await page.mouse.move(200, 600);
      await page.mouse.wheel(0, 500);
      await sleep(400);
      const scrolled = await state(page);
      check("P1-scroll", scrolled.scrollTop > 100 && scrolled.scrollHeight > 844, `scrollTop ${scrolled.scrollTop} of ${scrolled.scrollHeight}`);
      await touch("touchStart", [[150, 400], [250, 400]]);
      for (let i = 1; i <= 10; i++) { await sleep(16); await touch("touchMove", [[150 - i * 10, 400], [250 + i * 10, 400]]); }
      await touch("touchEnd", []);
      await sleep(1500);
      const zoomed = await state(page);
      await page.screenshot({ path: join(out, "preview-p1-zoomed.png") });
      check("P1-pinch-zoom", zoomed.contentWidth > zoomed.viewWidth * 1.8, `content ${zoomed.contentWidth}px in a ${zoomed.viewWidth}px view`);

      // Edit opens the editor, an edit is made there, and back shows it.
      await inFrame(page).click("#fp_edit");
      await waitState(page, () => document.querySelector("#fp").dataset.mode === "edit", "edit mode");
      await sleep(1500);
      st = await state(page);
      await page.screenshot({ path: join(out, "preview-p2-edit.png") });
      check("P2-edit", st.mode === "edit" && !st.previewShown && st.backShown && st.canvasVisible === "visible", JSON.stringify(st));
      await call(page, id, "create_node", { type: "frame", name: "MadeInEditor", x: 0, y: 1500, width: 80, height: 80 });
      await waitLog(page, id, "dirty");
      await inFrame(page).click("#fp_back");
      await waitState(page, () => Array.from(document.querySelectorAll("#fp_nav button")).some((b) => b.textContent === "MadeInEditor"), "the edit in the preview");
      await sleep(800);
      st = await state(page);
      await page.screenshot({ path: join(out, "preview-p2-back.png") });
      const dirties = (await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty);
      check("P2-back-shows-edit", st.mode === "preview" && st.names.includes("MadeInEditor"), JSON.stringify(st.names));
      check("P2-dirty-kept", sameJson(dirties, [true]), `dirty messages ${JSON.stringify(dirties)}`);
      await send(page, id, { type: "requestSave" });
      await waitLog(page, id, "save");
      const saved = (await logOf(page, id)).find((m) => m.type === "save");
      check("P2-save", saved.bytes.length > 0, `${saved.bytes.length} bytes`);
      await send(page, id, { type: "saved" });
      await waitLog(page, id, "dirty", 2);
      check("P2-saved-clears", sameJson((await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty), [true, false]), "saved clears dirty");

      // Band's theme colours the preview chrome.
      await send(page, id, { type: "theme", mode: "dark", tokens: { background: "#101820", foreground: "#eeeeee" } });
      await sleep(500);
      st = await state(page);
      check("P5-theme", st.background === "rgb(16, 24, 32)", `background ${st.background}`);

      // reload with new bytes redraws the preview (the tab has no unsaved edits now).
      await page.evaluate(([i, b]) => window.send(i, { type: "reload" }, b), [id, Array.from(reloaded)]);
      await waitState(page, () => Array.from(document.querySelectorAll("#fp_nav button")).some((b) => b.textContent === "AfterReload"), "the reloaded file");
      st = await state(page);
      await page.screenshot({ path: join(out, "preview-p4-reload.png") });
      check("P4-reload", st.names.includes("AfterReload") && !st.names.includes("MadeInEditor"), JSON.stringify(st.names));

      // A regular frame opens the editor and shows no preview.
      await page.setViewportSize({ width: 1280, height: 800 });
      const wide = await openAs(page, "design.figcraft", figcraft, "regular");
      await sizeFrame(page, 1280, 800);
      await sleep(2500);
      st = await state(page);
      await page.screenshot({ path: join(out, "preview-p3-regular.png") });
      check("P3-regular-editor", st.mode === "off" && !st.previewShown && !st.backShown && st.canvasVisible === "visible", JSON.stringify(st));
      const bare = await openAs(page, "design.figcraft", figcraft, undefined);
      await sizeFrame(page, 1280, 800);
      await sleep(2000);
      st = await state(page);
      check("P3-no-layout-editor", st.mode === "off" && !st.previewShown && st.canvasVisible === "visible", JSON.stringify(st));
      void wide; void bare;
    } finally {
      await ctx.close();
    }
  }

  // Compact layout, touch and selection (shared scenarios in scripts/verify-compact.mjs).
  {
    await compactScenarios(
      { browser, pageUrl, out, check, sleep, waitLog, logOf, call: (page, id, name, args) => call(page, id, name, args), text },
      {
        ext: "figcraft",
        s1Size: [900, 700],
        minChange: 0.02,
        file: { name: "seed.figcraft", bytes: figcraft },
        // The compact layout opens the preview first: press Edit to reach the editor the scenarios drive.
        prepare: async ({ page }) => {
          const f = page.frames().find((fr) => fr !== page.mainFrame() && fr.url().startsWith(buildBase));
          await f.click("#fp_edit");
          await sleep(1500);
        },
        tap: [25, 340],
        // A tap on empty canvas does not deselect in FigCraft, so the test runs its Select none command.
        clear: async (page, id) => call(page, id, "run_command", { command: "select.none", params: {} }),
        drag: { from: [300, 700], to: [100, 600] },
        wantSelection: (s) => (/^[0-9]+$/.test(s.address) && ["node", "text"].includes(s.kind) ? null : `unexpected address/kind ${s.address} ${s.kind}`),
        useAddress: async ({ page, id, selection, call, text }) => {
          const got = text(await call(page, id, "get_node", { id: Number(selection.address) }));
          return { ok: got.includes(selection.label.split(" and ")[0]) || /"id"/.test(got), detail: `get_node ${selection.address} -> ${got.slice(0, 120)}` };
        },
      },
    );
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
