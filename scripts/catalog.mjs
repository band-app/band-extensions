#!/usr/bin/env node
// Writes the official extension catalog.
//   node scripts/catalog.mjs --repo band-app/band-extensions --out dist/index.json
//   node scripts/catalog.mjs --from-dir <dir> --out dist/index.json
// The first form lists the repository's releases with `gh api` and downloads each listed
// extension's tarball (public assets, no token needed to download). The second reads
// <dir>/releases.json ([{ "tag", "assets": [{ "name", "file" }] }]) and the files beside it, so the
// workflow can be tried without GitHub.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildCatalog } from "./catalog-lib.mjs";

const { values } = parseArgs({
  options: { repo: { type: "string" }, out: { type: "string" }, "from-dir": { type: "string" } },
});
if (!values.out || (!values.repo && !values["from-dir"])) {
  console.error("usage: catalog.mjs (--repo <owner/name> | --from-dir <dir>) --out <file>");
  process.exit(2);
}

let releases;
let fetchAsset;
if (values["from-dir"]) {
  const dir = resolve(values["from-dir"]);
  const listed = JSON.parse(readFileSync(join(dir, "releases.json"), "utf8"));
  releases = listed.map((r) => ({
    tag: r.tag,
    assets: r.assets.map((a) => ({ name: a.name, url: `file://${join(dir, a.file)}` })),
  }));
  fetchAsset = async (url) => readFileSync(new URL(url));
} else {
  const raw = execFileSync(
    "gh",
    ["api", `repos/${values.repo}/releases`, "--paginate", "--jq", ".[] | {tag: .tag_name, draft, assets: [.assets[] | {name, url: .browser_download_url}]}"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  releases = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => !r.draft);
  fetchAsset = async (url) => {
    const res = await fetch(url, { headers: { "user-agent": "band-extensions-catalog" } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
}

const entries = await buildCatalog({ releases, fetchAsset });
if (entries.length === 0) {
  console.error("no release can be listed: the catalog would be empty");
  process.exit(1);
}
mkdirSync(dirname(resolve(values.out)), { recursive: true });
writeFileSync(values.out, `${JSON.stringify(entries, null, 2)}\n`);
console.log(`wrote ${values.out} with ${entries.map((e) => `${e.id} ${e.version}`).join(", ")}`);
