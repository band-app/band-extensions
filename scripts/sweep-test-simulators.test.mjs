import assert from "node:assert/strict";
import { test } from "node:test";
import { testDevicesIn } from "./sweep-test-simulators.mjs";

const D = "–";
const stamp = (ms) => Math.floor(ms / 1000).toString(36);

test("keeps a person's devices and a live run's, deletes a stale run's and the named run's", () => {
  const now = 1_800_000_000_000;
  const live = `band-test-${stamp(now - 60_000)}-1`;
  const old = `band-test-${stamp(now - 5 * 3600_000)}-2`;
  const list = {
    devices: {
      rt: [
        { udid: "a", name: `${live} ${D} wt` },
        { udid: "b", name: `${old} ${D} wt` },
        { udid: "c", name: `Band ${D} wt` },
        { udid: "d", name: "iPhone 17 Pro" },
        { udid: "e", name: `band-test-x ${D} wt` },
      ],
    },
  };
  const udids = (r) => r.map((d) => d.udid);
  assert.deepEqual(udids(testDevicesIn(list, { olderThanMs: 3 * 3600_000, now })), ["b"]);
  assert.deepEqual(udids(testDevicesIn(list, { prefix: live, olderThanMs: 3 * 3600_000, now })), ["a", "b"]);
});
