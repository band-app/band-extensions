import { connect, type Socket } from "node:net";
import { appleLogin, type Credentials } from "./ard.ts";
import type { Bgrx } from "./png.ts";

/**
 * A small RFB (VNC) client for the service's own use: screenshots and input for the agent tools.
 * It speaks to the display's x11vnc on loopback with security type None and the Raw encoding only,
 * which x11vnc always offers. The panel's viewer is a separate connection (noVNC in the browser).
 */
export class RfbClient {
  width = 0;
  height = 0;
  private fb = new Uint8Array(0);
  private pending: Buffer = Buffer.alloc(0);
  private waiter: { need: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  private error: Error | null = null;

  private readonly socket: Socket;
  private readonly creds?: Credentials;

  private constructor(socket: Socket, creds?: Credentials) {
    this.socket = socket;
    this.creds = creds;
    socket.on("data", (chunk) => {
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      this.flush();
    });
    const fail = (err: Error) => {
      this.error = this.error ?? err;
      this.waiter?.reject(this.error);
      this.waiter = null;
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("the display's VNC server closed the connection")));
  }

  /** Connects to x11vnc on `127.0.0.1:port` and completes the handshake. */
  static async open(port: number, timeoutMs = 10_000, creds?: Credentials): Promise<RfbClient> {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setNoDelay(true);
    const client = new RfbClient(socket, creds);
    const timer = setTimeout(() => socket.destroy(new Error("the VNC handshake timed out")), timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
      });
      await client.handshake();
      return client;
    } catch (err) {
      socket.destroy();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private flush(): void {
    const w = this.waiter;
    if (w && this.pending.length >= w.need) {
      const out = this.pending.subarray(0, w.need);
      this.pending = this.pending.subarray(w.need);
      this.waiter = null;
      w.resolve(Buffer.from(out));
    }
  }

  private read(n: number): Promise<Buffer> {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiter = { need: n, resolve, reject };
      this.flush();
    });
  }

  private write(buf: Buffer): void {
    if (!this.socket.destroyed) this.socket.write(buf);
  }

  private async handshake(): Promise<void> {
    if (this.creds) {
      // macOS Screen Sharing: Apple's user and password login.
      await appleLogin({ read: (n) => this.read(n), write: (b) => this.write(b) }, this.creds);
    } else {
      const version = (await this.read(12)).toString("ascii");
      if (!/^RFB 00\d\.00\d\n$/.test(version)) throw new Error(`not an RFB server: ${JSON.stringify(version)}`);
      this.write(Buffer.from("RFB 003.008\n", "ascii"));
      const count = (await this.read(1))[0] as number;
      if (count === 0) {
        const len = (await this.read(4)).readUInt32BE(0);
        throw new Error(`the VNC server refused: ${(await this.read(len)).toString("utf8")}`);
      }
      const types = [...(await this.read(count))];
      if (!types.includes(1)) throw new Error(`the VNC server wants a password (security types ${types.join(",")})`);
      this.write(Buffer.from([1]));
      const result = (await this.read(4)).readUInt32BE(0);
      if (result !== 0) throw new Error("the VNC server refused the connection");
    }
    this.write(Buffer.from([1])); // ClientInit: shared
    const init = await this.read(24);
    this.width = init.readUInt16BE(0);
    this.height = init.readUInt16BE(2);
    await this.read(init.readUInt32BE(20)); // the desktop's name
    this.fb = new Uint8Array(this.width * this.height * 4);
    // 32 bits per pixel, true colour, little endian: blue, green, red, unused in memory.
    const setPixelFormat = Buffer.alloc(20);
    setPixelFormat[0] = 0;
    setPixelFormat[4] = 32;
    setPixelFormat[5] = 24;
    setPixelFormat[6] = 0;
    setPixelFormat[7] = 1;
    setPixelFormat.writeUInt16BE(255, 8);
    setPixelFormat.writeUInt16BE(255, 10);
    setPixelFormat.writeUInt16BE(255, 12);
    setPixelFormat[14] = 16;
    setPixelFormat[15] = 8;
    setPixelFormat[16] = 0;
    this.write(setPixelFormat);
    const setEncodings = Buffer.alloc(8);
    setEncodings[0] = 2;
    setEncodings.writeUInt16BE(1, 2);
    setEncodings.writeInt32BE(0, 4); // Raw
    this.write(setEncodings);
  }

  private request(incremental: boolean, w = this.width, h = this.height): void {
    const m = Buffer.alloc(10);
    m[0] = 3;
    m[1] = incremental ? 1 : 0;
    m.writeUInt16BE(w, 6);
    m.writeUInt16BE(h, 8);
    this.write(m);
  }

  /** Reads one server message. Returns true when it was a framebuffer update. */
  private async message(): Promise<boolean> {
    const type = (await this.read(1))[0] as number;
    switch (type) {
      case 0: {
        const head = await this.read(3);
        const rects = head.readUInt16BE(1);
        for (let i = 0; i < rects; i++) {
          const r = await this.read(12);
          const x = r.readUInt16BE(0);
          const y = r.readUInt16BE(2);
          const w = r.readUInt16BE(4);
          const h = r.readUInt16BE(6);
          const enc = r.readInt32BE(8);
          if (enc !== 0) throw new Error(`the VNC server sent encoding ${enc}, which was not asked for`);
          const pixels = await this.read(w * h * 4);
          for (let row = 0; row < h; row++) {
            if (y + row >= this.height) break;
            const cols = Math.min(w, this.width - x);
            if (cols <= 0) break;
            this.fb.set(pixels.subarray(row * w * 4, (row * w + cols) * 4), ((y + row) * this.width + x) * 4);
          }
        }
        return true;
      }
      case 1: {
        const head = await this.read(5);
        await this.read(head.readUInt16BE(1 + 2) * 6);
        return false;
      }
      case 2:
        return false;
      case 3: {
        const head = await this.read(7);
        await this.read(head.readUInt32BE(3));
        return false;
      }
      default:
        throw new Error(`unexpected RFB message type ${type}`);
    }
  }

  /** Waits for the next framebuffer update after the request that was just sent. */
  private async nextUpdate(timeoutMs: number): Promise<void> {
    const timer = setTimeout(() => this.socket.destroy(new Error("the display did not answer in time")), timeoutMs);
    try {
      while (!(await this.message())) {
        // Bell, colour map and clipboard messages are skipped.
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** The whole screen as it is now. */
  async screenshot(timeoutMs = 15_000): Promise<Bgrx> {
    this.request(false);
    await this.nextUpdate(timeoutMs);
    return { width: this.width, height: this.height, data: this.fb.slice() };
  }

  /**
   * Resolves once the server has handled everything sent so far: it answers a framebuffer update
   * request only after the input events in front of it.
   */
  async barrier(timeoutMs = 10_000): Promise<void> {
    this.request(false, 1, 1);
    await this.nextUpdate(timeoutMs);
  }

  pointer(x: number, y: number, buttons: number): void {
    const m = Buffer.alloc(6);
    m[0] = 5;
    m[1] = buttons;
    m.writeUInt16BE(Math.max(0, Math.min(this.width - 1, Math.round(x))), 2);
    m.writeUInt16BE(Math.max(0, Math.min(this.height - 1, Math.round(y))), 4);
    this.write(m);
  }

  key(keysym: number, down: boolean): void {
    const m = Buffer.alloc(8);
    m[0] = 4;
    m[1] = down ? 1 : 0;
    m.writeUInt32BE(keysym >>> 0, 4);
    this.write(m);
  }

  close(): void {
    this.socket.destroy();
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Opens a client, runs `fn` and always closes it. */
export async function withRfb<T>(port: number, fn: (c: RfbClient) => Promise<T>, creds?: Credentials): Promise<T> {
  const client = await RfbClient.open(port, 10_000, creds);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

const BUTTONS = { left: 1, middle: 2, right: 4 } as const;

export async function click(
  c: RfbClient,
  x: number,
  y: number,
  button: keyof typeof BUTTONS = "left",
  double = false,
): Promise<void> {
  const mask = BUTTONS[button];
  c.pointer(x, y, 0);
  await sleep(20);
  for (let i = 0; i < (double ? 2 : 1); i++) {
    c.pointer(x, y, mask);
    await sleep(40);
    c.pointer(x, y, 0);
    await sleep(40);
  }
  await c.barrier();
}

export async function typeKeys(c: RfbClient, keysyms: number[]): Promise<void> {
  for (const sym of keysyms) {
    c.key(sym, true);
    await sleep(6);
    c.key(sym, false);
    await sleep(6);
  }
  await c.barrier();
}

export async function press(c: RfbClient, modifiers: number[], key: number): Promise<void> {
  for (const m of modifiers) c.key(m, true);
  await sleep(10);
  c.key(key, true);
  await sleep(30);
  c.key(key, false);
  for (const m of [...modifiers].reverse()) c.key(m, false);
  await c.barrier();
}
