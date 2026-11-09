// Builds dist/macos-look/: the folder `band extensions install` and the tarball are made from.
//   node build.mjs
// src/parts/*.css are joined in file name order into mod.css, the one file the manifest names.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist", "web");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const parts = readdirSync(join(here, "src", "parts")).filter((f) => f.endsWith(".css")).sort();
const css = parts.map((f) => readFileSync(join(here, "src", "parts", f), "utf8")).join("\n");
writeFileSync(join(out, "mod.css"), css);
void cpSync;
console.log(`macos-look: ${parts.length} parts, ${css.length} bytes -> ${join(out, "mod.css")}`);
