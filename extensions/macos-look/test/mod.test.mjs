import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "band-extension.json"), "utf8"));

test("the manifest names a mod css file that the build ships", () => {
  assert.equal(manifest.id, "macos-look");
  const mod = manifest.contributes.mod;
  const files = Array.isArray(mod.css) ? mod.css : [mod.css];
  for (const file of files) assert.ok(readFileSync(join(root, "dist", "web", file), "utf8").length > 0);
});

test("window options use the values the desktop main process accepts", () => {
  const w = manifest.contributes.mod.window;
  assert.ok(w.material === "sidebar");
  assert.equal(w.titleBarStyle, "hiddenInset");
  assert.ok(["none", "unified", "compact"].includes(w.toolbar));
  assert.equal(typeof w.trafficLightPosition.x, "number");
  assert.equal(typeof w.trafficLightPosition.y, "number");
});

test("the css has balanced braces and no hard-coded font family beyond system fonts", () => {
  const css = readFileSync(join(root, "dist", "web", "mod.css"), "utf8");
  assert.equal(css.split("{").length, css.split("}").length);
  assert.ok(!/(Inter|Roboto|Segoe)/.test(css));
});
