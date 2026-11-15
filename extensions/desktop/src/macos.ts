import { execFile, spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { userInfo } from "node:os";
import { appleLogin, ByteReader, type Credentials, LoginRefusedError } from "./ard.ts";
import { bridgeToMac, type PanelSide } from "./proxy.ts";
import { type RfbClient, sleep, withRfb } from "./rfb.ts";

/** macOS Screen Sharing listens here. */
export const SCREEN_SHARING_PORT = 5900;
const IOREG = "/usr/sbin/ioreg";
const PLUTIL = "/usr/bin/plutil";
const OPEN = "/usr/bin/open";
/** After a failed unlock, the next attempt waits this long, so a lock screen it cannot pass is not retried in a loop. */
const UNLOCK_RETRY_MS = 60_000;

/** An error whose message goes to the person or the agent as it is. */
export class MacError extends Error {}

export function macUser(): string {
  return process.env.USER || userInfo().username;
}

/** The line to show when the session cannot be reached, naming what Screen Sharing needs. */
export function setupMessage(cause: string): string {
  return (
    `Desktop cannot open the Mac session of ${macUser()}: ${cause}. ` +
    `It needs Screen Sharing turned on in System Settings > General > Sharing, with ${macUser()} allowed.`
  );
}

/** The worker user's password as a viewer typed it. Memory only: it is never written anywhere. */
let signedIn: string | null = null;

/** The message of a tool or status call when no viewer has signed in. */
export function signInMessage(reason = ""): string {
  const user = macUser();
  return (
    `sign-in needed: open the Desktop tab on this worktree and sign in as ${user}` +
    (reason ? ` (${reason})` : "")
  );
}

/** The login for the worker's own user, from the password a viewer gave. */
export function readCredentials(): Credentials {
  if (signedIn === null) throw new MacError(signInMessage());
  return { user: macUser(), password: signedIn };
}

/** Forgets the password, for tests and for a password the Mac no longer accepts. */
export function signOut(): void {
  signedIn = null;
}

/** Turns a connection or login failure into the message for the person. Never includes the password. */
export function explain(err: unknown): MacError {
  if (err instanceof MacError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof LoginRefusedError) {
    signedIn = null;
    return new MacError(signInMessage(err.message));
  }
  if (/ECONNREFUSED|ECONNRESET|EPIPE/.test(message)) return new MacError(setupMessage("Screen Sharing is not answering on 127.0.0.1:5900"));
  return new MacError(setupMessage(message));
}

function run(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Whether `user`'s session shows its lock screen. ioreg sets the flag on that user's entry only while locked. */
export async function isLocked(user: string): Promise<boolean> {
  try {
    const plist = await run(IOREG, ["-n", "Root", "-d1", "-a"]);
    const json = await run(PLUTIL, ["-extract", "IOConsoleUsers", "json", "-o", "-", "-"], plist);
    return lockedIn(JSON.parse(json), user);
  } catch {
    return false;
  }
}

export function lockedIn(sessions: unknown, user: string): boolean {
  return (
    Array.isArray(sessions) &&
    sessions.some(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        (s as Record<string, unknown>).kCGSSessionUserNameKey === user &&
        (s as Record<string, unknown>).CGSSessionScreenIsLocked === true,
    )
  );
}

const SHIFT = 0xffe1;
const RETURN = 0xff0d;
const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?');

/** Apple's server needs Shift held for capitals and shifted symbols (US layout). */
export async function typeApple(c: RfbClient, keysyms: number[]): Promise<void> {
  for (const sym of keysyms) {
    const ch = sym < 0x80 ? String.fromCharCode(sym) : "";
    const shift = ch !== "" && (ch !== ch.toLowerCase() || SHIFTED.has(ch));
    if (shift) c.key(SHIFT, true);
    c.key(sym, true);
    await sleep(6);
    c.key(sym, false);
    if (shift) c.key(SHIFT, false);
    await sleep(6);
  }
  await c.barrier();
}

let unlockFailedAt = 0;
let unlocking: Promise<void> | null = null;

/** What the last unlock attempt found, for `status`. */
export let lockNote = "";

/**
 * When the user's session is locked, types the password into the lock screen. Does nothing for an
 * unlocked session, so the password is never typed anywhere else. If the session is still locked
 * afterwards (the lock screen may show a list of users), it says so and waits before it tries again.
 */
export function ensureUnlocked(creds: Credentials, port = SCREEN_SHARING_PORT): Promise<void> {
  unlocking ??= unlock(creds, port).finally(() => {
    unlocking = null;
  });
  return unlocking;
}

async function unlock(creds: Credentials, port: number): Promise<void> {
  if (!(await isLocked(creds.user))) {
    lockNote = "";
    return;
  }
  if (Date.now() - unlockFailedAt < UNLOCK_RETRY_MS) throw new MacError(lockNote);
  await withRfb(
    port,
    async (c) => {
      // A Shift tap wakes a dimmed lock screen without moving focus off the password field.
      c.key(SHIFT, true);
      c.key(SHIFT, false);
      await sleep(1500);
      await typeApple(c, [...creds.password].map((ch) => ch.charCodeAt(0)));
      c.key(RETURN, true);
      c.key(RETURN, false);
      await c.barrier();
    },
    creds,
  );
  for (let i = 0; i < 6; i++) {
    if (!(await isLocked(creds.user))) {
      lockNote = "";
      return;
    }
    await sleep(1000);
  }
  unlockFailedAt = Date.now();
  lockNote =
    `The Mac session of ${creds.user} is locked and typing the password did not unlock it. ` +
    "If the lock screen shows a list of users, choose the user there once. Desktop retries in a minute.";
  throw new MacError(lockNote);
}

/** Credentials, then unlock, then `fn` on a logged-in client. Errors carry the setup message. */
export async function withSession<T>(fn: (c: RfbClient) => Promise<T>, port = SCREEN_SHARING_PORT): Promise<T> {
  const creds = readCredentials();
  try {
    await ensureUnlocked(creds, port);
    return await withRfb(port, fn, creds);
  } catch (err) {
    throw explain(err);
  }
}

let viewers = 0;

/** What `desktop_status` answers: the session's size, or the message that says what to set up. */
export async function status(port = SCREEN_SHARING_PORT): Promise<Record<string, unknown>> {
  const user = macUser();
  try {
    const size = await withSession(async (c) => ({ width: c.width, height: c.height }), port);
    return { platform: "macos", user, ...size, viewers, locked: false };
  } catch (err) {
    return { platform: "macos", user, viewers, error: explain(err).message };
  }
}

/** Opens a URL in the user's session. */
export function openUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(OPEN, [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`open exited with code ${code}`))));
  });
}

/** A panel stream as the service sees it: bytes for noVNC, and text messages for the panel itself. */
export interface StreamSide extends PanelSide {
  notify(message: Record<string, unknown>): void;
}

let workerId = "";

/** The worker's id, which the panel uses to name the saved password. */
export function setWorker(id: string): void {
  workerId = id;
}

/**
 * Connects to Screen Sharing and logs in. Returns the socket paused, logged in and waiting for
 * ClientInit. A login the Mac refuses, or a Mac that closes during the login, is a LoginRefusedError.
 */
export async function loginSocket(port: number, creds: Credentials): Promise<Socket> {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const reader = new ByteReader();
    const onData = (chunk: Buffer) => reader.push(chunk);
    const onError = (err: Error) => reader.fail(err);
    const onClose = () => reader.fail(new Error("the Mac closed the connection during the login"));
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    try {
      await appleLogin({ read: (n) => reader.read(n), write: (d) => void socket.write(d) }, creds);
    } catch (err) {
      if (err instanceof Error && err.message === "the Mac closed the connection during the login") {
        throw new LoginRefusedError(creds.user, "the Mac closed the connection during the login");
      }
      throw err;
    }
    socket.off("data", onData);
    socket.off("close", onClose);
    socket.pause();
    const rest = reader.takeRest();
    if (rest.length) socket.unshift(rest);
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/**
 * A panel stream. The panel supplies the password: the service sends `need-password` and waits for
 * `password`. With a password in memory (a viewer signed in before) it logs in at once. A refused
 * login asks again with the Mac's reason. After the login it sends `signed-in` and bridges the
 * panel's noVNC to the Mac. Any other failure goes to the panel as an `error` message.
 */
export function openStream(
  profile: "hub" | "direct",
  panel: StreamSide,
  port = SCREEN_SHARING_PORT,
): { onMessage(data: string | Uint8Array): void; onClose(): void } {
  let closed = false;
  let bridge: { onMessage(data: Uint8Array): void; onClose(): void } | null = null;
  let waiting: ((password: string | null) => void) | null = null;

  const ask = (reason: string) =>
    new Promise<string | null>((resolve) => {
      waiting = resolve;
      panel.notify({ type: "need-password", user: macUser(), worker: workerId, reason });
    });

  void (async () => {
    let reason = "";
    for (;;) {
      let password = signedIn;
      if (password === null) {
        password = await ask(reason);
        if (password === null) return;
      }
      if (password === "" || Buffer.byteLength(password) > 63) {
        reason = password === "" ? "the password is empty" : "the Mac login carries at most 63 bytes of password";
        signedIn = null;
        continue;
      }
      const creds = { user: macUser(), password };
      try {
        await ensureUnlocked(creds, port);
        const socket = await loginSocket(port, creds);
        if (closed) {
          socket.destroy();
          return;
        }
        signedIn = password;
        viewers += 1;
        let counted = true;
        panel.notify({ type: "signed-in" });
        bridge = bridgeToMac(socket, panel, {
          profile,
          onClose() {
            if (counted) viewers = Math.max(0, viewers - 1);
            counted = false;
          },
        });
        return;
      } catch (err) {
        if (closed) return;
        if (err instanceof LoginRefusedError) {
          signedIn = null;
          reason = err.message;
          continue;
        }
        panel.fail(explain(err).message);
        panel.end();
        return;
      }
    }
  })().catch((err) => {
    if (closed) return;
    panel.fail(explain(err).message);
    panel.end();
  });

  return {
    onMessage(data) {
      if (typeof data === "string") {
        let message: unknown;
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        const m = message as { type?: unknown; password?: unknown };
        if (m && m.type === "password" && typeof m.password === "string" && waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(m.password);
        }
        return;
      }
      bridge?.onMessage(data);
    },
    onClose() {
      closed = true;
      waiting?.(null);
      waiting = null;
      bridge?.onClose();
    },
  };
}
