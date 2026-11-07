// Builds extensions/simulator/dist/web: service.mjs (the worker service, bundled with the SDK),
// the panel, and the shipped copy of serve-sim with its one dependency, ws.
//   node build.mjs
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
  // serve-sim is a separate Node program that imports ws; both load the one shipped copy.
  external: ["ws", "sharp"],
  legalComments: "none",
  logLevel: "warning",
});

cpSync(join(here, "panel"), out, { recursive: true });

// Only what runs: serve-sim's dist (its CLI, the native module, the helper binaries) and ws.
const modules = join(here, "node_modules");
const need = (p) => {
  if (!existsSync(p)) throw new Error(`${p} is missing: run npm ci in extensions/simulator`);
  return p;
};
const ship = (name, paths) => {
  for (const p of paths) {
    cpSync(need(join(modules, name, p)), join(out, "node_modules", name, p), { recursive: true });
  }
};
ship("serve-sim", ["package.json", "dist"]);
ship("ws", ["package.json", "index.js", "wrapper.mjs", "lib", "LICENSE"]);

// sharp (the hub profile's in-process JPEG resize) loads a native addon and libvips from
// @img/sharp-<platform> and @img/sharp-libvips-<platform>. npm installs only the current
// machine's pair, so the other Mac architecture is fetched with `npm pack`. The archive carries both.
ship("sharp", ["package.json", "LICENSE", "lib"]);
ship("@img/colour", ["package.json", "index.cjs", "color.cjs"]);
ship("detect-libc", ["package.json", "lib"]);
ship("semver", ["package.json", "index.js", "preload.js", "range.bnf", "classes", "functions", "internal", "ranges"]);
const sharpOptional = JSON.parse(readFileSync(join(modules, "sharp", "package.json"), "utf8")).optionalDependencies;
for (const arch of ["arm64", "x64"]) {
  for (const name of [`@img/sharp-darwin-${arch}`, `@img/sharp-libvips-darwin-${arch}`]) {
    const dest = join(out, "node_modules", name);
    const installed = join(modules, name);
    if (existsSync(installed)) {
      cpSync(installed, dest, { recursive: true });
      continue;
    }
    const tmp = mkdtempSync(join(tmpdir(), "sim-pack-"));
    const tarball = execFileSync("npm", ["pack", `${name}@${sharpOptional[name]}`, "--silent", "--pack-destination", tmp], { encoding: "utf8" }).trim().split("\n").pop();
    mkdirSync(dest, { recursive: true });
    execFileSync("tar", ["-xzf", join(tmp, tarball), "-C", dest, "--strip-components=1"]);
    rmSync(tmp, { recursive: true, force: true });
  }
}

const pinned = JSON.parse(readFileSync(join(here, "package.json"), "utf8")).dependencies["serve-sim"];
const have = JSON.parse(readFileSync(join(modules, "serve-sim", "package.json"), "utf8")).version;
if (have !== pinned) throw new Error(`serve-sim ${have} is installed, package.json pins ${pinned}`);
console.log(`built ${out}`);
