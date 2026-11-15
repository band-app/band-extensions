import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Settings of the desktop service. Band starts a worker service with an allowlisted environment (no
 * `BAND_*` variable reaches it), so the service reads `config.json` in its state dir
 * (`<worker state>/extension-state/desktop/main/config.json`) on every call.
 */
export interface DesktopConfig {
  /** Screen size and depth, `WIDTHxHEIGHTxDEPTH`. Default 1280x800x24. Applies to displays started after the change. */
  resolution: string;
  /** A display with no viewer and no program drawing on it is stopped after this many seconds. Default 1800. */
  idleSeconds: number;
  /** The browser `desktop_open_url` starts. Default: the first of chromium, chromium-browser, google-chrome that is installed. */
  browser?: string;
  /** Pass --no-sandbox to the browser. Default: true inside a container (`/.dockerenv`), else false. */
  noSandbox?: boolean;
}

const DEFAULTS: DesktopConfig = { resolution: "1280x800x24", idleSeconds: 1800 };

let stateDir: string | null = null;

export function setStateDir(dir: string): void {
  stateDir = dir;
}

export function getStateDir(): string {
  if (!stateDir) throw new Error("The desktop service has no state dir yet");
  return stateDir;
}

/** `1280x800x24` to its parts, or null when it is not that shape or is out of range. */
export function parseResolution(value: unknown): { width: number; height: number; depth: number } | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{3,4})x(\d{3,4})x(8|16|24|32)$/.exec(value);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 320 || width > 3840 || height < 240 || height > 2400) return null;
  return { width, height, depth: Number(m[3]) };
}

export function readConfig(): DesktopConfig {
  const out = { ...DEFAULTS };
  if (!stateDir) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8"));
  } catch {
    return out;
  }
  if (typeof raw !== "object" || raw === null) return out;
  const c = raw as Record<string, unknown>;
  if (parseResolution(c.resolution)) out.resolution = c.resolution as string;
  if (typeof c.idleSeconds === "number" && c.idleSeconds >= 1 && c.idleSeconds <= 7 * 86400) {
    out.idleSeconds = c.idleSeconds;
  }
  if (typeof c.browser === "string" && /^[A-Za-z0-9._/+-]+$/.test(c.browser)) out.browser = c.browser;
  if (typeof c.noSandbox === "boolean") out.noSandbox = c.noSandbox;
  return out;
}
