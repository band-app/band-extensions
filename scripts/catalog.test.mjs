import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildCatalog, compareVersions, parseTag } from "./catalog-lib.mjs";
import { catalogEntrySchema, catalogMetaSchema, isStrictSemver } from "./catalog-schema.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "catalog-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** Packs { ext, version, workerServices, meta } the way scripts/package.sh does. */
function pack({ ext, version, workerServices = [], meta = { description: `The ${ext} extension`, minBand: "0.61.0" }, noMeta = false }) {
  const dir = join(scratch, `${ext}-${version}`);
  mkdirSync(join(dir, ext), { recursive: true });
  writeFileSync(
    join(dir, ext, "band-extension.json"),
    JSON.stringify({ id: ext, name: ext.toUpperCase(), version, extensionApi: 1, contributes: { workerServices } }),
  );
  if (!noMeta) writeFileSync(join(dir, ext, "catalog.json"), JSON.stringify(meta));
  const file = join(scratch, `${ext}-${version}.tar.gz`);
  execFileSync("tar", ["-czf", file, "-C", dir, ext]);
  return readFileSync(file);
}

const release = (ext, version, archive, extraAssets = []) => ({
  tag: `${ext}-v${version}`,
  assets: [
    { name: `${ext}-${version}.tar.gz`, url: `https://example.test/${ext}-${version}.tar.gz` },
    ...extraAssets,
  ],
  archive,
});

const fetcher = (releases) => async (url) => {
  for (const r of releases) {
    if (url.endsWith(".tar.gz")) {
      if (r.assets.some((a) => a.url === url)) return r.archive;
    } else if (url === `${r.assets[0].url}.sha256`) {
      return Buffer.from(`${createHash("sha256").update(r.archive).digest("hex")}  ${r.assets[0].name}\n`);
    }
  }
  throw new Error(`no such asset ${url}`);
};

describe("catalog generator", () => {
  it("lists the newest plain release of each extension with every field Band reads", async () => {
    const sim = pack({
      ext: "simulator",
      version: "0.1.0",
      workerServices: [{ id: "main", entry: "service.mjs", requires: ["os=darwin", "xcrun"], capability: "simulator" }],
    });
    const gridOld = pack({ ext: "gridcraft", version: "0.7.1" });
    const gridNew = pack({ ext: "gridcraft", version: "0.10.0" });
    const releases = [
      release("simulator", "0.1.0", sim),
      release("gridcraft", "0.7.1", gridOld),
      release("gridcraft", "0.10.0", gridNew, [
        { name: "gridcraft-0.10.0.tar.gz.sha256", url: "https://example.test/gridcraft-0.10.0.tar.gz.sha256" },
      ]),
      { tag: "gridcraft-v0.7.0-1", assets: [], archive: Buffer.alloc(0) },
      { tag: "catalog", assets: [], archive: Buffer.alloc(0) },
    ];
    const warnings = [];
    const entries = await buildCatalog({ releases, fetchAsset: fetcher(releases), warn: (m) => warnings.push(m) });

    assert.deepEqual(entries.map((e) => `${e.id} ${e.version}`), ["gridcraft 0.10.0", "simulator 0.1.0"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /gridcraft-v0\.7\.0-1/);

    const simEntry = entries[1];
    assert.deepEqual(simEntry, {
      id: "simulator",
      name: "SIMULATOR",
      description: "The simulator extension",
      version: "0.1.0",
      url: "https://example.test/simulator-0.1.0.tar.gz",
      sha256: createHash("sha256").update(sim).digest("hex"),
      minBand: "0.61.0",
      worker: true,
      requires: ["os=darwin", "xcrun"],
    });
    assert.equal(entries[0].worker, false);
    assert.deepEqual(entries[0].requires, []);
    for (const e of entries) assert.deepEqual(catalogEntrySchema.parse(e), e);
  });

  it("fails when the chosen release is broken, instead of leaving the extension out", async () => {
    const noMeta = pack({ ext: "nometa", version: "1.0.0", noMeta: true });
    const releases = [release("nometa", "1.0.0", noMeta)];
    await assert.rejects(buildCatalog({ releases, fetchAsset: fetcher(releases) }), /no nometa\/catalog\.json/);

    const wrong = pack({ ext: "wrongver", version: "1.0.1" });
    const releases2 = [release("wrongver", "1.0.2", wrong)];
    releases2[0].assets[0].url = releases2[0].assets[0].url.replace("1.0.2", "1.0.1");
    releases2[0].assets[0].name = "wrongver-1.0.2.tar.gz";
    await assert.rejects(buildCatalog({ releases: releases2, fetchAsset: async () => wrong }), /manifest says version 1\.0\.1/);
  });

  it("fails when the .sha256 asset disagrees with the archive", async () => {
    const a = pack({ ext: "sumcheck", version: "1.0.0" });
    const releases = [
      release("sumcheck", "1.0.0", a, [
        { name: "sumcheck-1.0.0.tar.gz.sha256", url: "https://example.test/sumcheck-1.0.0.tar.gz.sha256" },
      ]),
    ];
    const fetchAsset = async (url) =>
      url.endsWith(".sha256") ? Buffer.from(`${"0".repeat(64)}  sumcheck-1.0.0.tar.gz\n`) : a;
    await assert.rejects(buildCatalog({ releases, fetchAsset }), /sha256 says 0{64}/);
  });

  it("parses tags and orders versions numerically", () => {
    assert.deepEqual(parseTag("gridcraft-v0.7.1"), { ext: "gridcraft", version: "0.7.1" });
    assert.equal(parseTag("catalog"), null);
    assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
    assert.ok(isStrictSemver("1.2.3"));
    assert.ok(!isStrictSemver("0.7.0-1"));
  });
});

describe("the extensions in this repository", () => {
  const exts = readdirSync(join(root, "extensions"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it("finds the extensions", () => {
    assert.ok(exts.includes("gridcraft") && exts.includes("simulator"), exts.join(", "));
  });

  for (const ext of exts) {
    it(`${ext}: a plain version and a catalog.json Band's schema accepts`, () => {
      const manifest = JSON.parse(readFileSync(join(root, "extensions", ext, "band-extension.json"), "utf8"));
      assert.equal(manifest.id, ext);
      assert.ok(isStrictSemver(manifest.version), `${manifest.version} is not MAJOR.MINOR.PATCH, so Band's catalog would skip it`);
      const meta = catalogMetaSchema.parse(JSON.parse(readFileSync(join(root, "extensions", ext, "catalog.json"), "utf8")));
      catalogEntrySchema.parse({
        id: manifest.id,
        name: manifest.name,
        description: meta.description,
        version: manifest.version,
        url: `https://github.com/band-app/band-extensions/releases/download/${ext}-v${manifest.version}/${ext}-${manifest.version}.tar.gz`,
        sha256: "0".repeat(64),
        minBand: meta.minBand,
        worker: (manifest.contributes?.workerServices ?? []).length > 0,
        requires: (manifest.contributes?.workerServices ?? []).flatMap((s) => s.requires ?? []),
      });
    });
  }
});
