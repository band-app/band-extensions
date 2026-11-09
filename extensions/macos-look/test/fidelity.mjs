#!/usr/bin/env node
// Fidelity check: measures Band with macos-look installed (computed styles in Chromium) and compares
// the numbers with the values AppKit reports on macOS (test/native-reference.json).
//
//   HUB_URL=http://127.0.0.1:PORT HUB_TOKEN=... PLAYWRIGHT_DIR=<dir with @playwright/test> \
//     node test/fidelity.mjs [--out report.md]
//
// Needs a running hub that has macos-look installed and at least one worktree. It measures what CSS
// can measure: sizes, type, colors and radii. It does not judge the translucent sidebar; that needs a screenshot.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(readFileSync(join(here, "native-reference.json"), "utf8"));
const { HUB_URL, HUB_TOKEN, PLAYWRIGHT_DIR } = process.env;
if (!HUB_URL || !HUB_TOKEN || !PLAYWRIGHT_DIR) {
  console.error("Set HUB_URL, HUB_TOKEN and PLAYWRIGHT_DIR (a folder where @playwright/test resolves).");
  process.exit(2);
}
const { chromium } = createRequire(join(PLAYWRIGHT_DIR, "x.js"))("@playwright/test");

const hex = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
const parseColor = (s) => {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const [r, g, b, a = 1] = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return [r, g, b, a];
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rows = [];
const check = (scheme, name, measured, expected, ok, note = "") => {
  rows.push({ scheme, name, measured, expected, pass: ok, note });
};
const colorOk = (got, want, tol = 2, atol = 0.02) =>
  got && want && near(got[0], want[0], tol) && near(got[1], want[1], tol) && near(got[2], want[2], tol) && near(got[3] ?? 1, want[3] ?? 1, atol);
const fmt = (c) => (c ? `rgba(${c.map((v, i) => (i === 3 ? +v.toFixed(2) : Math.round(v))).join(", ")})` : "none");

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.addInitScript((s) => {
    try {
      localStorage.setItem("band-theme", s);
    } catch {}
  }, scheme);
  await page.goto(`${HUB_URL}/?token=${HUB_TOKEN}`);
  await page.waitForSelector('[data-testid^="repo-list__worktree-card--"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.documentElement.setAttribute("data-translucent-sidebar", ""));
  await page.locator('[data-testid^="repo-list__worktree-card--"]').first().click();
  await page.waitForTimeout(1000);
  const mod = await page.evaluate(() => document.querySelectorAll("link[data-band-mod]").length);
  check(scheme, "mod stylesheet is loaded", String(mod), ">= 1", mod >= 1);

  const main = await page.evaluate(`(() => {
    const px = (el, p) => getComputedStyle(el)[p];
    const q = (s) => document.querySelector(s);
    const color = (v) => { const d = document.createElement("div"); d.style.cssText = "position:fixed;left:-99px;width:1px;height:1px;background:" + v; document.body.appendChild(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; };
    const hdr = q('[data-testid="repos-panel__header"] > div');
    const row = q('[data-testid^="repo-list__worktree-card--"]');
    const side = q('[data-testid="app-shell__sidebar"]');
    const tabs = q('[data-testid="layout-tab-list"]');
    const nav = q('[data-testid="app-shell__nav-overlay"] > div');
    const header = q('[data-testid="layout-header"]');
    return {
      bodyFont: parseFloat(px(document.body, "fontSize")), bodyColor: px(document.body, "color"),
      secondary: hdr ? parseFloat(px(hdr, "fontSize")) : null, secondaryColor: hdr ? px(hdr, "color") : null,
      rowH: row ? row.getBoundingClientRect().height : null, rowRadius: row ? parseFloat(px(row, "borderRadius")) : null,
      sidebarRadius: side ? parseFloat(px(side, "borderRadius")) : null,
      tabsH: tabs ? tabs.getBoundingClientRect().height : null, navH: nav ? nav.getBoundingClientRect().height : null,
      headerH: header ? header.getBoundingClientRect().height : null,
      border: color("var(--border)"), selected: color("var(--ml-selected)"), accent: color("var(--ml-accent)"), window: color("var(--ml-window)"),
      family: px(document.body, "fontFamily"),
    };
  })()`);
  const c = ref.colors[scheme];
  check(scheme, "body text size (pt)", main.bodyFont, ref.font.body, near(main.bodyFont, ref.font.body, 0.2));
  check(scheme, "secondary text size (pt)", main.secondary, ref.font.secondary, main.secondary !== null && near(main.secondary, ref.font.secondary, 0.3));
  check(scheme, "font family starts with the system font", main.family.split(",")[0], "-apple-system", main.family.startsWith("-apple-system"));
  check(scheme, "primary text color", fmt(parseColor(main.bodyColor)), fmt(c.label), colorOk(parseColor(main.bodyColor), c.label));
  check(scheme, "secondary text color", fmt(parseColor(main.secondaryColor ?? "")), fmt(c.secondaryLabel), colorOk(parseColor(main.secondaryColor ?? ""), c.secondaryLabel));
  check(scheme, "separator color", fmt(parseColor(main.border)), fmt(c.separator), colorOk(parseColor(main.border), c.separator));
  check(scheme, "selected content color", fmt(parseColor(main.selected)), c.selectedContent, colorOk(parseColor(main.selected), [...hex(c.selectedContent), 1]));
  check(scheme, "accent color", fmt(parseColor(main.accent)), c.accent, colorOk(parseColor(main.accent), [...hex(c.accent), 1]));
  check(scheme, "window background", fmt(parseColor(main.window)), c.windowBackground, colorOk(parseColor(main.window), [...hex(c.windowBackground), 1]));
  check(scheme, "sidebar row height", main.rowH, ref.heights.sourceListRowMedium, main.rowH !== null && near(main.rowH, ref.heights.sourceListRowMedium, 6), "Band rows can hold a second line, so this is a minimum");
  check(scheme, "toolbar row height", main.headerH, ref.estimatedFromFinderScreenshot.toolbarHeight, main.headerH !== null && near(main.headerH, ref.estimatedFromFinderScreenshot.toolbarHeight, 1), "estimated from the Finder screenshot");

  await page.locator('[data-testid="repo-list__settings-button"]').click();
  await page.waitForTimeout(1200);
  const controls = await page.evaluate(`(() => {
    const out = { buttons: {}, inputs: [], switches: [] };
    for (const b of document.querySelectorAll('[role="dialog"] button[data-slot="button"]')) {
      const s = b.getAttribute("data-size"); const v = b.getAttribute("data-variant");
      const r = b.getBoundingClientRect(); if (r.height === 0) continue;
      (out.buttons[s + "/" + v] ||= []).push(Math.round(r.height * 10) / 10);
    }
    for (const i of document.querySelectorAll('[role="dialog"] [data-slot="input"]')) { const r = i.getBoundingClientRect(); if (r.height) out.inputs.push(Math.round(r.height * 10) / 10); }
    for (const s of document.querySelectorAll('[role="dialog"] button[role="switch"]')) { const r = s.getBoundingClientRect(); if (!r.height) continue; const k = s.firstElementChild.getBoundingClientRect(); out.switches.push([Math.round(r.width), Math.round(r.height), k.x >= r.x - 0.5 && k.right <= r.right + 0.5, s.dataset.state]); }
    return out;
  })()`);
  const want = { default: ref.heights.pushLarge, sm: ref.heights.pushRegular, xs: ref.heights.pushSmall };
  for (const [key, heights] of Object.entries(controls.buttons)) {
    const size = key.split("/")[0];
    if (!(size in want) || key.endsWith("/ghost") || key.endsWith("/link")) continue;
    check(scheme, `button ${key} height`, heights[0], want[size], near(heights[0], want[size], 0.5));
  }
  for (const h of controls.inputs.slice(0, 1)) check(scheme, "text field height", h, ref.heights.textField, near(h, ref.heights.textField, 0.5));
  for (const [, , inside, state] of controls.switches) check(scheme, `switch thumb stays inside the track (${state})`, inside, true, inside === true);
  for (const [w, h] of controls.switches.slice(0, 1)) {
    check(scheme, "switch width", w, ref.switch.w, near(w, ref.switch.w, 0.5));
    check(scheme, "switch height", h, ref.switch.h, near(h, ref.switch.h, 0.5));
  }
  await ctx.close();
}
await browser.close();

const failed = rows.filter((r) => !r.pass);
const md = [
  "| Scheme | Check | Band + macos-look | AppKit | Result |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.scheme} | ${r.name}${r.note ? ` (${r.note})` : ""} | ${r.measured} | ${r.expected} | ${r.pass ? "pass" : "FAIL"} |`),
  "",
  `${rows.length - failed.length} of ${rows.length} checks pass.`,
].join("\n");
console.log(md);
const out = process.argv.indexOf("--out");
if (out > 0) writeFileSync(process.argv[out + 1], `${md}\n`);
process.exit(failed.length ? 1 : 0);
