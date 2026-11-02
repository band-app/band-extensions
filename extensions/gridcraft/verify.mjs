// Protocol test for the GridCraft extension build, in headless Chrome.
//   PLAYWRIGHT=<path to playwright-core> node extensions/gridcraft/verify.mjs [outdir]
// Tests extensions/gridcraft/dist/web (with tools.json, written by scripts/package.sh), or DIST.
//
// The test page (origin A) frames the build from another server (origin B) in
// <iframe sandbox="allow-scripts">, as Band does, so the frame has a null origin. The page plays
// Band: it sends band:hello with a MessagePort, then init, and speaks the editor protocol on the
// port. Checks scenarios S1 to S6 (init, save, reload, csv, mcp, forged messages); the rest are shell commands (see the README).
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";

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
    "ch.port1.postMessage({ type: 'init', file: { name: 'evil.csv', bytes: new TextEncoder().encode('evil\\\\n1').buffer } });" +
    "<\\/script>";
  window.addEventListener("message", (e) => { if (e.data && e.data.forgerRan) window.forgerRan = true; if (e.data && e.data.forgedReply) sessions[id].log.push({ type: "FORGED:" + e.data.forgedReply }); });
  document.body.appendChild(el);
};

// Messages from the parent that are not a valid band:hello.
window.junk = (id) => {
  const w = sessions[id].el.contentWindow;
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => sessions[id].log.push({ type: "JUNK:" + e.data.type });
  w.postMessage({ type: "init", file: { name: "x.csv", bytes: new ArrayBuffer(0) } }, "*");
  w.postMessage({ type: "band:hello", extensionApi: 2 }, "*", [ch.port2]);
  w.postMessage({ type: "band:hello", extensionApi: 1 }, "*");
  w.postMessage({ type: "gridcraft:mcp", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } }, "*");
  ch.port1.postMessage({ type: "init", file: { name: "x.csv", bytes: new ArrayBuffer(0) } });
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
  const csv = Buffer.from("fruit,qty\napple,3\npear,5\n");
  let xlsx;

  // S5 first, because it also makes the .xlsx the other scenarios open: the repo has none.
  {
    const page = await newPage();
    const id = await open(page, "fruit.csv", csv);
    await sleep(2000);
    const before = text(await call(page, id, "read_range", { range: "A1:B3" }));
    check("S5a", /apple/.test(before) && /pear/.test(before), before.slice(0, 120));
    await page.screenshot({ path: join(out, "s5-csv.png") });
    await call(page, id, "set_cell", { cell: "B2", input: "42" });
    await waitLog(page, id, "dirty");
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save");
    const saved = (await logOf(page, id)).find((m) => m.type === "save");
    const savedText = Buffer.from(saved.bytes).toString();
    check("S5b", /apple,42/.test(savedText), savedText.replace(/\n/g, "|"));
    // The .xlsx for the other scenarios, made by the build itself.
    const made = await call(page, id, "execute_command", { command: "file.saveBytes", params: { format: "xlsx" } });
    const b64 = /"base64"\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(text(made))?.[1];
    xlsx = b64 ? Buffer.from(b64, "base64") : null;
    writeFileSync(join(out, "seed.xlsx"), xlsx ?? Buffer.alloc(0));
    if (!xlsx) console.log("  saveBytes reply:", text(made).slice(0, 300));
    await page.close();
  }
  if (!xlsx) throw new Error("couldn't make an .xlsx fixture");

  // S1 to S4 on an .xlsx.
  {
    const page = await newPage();
    const t0 = Date.now();
    const id = await open(page, "book.xlsx", xlsx);
    console.log("  hello to ready:", Date.now() - t0, "ms");
    await sleep(2500);
    await page.screenshot({ path: join(out, "s1-xlsx.png") });
    const cell = text(await call(page, id, "read_range", { range: "A1:B3" }));
    check("S1", /apple/.test(cell), `ready received; A1:B3 = ${cell.slice(0, 100)}`);
    check("S1-dirty-initial", !(await logOf(page, id)).some((m) => m.type === "dirty"), "no dirty message before an edit");

    // S4: tools/list equals tools.json, tools/call works, screenshot is MCP image content.
    const list = (await mcp(page, id, "tools/list", {})).tools;
    const fromFile = JSON.parse(readFileSync(join(dist, "tools.json"), "utf8")).tools;
    const strip = ({ agent, ...t }) => t;
    check("S4a", sameJson(list, fromFile.map(strip)) && fromFile.length === list.length, `${list.length} tools`);
    await call(page, id, "set_cell", { cell: "C3", input: "edited" });
    const readBack = text(await call(page, id, "read_range", { range: "C3" }));
    await waitLog(page, id, "dirty");
    const dirty1 = (await logOf(page, id)).find((m) => m.type === "dirty");
    check("S4b", /edited/.test(readBack) && dirty1.dirty === true, `${readBack.slice(0, 60)}; dirty ${dirty1.dirty}`);
    const shot = await call(page, id, "screenshot", {});
    const img = shot.content.find((c) => c.type === "image");
    if (img) writeFileSync(join(out, "s4-screenshot.png"), Buffer.from(img.data, "base64"));
    check("S4c", !!img && img.mimeType === "image/png", img ? `${img.data.length} base64 chars` : text(shot));

    // S2: requestSave gives a valid .xlsx holding the edit; saved clears dirty.
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save");
    const save = (await logOf(page, id)).find((m) => m.type === "save");
    const bytes = Buffer.from(save.bytes);
    writeFileSync(join(out, "s2-saved.xlsx"), bytes);
    check("S2a", bytes[0] === 0x50 && bytes[1] === 0x4b, `${bytes.length} bytes, PK header`);
    check("S2b", (await logOf(page, id)).filter((m) => m.type === "dirty").length === 1, "still dirty until saved");
    await page.evaluate((i) => window.send(i, { type: "saved" }), id);
    await waitLog(page, id, "dirty", 2);
    const dirties = (await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty);
    check("S2c", sameJson(dirties, [true, false]), JSON.stringify(dirties));
    // saveFailed keeps it dirty: edit, save, fail.
    await call(page, id, "set_cell", { cell: "D4", input: "again" });
    await waitLog(page, id, "dirty", 3);
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save", 2);
    await page.evaluate((i) => window.send(i, { type: "saveFailed", error: "disk full" }), id);
    await sleep(1500);
    const afterFail = (await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty);
    check("S2d", sameJson(afterFail, [true, false, true]), `saveFailed keeps dirty: ${JSON.stringify(afterFail)}`);

    // The saved bytes reopen with the edit.
    const id2 = await open(page, "reopen.xlsx", bytes);
    await sleep(1500);
    const again = text(await call(page, id2, "read_range", { range: "C3" }));
    check("S2e", /edited/.test(again), `reopened: ${again.slice(0, 60)}`);

    // GridCraft's own File > Save (Cmd+S in the UI) also sends save.
    const id3 = await open(page, "book.xlsx", xlsx);
    await sleep(1500);
    await call(page, id3, "set_cell", { cell: "A9", input: "ui" });
    await waitLog(page, id3, "dirty");
    await call(page, id3, "execute_command", { command: "file.save", params: {} });
    await waitLog(page, id3, "save");
    check("S2f", true, "file.save inside GridCraft sent save");

    // S3: reload replaces the workbook.
    const id4 = await open(page, "book.xlsx", xlsx);
    await sleep(1500);
    const pre = text(await call(page, id4, "read_range", { range: "A1:C3" }));
    await page.evaluate(([i, b]) => window.send(i, { type: "reload" }, b), [id4, Array.from(bytes)]);
    await sleep(2500);
    const post = text(await call(page, id4, "read_range", { range: "C3" }));
    check("S3", /apple/.test(pre) && /edited/.test(post) && !/edited/.test(pre), `before: ${pre.slice(0, 50)} | after C3: ${post.slice(0, 50)}`);
    await page.screenshot({ path: join(out, "s3-reload.png") });
    await page.close();
  }

  // S6: forged and junk messages change nothing.
  {
    const page = await newPage();
    const id = await page.evaluate(() => window.frame(false));
    await sleep(6000); // the frame is up and waiting for band:hello
    await page.evaluate((i) => window.forger(i), id);
    await page.evaluate((i) => window.junk(i), id);
    await sleep(4000);
    const quiet = await logOf(page, id);
    const ran = await page.evaluate(() => window.forgerRan === true);
    check("S6a", ran && quiet.length === 0, `nothing came back to the forger or the parent: ${JSON.stringify(quiet)}`);
    // The real hello still works afterwards, so nothing took the port.
    await page.evaluate((i) => window.hello(i), id);
    await page.evaluate(([i, b]) => window.init(i, "real.csv", b), [id, Array.from(csv)]);
    await waitLog(page, id, "ready");
    const cells = text(await call(page, id, "read_range", { range: "A1:B3" }));
    check("S6b", /apple/.test(cells) && !/evil/.test(cells), cells.slice(0, 100));
    await page.close();
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
