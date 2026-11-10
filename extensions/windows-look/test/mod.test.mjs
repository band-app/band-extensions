import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "band-extension.json"), "utf8"));

test("the manifest names a css file that the build ships", () => {
  assert.equal(manifest.id, "windows-look");
  const css = readFileSync(join(root, "dist", "web", manifest.contributes.mod.css), "utf8");
  assert.ok(css.length > 0);
  assert.equal(css.split("{").length, css.split("}").length);
});
