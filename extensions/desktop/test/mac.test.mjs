import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ByteReader, LoginRefusedError } from "../src/ard.ts";
import { setStateDir } from "../src/config.ts";
import { lockedIn, macUser, openStream, readCredentials, status } from "../src/macos.ts";
import { bridgeToMac, ClientMessages } from "../src/proxy.ts";
import { RfbClient } from "../src/rfb.ts";
import { fakeApple } from "./fake-apple.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const user = macUser();

/** A temp state dir with a config.json, and a password file when `password` is given. */
function setup(password) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-mac-"));
  const file = join(dir, "screen-password");
  if (password !== undefined) writeFileSync(file, `${password}\n`, { mode: 0o600 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ macos: { passwordFile: file } }));
  setStateDir(dir);
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What noVNC is to the proxy: a place that receives bytes and ends. */
function fakePanel() {
  const reader = new ByteReader();
  const panel = { ended: false, reader, send: (d) => reader.push(d), end: () => (panel.ended = true) };
  return panel;
}

function connectTo(port) {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port }, () => resolve(s));
    s.once("error", reject);
  });
}

test("S1: RfbClient logs in with Apple's login and reaches ServerInit", async () => {
  const mac = await fakeApple({ user: "agent-test", password: "s3cret!", width: 20, height: 10 });
  try {
    const client = await RfbClient.open(mac.port, 5000, { user: "agent-test", password: "s3cret!" });
    assert.equal(client.width, 20);
    assert.equal(client.height, 10);
    assert.deepEqual(mac.logins, [{ user: "agent-test", ok: true }]);
    client.close();
  } finally {
    mac.close();
  }
});

test("S1: a wrong password raises an error that names the refusal", async () => {
  const mac = await fakeApple({ user: "agent-test", password: "s3cret!" });
  try {
    await assert.rejects(
      RfbClient.open(mac.port, 5000, { user: "agent-test", password: "wrong" }),
      (err) => err instanceof LoginRefusedError && /refused the login for agent-test: Authentication failed/.test(err.message),
    );
    await assert.rejects(RfbClient.open(mac.port, 5000, { user: "someone", password: "s3cret!" }), /refused the login for someone/);
  } finally {
    mac.close();
  }
});

/** Walks a fake panel through noVNC's handshake against the proxy. */
async function handshake(proxy, panel, clientInit = Buffer.from([1])) {
  assert.equal((await panel.reader.read(12)).toString(), "RFB 003.008\n");
  proxy.onMessage(Buffer.from("RFB 003.008\n"));
  assert.deepEqual([...(await panel.reader.read(2))], [1, 1]);
  proxy.onMessage(Buffer.from([1]));
  assert.deepEqual([...(await panel.reader.read(4))], [0, 0, 0, 0]);
  proxy.onMessage(clientInit);
}

test("S2: the proxy shows the panel a server with no login, then passes bytes both ways", async () => {
  const mac = await fakeApple({ user: "agent-test", password: "pw", width: 640, height: 480, name: "agent-test's Mac" });
  const panel = fakePanel();
  try {
    const proxy = bridgeToMac(await connectTo(mac.port), { user: "agent-test", password: "pw" }, panel, { profile: "direct" });
    await handshake(proxy, panel);
    const session = await mac.session();
    const init = await panel.reader.read(session.serverInit.length);
    assert.deepEqual(init, session.serverInit);
    assert.deepEqual(session.clientInit, Buffer.from([1]));

    // Arbitrary bytes, a message type nobody knows included.
    const toMac = Buffer.from([0xfa, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    proxy.onMessage(toMac);
    await sleep(50);
    assert.deepEqual(session.received, toMac);
    const toPanel = Buffer.from("framebuffer update bytes \x00\xff");
    session.socket.write(toPanel);
    assert.deepEqual(await panel.reader.read(toPanel.length), toPanel);
    proxy.onClose();
    assert.equal(panel.ended, true);
  } finally {
    mac.close();
  }
});

test("S2: a refused login reaches the panel as the failure reason and the stream ends", async () => {
  const mac = await fakeApple({ user: "agent-test", password: "pw" });
  const panel = fakePanel();
  try {
    const proxy = bridgeToMac(await connectTo(mac.port), { user: "agent-test", password: "nope" }, panel, { profile: "hub" });
    assert.equal((await panel.reader.read(12)).toString(), "RFB 003.008\n");
    proxy.onMessage(Buffer.from("RFB 003.008\n"));
    assert.equal((await panel.reader.read(1))[0], 0);
    const len = (await panel.reader.read(4)).readUInt32BE(0);
    assert.match((await panel.reader.read(len)).toString(), /refused the login for agent-test/);
    await sleep(20);
    assert.equal(panel.ended, true);
  } finally {
    mac.close();
  }
});

const fbur = (incremental = 1) => Buffer.from([3, incremental, 0, 0, 0, 0, 0, 8, 0, 4]);
const key = (down, sym) => Buffer.from([4, down, 0, 0, (sym >>> 24) & 255, (sym >>> 16) & 255, (sym >>> 8) & 255, sym & 255]);
const pointer = (x) => Buffer.from([5, 0, 0, x, 0, 9]);

/** The client messages in a byte stream, by type, in order. */
function parse(stream) {
  const sizes = { 0: 20, 3: 10, 4: 8, 5: 6 };
  const out = [];
  for (let i = 0; i < stream.length; ) {
    const size = sizes[stream[i]];
    assert.ok(size, `unexpected message type ${stream[i]}`);
    out.push(stream.subarray(i, i + size));
    i += size;
  }
  return out;
}

async function flood(profile) {
  const mac = await fakeApple({ user: "agent-test", password: "pw" });
  const panel = fakePanel();
  try {
    const proxy = bridgeToMac(await connectTo(mac.port), { user: "agent-test", password: "pw" }, panel, { profile });
    await handshake(proxy, panel);
    const session = await mac.session();
    await panel.reader.read(session.serverInit.length);
    const sent = [];
    for (let i = 0; i < 100; i++) {
      proxy.onMessage(fbur());
      if (i % 10 === 0) {
        proxy.onMessage(key(1, 0x61 + (i % 26)));
        proxy.onMessage(pointer(i % 200));
        sent.push(key(1, 0x61 + (i % 26)), pointer(i % 200));
      }
      await sleep(10);
    }
    await sleep(200);
    const got = parse(session.received);
    proxy.onClose();
    return { requests: got.filter((m) => m[0] === 3).length, others: got.filter((m) => m[0] !== 3), sent };
  } finally {
    mac.close();
  }
}

test("S3: the hub profile lets about 15 requests a second through, and every key and pointer event in order", async () => {
  const r = await flood("hub");
  assert.ok(r.requests >= 10 && r.requests <= 22, `${r.requests} requests reached the Mac`);
  assert.deepEqual(r.others, r.sent);
});

test("S3: the direct profile passes all 100 requests", async () => {
  const r = await flood("direct");
  assert.equal(r.requests, 100);
  assert.deepEqual(r.others, r.sent);
});

test("ClientMessages cuts messages across chunks and streams a long ClientCutText", () => {
  const forwarded = [];
  const requests = [];
  const m = new ClientMessages((d) => forwarded.push(Buffer.from(d)), (r) => requests.push(Buffer.from(r)));
  const cut = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 12]), Buffer.from("hello, world")]);
  const encodings = Buffer.concat([Buffer.from([2, 0, 0, 2]), Buffer.alloc(8, 7)]);
  const all = Buffer.concat([key(1, 65), fbur(), cut, encodings, pointer(3), fbur(0)]);
  for (let i = 0; i < all.length; i += 7) m.push(all.subarray(i, i + 7));
  assert.equal(requests.length, 2);
  assert.deepEqual(Buffer.concat(forwarded), Buffer.concat([key(1, 65), cut, encodings, pointer(3)]));
});

test("S4: no password file names the file and what Screen Sharing needs", async () => {
  const s = setup();
  try {
    assert.throws(() => readCredentials(), (e) => e.message.includes(s.file) && /Screen Sharing/.test(e.message));
    const st = await status(1);
    assert.match(String(st.error), new RegExp(s.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(String(st.error), /Screen Sharing/);
    const panel = fakePanel();
    const handlers = await openStream("hub", panel, 1);
    assert.equal((await panel.reader.read(12)).toString(), "RFB 003.008\n");
    handlers.onMessage(Buffer.from("RFB 003.008\n"));
    assert.equal((await panel.reader.read(1))[0], 0);
    const len = (await panel.reader.read(4)).readUInt32BE(0);
    assert.match((await panel.reader.read(len)).toString(), /screen-password/);
    assert.equal(panel.ended, true);
  } finally {
    s.done();
  }
});

test("S4: a refused login shows the same message from status and the stream", async () => {
  const s = setup("wrong");
  const mac = await fakeApple({ user, password: "right" });
  try {
    const st = await status(mac.port);
    assert.match(String(st.error), /refused the login/);
    assert.ok(String(st.error).includes(s.file));
    assert.ok(!String(st.error).includes("wrong"));
    const panel = fakePanel();
    const handlers = await openStream("hub", panel, mac.port);
    assert.equal((await panel.reader.read(12)).toString(), "RFB 003.008\n");
    handlers.onMessage(Buffer.from("RFB 003.008\n"));
    assert.equal((await panel.reader.read(1))[0], 0);
    const len = (await panel.reader.read(4)).readUInt32BE(0);
    assert.match((await panel.reader.read(len)).toString(), /refused the login/);
    await sleep(20);
    assert.equal(panel.ended, true);
  } finally {
    mac.close();
    s.done();
  }
});

test("status answers with the session size when the login works", async () => {
  const s = setup("right");
  const mac = await fakeApple({ user, password: "right", width: 30, height: 20 });
  try {
    const st = await status(mac.port);
    assert.equal(st.width, 30);
    assert.equal(st.height, 20);
    assert.equal(st.error, undefined);
  } finally {
    mac.close();
    s.done();
  }
});

test("lockedIn reads the user's own entry of IOConsoleUsers", () => {
  const users = [
    { kCGSSessionUserNameKey: "someone", CGSSessionScreenIsLocked: true },
    { kCGSSessionUserNameKey: "agent-test" },
  ];
  assert.equal(lockedIn(users, "agent-test"), false);
  assert.equal(lockedIn(users, "someone"), true);
  assert.equal(lockedIn(users, "nobody"), false);
  assert.equal(lockedIn(null, "agent-test"), false);
});
