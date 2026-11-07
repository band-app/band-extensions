// Compact layout and selection scenarios shared by every extension's verify.mjs.
//   import { compactScenarios } from "../../scripts/verify-compact.mjs";
//
// verify.mjs owns the test page that plays Band (window.frame, whenHello, send, log, mcp) and passes
// in what the scenarios need. The viewport is a phone (390x844) with touch emulation, and fingers
// are CDP touch events, so the page sees what a phone sends.
//
//   S1  init with layout "compact" collapses the chrome and a "layout" message restores it
//   S2  a one-finger drag moves the document without selecting, and a tap sends a selection
//   S3  the selection's address works in the app's own tool (cfg.useAddress)
//   S4  clearing the selection sends null, and an init with no layout field still works
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PHONE = { width: 390, height: 844 };

/**
 * env: { browser, pageUrl, out, check, sleep, waitLog, logOf, call, text }
 * cfg: {
 *   ext, file: { name, bytes },
 *   tap: [x, y]            where a tap selects something (frame pixels in the phone viewport)
 *   clear: [x, y] | async (page, id) => void   how the person clears the selection
 *   noNull: true   the app always has a selection while a file is open (a spreadsheet's active cell),
 *                  so S4a checks that a second tap replaces it instead of clearing it
 *   tap2: [x, y]   with noNull, where the second tap goes
 *   drag: { from: [x, y], to: [x, y] }   a drag on the document that must move it
 *   wantSelection: (selection) => string | null   a problem with the selection, or null
 *   useAddress: async ({ page, id, selection, call, text }) => { ok, detail }
 *   s1Size: [w, h]   run S1 at this size instead of the phone's (FigCraft already narrows itself at phone width, so
 *                    only a wide frame shows what compact adds)
 *   noLayoutTolerance: most the no-layout shot may differ from the regular shot (default 0.04); VectorCraft refits
 *                      the drawing to the frame, so the page differs a little
 *   minChange: share of pixels that must differ between compact and regular (default 0.04)
 *   prepare / restore: async ({ page, id, call }) => void   zoom in before the drag, back to fit before the tap
 *   settle: ms to wait after open (default 2500)
 *   afterOpen: async ({ page, id }) => void   runs after a compact open settles (DeckCraft opens a preview first;
 *                                             its hook presses Edit so the scenarios run on the editor)
 * }
 */
export async function compactScenarios(env, cfg) {
  const { browser, pageUrl, out, check, sleep, waitLog, logOf } = env;
  const settle = cfg.settle ?? 2500;
  const ctx = await browser.newContext({ viewport: PHONE, hasTouch: true, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 300)));
  await page.goto(pageUrl);
  const cdp = await ctx.newCDPSession(page);
  const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i })) });
  const tap = async ([x, y]) => {
    await touch("touchStart", [[x, y]]);
    await sleep(70);
    await touch("touchEnd", []);
  };
  const drag = async ({ from, to }, steps = 14) => {
    await touch("touchStart", [from]);
    for (let i = 1; i <= steps; i++) {
      await sleep(16);
      await touch("touchMove", [[from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]]);
    }
    await touch("touchEnd", []);
  };
  const shot = async (name) => {
    const buf = await page.screenshot({ path: join(out, `${cfg.ext}-${name}.png`) });
    return buf.toString("base64");
  };
  // Share of pixels that differ between two screenshots, from a canvas in the test page.
  const diff = (a, b) =>
    page.evaluate(
      async ([x, y]) => {
        const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + b64; });
        const [ia, ib] = await Promise.all([load(x), load(y)]);
        const px = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
        const da = px(ia), db = px(ib);
        let n = 0;
        for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 48) n++;
        return n / (da.length / 4);
      },
      [a, b],
    );
  const sizeFrame = (size = [PHONE.width, PHONE.height]) =>
    page.evaluate(([w, h]) => {
      document.body.style.margin = "0";
      const f = document.querySelector("iframe[data-editor]");
      f.style.cssText = `width:${w}px;height:${h}px;border:0;display:block`;
    }, size);
  const open = async (layout, size) => {
    const id = await page.evaluate(() => window.frame());
    await sizeFrame(size);
    await page.evaluate((i) => window.whenHello(i), id);
    await page.evaluate(([i, name, bytes, l]) => {
      const msg = { type: "init", file: { name, path: name, mime: "", bytes, readOnly: false }, theme: { tokens: {} } };
      if (l) msg.layout = l;
      window.send(i, msg);
    }, [id, cfg.file.name, Array.from(cfg.file.bytes), layout]);
    await waitLog(page, id, "ready");
    await sleep(settle);
    if (layout === "compact") await cfg.afterOpen?.({ page, id });
    return id;
  };
  const selections = async (id) => (await logOf(page, id)).filter((m) => m.type === "selection");

  try {
    // S1: compact collapses the chrome; a layout message brings it back.
    if (cfg.s1Size) {
      await page.setViewportSize({ width: cfg.s1Size[0], height: cfg.s1Size[1] });
      const wide = await open("compact", cfg.s1Size);
      const wc = await shot("s1-wide-compact");
      await page.evaluate((i) => window.send(i, { type: "layout", layout: "regular" }), wide);
      await sleep(1500);
      const changedWide = await diff(wc, await shot("s1-wide-regular"));
      check(`${cfg.ext}:S1w`, changedWide > (cfg.minChange ?? 0.04), `at ${cfg.s1Size.join("x")} compact vs regular differ in ${(changedWide * 100).toFixed(1)}% of pixels`);
      await page.setViewportSize(PHONE);
    }
    const id = await open("compact");
    const compact = await shot("s1-compact");
    await page.evaluate((i) => window.send(i, { type: "layout", layout: "regular" }), id);
    await sleep(1500);
    const regular = await shot("s1-regular");
    const changed = await diff(compact, regular);
    check(`${cfg.ext}:S1`, changed > (cfg.s1Size ? -1 : cfg.minChange ?? 0.04), `compact vs regular differ in ${(changed * 100).toFixed(1)}% of pixels at ${PHONE.width}x${PHONE.height}; see ${cfg.ext}-s1-*.png`);
    await page.evaluate((i) => window.send(i, { type: "layout", layout: "compact" }), id);
    await sleep(1500);
    const again = await shot("s1-compact-again");
    check(`${cfg.ext}:S1b`, (await diff(compact, again)) < 0.02, "compact again after regular matches the first compact");
    await page.evaluate((i) => window.send(i, { type: "layout", layout: "sideways" }), id);
    await sleep(600);
    check(`${cfg.ext}:S1c`, (await diff(again, await shot("s1-unknown-layout"))) < 0.02, "an unknown layout value changes nothing");

    // S2: a drag moves the document and selects nothing; a tap selects.
    await cfg.prepare?.({ page, id, call: env.call });
    await sleep(800);
    const before = await shot("s2-before-drag");
    const selBefore = (await selections(id)).length;
    await drag(cfg.drag);
    await sleep(1200);
    const afterDrag = await shot("s2-after-drag");
    const moved = await diff(before, afterDrag);
    const selAfter = (await selections(id)).length;
    check(`${cfg.ext}:S2a`, moved > 0.01 && selAfter === selBefore, `drag moved ${(moved * 100).toFixed(1)}% of pixels; selection messages ${selBefore} -> ${selAfter}`);
    await cfg.restore?.({ page, id, call: env.call });
    await sleep(800);
    await tap(cfg.tap);
    await waitLog(page, id, "selection", selBefore + 1, 15000).catch(() => {});
    const sels = await selections(id);
    const sel = sels.at(-1)?.selection;
    await shot("s2-after-tap");
    const problem = sel ? (cfg.wantSelection?.(sel) ?? null) : "no selection message after a tap";
    const shape = sel && typeof sel.address === "string" && sel.address && typeof sel.kind === "string" && typeof sel.label === "string" && sel.label;
    check(`${cfg.ext}:S2b`, !!shape && !problem, JSON.stringify(sel)?.slice(0, 300) + (problem ? ` | ${problem}` : ""));
    check(`${cfg.ext}:S2c`, !sel?.text || new TextEncoder().encode(sel.text).length <= 4096, "selection text is at most 4 KB");

    // S3: the address works in the app's own tool.
    if (sel) {
      const r = await cfg.useAddress({ page, id, selection: sel, call: env.call, text: env.text });
      check(`${cfg.ext}:S3`, r.ok, r.detail);
    } else check(`${cfg.ext}:S3`, false, "no selection to use");

    // S4: clearing sends null; no layout field in init still works and opens normally.
    const nulls = (await selections(id)).filter((m) => m.selection === null).length;
    const count = (await selections(id)).length;
    if (cfg.noNull) await tap(cfg.tap2);
    else if (typeof cfg.clear === "function") await cfg.clear(page, id, { tap });
    else await tap(cfg.clear);
    await waitLog(page, id, "selection", count + 1, 15000).catch(() => {});
    await shot("s4-after-clear");
    const last = (await selections(id)).at(-1);
    if (cfg.noNull) check(`${cfg.ext}:S4a`, last && last.selection && last.selection.address !== sel?.address, `a second tap replaced ${sel?.address} with ${last?.selection?.address}`);
    else check(`${cfg.ext}:S4a`, last && last.selection === null && (await selections(id)).filter((m) => m.selection === null).length > nulls, `last selection message: ${JSON.stringify(last?.selection)}`);
    const id2 = await open(undefined);
    await sleep(1500);
    const msgs = (await logOf(page, id2)).map((m) => m.type);
    check(`${cfg.ext}:S4b`, msgs.includes("ready"), `init without layout: ${msgs.join(",")}`);
    const plain = await shot("s4-no-layout");
    const wide = await diff(plain, regular);
    check(`${cfg.ext}:S4c`, wide < (cfg.noLayoutTolerance ?? 0.04), `no layout field gives the regular UI (${(wide * 100).toFixed(1)}% differs from the regular shot)`);
  } finally {
    await ctx.close();
  }
}
