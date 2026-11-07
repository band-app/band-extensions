import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Watchers } from "../src/watch.ts";

const dev = (id, state) => ({ id, platform: id.startsWith("ios") ? "ios" : "android", name: id, state, os: "x", owned: false });

function setup() {
  let t = 1_000_000;
  let devices = [dev("ios:A", "on"), dev("ios:B", "off")];
  let reads = 0;
  const w = new Watchers(async () => (reads++, devices), 2000, () => t);
  return { w, tick: (ms) => (t += ms), set: (d) => (devices = d), reads: () => reads };
}

describe("Watchers", () => {
  it("the first poll only sets the baseline: a device already on is not offered", async () => {
    const { w } = setup();
    assert.deepEqual((await w.poll("wt", { shown: ["ios:A"] })).events, []);
  });

  it("offers a device that went from off to on once, and not one already shown", async () => {
    const { w, tick, set } = setup();
    await w.poll("wt", { shown: ["ios:A"] });
    tick(2000);
    set([dev("ios:A", "on"), dev("ios:B", "on"), dev("ios:C", "booting")]);
    const r = await w.poll("wt", { since: 0, shown: ["ios:A", "ios:C"] });
    assert.deepEqual(r.events.map((e) => [e.type, e.device.id]), [["offer", "ios:B"]]);
    tick(2000);
    assert.deepEqual((await w.poll("wt", { since: r.seq, shown: ["ios:A"] })).events, []);
  });

  it("withdraws the offer when the device turns off, and offers it again on the next start", async () => {
    const { w, tick, set } = setup();
    await w.poll("wt", {});
    tick(2000);
    set([dev("ios:A", "on"), dev("ios:B", "on")]);
    let r = await w.poll("wt", { since: 0 });
    tick(2000);
    set([dev("ios:A", "on"), dev("ios:B", "off")]);
    r = await w.poll("wt", { since: r.seq });
    assert.deepEqual(r.events.map((e) => e.type), ["withdraw"]);
    tick(2000);
    set([dev("ios:A", "on"), dev("ios:B", "on")]);
    r = await w.poll("wt", { since: r.seq });
    assert.deepEqual(r.events.map((e) => e.type), ["offer"]);
  });

  it("reads the devices at most once per 2 seconds for all tabs together", async () => {
    const { w, tick, reads } = setup();
    for (let i = 0; i < 10; i++) {
      await w.poll(i % 2 ? "wt-1" : "wt-2", {});
      tick(100);
    }
    assert.equal(reads(), 1);
    tick(2000);
    await w.poll("wt-1", {});
    assert.equal(reads(), 2);
  });

  it("does nothing for a tab that stopped polling, and starts over when it comes back", async () => {
    const { w, tick, set } = setup();
    await w.poll("wt", { focus: "p2" });
    assert.equal(w.isOpen("wt"), true);
    assert.equal(w.focusPane("wt"), "p2");
    tick(11_000);
    assert.equal(w.isOpen("wt"), false);
    assert.equal(w.push("wt", { type: "withdraw", id: "x" }), false);
    set([dev("ios:A", "on"), dev("ios:B", "on")]);
    // The baseline is taken again, so a device that started while the tab was closed is not offered.
    assert.deepEqual((await w.poll("wt", {})).events, []);
  });
});
