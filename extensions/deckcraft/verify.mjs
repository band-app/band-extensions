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


  // The compact preview (S1 to S4 of the preview brief): plain HTML built from the engine's own slide pictures.
  {
    const PHONE = { width: 390, height: 844 };
    const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));
    await page.goto(pageUrl);
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i })) });
    const swipe = async (from, to, steps = 12) => {
      await touch("touchStart", [from]);
      for (let i = 1; i <= steps; i++) {
        await sleep(16);
        await touch("touchMove", [[from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]]);
      }
      await touch("touchEnd", []);
    };
    const size = (w, h) =>
      page.evaluate(([w, h]) => {
        document.body.style.margin = "0";
        document.querySelector("iframe[data-editor]").style.cssText = `width:${w}px;height:${h}px;border:0;display:block`;
      }, [w, h]);
    const frame = () => page.frameLocator("iframe[data-editor]");
    const inFrame = (fn, arg) => page.frames().find((f) => f.url().startsWith(buildBase)).evaluate(fn, arg);
    const openAs = async (layout, bytes, w, h) => {
      const id = await page.evaluate(() => window.frame());
      await size(w, h);
      await page.evaluate((i) => window.whenHello(i), id);
      await page.evaluate(([i, b, l]) => {
        const m = { type: "init", file: { name: "deck.pptx", path: "deck.pptx", mime: "", bytes: b, readOnly: false }, theme: { mode: "dark", tokens: { background: "#10203a", foreground: "#f0e6d2" } } };
        if (l) m.layout = l;
        window.send(i, m);
      }, [id, Array.from(bytes), layout]);
      await waitLog(page, id, "ready");
      return id;
    };
    // The picture of slide `n` as a size in bytes, once it has loaded.
    const pictureSize = (n) =>
      inFrame(async (n) => {
        for (let t = 0; t < 100; t++) {
          const img = document.querySelectorAll(".bp-slide img")[n];
          if (img && img.getAttribute("src") && img.complete && img.naturalWidth > 0) return (await (await fetch(img.src)).arrayBuffer()).byteLength;
          await new Promise((r) => setTimeout(r, 100));
        }
        return 0;
      }, n);
    // Headless Chrome drops pointer input to this framed page below about y=750 (a plain page has no such gap), where
    // the next button and the back pill sit, so those two get a click event instead of a finger.
    const counter = () => frame().locator("#bp-count").innerText();
    const previewShown = () => inFrame(() => !document.getElementById("bp").hidden);
    try {
      // A three slide deck with notes on the second, made by editing the fixture and saving.
      const maker = await openAs("regular", pptx, 1040, 700);
      await sleep(2000);
      await call(page, maker, "add_slide", {});
      await call(page, maker, "add_slide", {});
      await call(page, maker, "run_command", { command: "slide.notes", params: { index: 1, text: "Speaker notes for the second slide" } });
      await page.evaluate((i) => window.send(i, { type: "requestSave" }), maker);
      await waitLog(page, maker, "save");
      const deck = Buffer.from((await logOf(page, maker)).find((m) => m.type === "save").bytes);

      // S3: a regular frame opens the editor and no preview.
      const regularId = await openAs("regular", deck, 1280, 720);
      await sleep(2500);
      check("S3-regular-no-preview", !(await previewShown()) && (await frame().locator("#bp-back").isHidden()), "the preview is hidden in the regular layout");
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.screenshot({ path: join(out, "preview-s3-regular.png") });
      await page.setViewportSize(PHONE);

      // S1: a compact frame opens the preview, built from the engine's pictures.
      await openAs("compact", deck, PHONE.width, PHONE.height);
      const first = await pictureSize(0);
      check("S1-preview-shown", (await previewShown()) && first > 1000, `preview shown, slide 1 picture ${first} bytes`);
      check("S1-counter", (await counter()) === "1 / 3", await counter());
      const box = await frame().locator("#bp").boundingBox();
      check("S1-fills-frame", box && Math.round(box.width) === PHONE.width && Math.round(box.height) === PHONE.height, JSON.stringify(box));
      const theme = await inFrame(() => getComputedStyle(document.getElementById("bp")).backgroundColor);
      check("S1-theme", theme === "rgb(16, 32, 58)", `chrome background ${theme} from the theme token`);
      await page.screenshot({ path: join(out, "preview-s1-slide1.png") });
      // Only the slides near the current one are drawn.
      const drawn = await inFrame(() => [...document.querySelectorAll(".bp-slide img")].map((i) => !!i.getAttribute("src")));
      check("S1-lazy", drawn[0] && !drawn[2], `drawn: ${JSON.stringify(drawn)}`);

      // A swipe pages to the next slide; the arrow and the notes toggle work.
      await swipe([330, 420], [60, 420]);
      await sleep(900);
      check("S1-swipe", (await counter()) === "2 / 3", await counter());
      check("S1-next-drawn", (await pictureSize(1)) > 1000, "slide 2 drawn after the swipe");
      await frame().locator("#bp-notes-btn").click();
      const notes = await frame().locator("#bp-notes").innerText();
      check("S1-notes", /Speaker notes for the second slide/.test(notes), notes);
      await page.screenshot({ path: join(out, "preview-s1-slide2-notes.png") });
      await frame().locator("#bp-notes-btn").click();
      await frame().locator("#bp-next").dispatchEvent("click");
      await sleep(900);
      check("S1-next-button", (await counter()) === "3 / 3", await counter());
      await page.keyboard.press("ArrowLeft");
      await sleep(900);
      check("S1-arrow-key", (await counter()) === "2 / 3", await counter());

      // Pinch: two fingers spreading make the slide larger.
      const width = () => inFrame(() => document.querySelectorAll(".bp-zoom")[1].getBoundingClientRect().width);
      const w0 = await width();
      await touch("touchStart", [[170, 400], [220, 400]]);
      for (let i = 1; i <= 10; i++) {
        await sleep(16);
        await touch("touchMove", [[170 - i * 8, 400], [220 + i * 8, 400]]);
      }
      await touch("touchEnd", []);
      await sleep(400);
      const w1 = await width();
      check("S1-pinch", w1 > w0 * 1.8, `slide width ${Math.round(w0)} -> ${Math.round(w1)} px`);
      await page.screenshot({ path: join(out, "preview-s1-pinched.png") });


      // S2: Edit opens the editor; back returns to the preview showing the edits; dirty and save behave as before.
      await openAs("compact", deck, PHONE.width, PHONE.height).then(async (id) => {
        const before = await pictureSize(0);
        await frame().locator("#bp-edit").click();
        await sleep(1500);
        check("S2-edit-opens-editor", !(await previewShown()) && (await frame().locator("#bp-back").isVisible()), "preview hidden, back control shown");
        await page.screenshot({ path: join(out, "preview-s2-editor.png") });
        check("S2-clean-before-edit", !(await logOf(page, id)).some((m) => m.type === "dirty"), "switching to the editor does not dirty the file");
        await call(page, id, "add_text_box", { x: 60, y: 60, w: 600, h: 90, text: "preview edit" });
        await waitLog(page, id, "dirty");
        await frame().locator("#bp-back").dispatchEvent("click");
        await sleep(1000);
        let after = before;
        for (let t = 0; t < 100 && after === before; t++) {
          after = await pictureSize(0);
          await sleep(100);
        }
        await page.screenshot({ path: join(out, "preview-s2-back.png") });
        check("S2-back-shows-edit", (await previewShown()) && after !== before, `slide 1 picture ${before} -> ${after} bytes`);
        const dirties = (await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty);
        check("S2-still-dirty", sameJson(dirties, [true]), JSON.stringify(dirties));
        check("S2-edit-kept", /preview edit/.test(text(await call(page, id, "inspect_slide", { index: 0 }))), "the document holds the edit");
        await page.evaluate((i) => window.send(i, { type: "requestSave" }), id);
        await waitLog(page, id, "save");
        const saved = Buffer.from((await logOf(page, id)).find((m) => m.type === "save").bytes);
        check("S2-save", saved[0] === 0x50 && saved[1] === 0x4b, `${saved.length} bytes, PK header`);
        await page.evaluate((i) => window.send(i, { type: "saved" }), id);
        await waitLog(page, id, "dirty", 2);
        check("S2-saved", sameJson((await logOf(page, id)).filter((m) => m.type === "dirty").map((m) => m.dirty), [true, false]), "saved clears dirty");
        writeFileSync(join(out, "preview-edited.pptx"), saved);
        return saved;
      }).then(async (edited) => {
        // S4: reload with new bytes updates the preview.
        const id = await openAs("compact", deck, PHONE.width, PHONE.height);
        const a = await pictureSize(0);
        await page.evaluate(([i, b]) => window.send(i, { type: "reload" }, b), [id, Array.from(edited)]);
        let b = a;
        for (let t = 0; t < 300 && b === a; t++) {
          await sleep(100);
          b = await pictureSize(0);
        }
        await page.screenshot({ path: join(out, "preview-s4-reload.png") });
        check("S4-reload", b !== a && (await previewShown()), `slide 1 picture ${a} -> ${b} bytes after reload`);
        check("S4-count", (await counter()) === "1 / 3", await counter());
      });
      await ctx.close();
    } catch (e) {
      await ctx.close();
      throw e;
    }
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
        // A compact frame opens the preview; the shared scenarios are about the editor, so press Edit first.
        afterOpen: async ({ page }) => {
          await page.frameLocator("iframe[data-editor]").locator("#bp-edit").click();
          await sleep(1500);
        },
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
