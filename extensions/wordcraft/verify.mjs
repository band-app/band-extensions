// Protocol test for the WordCraft extension build, in headless Chrome.
//   PLAYWRIGHT=<path to playwright-core> node extensions/wordcraft/verify.mjs [outdir]
// Tests extensions/wordcraft/dist/web (with tools.json, written by scripts/package.sh), or DIST.
//
// The test page (origin A) frames the build from another server (origin B) in
// <iframe sandbox="allow-scripts">, as Band does, so the frame has a null origin. The page plays
// Band: it sends band:hello with a MessagePort, then init, and speaks the editor protocol on the
// port. Checks init, ready, dirty, save, saved, saveFailed, reload, mcp and forged messages for .docx, .odt and .rtf.
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
    "ch.port1.postMessage({ type: 'init', file: { name: 'evil.docx', bytes: new TextEncoder().encode('evil').buffer } });" +
    "<\\/script>";
  window.addEventListener("message", (e) => { if (e.data && e.data.forgerRan) window.forgerRan = true; if (e.data && e.data.forgedReply) sessions[id].log.push({ type: "FORGED:" + e.data.forgedReply }); });
  document.body.appendChild(el);
};

// Messages from the parent that are not a valid band:hello.
window.junk = (id) => {
  const w = sessions[id].el.contentWindow;
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => sessions[id].log.push({ type: "JUNK:" + e.data.type });
  w.postMessage({ type: "init", file: { name: "x.docx", bytes: new ArrayBuffer(0) } }, "*");
  w.postMessage({ type: "band:hello", extensionApi: 2 }, "*", [ch.port2]);
  w.postMessage({ type: "band:hello", extensionApi: 1 }, "*");
  w.postMessage({ type: "wordcraft:mcp", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } }, "*");
  ch.port1.postMessage({ type: "init", file: { name: "x.docx", bytes: new ArrayBuffer(0) } });
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

// Fixtures made here, so the repository holds no binary files. A .docx and an .odt are stored
// (uncompressed) zips of the smallest parts the format needs; the .rtf is plain text.
const crc = (() => {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();
const zip = (files) => {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const n = Buffer.from(name);
    const data = Buffer.from(content);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt32LE(crc(data), 14);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    parts.push(h, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc(data), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
};
const docx = (word) =>
  zip([
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ["word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${word}</w:t></w:r></w:p></w:body></w:document>`],
  ]);
const odt = (word) =>
  zip([
    ["mimetype", "application/vnd.oasis.opendocument.text"],
    ["META-INF/manifest.xml", '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>'],
    ["content.xml", `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text><text:p>${word}</text:p></office:text></office:body></office:document-content>`],
  ]);
const rtf = (word) => Buffer.from(`{\\rtf1\\ansi\\deff0 {\\fonttbl{\\f0 Times New Roman;}}\\f0\\fs24 ${word}\\par}`);
const FORMATS = [
  { ext: "docx", make: docx, magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { ext: "odt", make: odt, magic: (b) => b[0] === 0x50 && b[1] === 0x4b },
  { ext: "rtf", make: rtf, magic: (b) => b.subarray(0, 5).toString() === "{\\rtf" },
];

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
const dirtyOf = async (page, id) => (await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty);
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
const bodyText = async (page, id) => text(await call(page, id, "get_text", {}));
// The document shows its text once the app has drained the file; poll instead of sleeping.
const waitText = async (page, id, re, timeout = 30000) => {
  const end = Date.now() + timeout;
  let t = "";
  while (Date.now() < end) {
    t = await bodyText(page, id);
    if (re.test(t)) return t;
    await sleep(300);
  }
  return t;
};
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  for (const { ext, make, magic } of FORMATS) {
    const page = await newPage();
    const name = `note.${ext}`;
    const t0 = Date.now();
    const id = await open(page, name, make("appleword"));
    console.log(`  ${ext}: hello to ready`, Date.now() - t0, "ms");
    const first = await waitText(page, id, /appleword/);
    await page.screenshot({ path: join(out, `${ext}-opened.png`) });
    check(`${ext}-open`, /appleword/.test(first), `ready received; text = ${first.slice(0, 80)}`);
    check(`${ext}-clean`, !(await logOf(page, id)).some((m) => m.type === "dirty" && m.dirty), "no dirty message before an edit");

    // An edit through the app's MCP tools marks the tab dirty.
    await call(page, id, "type_text", { text: "EDITED" });
    await waitLog(page, id, "dirty");
    check(`${ext}-dirty`, sameJson(await dirtyOf(page, id), [true]), JSON.stringify(await dirtyOf(page, id)));

    // requestSave sends the document in the same format; the tab stays dirty until saved.
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save");
    const save = (await logOf(page, id)).find((m) => m.type === "save");
    const bytes = Buffer.from(save.bytes);
    writeFileSync(join(out, `saved.${ext}`), bytes);
    check(`${ext}-save`, magic(bytes), `${bytes.length} bytes`);
    check(`${ext}-save-pending`, sameJson(await dirtyOf(page, id), [true]), "still dirty until saved");
    await page.evaluate((i) => window.send(i, { type: "saved" }), id);
    await waitLog(page, id, "dirty", 2);
    check(`${ext}-saved`, sameJson(await dirtyOf(page, id), [true, false]), JSON.stringify(await dirtyOf(page, id)));

    // saveFailed keeps the tab dirty.
    await call(page, id, "type_text", { text: "AGAIN" });
    await waitLog(page, id, "dirty", 3);
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save", 2);
    await page.evaluate((i) => window.send(i, { type: "saveFailed", error: "disk full" }), id);
    await sleep(1500);
    check(`${ext}-save-failed`, (await dirtyOf(page, id)).at(-1) === true, JSON.stringify(await dirtyOf(page, id)));

    // An edit made while a save is in flight stays unsaved after `saved`.
    await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
    await waitLog(page, id, "save", 3);
    await call(page, id, "type_text", { text: "LATE" });
    await page.evaluate((i) => window.send(i, { type: "saved" }), id);
    await sleep(1500);
    check(`${ext}-edit-during-save`, (await dirtyOf(page, id)).at(-1) === true, JSON.stringify(await dirtyOf(page, id)));

    // The saved bytes reopen with the edit.
    const id2 = await open(page, `reopen.${ext}`, bytes);
    const again = await waitText(page, id2, /EDITED/);
    check(`${ext}-reopen`, /EDITED/.test(again) && /appleword/.test(again), again.slice(0, 80));

    // WordCraft's own File > Save (Cmd+S in the UI) also sends save, and the tab is clean after `saved`.
    const id3 = await open(page, name, make("appleword"));
    await waitText(page, id3, /appleword/);
    await call(page, id3, "type_text", { text: "UI" });
    await waitLog(page, id3, "dirty");
    await call(page, id3, "execute", { command: "file.save", params: {} });
    await waitLog(page, id3, "save");
    await page.evaluate((i) => window.send(i, { type: "saved" }), id3);
    await sleep(1500);
    check(`${ext}-ui-save`, (await dirtyOf(page, id3)).at(-1) === false, JSON.stringify(await dirtyOf(page, id3)));
    // A format Band cannot store is refused and the tab stays as it was.
    await call(page, id3, "type_text", { text: "MORE" });
    const saves = (await logOf(page, id3)).filter((m) => m.type === "save").length;
    const pdf = await call(page, id3, "execute", { command: "file.saveAs", params: { path: "copy.pdf" } });
    await sleep(500);
    const unchanged = (await logOf(page, id3)).filter((m) => m.type === "save").length === saves;
    check(`${ext}-other-format`, pdf.isError === true && unchanged, text(pdf).slice(0, 100));

    // reload replaces the document.
    const id4 = await open(page, name, make("appleword"));
    await waitText(page, id4, /appleword/);
    await page.evaluate(([i, b]) => window.send(i, { type: "reload" }, b), [id4, Array.from(make("pearword"))]);
    const after = await waitText(page, id4, /pearword/);
    check(`${ext}-reload`, /pearword/.test(after) && !/appleword/.test(after), after.slice(0, 80));
    await page.screenshot({ path: join(out, `${ext}-reload.png`) });
    await page.close();
  }

  // The MCP bridge: tools/list is the server's, screenshot is image content.
  {
    const page = await newPage();
    const id = await open(page, "tools.docx", docx("appleword"));
    await waitText(page, id, /appleword/);
    const list = (await mcp(page, id, "tools/list", {})).tools;
    const fromFile = JSON.parse(readFileSync(join(dist, "tools.json"), "utf8")).tools;
    const strip = ({ agent, ...t }) => t;
    check("mcp-tools", sameJson(list, fromFile.map(strip)) && list.length > 0, `${list.length} tools`);
    const hidden = fromFile.filter((t) => t.agent === false).map((t) => t.name);
    check("mcp-agent-false", sameJson(hidden.sort(), ["open_document", "save_document"]), hidden.join(","));
    const shot = await call(page, id, "screenshot", {});
    const img = shot.content.find((c) => c.type === "image");
    if (img) writeFileSync(join(out, "screenshot.png"), Buffer.from(img.data, "base64"));
    check("mcp-screenshot", !!img && img.mimeType === "image/png", img ? `${img.data.length} base64 chars` : text(shot));
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
    check("forged-ignored", ran && quiet.length === 0, `nothing came back to the forger or the parent: ${JSON.stringify(quiet)}`);
    // The real hello still works afterwards, so nothing took the port.
    await page.evaluate((i) => window.hello(i), id);
    await page.evaluate(([i, b]) => window.init(i, "real.docx", b), [id, Array.from(docx("realword"))]);
    await waitLog(page, id, "ready");
    const t = await waitText(page, id, /realword/);
    check("forged-real-hello", /realword/.test(t), t.slice(0, 80));
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
