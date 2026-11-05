// Protocol test for the DeckCraft extension build, in headless Chrome.
//   PLAYWRIGHT=<path to playwright-core> node extensions/deckcraft/verify.mjs [outdir]
// Tests extensions/deckcraft/dist/web (with tools.json, written by scripts/package.sh), or DIST.
//
// The test page (origin A) frames the build from another server (origin B) in
// <iframe sandbox="allow-scripts">, as Band does, so the frame has a null origin. The page plays
// Band: it sends band:hello with a MessagePort, then init, and speaks the editor protocol on the
// port. Checks init, dirty, save, saved, saveFailed, reload, mcp and forged messages.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";
import { compactScenarios } from "../../scripts/verify-compact.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright-core");
const root = join(import.meta.dirname, "../..");
const fixture = join(import.meta.dirname, "fixtures/sample.pptx");
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
    "ch.port1.postMessage({ type: 'init', file: { name: 'evil.pptx', bytes: new TextEncoder().encode('evil\\\\n1').buffer } });" +
    "<\\/script>";
  window.addEventListener("message", (e) => { if (e.data && e.data.forgerRan) window.forgerRan = true; if (e.data && e.data.forgedReply) sessions[id].log.push({ type: "FORGED:" + e.data.forgedReply }); });
  document.body.appendChild(el);
};

// Messages from the parent that are not a valid band:hello.
window.junk = (id) => {
  const w = sessions[id].el.contentWindow;
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => sessions[id].log.push({ type: "JUNK:" + e.data.type });
  w.postMessage({ type: "init", file: { name: "x.pptx", bytes: new ArrayBuffer(0) } }, "*");
  w.postMessage({ type: "band:hello", extensionApi: 2 }, "*", [ch.port2]);
  w.postMessage({ type: "band:hello", extensionApi: 1 }, "*");
  w.postMessage({ type: "deckcraft:mcp", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } }, "*");
  ch.port1.postMessage({ type: "init", file: { name: "x.pptx", bytes: new ArrayBuffer(0) } });
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
const waitLog = (page, id, type, n = 1, timeout = 90000) =>
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

try {
  const pptx = readFileSync(fixture);
  const titleOf = async (page, id) => {
    const r = await call(page, id, "run_command", { command: "slide.inspect", params: {} });
    return text(r);
  };

  // Open, init to ready, tools/list, an edit sends dirty.
  {
    const page = await newPage();
    const t0 = Date.now();
    const id = await open(page, "deck.pptx", pptx);
    console.log("  hello to ready:", Date.now() - t0, "ms");
    await sleep(2500);
    await page.screenshot({ path: join(out, "s1-open.png") });
    const doc = text(await call(page, id, "inspect_document", {}));
    check("S1-open", /slides/i.test(doc), doc.slice(0, 100));
    check("S1-dirty-initial", !(await logOf(page, id)).some((m) => m.type === "dirty"), "no dirty message before an edit");

    const list = (await mcp(page, id, "tools/list", {})).tools;
    const fromFile = JSON.parse(readFileSync(join(dist, "tools.json"), "utf8")).tools;
    const strip = ({ agent, ...t }) => t;
    check("S1-tools", sameJson(list, fromFile.map(strip)) && fromFile.length === list.length && list.length > 0, `${list.length} tools`);
    const hidden = fromFile.filter((t) => t.agent === false).map((t) => t.name).sort();
    check("S3-hidden", sameJson(hidden, ["export", "new_presentation", "open_presentation", "save_presentation"]), hidden.join(","));

    await call(page, id, "add_text_box", { x: 60, y: 60, w: 400, h: 60, text: "edited by verify" });
    await waitLog(page, id, "dirty");
    const dirty1 = (await logOf(page, id)).find((m) => m.type === "dirty");
    check("S1-dirty", dirty1.dirty === true, `dirty ${dirty1.dirty}`);
    const shot = await call(page, id, "screenshot", {});
    const img = shot.content.find((c) => c.type === "image");
    if (img) writeFileSync(join(out, "s1-screenshot.png"), Buffer.from(img.data, "base64"));
    check("S1-screenshot", !!img && img.mimeType === "image/png", img ? `${img.data.length} base64 chars` : text(shot));

    // requestSave gives a valid .pptx holding the edit; saved clears dirty.
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save");
    const save = (await logOf(page, id)).find((m) => m.type === "save");
    const bytes = Buffer.from(save.bytes);
    writeFileSync(join(out, "saved.pptx"), bytes);
    check("S1-save", bytes[0] === 0x50 && bytes[1] === 0x4b, `${bytes.length} bytes, PK header`);
    check("S1-still-dirty", (await logOf(page, id)).filter((m) => m.type === "dirty").length === 1, "still dirty until saved");
    await page.evaluate((i) => window.send(i, { type: "saved" }), id);
    await waitLog(page, id, "dirty", 2);
    const dirties = (await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty);
    check("S1-saved", sameJson(dirties, [true, false]), JSON.stringify(dirties));
    // saveFailed keeps it dirty.
    await call(page, id, "add_text_box", { x: 60, y: 200, w: 400, h: 60, text: "again" });
    await waitLog(page, id, "dirty", 3);
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save", 2);
    await page.evaluate((i) => window.send(i, { type: "saveFailed", error: "disk full" }), id);
    await sleep(1500);
    const afterFail = (await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty);
    check("S1-saveFailed", sameJson(afterFail, [true, false, true]), JSON.stringify(afterFail));

    // The saved bytes reopen with the edit.
    const id2 = await open(page, "reopen.pptx", bytes);
    await sleep(1500);
    const again = await titleOf(page, id2);
    check("S1-reopen", /edited by verify/.test(again), again.slice(0, 80));

    // DeckCraft's own File > Save (the file.save command) also sends save.
    const id3 = await open(page, "deck.pptx", pptx);
    await sleep(1500);
    await call(page, id3, "add_text_box", { x: 60, y: 60, w: 300, h: 40, text: "ui" });
    await waitLog(page, id3, "dirty");
    await call(page, id3, "run_command", { command: "file.save", params: {} });
    await waitLog(page, id3, "save");
    check("S1-ui-save", true, "file.save inside DeckCraft sent save");

    // reload replaces the document.
    const id4 = await open(page, "deck.pptx", pptx);
    await sleep(1500);
    const pre = await titleOf(page, id4);
    await page.evaluate(([i, b]) => window.send(i, { type: "reload" }, b), [id4, Array.from(bytes)]);
    await sleep(3000);
    const post = await titleOf(page, id4);
    check("S1-reload", !/edited by verify/.test(pre) && /edited by verify/.test(post), `before: ${pre.length} chars | after has edit: ${/edited by verify/.test(post)}`);
    await page.screenshot({ path: join(out, "s1-reload.png") });
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
    check("forged", ran && quiet.length === 0, `nothing came back to the forger or the parent: ${JSON.stringify(quiet)}`);
    // The real hello still works afterwards, so nothing took the port.
    await page.evaluate((i) => window.hello(i), id);
    await page.evaluate(([i, b]) => window.init(i, "real.pptx", b), [id, Array.from(pptx)]);
    await waitLog(page, id, "ready");
    const doc = text(await call(page, id, "inspect_document", {}));
    check("forged-real-hello", /slides/i.test(doc) && !/evil/.test(doc), doc.slice(0, 100));
    await page.close();
  }

  // Compact layout, touch and selection (shared scenarios in scripts/verify-compact.mjs).
  {
    await compactScenarios(
      { browser, pageUrl, out, check, sleep, waitLog, logOf, call: (page, id, name, args) => call(page, id, name, args), text },
      {
        ext: "deckcraft",
        minChange: 0.015,
        prepare: ({ page, id, call }) => call(page, id, "call_app", { method: "ui.set", params: { zoom: 0.6 } }),
        restore: ({ page, id, call }) => call(page, id, "call_app", { method: "ui.set", params: { zoom: null } }),
        file: { name: "sample.pptx", bytes: readFileSync(fixture) },
        tap: [270, 437],
        clear: [250, 700],
        drag: { from: [340, 700], to: [200, 700] },
        wantSelection: (s) => (/^slide[0-9]+![0-9]+$/.test(s.address) && ["shape", "text"].includes(s.kind) ? null : `unexpected address/kind ${s.address} ${s.kind}`),
        useAddress: async ({ page, id, selection, call, text }) => {
          // slide<index>!<shape id>: go to the slide, then read it; the shape id must be on that slide.
          const [, slide, shape] = /^slide([0-9]+)!([0-9]+)$/.exec(selection.address);
          const got = text(await call(page, id, "inspect_slide", { index: Number(slide) }));
          const found = new RegExp(`"id":\\s*${shape}\\b`).test(got);
          return { ok: found, detail: `inspect_slide ${slide} lists shape ${shape}: ${found}` };
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
