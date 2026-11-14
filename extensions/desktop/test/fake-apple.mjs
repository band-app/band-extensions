import { createDecipheriv, createHash, generatePrimeSync, randomBytes } from "node:crypto";
import { createServer } from "node:net";

const KEY_LEN = 64;
const prime = generatePrimeSync(KEY_LEN * 8, { bigint: true });
const generator = 2n;

function modPow(base, exp, mod) {
  let r = 1n;
  let b = base % mod;
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
  }
  return r;
}
const bytes = (n) => Buffer.from(n.toString(16).padStart(KEY_LEN * 2, "0"), "hex");

/**
 * A server that speaks the Mac's Screen Sharing handshake: security type 30, Diffie-Hellman, then
 * AES-128-ECB credentials it decrypts and checks. `sessions` lists the logins that got through.
 */
export async function fakeApple({ user, password, width = 8, height = 4, name = "fake mac" } = {}) {
  const sessions = [];
  const logins = [];
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    let waiter = null;
    let passed = false;
    const session = { socket, received: Buffer.alloc(0), clientInit: null };
    socket.on("data", (chunk) => {
      if (passed) {
        session.received = Buffer.concat([session.received, chunk]);
        session.onData?.(chunk);
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      if (waiter && buf.length >= waiter.n) {
        const w = waiter;
        waiter = null;
        w.resolve();
      }
    });
    socket.on("error", () => undefined);
    const read = async (n) => {
      if (buf.length < n) await new Promise((resolve) => (waiter = { n, resolve }));
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return out;
    };
    (async () => {
      socket.write("RFB 003.008\n");
      await read(12);
      socket.write(Buffer.from([1, 30]));
      await read(1);
      const priv = BigInt(`0x${randomBytes(KEY_LEN).toString("hex")}`) % (prime - 2n) + 1n;
      const head = Buffer.alloc(4);
      head.writeUInt16BE(Number(generator), 0);
      head.writeUInt16BE(KEY_LEN, 2);
      socket.write(Buffer.concat([head, bytes(prime), bytes(modPow(generator, priv, prime))]));
      const blob = await read(128 + KEY_LEN);
      const clientPub = BigInt(`0x${blob.subarray(128).toString("hex")}`);
      const key = createHash("md5").update(bytes(modPow(clientPub, priv, prime))).digest();
      const decipher = createDecipheriv("aes-128-ecb", key, null);
      decipher.setAutoPadding(false);
      const plain = Buffer.concat([decipher.update(blob.subarray(0, 128)), decipher.final()]);
      const cstr = (b) => b.subarray(0, b.indexOf(0)).toString("utf8");
      const gotUser = cstr(plain.subarray(0, 64));
      const gotPassword = cstr(plain.subarray(64));
      logins.push({ user: gotUser, ok: gotUser === user && gotPassword === password });
      if (gotUser !== user || gotPassword !== password) {
        const reason = Buffer.from("Authentication failed");
        const out = Buffer.alloc(8 + reason.length);
        out.writeUInt32BE(1, 0);
        out.writeUInt32BE(reason.length, 4);
        reason.copy(out, 8);
        socket.end(out);
        return;
      }
      socket.write(Buffer.from([0, 0, 0, 0]));
      session.clientInit = await read(1);
      const init = Buffer.alloc(24);
      init.writeUInt16BE(width, 0);
      init.writeUInt16BE(height, 2);
      init[4] = 32; // bits per pixel
      init[5] = 24; // depth
      init[7] = 1; // true colour
      init.writeUInt32BE(Buffer.byteLength(name), 20);
      session.serverInit = Buffer.concat([init, Buffer.from(name)]);
      passed = true;
      session.received = buf; // anything that came with ClientInit
      buf = Buffer.alloc(0);
      sessions.push(session);
      socket.write(session.serverInit);
      session.ready?.();
    })().catch(() => socket.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    sessions,
    logins,
    /** The next session that got through, once it has sent ServerInit. */
    async session(index = 0) {
      for (let i = 0; i < 200 && !sessions[index]; i++) await new Promise((r) => setTimeout(r, 10));
      if (!sessions[index]) throw new Error("no session");
      return sessions[index];
    },
    close() {
      for (const s of sessions) s.socket.destroy();
      server.close();
    },
  };
}
