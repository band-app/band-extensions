// Shared build for the language server extensions (typescript-lsp, python-lsp). Copies the npm
// packages an extension ships into extensions/<ext>/dist/web/node_modules/, the folder
// scripts/package.sh packs. A language server extension has no code of its own: its manifest
// names a script in those packages, which the worker runs with its node.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Copies `packages` (name to paths inside the package, or "all") and checks the pinned versions. */
export function buildLanguageServer(root, packages) {
  const out = join(root, "dist", "web");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const pins = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies;
  for (const [name, paths] of Object.entries(packages)) {
    const from = join(root, "node_modules", name);
    if (!existsSync(from)) throw new Error(`${from} is missing: run npm ci in ${root}`);
    const have = JSON.parse(readFileSync(join(from, "package.json"), "utf8")).version;
    if (have !== pins[name]) throw new Error(`${name} ${have} is installed, package.json pins ${pins[name]}`);
    const to = join(out, "node_modules", name);
    if (paths === "all") cpSync(from, to, { recursive: true });
    else {
      for (const p of paths) {
        const src = join(from, p);
        if (existsSync(src)) cpSync(src, join(to, p), { recursive: true });
      }
    }
  }
  console.log(`built ${out}`);
}
