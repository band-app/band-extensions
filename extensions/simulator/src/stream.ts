import WebSocket from "ws";
import type { Helper, ServeSimHelpers } from "./servesim.ts";

/** What openScreenStream returns: frames to send out and a way to write what the viewer sent. */
export interface ScreenStream {
  output: AsyncIterable<string | Uint8Array>;
  write(message: string | Uint8Array): void;
  close(): void;
}

const BUTTONS: Record<string, string> = {
  HOME: "home",
  LOCK: "lock",
  SIDE_BUTTON: "side_button",
  SIRI: "siri",
};
/** The orientations the panel's Rotate button uses. */
export const ORIENTATIONS = ["portrait", "landscape_left"];

const KEY_USAGE: Record<string, number> = { Enter: 0x28, Backspace: 0x2a, Tab: 0x2b, Escape: 0x29 };

const JPEG_START = Buffer.from([0xff, 0xd8]);

/**
 * Splits serve-sim's `multipart/x-mixed-replace` stream into JPEG frames. Each part has
 * a `Content-Length`, so no boundary search is needed.
 */
export async function* mjpegFrames(body: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer> {
  let buf = Buffer.alloc(0);
  for await (const chunk of body) {
    buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
    for (;;) {
      const headEnd = buf.indexOf("\r\n\r\n");
      if (headEnd < 0) break;
      const head = buf.subarray(0, headEnd).toString("latin1");
      const length = /content-length:\s*(\d+)/i.exec(head)?.[1];
      if (!length) {
        // A part with no length: skip its header and look again.
        buf = buf.subarray(headEnd + 4);
        continue;
      }
      const size = Number(length);
      const start = headEnd + 4;
      if (buf.length < start + size) break;
      const frame = buf.subarray(start, start + size);
      buf = buf.subarray(start + size);
      if (frame.subarray(0, 2).equals(JPEG_START)) yield Buffer.from(frame);
    }
  }
}

/** Pixel size of a JPEG, from its first start-of-frame marker, or null when it has none. */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1] as number;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
    }
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * What a viewer is sent. The `direct` profile is serve-sim's own frames: the viewer is on this
 * machine, so nothing limits them. The `hub` profile is for a viewer behind the hub, where every
 * frame crosses the link and the hub's connection to the browser. serve-sim has no size or rate
 * option on its MJPEG stream, so the worker halves the frame's width and height and sends at most
 * `HUB_MAX_FPS` frames a second. Touches are fractions of the screen, so scaling does not change
 * where they land.
 */
export const HUB_MAX_FPS = 15;
const HUB_SCALE = 0.5;
const HUB_JPEG_QUALITY = 70;

/** Band sets `profile` on every stream. Anything but "direct" is treated as "hub", the cheaper one. */
export function streamProfile(params: unknown): "hub" | "direct" {
  const profile = (params as { profile?: unknown } | null)?.profile;
  return profile === "direct" ? "direct" : "hub";
}

type Sharp = typeof import("sharp");
let sharpModule: Promise<Sharp | null> | null = null;

/** sharp loads once, on the first hub frame. A missing or broken addon leaves frames at full size. */
function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import("sharp")
    .then((m) => {
      const sharp = ((m as { default?: Sharp }).default ?? m) as Sharp;
      // One frame is in flight at a time, so a small libvips pool is enough and the cache only holds old frames.
      sharp.cache(false);
      sharp.concurrency(2);
      return sharp;
    })
    .catch(() => null);
  return sharpModule;
}

/** Halves a JPEG in process with sharp (libvips). No process is spawned per frame. */
export async function scaleFrame(frame: Buffer): Promise<Buffer> {
  const size = jpegSize(frame);
  if (!size) return frame;
  const width = Math.max(1, Math.floor(size.width * HUB_SCALE));
  const height = Math.max(1, Math.floor(size.height * HUB_SCALE));
  try {
    const sharp = await loadSharp();
    if (!sharp) return frame;
    return await sharp(frame, { failOn: "none" })
      .resize(width, height, { fit: "fill", kernel: "lanczos2" })
      .jpeg({ quality: HUB_JPEG_QUALITY })
      .toBuffer();
  } catch {
    // The viewer gets the full frame rather than none.
    return frame;
  }
}

/**
 * Moves frames from `source` to `sink` through `encode`: one frame is encoded at a time, the
 * frame taken is the newest one waiting (older ones were already replaced), and no more than
 * `fps` frames a second go out. Ends `sink` when `source` ends.
 */
export async function pumpLatest<T, U>(
  source: Latest<T>,
  sink: Latest<U>,
  encode: (frame: T) => Promise<U>,
  fps: number = HUB_MAX_FPS,
): Promise<void> {
  const frames = source[Symbol.asyncIterator]();
  let sentAt = 0;
  try {
    for (;;) {
      const wait = sentAt + 1000 / fps - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const next = await frames.next();
      if (next.done) break;
      sentAt = Date.now();
      sink.push(await encode(next.value));
    }
  } finally {
    sink.end();
  }
}

/** Holds the newest message, so a slow viewer skips frames instead of lagging further behind. */
export class Latest<T> {
  private value: T | undefined;
  private waiter: (() => void) | null = null;
  private ended = false;

  push(value: T): void {
    this.value = value;
    this.waiter?.();
  }

  end(): void {
    this.ended = true;
    this.waiter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.value !== undefined) {
        const v = this.value;
        this.value = undefined;
        yield v;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
  }
}

interface Hid {
  send(type: number, payload: unknown): void;
  close(): void;
}

/** The helper's HID socket: a type byte, then JSON. Messages sent before it opens wait. */
function openHid(helper: Helper): Hid {
  const ws = new WebSocket(helper.wsUrl);
  const queue: Buffer[] = [];
  ws.on("open", () => {
    for (const m of queue.splice(0)) ws.send(m);
  });
  ws.on("error", () => undefined);
  return {
    send(type, payload) {
      const msg = Buffer.concat([Buffer.from([type]), Buffer.from(JSON.stringify(payload))]);
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      else if (ws.readyState === WebSocket.CONNECTING) queue.push(msg);
    },
    close: () => ws.close(),
  };
}

const unit = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;

/**
 * The live screen of one device. Messages to the viewer are text `{"type":"info"}` and then one
 * binary JPEG per frame (the newest one when the viewer is slow). Messages from the viewer are
 * JSON: `touch` (phase and 0..1 coordinates), `button`, `key` and `text`. Frame size and rate
 * follow the `profile` in `params`.
 */
export function openScreenStream(
  helper: Helper,
  helpers: ServeSimHelpers,
  info: { width: number; height: number; udid: string; name: string; model?: string; platform?: string },
  params: unknown = {},
): ScreenStream {
  const abort = new AbortController();
  const latest = new Latest<Buffer>();
  const hid = openHid(helper);
  const hub = streamProfile(params) === "hub";
  // Raw frames wait here for the encoder, which takes the newest one at most `HUB_MAX_FPS` times a second.
  const raw = hub ? new Latest<Buffer>() : latest;
  if (hub) void pumpLatest(raw, latest, scaleFrame);

  void (async () => {
    try {
      const res = await fetch(helper.streamUrl, { signal: abort.signal });
      if (!res.ok || !res.body) throw new Error(`serve-sim stream answered ${res.status}`);
      for await (const frame of mjpegFrames(res.body as unknown as AsyncIterable<Uint8Array>)) {
        raw.push(frame);
      }
    } catch {
      // Ending the output closes the viewer's socket; it reconnects.
    } finally {
      raw.end();
      if (!hub) latest.end();
    }
  })();

  let typing: Promise<unknown> = Promise.resolve();
  // The info message goes first and is never coalesced; only frames are.
  const output = (async function* () {
    yield JSON.stringify({ type: "info", ...info });
    yield* latest;
  })();
  let queuedText = 0;
  return {
    output,
    write(message) {
      if (typeof message !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(message) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (msg.type) {
        case "touch": {
          const x = unit(msg.x);
          const y = unit(msg.y);
          if (x === null || y === null) return;
          if (msg.phase !== "begin" && msg.phase !== "move" && msg.phase !== "end") return;
          hid.send(3, { type: msg.phase, x, y, edge: 0 });
          return;
        }
        case "button": {
          if (typeof msg.name !== "string") return;
          const name = BUTTONS[msg.name];
          if (name) hid.send(4, { button: name });
          return;
        }
        case "key": {
          const usage = typeof msg.key === "string" ? KEY_USAGE[msg.key] : undefined;
          if (usage === undefined) return;
          hid.send(6, { type: "down", usage });
          hid.send(6, { type: "up", usage });
          return;
        }
        case "text": {
          const text = msg.text;
          if (typeof text !== "string" || text === "" || text.length > 1000) return;
          // A viewer cannot queue more than a few typed chunks at once.
          if (queuedText >= 20) return;
          queuedText++;
          typing = typing
            .then(() => helpers.type(helper.udid, text))
            .catch(() => undefined)
            .finally(() => queuedText--);
          return;
        }
      }
    },
    close() {
      abort.abort();
      hid.close();
      raw.end();
      latest.end();
    },
  };
}
