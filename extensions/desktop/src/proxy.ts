import type { Socket } from "node:net";
import { appleLogin, ByteReader, type Credentials } from "./ard.ts";

/** How a panel stream looks to the proxy. */
export interface PanelSide {
  /** Sends bytes to the panel's noVNC. */
  send(data: Uint8Array): void;
  /** Ends the stream. */
  end(): void;
}

export interface ProxyOptions {
  /** `hub` caps FramebufferUpdateRequests, `direct` forwards everything. */
  profile: "hub" | "direct";
  /** The shortest time between two FramebufferUpdateRequests sent on, for `hub`. */
  minRequestIntervalMs?: number;
  onClose?: () => void;
}

/** About 15 requests a second, the hub profile's cap. */
export const HUB_REQUEST_INTERVAL_MS = 1000 / 15;

/**
 * Cuts the client-to-server RFB stream into messages, to find FramebufferUpdateRequests. Other
 * messages go through at once and in order. A message type it does not know ends parsing: from then
 * on everything is forwarded as it comes, since its length is unknown.
 */
export class ClientMessages {
  private head: Buffer = Buffer.alloc(0);
  /** Bytes of the current message still to pass through unparsed. */
  private skip = 0;
  private raw = false;

  private readonly forward: (data: Buffer) => void;
  private readonly request: (message: Buffer) => void;

  constructor(forward: (data: Buffer) => void, request: (message: Buffer) => void) {
    this.forward = forward;
    this.request = request;
  }

  push(chunk: Buffer): void {
    if (this.raw) return this.forward(chunk);
    let data = this.head.length ? Buffer.concat([this.head, chunk]) : chunk;
    this.head = Buffer.alloc(0);
    while (data.length > 0) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, data.length);
        this.forward(data.subarray(0, n));
        this.skip -= n;
        data = data.subarray(n);
        continue;
      }
      const size = this.sizeOf(data);
      if (size === "unknown") {
        this.raw = true;
        return this.forward(data);
      }
      if (size === "more") {
        this.head = Buffer.from(data);
        return;
      }
      if (data[0] === 3) {
        if (data.length < size.total) {
          this.head = Buffer.from(data);
          return;
        }
        this.request(Buffer.from(data.subarray(0, size.total)));
        data = data.subarray(size.total);
      } else if (size.total <= data.length) {
        this.forward(data.subarray(0, size.total));
        data = data.subarray(size.total);
      } else {
        // A long message (ClientCutText): send what is here, the rest as it arrives.
        this.forward(data);
        this.skip = size.total - data.length;
        return;
      }
    }
  }

  private sizeOf(data: Buffer): { total: number } | "more" | "unknown" {
    switch (data[0]) {
      case 0:
        return { total: 20 };
      case 2:
        return data.length < 4 ? "more" : { total: 4 + 4 * data.readUInt16BE(2) };
      case 3:
        return { total: 10 };
      case 4:
        return { total: 8 };
      case 5:
        return { total: 6 };
      case 6:
        return data.length < 8 ? "more" : { total: 8 + data.readUInt32BE(4) };
      default:
        return "unknown";
    }
  }
}

/**
 * Bridges a panel's noVNC to the Mac's Screen Sharing server. The service logs in to the server
 * itself (Apple's login), and shows the panel a server with no authentication, so noVNC needs no
 * Apple login. After ServerInit, bytes pass through both ways.
 *
 * `upstream` must be connected but not read from. Returns the handlers for the panel's messages.
 */
export function bridgeToMac(
  upstream: Socket,
  creds: Credentials,
  panel: PanelSide,
  options: ProxyOptions,
): { onMessage(data: Uint8Array): void; onClose(): void } {
  const fromMac = new ByteReader();
  const fromPanel = new ByteReader();
  let closed = false;
  let passing = false;
  let lastRequest = 0;
  let pending: Buffer | null = null;
  let timer: NodeJS.Timeout | null = null;
  const interval = options.minRequestIntervalMs ?? HUB_REQUEST_INTERVAL_MS;

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    upstream.destroy();
    options.onClose?.();
    panel.end();
  };

  const toMac = (data: Buffer) => {
    if (!upstream.destroyed) upstream.write(data);
  };

  const sendPending = () => {
    timer = null;
    if (!pending || closed) return;
    lastRequest = Date.now();
    toMac(pending);
    pending = null;
  };

  const request = (message: Buffer) => {
    if (options.profile === "direct") return toMac(message);
    if (pending) {
      // Two waiting requests become one: the later area, and a full refresh if either asked for one.
      const incremental = pending[1] === 1 && message[1] === 1;
      pending = Buffer.from(message);
      pending[1] = incremental ? 1 : 0;
    } else {
      pending = Buffer.from(message);
    }
    const wait = lastRequest + interval - Date.now();
    if (wait <= 0) sendPending();
    else if (!timer) timer = setTimeout(sendPending, wait);
  };

  const messages = new ClientMessages(toMac, request);

  const refuse = (reason: string) => {
    // A failed handshake that noVNC shows: no security types, and the reason.
    const text = Buffer.from(reason, "utf8");
    const out = Buffer.alloc(5 + text.length);
    out[0] = 0;
    out.writeUInt32BE(text.length, 1);
    text.copy(out, 5);
    panel.send(out);
  };

  upstream.on("data", (chunk) => {
    if (passing) panel.send(chunk);
    else fromMac.push(chunk);
  });
  upstream.on("error", (err) => fromMac.fail(err));
  upstream.on("close", () => {
    fromMac.fail(new Error("the Mac closed the connection"));
    close();
  });

  void (async () => {
    // Log in to the Mac while the panel says its version.
    panel.send(Buffer.from("RFB 003.008\n", "ascii"));
    const login = appleLogin({ read: (n) => fromMac.read(n), write: toMac }, creds).then(
      () => undefined,
      (err: Error) => err,
    );
    await fromPanel.read(12); // the panel's version
    const failure = await login;
    if (failure) {
      refuse(failure.message);
      return close();
    }
    panel.send(Buffer.from([1, 1])); // one security type: None
    await fromPanel.read(1); // the panel picked it
    panel.send(Buffer.from([0, 0, 0, 0])); // SecurityResult: OK
    const clientInit = await fromPanel.read(1);
    toMac(clientInit);
    const head = await fromMac.read(24);
    const nameLength = head.readUInt32BE(20);
    const name = await fromMac.read(nameLength);
    panel.send(Buffer.concat([head, name]));
    passing = true;
    const rest = fromMac.takeRest();
    if (rest.length) panel.send(rest);
    const early = fromPanel.takeRest();
    if (early.length) messages.push(early);
  })().catch((err: Error) => {
    if (!closed) {
      try {
        refuse(err.message);
      } catch {
        // The panel is gone.
      }
    }
    close();
  });

  return {
    onMessage(data) {
      if (closed) return;
      const chunk = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (passing) messages.push(chunk);
      else fromPanel.push(chunk);
    },
    onClose: close,
  };
}
