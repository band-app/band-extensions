import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Credentials } from "./ard.ts";
import { readConfig } from "./config.ts";
import { bridgeToMac, type PanelSide } from "./proxy.ts";
import { type RfbClient, sleep, withRfb } from "./rfb.ts";

/** macOS Screen Sharing listens here. */
export const SCREEN_SHARING_PORT = 5900;
const DEFAULT_PASSWORD_FILE = "~/.band/screen-password";
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

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

export function passwordFilePath(): string {
  return expandHome(readConfig().macos?.passwordFile ?? DEFAULT_PASSWORD_FILE);
}

/** The line to show when the session cannot be reached, naming the file and what Screen Sharing needs. */
export function setupMessage(cause: string): string {
  const file = readConfig().macos?.passwordFile ?? DEFAULT_PASSWORD_FILE;
  return (
    `Desktop cannot open the Mac session of ${macUser()}: ${cause}. ` +
    `It needs ${macUser()}'s password in ${file} (set macos.passwordFile in the Desktop config.json to use another file), ` +
    `and Screen Sharing turned on in System Settings > General > Sharing, with ${macUser()} allowed.`
  );
}

/** The login for the worker's own user, from the password file. */
export function readCredentials(): Credentials {
  let raw: string;
  try {
    raw = readFileSync(passwordFilePath(), "utf8");
  } catch {
    throw new MacError(setupMessage("the password file is missing or unreadable"));
  }
  const password = raw.replace(/\r?\n$/, "");
  if (password === "") throw new MacError(setupMessage("the password file is empty"));
  return { user: macUser(), password };
}

/** Turns a connection or login failure into the message for the person. Never includes the password. */
export function explain(err: unknown): MacError {
  if (err instanceof MacError) return err;
  const message = err instanceof Error ? err.message : String(err);
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

/** A panel stream: unlock if needed, log in to Screen Sharing, then bridge. */
export async function openStream(
  profile: "hub" | "direct",
  panel: PanelSide,
  port = SCREEN_SHARING_PORT,
): Promise<{ onMessage(data: Uint8Array): void; onClose(): void }> {
  let creds: Credentials;
  try {
    creds = readCredentials();
    await ensureUnlocked(creds, port);
  } catch (err) {
    return refuseStream(explain(err).message, panel);
  }
  const socket = connect({ host: "127.0.0.1", port });
  socket.setNoDelay(true);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
  } catch (err) {
    socket.destroy();
    return refuseStream(explain(err).message, panel);
  }
  viewers += 1;
  let counted = true;
  return bridgeToMac(socket, creds, panel, {
    profile,
    onClose() {
      if (counted) viewers = Math.max(0, viewers - 1);
      counted = false;
    },
  });
}

/** Tells the panel why, in a way noVNC shows: a version, then a handshake with no security types and a reason. */
function refuseStream(reason: string, panel: PanelSide): { onMessage(data: Uint8Array): void; onClose(): void } {
  let sent = false;
  panel.send(Buffer.from("RFB 003.008\n", "ascii"));
  const text = Buffer.from(reason, "utf8");
  const failure = Buffer.alloc(5 + text.length);
  failure.writeUInt32BE(text.length, 1);
  text.copy(failure, 5);
  return {
    onMessage() {
      if (sent) return;
      sent = true;
      panel.send(failure);
      panel.end();
    },
    onClose() {},
  };
}
