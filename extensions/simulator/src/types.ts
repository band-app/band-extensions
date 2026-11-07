import type { Platform } from "./layout.ts";
import type { DescribedElement } from "./servesim.ts";
import type { ScreenStream } from "./stream.ts";

export type { Platform };

/** One device the picker offers, from either platform. */
export interface SimDevice {
  /** "ios:<udid>", "android:avd:<name>" or "android:serial:<serial>". Stable across boots. */
  id: string;
  platform: Platform;
  name: string;
  state: "on" | "off" | "booting";
  /** The hardware model, such as "iPhone 17 Pro" or "Pixel 8", when known. */
  model?: string;
  /** The OS version shown beside the name: "iOS 26.5" or "Android 15". */
  os: string;
  /** Whether Band created it (its name starts with the prefix). */
  owned: boolean;
}

/** What the service tells the panel while a device is made ready. */
export type BootPhase = { phase: "booting"; name?: string; model?: string };
export type OnPhase = (phase: BootPhase) => void;

export interface Screen {
  width: number;
  height: number;
}

export interface Shot {
  data: Buffer;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  /** Pixels per tap unit: points on iOS, so 3 on current iPhones, and 1 on Android. */
  scale: number | null;
}

export interface DescribeResult {
  screen: Screen | null;
  elements: DescribedElement[];
}

export interface CreateSpec {
  [key: string]: unknown;
}

/** What one platform can do. The fleet picks the backend by `SimDevice.platform`. */
export interface Backend {
  readonly platform: Platform;
  /** Whether the platform's tools are installed. When false, `reason` says what to install. */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  list(): Promise<SimDevice[]>;
  maxBooted(): number;
  /** Boots the device and waits until it is ready. Does not make room: the fleet does. */
  boot(device: SimDevice, onPhase?: OnPhase): Promise<SimDevice>;
  shutdown(device: SimDevice): Promise<void>;
  /** The choices the "New ..." form offers. */
  options(): Promise<unknown>;
  create(spec: CreateSpec): Promise<SimDevice>;
  screen(device: SimDevice): Promise<Screen | null>;
  screenshot(device: SimDevice): Promise<Shot>;
  describe(device: SimDevice): Promise<DescribeResult>;
  tap(device: SimDevice, x: number, y: number): Promise<void>;
  type(device: SimDevice, text: string): Promise<void>;
  button(device: SimDevice, name: string): Promise<void>;
  openUrl(device: SimDevice, url: string): Promise<void>;
  /** Installs a build from a path the service already checked is inside the worktree. */
  install(device: SimDevice, path: string): Promise<void>;
  /** The file extension `install` takes: ".app" or ".apk". */
  readonly installExt: string;
  launch(device: SimDevice, id: string): Promise<string>;
  rotate(device: SimDevice, orientation: string): Promise<void>;
  /** The live screen. The device is booted. */
  openStream(device: SimDevice, params: unknown): Promise<ScreenStream>;
  /** Stops anything kept for a device (helpers, polling), after it shut down or the service stops. */
  release(device: SimDevice): Promise<void>;
  stopAll(): Promise<void>;
}
