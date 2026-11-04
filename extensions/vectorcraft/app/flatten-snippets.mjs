// Trunk post-build hook. wasm-bindgen writes the JS snippets of eframe into snippets/<crate>-<hash>/,
// and the loader imports them by that path. scripts/package.sh copies the files of dist/web but
// not folders, so this moves each snippet next to the loader and points the imports at it.
import { readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const dir = process.env.TRUNK_STAGING_DIR;
if (!dir) throw new Error("TRUNK_STAGING_DIR is not set: run this as a Trunk hook");
const snippets = join(dir, "snippets");
if (existsSync(snippets)) {
  const moved = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else moved.push(path);
    }
  };
  walk(snippets);
  const loaders = readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".html"));
  for (const file of moved) {
    const rel = relative(dir, file).split(sep).join("/");
    const flat = rel.replace(/^snippets\//, "").replaceAll("/", "-");
    copyFileSync(file, join(dir, flat));
    for (const loader of loaders) {
      const text = readFileSync(join(dir, loader), "utf8");
      // Only the import statement and the preload link change. The wasm file names the module by its
      // original path in its import list, and the loader's import object keys it the same way.
      const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const imports = new RegExp(`^(import[^\\n]* from )(['"])\\./${esc}\\2`, "gm");
      writeFileSync(join(dir, loader), text.replace(imports, `$1$2./${flat}$2`).replaceAll(`href="./${rel}"`, `href="./${flat}"`));
    }
  }
  rmSync(snippets, { recursive: true });
}
