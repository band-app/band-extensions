// Builds extensions/desktop/dist/web: service.mjs (the worker service, bundled with the SDK),
// panel.js (the panel page's script, bundled with noVNC) and panel.html.
//   node build.mjs
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist", "web");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(here, "src", "service.ts")],
  outfile: join(out, "service.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  logLevel: "warning",
});

const novnc = join(here, "node_modules", "@novnc", "novnc");
if (!existsSync(novnc)) throw new Error("@novnc/novnc is missing: run npm ci in extensions/desktop");
const pinned = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).dependencies["@novnc/novnc"];
const have = JSON.parse(readFileSync(join(novnc, "package.json"), "utf8")).version;
if (have !== pinned) throw new Error(`noVNC ${have} is installed, package.json pins ${pinned}`);

await build({
  entryPoints: [join(here, "panel", "panel.js")],
  outfile: join(out, "panel.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  legalComments: "none",
  logLevel: "warning",
});
cpSync(join(here, "panel", "panel.html"), join(out, "panel.html"));
cpSync(join(novnc, "LICENSE.txt"), join(out, "NOVNC-LICENSE.txt"));
console.log(`built ${out}`);
