import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Settings of the simulator service. Band starts a worker service with an allowlisted environment
 * (no `BAND_*` variable reaches it), so the bundled plugin's `BAND_SIMULATOR_*` variables cannot
 * be set from the worker's environment. The service reads `config.json` in its state dir
 * (`<worker state>/extension-state/simulator/main/config.json`) on every call instead. The
 * variables still work when the service runs outside a worker, which is how its tests run it.
 */
export interface SimulatorConfig {
  /** Replaces "Band" in every device name. Tests set their own, so they never match a person's devices. */
  namePrefix?: string;
  /** The most devices booted at once. Default 2. */
  maxBooted?: number;
  /** A simctl device type identifier for the base device. */
  deviceType?: string;
  /** A simctl runtime identifier or version for the base device. */
  runtime?: string;
  /** Another `serve-sim.js` than the one shipped in this extension. */
  serveSimEntry?: string;
}

let stateDir: string | null = null;

export function setStateDir(dir: string): void {
  stateDir = dir;
}

export function getStateDir(): string {
  if (!stateDir) throw new Error("The simulator service has no state dir yet");
  return stateDir;
}

function fromFile(): SimulatorConfig {
  if (!stateDir) return {};
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as SimulatorConfig) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** The current settings: `config.json` first, then the environment, read on every call. */
export function config(): Required<Pick<SimulatorConfig, "namePrefix" | "maxBooted">> &
  SimulatorConfig {
  const file = fromFile();
  const env = process.env;
  const maxFile = file.maxBooted;
  const maxEnv = Number(env.BAND_SIMULATOR_MAX_BOOTED);
  const max =
    typeof maxFile === "number" && Number.isInteger(maxFile) && maxFile >= 1
      ? maxFile
      : Number.isInteger(maxEnv) && maxEnv >= 1
        ? maxEnv
        : 2;
  return {
    namePrefix: text(file.namePrefix) ?? text(env.BAND_SIMULATOR_NAME_PREFIX) ?? "Band",
    maxBooted: max,
    deviceType: text(file.deviceType) ?? text(env.BAND_SIMULATOR_DEVICE_TYPE),
    runtime: text(file.runtime) ?? text(env.BAND_SIMULATOR_RUNTIME),
    serveSimEntry: text(file.serveSimEntry) ?? text(env.BAND_SERVE_SIM_ENTRY),
  };
}
