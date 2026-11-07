import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import vm from "node:vm";
import { setStateDir } from "../src/config.ts";
import { deviceIds, MAX_PANES, paneCount, sanitizeLayout } from "../src/layout.ts";
import { LayoutStore } from "../src/store.ts";

const ctx = { globalThis: null };
ctx.globalThis = ctx;
vm.runInNewContext(readFileSync(new URL("../panel/canvas.js", import.meta.url), "utf8"), ctx);
const C = ctx.BandSimCanvas;
const j = (v) => JSON.parse(JSON.stringify(v));

const dev = (id, name = id) => ({ id, platform: id.startsWith("ios") ? "ios" : "android", name });

describe("canvas edits (panel)", () => {
  it("splits a pane in two and closes it again, the sibling taking the space", () => {
    let t = C.pane("p1", dev("ios:AAA"));
    t = C.split(t, "p1", "row", "p2");
    assert.equal(C.paneCount(t), 2);
    assert.equal(t.dir, "row");
    assert.equal(t.a.device.id, "ios:AAA");
    assert.equal(t.b.device, null);
    t = C.close(t, "p2");
    assert.deepEqual(j(t), j(C.pane("p1", dev("ios:AAA"))));
  });

  it("stops splitting at 4 panes and never closes the last pane", () => {
    let t = C.pane("p1", null);
    for (const dir of ["row", "column", "row", "column", "row"]) t = C.split(t, C.panes(t)[0].id, dir, C.nextPaneId(t));
    assert.equal(C.paneCount(t), C.MAX_PANES);
    assert.equal(C.canSplit(t), false);
    let single = C.pane("p1", null);
    assert.equal(C.close(single, "p1"), single);
  });

  it("sets a device, a split ratio within limits, and lists the devices other panes hold", () => {
    let t = C.split(C.pane("p1", dev("ios:AAA")), "p1", "column", "p2");
    t = C.setDevice(t, "p2", dev("android:avd:Pixel_8"));
    assert.deepEqual([...C.takenDeviceIds(t, "p2")], ["ios:AAA"]);
    assert.equal(C.setRatio(t, [], 0.99).ratio, 0.85);
    assert.equal(C.setRatio(t, [], 0.01).ratio, 0.15);
    assert.equal(C.setRatio(t, [], 0.4).ratio, 0.4);
  });

  it("the saved shape passes the service's check", () => {
    let t = C.split(C.pane("p1", dev("ios:AAA")), "p1", "row", "p2");
    t = C.setDevice(t, "p2", dev("android:avd:Pixel_8"));
    assert.ok(sanitizeLayout(j(C.toSaved(t))));
  });
});

describe("sanitizeLayout (service)", () => {
  const pane = (id, device = null) => ({ type: "pane", id, device });
  const split = (a, b, dir = "row", ratio = 0.5) => ({ type: "split", dir, ratio, a, b });

  it("accepts a layout of up to 4 panes and clamps the ratio", () => {
    const l = sanitizeLayout(split(pane("p1", dev("ios:AAA")), split(pane("p2"), pane("p3"), "column"), "row", 5));
    assert.equal(paneCount(l), 3);
    assert.equal(l.ratio, 0.85);
    assert.deepEqual(deviceIds(l), ["ios:AAA"]);
  });

  it("rejects 5 panes, a device in two panes, a duplicate pane id and a bad device id", () => {
    assert.equal(MAX_PANES, 4);
    const five = split(split(pane("a"), pane("b")), split(pane("c"), split(pane("d"), pane("e"))));
    assert.equal(sanitizeLayout(five), null);
    assert.equal(sanitizeLayout(split(pane("a", dev("ios:AAA")), pane("b", dev("ios:AAA")))), null);
    assert.equal(sanitizeLayout(split(pane("a"), pane("a"))), null);
    assert.equal(sanitizeLayout(pane("a", { id: "ios:$(rm -rf)", platform: "ios", name: "x" })), null);
    assert.equal(sanitizeLayout(pane("a", { id: "android:avd:X", platform: "ios", name: "x" })), null);
    assert.equal(sanitizeLayout("nope"), null);
  });
});

describe("LayoutStore", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sim-store-")));
  const repo = join(root, "repo");
  const wtA = join(root, "wt-a");
  const wtB = join(root, "wt-b");
  const other = join(root, "other");
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  before(() => {
    mkdirSync(repo);
    mkdirSync(other);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "-c", "user.email=a@b.c", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
    git(repo, "worktree", "add", "-q", "-b", "a", wtA);
    git(repo, "worktree", "add", "-q", "-b", "b", wtB);
    git(other, "init", "-q");
    setStateDir(join(root, "state"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const layout = {
    type: "split",
    dir: "row",
    ratio: 0.5,
    a: { type: "pane", id: "p1", device: dev("ios:AAA", "iPhone") },
    b: { type: "pane", id: "p2", device: dev("android:avd:Pixel_8", "Pixel_8") },
  };

  it("restores a worktree's layout after a restart", async () => {
    const s = new LayoutStore();
    assert.deepEqual(await s.get("wt-a", wtA), { layout: null, from: null });
    await s.save("wt-a", wtA, layout);
    await s.flush();
    const again = new LayoutStore();
    const got = await again.get("wt-a", wtA);
    assert.equal(got.from, "worktree");
    assert.deepEqual(j(got.layout), j(layout));
  });

  it("a worktree that never opened the tab starts from the repo's last layout; another repo gets none", async () => {
    const s = new LayoutStore();
    const got = await s.get("wt-b", wtB);
    assert.equal(got.from, "repo");
    assert.deepEqual(j(got.layout), j(layout));
    assert.deepEqual(await s.get("wt-x", other), { layout: null, from: null });
  });

  it("reports every saved device, and forgetting a worktree keeps the repo's layout", async () => {
    const s = new LayoutStore();
    assert.deepEqual([...(await s.savedDeviceIds())].sort(), ["android:avd:Pixel_8", "ios:AAA"]);
    await s.forget("wt-a");
    assert.equal((await s.get("wt-a", wtA)).from, "repo");
    await assert.rejects(s.save("wt-a", wtA, { type: "pane", id: "p1", device: { id: "bad", platform: "ios", name: "x" } }));
  });
});
