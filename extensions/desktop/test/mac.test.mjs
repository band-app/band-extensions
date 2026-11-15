import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ByteReader, LoginRefusedError } from "../src/ard.ts";
import { setStateDir } from "../src/config.ts";
import { loginSocket, lockedIn, macUser, openStream, readCredentials, setWorker, signOut, status } from "../src/macos.ts";
import { bridgeToMac, ClientMessages } from "../src/proxy.ts";
import { RfbClient } from "../src/rfb.ts";
import { fakeApple } from "./fake-apple.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const user = macUser();

/** A temp state dir. A password file in it, named by the config, must be ignored. */
function setup(passwordFile) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-mac-"));
  const file = join(dir, "screen-password");
  if (passwordFile !== undefined) {
    writeFileSync(file, `${passwordFile}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ macos: { passwordFile: file } }));
  }
  setStateDir(dir);
  signOut();
  setWorker("w1");
  return { dir, file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** What the panel is to the service: noVNC's bytes, and the text messages that go next to them. */
function fakePanel() {
  const reader = new ByteReader();
  const panel = {
    ended: false,
    reader,
    notices: [],
    waiters: [],
    send: (d) => reader.push(d),
    end: () => (panel.ended = true),
    notify(m) {
      panel.notices.push(m);
      for (const w of panel.waiters.splice(0)) w();
    },
    fail: (message) => panel.notify({ type: "error", message }),
    /** The next notice of `type` (one that already came counts once). */
    async next(type) {
      for (let i = 0; i < 300; i++) {
        const at = panel.notices.findIndex((m) => m.type === type);
        if (at >= 0) return panel.notices.splice(at, 1)[0];
        await new Promise((resolve) => {
          panel.waiters.push(resolve);
          setTimeout(resolve, 10);
        });
      }
      throw new Error(`no ${type} message; got ${JSON.stringify(panel.notices)}`);
    },
  };
  return panel;
}

const answer = (handlers, password) => handlers.onMessage(JSON.stringify({ type: "password", password }));

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
    const proxy = bridgeToMac(await loginSocket(mac.port, { user: "agent-test", password: "pw" }), panel, { profile: "direct" });
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
    const proxy = bridgeToMac(await loginSocket(mac.port, { user: "agent-test", password: "pw" }), panel, { profile });
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

test("S1: with no password in memory the panel is asked; a wrong one is asked again with the reason; a right one connects", async () => {
  const s = setup();
  const mac = await fakeApple({ user, password: "right", width: 30, height: 20 });
  const panel = fakePanel();
  try {
    const handlers = openStream("hub", panel, mac.port);
    assert.deepEqual(await panel.next("need-password"), { type: "need-password", user, worker: "w1", reason: "" });
    answer(handlers, "wrong");
    const again = await panel.next("need-password");
    assert.match(again.reason, /the Mac refused the login for .*Authentication failed/);
    assert.ok(!JSON.stringify(panel.notices).includes("wrong"));
    answer(handlers, "right");
    await panel.next("signed-in");
    await handshake(handlers, panel);
    const session = await mac.session();
    assert.deepEqual(await panel.reader.read(session.serverInit.length), session.serverInit);
    assert.deepEqual(mac.logins.map((l) => l.ok), [false, true]);
    handlers.onClose();
  } finally {
    mac.close();
    s.done();
  }
});

test("S1: a password in memory from an earlier sign-in connects without asking; a refusal clears it and asks", async () => {
  const s = setup();
  const mac = await fakeApple({ user, password: "right" });
  try {
    const first = fakePanel();
    const h1 = openStream("hub", first, mac.port);
    await first.next("need-password");
    answer(h1, "right");
    await first.next("signed-in");
    h1.onClose();

    const second = fakePanel();
    const h2 = openStream("hub", second, mac.port);
    await second.next("signed-in");
    assert.equal(second.notices.some((m) => m.type === "need-password"), false);
    h2.onClose();

    // The Mac's password changed: the remembered one is refused.
    mac.close();
    const changed = await fakeApple({ user, password: "new" });
    try {
      const third = fakePanel();
      const h3 = openStream("hub", third, changed.port);
      const ask = await third.next("need-password");
      assert.match(ask.reason, /refused the login/);
      assert.throws(() => readCredentials(), /sign-in needed/);
      h3.onClose();
    } finally {
      changed.close();
    }
  } finally {
    mac.close();
    s.done();
  }
});

test("S3: tools and status say sign-in needed until a viewer signs in, then work", async () => {
  const s = setup();
  const mac = await fakeApple({ user, password: "right", width: 30, height: 20 });
  try {
    const message = `sign-in needed: open the Desktop tab on this worktree and sign in as ${user}`;
    assert.throws(() => readCredentials(), (e) => e.message === message);
    assert.equal((await status(mac.port)).error, message);
    assert.equal(mac.logins.length, 0);

    const panel = fakePanel();
    const handlers = openStream("hub", panel, mac.port);
    await panel.next("need-password");
    answer(handlers, "right");
    await panel.next("signed-in");
    const st = await status(mac.port);
    assert.equal(st.error, undefined);
    assert.equal(st.width, 30);
    handlers.onClose();
  } finally {
    mac.close();
    s.done();
  }
});

test("S4: a password file, named by the config or at the default place, is ignored", async () => {
  const s = setup("right");
  const mac = await fakeApple({ user, password: "right" });
  try {
    assert.throws(() => readCredentials(), /sign-in needed/);
    assert.match(String((await status(mac.port)).error), /sign-in needed/);
    assert.equal(mac.logins.length, 0);
    const panel = fakePanel();
    const handlers = openStream("hub", panel, mac.port);
    await panel.next("need-password");
    handlers.onClose();
    assert.equal(mac.logins.length, 0);
  } finally {
    mac.close();
    s.done();
  }
});

test("S5: setup failures reach the panel as an error message with the reason", async () => {
  const s = setup();
  try {
    const panel = fakePanel();
    const handlers = openStream("hub", panel, 1);
    await panel.next("need-password");
    answer(handlers, "right");
    const failure = await panel.next("error");
    assert.match(failure.message, /Screen Sharing is not answering/);
    assert.ok(!failure.message.includes("right"));
    await sleep(20);
    assert.equal(panel.ended, true);
  } finally {
    s.done();
  }
});

test("S5: a Mac that closes the socket during the login is a refusal the panel hears about", async () => {
  const s = setup();
  const mac = await fakeApple({ user, password: "right", dropAt: "login" });
  try {
    const panel = fakePanel();
    const handlers = openStream("hub", panel, mac.port);
    await panel.next("need-password");
    answer(handlers, "right");
    const again = await panel.next("need-password");
    assert.match(again.reason, /closed the connection during the login/);
    handlers.onClose();
  } finally {
    mac.close();
    s.done();
  }
});

test("S5: a Mac that closes right after the login reaches the panel as an error before the stream ends", async () => {
  const s = setup();
  const mac = await fakeApple({ user, password: "right", dropAt: "init" });
  try {
    const panel = fakePanel();
    const handlers = openStream("hub", panel, mac.port);
    await panel.next("need-password");
    answer(handlers, "right");
    await panel.next("signed-in");
    const failure = await panel.next("error");
    assert.match(failure.message, /the Mac closed the connection/);
    await sleep(20);
    assert.equal(panel.ended, true);
  } finally {
    mac.close();
    s.done();
  }
});

test("status answers with the session size when the login works", async () => {
  const s = setup();
  const mac = await fakeApple({ user, password: "right", width: 30, height: 20 });
  try {
    const panel = fakePanel();
    const handlers = openStream("hub", panel, mac.port);
    await panel.next("need-password");
    answer(handlers, "right");
    await panel.next("signed-in");
    const st = await status(mac.port);
    assert.equal(st.width, 30);
    assert.equal(st.height, 20);
    handlers.onClose();
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
