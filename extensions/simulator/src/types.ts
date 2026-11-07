import type { Platform } from "./layout.ts";
import type { ScreenStream } from "./stream.ts";

export type { Platform };

/** One device the picker offers, from either platform. */
export interface SimDevice {
  /** "ios:<udid>", "android:avd:<name>" or "android:serial:<serial>". Stable across boots. */
  id: string;
  platform: Platform;
  name: string;
  /**
   * "booting" and "stopping" are transitions: such a device neither counts toward the booted limit
   * nor is picked to be shut down, and it cannot be streamed yet.
   */
  state: "on" | "off" | "booting" | "stopping";
  /** The adb serial of a running Android device, such as "emulator-5554". */
  serial?: string;
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
  rotate(device: SimDevice, orientation: string): Promise<void>;
  /** The live screen. The device is booted. */
  openStream(device: SimDevice, params: unknown): Promise<ScreenStream>;
  /** Stops anything kept for a device (helpers, polling), after it shut down or the service stops. */
  release(device: SimDevice): Promise<void>;
  stopAll(): Promise<void>;
}
