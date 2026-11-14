import { createCipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Apple's RFB login: security type 30, a Diffie-Hellman exchange followed by the user name and the
 * password, each in a 64-byte field, encrypted with AES-128-ECB under the MD5 of the shared secret.
 * macOS Screen Sharing offers it and opens the session of the user who logs in.
 */

export interface Credentials {
  user: string;
  password: string;
}

/** What the login reads from and writes to: a socket behind a buffer. */
export interface Io {
  read(n: number): Promise<Buffer>;
  write(data: Buffer): void;
}

/** The Mac answered the login with a refusal. */
export class LoginRefusedError extends Error {
  constructor(user: string, reason: string) {
    super(`the Mac refused the login for ${user}${reason ? `: ${reason}` : ""}`);
    this.name = "LoginRefusedError";
  }
}

/** A buffer that hands out exact byte counts as chunks arrive. One reader may wait at a time. */
export class ByteReader {
  private pending: Buffer = Buffer.alloc(0);
  private waiter: { need: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private error: Error | null = null;

  push(chunk: Uint8Array): void {
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.pending = this.pending.length ? Buffer.concat([this.pending, buf]) : buf;
    this.flush();
  }

  /** Fails the waiting read and every later one. */
  fail(err: Error): void {
    this.error = this.error ?? err;
    this.waiter?.reject(this.error);
    this.waiter = null;
  }

  read(n: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiter = { need: n, resolve, reject };
      this.flush();
    });
  }

  /** Bytes that arrived but were not asked for yet. */
  takeRest(): Buffer {
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }

  private flush(): void {
    const w = this.waiter;
    if (w && this.pending.length >= w.need) {
      const out = Buffer.from(this.pending.subarray(0, w.need));
      this.pending = this.pending.subarray(w.need);
      this.waiter = null;
      w.resolve(out);
    }
  }
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function toBytes(n: bigint, len: number): Buffer {
  return Buffer.from(n.toString(16).padStart(len * 2, "0"), "hex");
}

/** 64 bytes: the value, a NUL, then random filler. */
function field(value: string, what: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 63) throw new Error(`the ${what} is longer than 63 bytes`);
  return Buffer.concat([bytes, Buffer.from([0]), randomBytes(63 - bytes.length)]);
}

/**
 * The RFB handshake up to and including SecurityResult, as a client logging in with type 30. It
 * leaves ClientInit and everything after it to the caller.
 */
export async function appleLogin(io: Io, creds: Credentials): Promise<void> {
  const version = (await io.read(12)).toString("ascii");
  if (!/^RFB 00\d\.\d{3}\n$/.test(version)) throw new Error(`not an RFB server: ${JSON.stringify(version)}`);
  io.write(Buffer.from("RFB 003.008\n", "ascii"));
  const count = (await io.read(1))[0] as number;
  if (count === 0) {
    const len = (await io.read(4)).readUInt32BE(0);
    throw new Error(`the VNC server refused: ${(await io.read(len)).toString("utf8")}`);
  }
  const types = [...(await io.read(count))];
  if (!types.includes(30)) {
    throw new Error(`the Mac offers no Apple user and password login (security types ${types.join(",")})`);
  }
  io.write(Buffer.from([30]));
  const params = await io.read(4);
  const generator = BigInt(params.readUInt16BE(0));
  const keyLen = params.readUInt16BE(2);
  const prime = BigInt(`0x${(await io.read(keyLen)).toString("hex")}`);
  const serverPub = BigInt(`0x${(await io.read(keyLen)).toString("hex")}`);
  const priv = (BigInt(`0x${randomBytes(keyLen).toString("hex")}`) % (prime - 2n)) + 1n;
  const clientPub = toBytes(modPow(generator, priv, prime), keyLen);
  const shared = toBytes(modPow(serverPub, priv, prime), keyLen);
  const cipher = createCipheriv("aes-128-ecb", createHash("md5").update(shared).digest(), null);
  cipher.setAutoPadding(false);
  const credentials = Buffer.concat([field(creds.user, "user name"), field(creds.password, "password")]);
  io.write(Buffer.concat([cipher.update(credentials), cipher.final(), clientPub]));
  const status = (await io.read(4)).readUInt32BE(0);
  if (status !== 0) {
    let reason = "";
    try {
      const len = (await Promise.race([io.read(4), timeout(1000)])).readUInt32BE(0);
      reason = (await Promise.race([io.read(Math.min(len, 1000)), timeout(1000)])).toString("utf8");
    } catch {
      // Some servers close right after the status.
    }
    throw new LoginRefusedError(creds.user, reason);
  }
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms).unref());
}
