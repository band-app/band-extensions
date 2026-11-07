import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { parseResolution } from "../src/config.ts";
import { keysymOfChar, parseKeys } from "../src/keys.ts";
import { encodePng, halve } from "../src/png.ts";

test("parseKeys names modifiers and keys", () => {
  assert.deepEqual(parseKeys("Enter"), { modifiers: [], key: 0xff0d });
  assert.deepEqual(parseKeys("ctrl+shift+t"), { modifiers: [0xffe3, 0xffe1], key: 0x74 });
  assert.equal(parseKeys("F5").key, 0xffc2);
  assert.equal(parseKeys("+").key, 0x2b);
  assert.throws(() => parseKeys("nope+a"), /not a modifier/);
  assert.throws(() => parseKeys("NotAKey"), /not a key name/);
});

test("keysymOfChar maps ASCII, Latin-1 and Unicode", () => {
  assert.equal(keysymOfChar("a"), 0x61);
  assert.equal(keysymOfChar("\n"), 0xff0d);
  assert.equal(keysymOfChar("é"), 0xe9);
  assert.equal(keysymOfChar("€"), 0x01000000 + 0x20ac);
});

test("parseResolution accepts WxHxD in range", () => {
  assert.deepEqual(parseResolution("1280x800x24"), { width: 1280, height: 800, depth: 24 });
  assert.equal(parseResolution("10x10x24"), null);
  assert.equal(parseResolution("1280x800"), null);
});

test("encodePng writes a decodable RGB image from BGRX pixels", () => {
  const data = new Uint8Array([0, 0, 255, 0, 0, 255, 0, 0]); // red then green, as B,G,R,X
  const png = encodePng({ width: 2, height: 1, data });
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  const idat = png.subarray(png.indexOf("IDAT") + 4, png.indexOf("IEND") - 8);
  const raw = inflateSync(idat);
  assert.deepEqual([...raw], [0, 255, 0, 0, 0, 255, 0]);
  const half = halve({ width: 2, height: 2, data: new Uint8Array(16).fill(10) });
  assert.equal(half.width, 1);
  assert.equal(half.data[0], 10);
});
