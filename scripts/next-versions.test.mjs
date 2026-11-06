// node --test scripts/next-versions.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan, applyPlan } from "./next-versions.mjs";

const EXTS = { gridcraft: "0.7.1", wordcraft: "0.15.1", simulator: "0.1.0" };

function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root, encoding: "utf8" });
}

// A repo with every extension committed once, and a tag for each one in `released`.
function repo(released = ["gridcraft", "wordcraft"]) {
  const root = mkdtempSync(join(tmpdir(), "nv-"));
  git(root, "init", "-q", "-b", "main");
  for (const [ext, version] of Object.entries(EXTS)) {
    mkdirSync(join(root, "extensions", ext), { recursive: true });
    writeFileSync(join(root, "extensions", ext, "band-extension.json"), `{\n  "id": "${ext}",\n  "version": "${version}"\n}\n`);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore: initial");
  for (const ext of released) git(root, "tag", `${ext}-v${EXTS[ext]}`);
  return { root, tags: released.map((e) => `${e}-v${EXTS[e]}`) };
}

function commit(root, file, message) {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), `${Math.random()}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

const summary = (p) => p.releases.map((r) => `${r.ext}@${r.version}`);
// The simulator has no release in most tests; give it one so it stays out of the plan.
const withSim = () => {
  const r = repo(["gridcraft", "wordcraft", "simulator"]);
  return r;
};

test("S1: a fix touching gridcraft plans a patch and nothing else", () => {
  const { root, tags } = withSim();
  commit(root, "extensions/gridcraft/src/a.rs", "fix: handle empty ranges");
  assert.deepEqual(summary(plan({ root, tags })), ["gridcraft@0.7.2"]);
});

test("S2: feat is a minor bump, fix a patch, in one run", () => {
  const { root, tags } = withSim();
  commit(root, "extensions/gridcraft/src/a.rs", "feat: add pivot tables");
  commit(root, "extensions/wordcraft/src/b.rs", "fix: crash on empty file");
  const p = plan({ root, tags });
  assert.deepEqual(summary(p), ["gridcraft@0.8.0", "wordcraft@0.15.2"]);
  assert.equal(p.message, "chore(release): gridcraft v0.8.0, wordcraft v0.15.2");
});

test("feat! and a scoped feat are minor, never major", () => {
  const { root, tags } = withSim();
  commit(root, "extensions/gridcraft/src/a.rs", "feat(core)!: drop the old format");
  assert.deepEqual(summary(plan({ root, tags })), ["gridcraft@0.8.0"]);
});

test("S3: a manifest above the latest release is released as written", () => {
  const { root, tags } = withSim();
  writeFileSync(join(root, "extensions/gridcraft/band-extension.json"), `{\n  "id": "gridcraft",\n  "version": "1.0.0"\n}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "feat!: 1.0");
  const p = plan({ root, tags });
  assert.deepEqual(summary(p), ["gridcraft@1.0.0"]);
  assert.equal(p.releases[0].bump, "manifest");
});

test("S4: an extension with no release gets its manifest version", () => {
  const { root, tags } = repo(["gridcraft", "wordcraft"]);
  assert.deepEqual(summary(plan({ root, tags })), ["simulator@0.1.0"]);
});

test("S5: only the bot's release commit since the last release plans nothing", () => {
  const { root, tags } = withSim();
  writeFileSync(join(root, "extensions/gridcraft/band-extension.json"), `{\n  "id": "gridcraft",\n  "version": "0.7.2"\n}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "chore(release): gridcraft v0.7.2");
  git(root, "tag", "gridcraft-v0.7.2");
  assert.deepEqual(plan({ root, tags: [...tags, "gridcraft-v0.7.2"] }).releases, []);
});

test("S5b: a release commit after the tag is filtered out, a real commit beside it is not", () => {
  const { root, tags } = withSim();
  commit(root, "extensions/gridcraft/notes.txt", "chore(release): gridcraft v0.7.1");
  assert.deepEqual(plan({ root, tags }).releases, []);
  commit(root, "extensions/gridcraft/src/a.rs", "fix: y");
  assert.deepEqual(summary(plan({ root, tags })), ["gridcraft@0.7.2"]);
});

test("S6: changes outside extensions/ plan nothing", () => {
  const { root, tags } = withSim();
  commit(root, "scripts/x.mjs", "fix: script");
  commit(root, "README.md", "docs: readme");
  assert.deepEqual(plan({ root, tags }).releases, []);
});

test("the latest release wins when several exist, and a release after the fix hides it", () => {
  const { root, tags } = withSim();
  commit(root, "extensions/gridcraft/src/a.rs", "fix: one");
  git(root, "tag", "gridcraft-v0.7.2");
  assert.deepEqual(summary(plan({ root, tags: [...tags, "gridcraft-v0.7.2"] })), []);
  commit(root, "extensions/gridcraft/src/a.rs", "fix: two");
  assert.deepEqual(summary(plan({ root, tags: [...tags, "gridcraft-v0.7.2"] })), ["gridcraft@0.7.3"]);
});

test("a release whose tag is missing locally is an error", () => {
  const { root } = withSim();
  assert.throws(() => plan({ root, tags: ["gridcraft-v0.7.9", "wordcraft-v0.15.1", "simulator-v0.1.0"] }), /fetch tags/);
});

test("a manifest version with a suffix is rejected", () => {
  const { root, tags } = withSim();
  writeFileSync(join(root, "extensions/gridcraft/band-extension.json"), `{\n  "version": "0.7.0-1"\n}\n`);
  assert.throws(() => plan({ root, tags }), /plain MAJOR\.MINOR\.PATCH/);
});

test("applyPlan changes only the version line", () => {
  const { root, tags } = withSim();
  commit(root, "extensions/gridcraft/src/a.rs", "fix: x");
  applyPlan(root, plan({ root, tags }));
  assert.equal(readFileSync(join(root, "extensions/gridcraft/band-extension.json"), "utf8"), `{\n  "id": "gridcraft",\n  "version": "0.7.2"\n}\n`);
});
