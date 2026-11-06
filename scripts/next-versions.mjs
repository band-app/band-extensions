#!/usr/bin/env node
// Decides which extensions to release and with which version.
//   node scripts/next-versions.mjs plan [--releases <file>] [--write]
//   node scripts/next-versions.mjs apply <plan.json>
// `plan` prints the plan as JSON. --releases is a JSON array of release tag names; without it the
// script asks `gh release list`. --write also sets the planned versions in the manifests.
// `apply` sets the versions of a saved plan in the manifests, so a later job can build them.
//
// Rules, per extension (a folder under extensions/ with a band-extension.json):
//   - no release yet: release the manifest version.
//   - manifest version above the latest release: release the manifest version as written (a manual
//     major bump).
//   - else, if a commit since the latest release touched extensions/<ext>/ (the bot's own
//     `chore(release):` commits do not count): minor when a commit title starts with `feat`,
//     otherwise patch.
//   - else nothing.
// A major bump is never automatic. Versions are plain MAJOR.MINOR.PATCH.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLAIN = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_COMMIT = /^chore\(release\):/;
const FEAT = /^feat(\([^)]*\))?!?:/;

function parse(version, where) {
  const m = PLAIN.exec(version);
  if (!m) throw new Error(`${where}: version "${version}" must be plain MAJOR.MINOR.PATCH`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compare(a, b) {
  const x = parse(a, "compare");
  const y = parse(b, "compare");
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function bump(version, kind) {
  const [major, minor, patch] = parse(version, "bump");
  return kind === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function latestRelease(ext, tags) {
  const prefix = `${ext}-v`;
  const versions = tags
    .filter((t) => t.startsWith(prefix) && PLAIN.test(t.slice(prefix.length)))
    .map((t) => t.slice(prefix.length));
  return versions.sort(compare).at(-1) ?? null;
}

// Titles of the commits since `tag` that touched the extension, without the bot's release commits.
function commitTitles(root, ext, tag) {
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]);
  } catch {
    throw new Error(`release ${tag} exists but the tag is not in this checkout: fetch tags first`);
  }
  const out = git(root, ["log", `${tag}..HEAD`, "--format=%s", "--", `extensions/${ext}`]);
  return out.split("\n").filter(Boolean).filter((s) => !RELEASE_COMMIT.test(s));
}

export function plan({ root, tags }) {
  const exts = readdirSync(join(root, "extensions"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, "extensions", d.name, "band-extension.json")))
    .map((d) => d.name)
    .sort();
  const releases = [];
  for (const ext of exts) {
    const manifest = JSON.parse(readFileSync(join(root, "extensions", ext, "band-extension.json"), "utf8")).version;
    parse(manifest, `extensions/${ext}/band-extension.json`);
    const latest = latestRelease(ext, tags);
    if (latest === null) {
      releases.push({ ext, version: manifest, previous: null, bump: "first", reason: "no release yet" });
    } else if (compare(manifest, latest) > 0) {
      releases.push({ ext, version: manifest, previous: latest, bump: "manifest", reason: `manifest ${manifest} is above release ${latest}` });
    } else {
      const titles = commitTitles(root, ext, `${ext}-v${latest}`);
      if (titles.length === 0) continue;
      const kind = titles.some((t) => FEAT.test(t)) ? "minor" : "patch";
      releases.push({ ext, version: bump(latest, kind), previous: latest, bump: kind, reason: `${titles.length} commit(s) since ${latest}` });
    }
  }
  const message = releases.length
    ? `chore(release): ${releases.map((r) => `${r.ext} v${r.version}`).join(", ")}`
    : "";
  return { releases, message };
}

export function applyPlan(root, p) {
  for (const r of p.releases) {
    const file = join(root, "extensions", r.ext, "band-extension.json");
    const text = readFileSync(file, "utf8");
    const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${r.version}$2`);
    if (next === text && !text.includes(`"${r.version}"`)) throw new Error(`${file}: no version field to update`);
    writeFileSync(file, next);
  }
}

function releaseTags() {
  const out = execFileSync("gh", ["release", "list", "--limit", "1000", "--json", "tagName"], { encoding: "utf8" });
  return JSON.parse(out).map((r) => r.tagName);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (cmd === "plan") {
    const i = rest.indexOf("--releases");
    const tags = i >= 0 ? JSON.parse(readFileSync(rest[i + 1], "utf8")) : releaseTags();
    const p = plan({ root, tags });
    if (rest.includes("--write")) applyPlan(root, p);
    console.log(JSON.stringify(p, null, 2));
  } else if (cmd === "apply" && rest[0]) {
    applyPlan(root, JSON.parse(readFileSync(rest[0], "utf8")));
  } else {
    console.error("usage: next-versions.mjs plan [--releases <file>] [--write] | apply <plan.json>");
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
