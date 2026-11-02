// End-to-end check of dist/web in headless Chrome (acceptance scenarios W2 to W7).
//   PLAYWRIGHT=<path to playwright-core> node scripts/verify-host.mjs [outdir]
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? "playwright-core");
const dist = join(import.meta.dirname, "../dist/web");
const out = process.argv[2] ?? join(import.meta.dirname, "../.am/evidence");
mkdirSync(out, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm" };

const srv = createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/\.\./g, "");
  let body;
  try { body = readFileSync(join(dist, rel === "/" ? "index.html" : rel)); } catch { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" });
  res.end(body);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const results = {};
const check = (name, ok, detail) => { results[name] = { ok, detail }; console.log(ok ? "PASS" : "FAIL", name, detail ?? ""); };
const text = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("");

try {
  // W2: the stock sample renders.
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on("console", (m) => console.log("  [w2]", m.text().slice(0, 200)));
    await page.goto(`${base}/index.html?sample=sales`);
    await page.waitForSelector("#gridcraft_loading", { state: "detached", timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(out, "w2-sales.png") });
    check("W2", true, "see w2-sales.png");
    await page.close();
  }

  // W3 to W7 through the host page.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("console", (m) => console.log("  [host]", m.text().slice(0, 200)));
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));
  const t0 = Date.now();
  await page.goto(`${base}/host.html`);
  await page.waitForFunction(() => window.gridcraftToolsReady || window.gridcraftToolsError, null, { timeout: 90000 });
  const ready = await page.evaluate(() => ({ n: window.gridcraftToolsReady, err: window.gridcraftToolsError, ms: window.gridcraftToolsMs }));
  console.log("time to tools (page load to registered):", Date.now() - t0, "ms; initialize+tools/list:", ready.ms, "ms");
  const direct = await page.evaluate(() => window.gridcraftHost.request("tools/list", {}));
  const names = direct.tools.map((t) => t.name);
  writeFileSync(join(out, "tools-wrapper.json"), JSON.stringify(names.sort(), null, 1));
  check("W3", names.length > 0 && !ready.err, `${names.length} tools`);

  const call = (name, args) => page.evaluate(([n, a]) => window.gridcraftHost.request("tools/call", { name: n, arguments: a }), [name, args]);
  const w = await call("write_range", { range: "A1", values: [[42]] });
  const r = await call("read_range", { range: "A1" });
  check("W4", /42/.test(text(r)), text(r).slice(0, 120));

  const shot = await call("screenshot", {});
  const img = shot.content.find((c) => c.type === "image");
  if (img) writeFileSync(join(out, "w5-screenshot.png"), Buffer.from(img.data, "base64"));
  check("W5", !!img && img.mimeType === "image/png", img ? `${img.data.length} base64 chars` : text(shot));

  // W6: tools live on document.modelContext (the stand-in records them).
  const registered = await page.evaluate(() => [...document.modelContext.__tools.keys()]);
  check("W6a", registered.length === names.length, `${registered.length} registered`);
  const viaCtx = await page.evaluate(async () => {
    const tools = document.modelContext.__tools;
    await tools.get("set_cell").execute({ cell: "B2", input: "hello" });
    return await tools.get("get_cell").execute({ cell: "B2" });
  });
  check("W6b", /hello/.test(JSON.stringify(viaCtx)), JSON.stringify(viaCtx).slice(0, 160));

  // W7: open an .xlsx, set a cell, save_workbook, receive gridcraft:save, reopen.
  await page.evaluate(() => {
    window.saves = [];
    window.addEventListener("message", (e) => { if (e.data?.type === "gridcraft:save") window.saves.push(e.data); });
  });
  const saveBytes = async (n) => {
    await page.waitForFunction((k) => window.saves.length >= k, n, { timeout: 10000 }).catch(() => {});
    return page.evaluate((k) => { const s = window.saves[k - 1]; return s ? { name: s.name, bytes: Array.from(new Uint8Array(s.bytes)) } : null; }, n);
  };
  const open = (bytes, name) => page.evaluate(([b, n]) => {
    window.gridcraftHost.frame.contentWindow.postMessage({ type: "gridcraft:open", name: n, bytes: new Uint8Array(b).buffer }, location.origin);
  }, [bytes, name]);
  // A first save gives an .xlsx to open, since the repo carries none.
  console.log("  first save ->", text(await call("save_workbook", {})).slice(0, 300));
  const input = await saveBytes(1);
  await open(input.bytes, "input.xlsx");
  await page.waitForTimeout(2000);
  await call("set_cell", { cell: "C3", input: "saved-value" });
  const saveRes = await call("save_workbook", {});
  console.log("  save_workbook ->", text(saveRes).slice(0, 200));
  const last = await saveBytes(2);
  check("W7a", !!last && last.bytes[0] === 0x50 && last.bytes[1] === 0x4b, last ? `${last.name} ${last.bytes.length} bytes` : "no gridcraft:save");
  if (last) {
    writeFileSync(join(out, "w7-saved.xlsx"), Buffer.from(last.bytes));
    await call("new_workbook", {});
    await page.waitForTimeout(1000);
    const blank = await call("get_cell", { cell: "C3" });
    await open(last.bytes, "reopen.xlsx");
    await page.waitForTimeout(2000);
    const back = await call("get_cell", { cell: "C3" });
    check("W7b", !/saved-value/.test(text(blank)) && /saved-value/.test(text(back)), `blank: ${text(blank).slice(0, 60)} | reopened: ${text(back).slice(0, 60)}`);
  }
} finally {
  writeFileSync(join(out, "verify-results.json"), JSON.stringify(results, null, 1));
  await browser.close();
  srv.close();
}
