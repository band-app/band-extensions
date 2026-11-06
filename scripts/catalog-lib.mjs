// Builds the official extension catalog (index.json) from the extensions' releases.
// Band's hub reads one file, https://github.com/band-app/band-extensions/releases/download/catalog/index.json,
// and skips an entry its schema rejects (scripts/catalog-schema.mjs).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogEntrySchema, catalogMetaSchema, isStrictSemver } from "./catalog-schema.mjs";

const TAG = /^([a-z][a-z0-9-]*)-v(.+)$/;

/** `gridcraft-v0.7.1` gives { ext: "gridcraft", version: "0.7.1" }; null for any other tag. */
export function parseTag(tag) {
  const m = TAG.exec(tag);
  return m ? { ext: m[1], version: m[2] } : null;
}

export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** Reads one file out of a .tar.gz held in memory, with the system tar. Null when it is not there. */
export function readFromArchive(archive, member) {
  const dir = mkdtempSync(join(tmpdir(), "catalog-"));
  try {
    const file = join(dir, "a.tar.gz");
    writeFileSync(file, archive);
    try {
      return execFileSync("tar", ["-xzOf", file, member], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
    } catch {
      return null;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The catalog entry for one release. Everything comes from the archive the hub will download, so
 * the entry cannot disagree with it: the manifest gives id, name and version, `catalog.json` gives
 * the description and minBand, the manifest's worker services give `worker` and `requires`.
 * Throws with the reason when the release cannot be listed.
 */
export function buildEntry({ ext, version, url, archive }) {
  const manifestText = readFromArchive(archive, `${ext}/band-extension.json`);
  if (manifestText === null) throw new Error(`${ext}-v${version}: the archive has no ${ext}/band-extension.json`);
  const manifest = JSON.parse(manifestText);
  if (manifest.id !== ext) throw new Error(`${ext}-v${version}: the manifest id is "${manifest.id}"`);
  if (manifest.version !== version) {
    throw new Error(`${ext}-v${version}: the manifest says version ${manifest.version}`);
  }
  const metaText = readFromArchive(archive, `${ext}/catalog.json`);
  if (metaText === null) throw new Error(`${ext}-v${version}: the archive has no ${ext}/catalog.json`);
  const meta = catalogMetaSchema.parse(JSON.parse(metaText));
  const services = manifest.contributes?.workerServices ?? [];
  const requires = [...new Set(services.flatMap((s) => s.requires ?? []))];
  const entry = {
    id: manifest.id,
    name: manifest.name,
    description: meta.description,
    version,
    url,
    sha256: createHash("sha256").update(archive).digest("hex"),
    minBand: meta.minBand,
    worker: services.length > 0,
    requires,
  };
  return catalogEntrySchema.parse(entry);
}

/**
 * The catalog for a list of releases. `releases` is `[{ tag, assets: [{ name, url }] }]` and
 * `fetchAsset(url)` returns the bytes. Per extension the highest plain MAJOR.MINOR.PATCH release
 * is listed. A release whose version is not plain (gridcraft-v0.7.0-1) or that has no tarball is
 * skipped with a warning. If the release chosen for an extension is invalid, that is an error,
 * so a broken release stops the workflow instead of leaving the extension out.
 */
export async function buildCatalog({ releases, fetchAsset, warn = console.warn }) {
  const best = new Map();
  for (const release of releases) {
    const parsed = parseTag(release.tag);
    if (!parsed) continue;
    if (!isStrictSemver(parsed.version)) {
      warn(`skipping ${release.tag}: ${parsed.version} is not a plain MAJOR.MINOR.PATCH version`);
      continue;
    }
    const current = best.get(parsed.ext);
    if (!current || compareVersions(parsed.version, current.version) > 0) {
      best.set(parsed.ext, { ...parsed, release });
    }
  }
  const entries = [];
  for (const { ext, version, release } of [...best.values()].sort((a, b) => a.ext.localeCompare(b.ext))) {
    const name = `${ext}-${version}.tar.gz`;
    const asset = release.assets.find((a) => a.name === name);
    if (!asset) throw new Error(`${release.tag}: no asset named ${name}`);
    const archive = await fetchAsset(asset.url);
    const entry = buildEntry({ ext, version, url: asset.url, archive });
    const sum = release.assets.find((a) => a.name === `${name}.sha256`);
    if (sum) {
      const text = (await fetchAsset(sum.url)).toString("utf8");
      const listed = text.trim().split(/\s+/)[0]?.toLowerCase();
      if (listed !== entry.sha256) {
        throw new Error(`${release.tag}: ${name}.sha256 says ${listed}, the archive is ${entry.sha256}`);
      }
    }
    entries.push(entry);
  }
  return entries;
}
