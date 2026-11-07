// The Android backend. Boot, discovery, AVD creation and the uiautomator tree follow the approach
// of Orca's emulator code (github.com/stablyai/orca, src/main/emulator/android, MIT License,
// Copyright (c) 2026 Lovecast Inc.): `emulator -avd`, a wait for `sys.boot_completed`, adb for
// input and install, `uiautomator dump` for the accessibility tree. No Orca source is copied. The
// stream is deliberately simpler than Orca's scrcpy session: it polls `adb exec-out screencap`.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { config, getStateDir } from "./config.ts";
import { Latest, type ScreenStream, streamProfile } from "./stream.ts";
import { run, runBuffer } from "./tools.ts";
import type { Backend, CreateSpec, Screen, SimDevice } from "./types.ts";

const ANDROID_VERSIONS: Record<number, string> = {
  26: "8.0", 27: "8.1", 28: "9", 29: "10", 30: "11", 31: "12", 32: "12L", 33: "13", 34: "14", 35: "15", 36: "16",
};

/** "Android 14" from an API level, or "Android API 37" when the level is newer than this table. */
export function androidLabel(api: number): string {
  const v = ANDROID_VERSIONS[api];
  return v ? `Android ${v}` : `Android API ${api}`;
}

/** An AVD name allows letters, digits, dot, underscore and dash. The prefix is made to fit. */
export function avdPrefix(prefix: string): string {
  return `${prefix.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "Band"}-`;
}

/** "Pixel 8" from "pixel_8". */
export function profileLabel(id: string): string {
  const s = id.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string;
}

/** The rows of `adb devices -l`. */
export function parseAdbDevices(output: string): AdbDevice[] {
  const out: AdbDevice[] = [];
  for (const line of output.split("\n").slice(0)) {
    const m = /^(\S+)\s+(device|offline|unauthorized|authorizing|no permissions)\b(.*)$/.exec(line.trim());
    if (!m) continue;
    const model = /\bmodel:(\S+)/.exec(m[3] ?? "")?.[1];
    out.push({ serial: m[1] as string, state: m[2] as string, ...(model ? { model: model.replace(/_/g, " ") } : {}) });
  }
  return out;
}

/** The AVD's settings from its config.ini. */
export function parseAvdConfig(ini: string): { api?: number; model?: string; tag?: string } {
  const kv = new Map<string, string>();
  for (const line of ini.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) kv.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const sysdir = kv.get("image.sysdir.1") ?? "";
  const api = /android-(\d+)/.exec(sysdir)?.[1];
  const device = kv.get("hw.device.name");
  return {
    ...(api ? { api: Number(api) } : {}),
    ...(device ? { model: profileLabel(device) } : {}),
    ...(kv.get("tag.id") ? { tag: kv.get("tag.id") } : {}),
  };
}

/** Text for `adb shell input text`: spaces become %s and the shell sees it as one quoted word. */
export function inputTextArg(text: string): string {
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error("Only printable ASCII can be typed on Android");
  return `'${text.replace(/%/g, "%25").replace(/ /g, "%s").replace(/'/g, `'\\''`)}'`;
}

const KEYCODES: Record<string, number> = {
  HOME: 3,
  BACK: 4,
  APP_SWITCH: 187,
  LOCK: 26,
  SIDE_BUTTON: 26,
  Enter: 66,
  Backspace: 67,
  Tab: 61,
  Escape: 111,
};
export const ANDROID_BUTTONS = ["HOME", "BACK", "APP_SWITCH", "LOCK", "SIDE_BUTTON"];

export interface Sdk {
  adb: string | null;
  emulator: string | null;
  avdmanager: string | null;
  root: string | null;
}

function firstExisting(paths: string[]): string | null {
  return paths.find((p) => existsSync(p)) ?? null;
}

/** Finds the SDK's tools: the configured folder, ANDROID_HOME, the default install folders, then PATH. */
export function findSdk(): Sdk {
  const roots = [config().androidSdk, join(homedir(), "Library/Android/sdk"), join(homedir(), "Android/Sdk")].filter(
    (r): r is string => !!r && existsSync(r),
  );
  const root = roots[0] ?? null;
  const onPath = (bin: string): string | null => {
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (dir && existsSync(join(dir, bin))) return join(dir, bin);
    }
    return null;
  };
  const cmdline = (r: string) => {
    const dir = join(r, "cmdline-tools");
    const versions = existsSync(dir) ? readdirSync(dir).sort().reverse() : [];
    return versions.map((v) => join(dir, v, "bin", "avdmanager"));
  };
  return {
    root,
    adb: firstExisting(roots.map((r) => join(r, "platform-tools", "adb"))) ?? onPath("adb"),
    emulator: firstExisting(roots.map((r) => join(r, "emulator", "emulator"))) ?? onPath("emulator"),
    avdmanager:
      firstExisting([...roots.flatMap(cmdline), ...roots.map((r) => join(r, "tools/bin/avdmanager"))]) ??
      onPath("avdmanager"),
  };
}

/** The environment of SDK tools: no Band variable or credential, but the SDK and Java locations. */
function sdkEnv(sdk: Sdk): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "JAVA_HOME", "ANDROID_AVD_HOME", "ANDROID_USER_HOME"]) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  if (sdk.root) {
    env.ANDROID_HOME = sdk.root;
    env.ANDROID_SDK_ROOT = sdk.root;
  }
  return env;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const avdId = (name: string) => `android:avd:${name}`;
const serialId = (serial: string) => `android:serial:${serial}`;

interface Running {
  serial: string;
  /** The AVD it runs, for an emulator. */
  avd?: string;
  model?: string;
  booted: boolean;
}

export interface ImageOption {
  pkg: string;
  label: string;
}

export interface AndroidOptions {
  available: boolean;
  reason?: string;
  profiles: Array<{ id: string; name: string }>;
  images: ImageOption[];
  /** What to run when no system image is installed. */
  hint?: string;
}

const hostAbi = () => (process.arch === "arm64" ? "arm64-v8a" : "x86_64");

/** The system images installed in the SDK that can run on this machine. */
export function installedImages(root: string): ImageOption[] {
  const base = join(root, "system-images");
  const out: Array<ImageOption & { api: number }> = [];
  const dirs = (p: string) => (existsSync(p) ? readdirSync(p) : []);
  for (const platform of dirs(base)) {
    const api = /^android-(\d+)$/.exec(platform)?.[1];
    if (!api) continue;
    for (const tag of dirs(join(base, platform))) {
      if (/tv|wear|automotive|desktop/.test(tag)) continue;
      const abi = hostAbi();
      if (!existsSync(join(base, platform, tag, abi, "system.img"))) continue;
      out.push({
        pkg: `system-images;${platform};${tag};${abi}`,
        label: `${androidLabel(Number(api))}, ${tag.replace(/_/g, " ")}`,
        api: Number(api),
      });
    }
  }
  return out.sort((a, b) => b.api - a.api || a.pkg.localeCompare(b.pkg)).map(({ pkg, label }) => ({ pkg, label }));
}

/** Android emulators through the SDK's emulator and adb. A phone plugged into adb is listed too. */
export class AndroidBackend implements Backend {
  readonly platform = "android" as const;
  private readonly children = new Map<string, ChildProcess>();
  private readonly screens = new Set<{ close(): void }>();

  maxBooted() {
    return config().maxBootedAndroid;
  }

  async available() {
    const sdk = findSdk();
    if (!sdk.adb || !sdk.emulator) {
      return {
        ok: false as const,
        reason:
          "The Android SDK was not found. Install Android Studio or the command-line tools, then set ANDROID_HOME for the worker or \"androidSdk\" in the simulator's config.json.",
      };
    }
    return { ok: true as const };
  }

  private adbBin(): string {
    const sdk = findSdk();
    if (!sdk.adb) throw new Error("adb was not found. Install the Android SDK platform-tools.");
    return sdk.adb;
  }

  private adb(serial: string | null, args: string[], timeoutMs = 30_000) {
    return run(this.adbBin(), [...(serial ? ["-s", serial] : []), ...args], { timeoutMs, env: sdkEnv(findSdk()) });
  }

  private async adbDevices(): Promise<AdbDevice[]> {
    const { stdout } = await this.adb(null, ["devices", "-l"], 15_000);
    return parseAdbDevices(stdout).filter((d) => d.state === "device");
  }

  /** The emulators and phones adb sees, with the AVD each emulator runs and whether it finished booting. */
  private async running(): Promise<Running[]> {
    let devices: AdbDevice[];
    try {
      devices = await this.adbDevices();
    } catch {
      return [];
    }
    return Promise.all(
      devices.map(async (d): Promise<Running> => {
        const booted = await this.adb(d.serial, ["shell", "getprop", "sys.boot_completed"], 10_000)
          .then((r) => r.stdout.trim() === "1")
          .catch(() => false);
        if (!d.serial.startsWith("emulator-")) return { serial: d.serial, model: d.model, booted };
        const avd = await this.adb(d.serial, ["emu", "avd", "name"], 10_000)
          .then((r) => r.stdout.split(/\r?\n/)[0]?.trim() || undefined)
          .catch(() => undefined);
        return { serial: d.serial, avd, model: d.model, booted };
      }),
    );
  }

  private avdHome(): string {
    return process.env.ANDROID_AVD_HOME ?? join(homedir(), ".android", "avd");
  }

  async list(): Promise<SimDevice[]> {
    const sdk = findSdk();
    if (!sdk.adb) return [];
    const out: SimDevice[] = [];
    const running = await this.running();
    const owned = avdPrefix(config().namePrefix);
    let names: string[] = [];
    if (sdk.emulator) {
      try {
        const { stdout } = await run(sdk.emulator, ["-list-avds"], { timeoutMs: 20_000, env: sdkEnv(sdk) });
        names = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[A-Za-z0-9._-]+$/.test(l));
      } catch {
        names = [];
      }
    }
    for (const name of names) {
      let info: ReturnType<typeof parseAvdConfig> = {};
      try {
        info = parseAvdConfig(readFileSync(join(this.avdHome(), `${name}.avd`, "config.ini"), "utf8"));
      } catch {
        // An AVD without a readable config is still listed.
      }
      const live = running.find((r) => r.avd === name);
      out.push({
        id: avdId(name),
        platform: "android",
        name,
        state: live ? (live.booted ? "on" : "booting") : "off",
        ...(live ? { serial: live.serial } : {}),
        model: info.model,
        os: info.api ? androidLabel(info.api) : "Android",
        owned: name.startsWith(owned),
      });
    }
    for (const r of running) {
      if (r.serial.startsWith("emulator-")) continue;
      out.push({
        id: serialId(r.serial),
        serial: r.serial,
        platform: "android",
        name: r.model ?? r.serial,
        state: r.booted ? "on" : "booting",
        model: r.model,
        os: "Android",
        owned: false,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The adb serial of a device that is on. */
  private async serialOf(device: SimDevice): Promise<string> {
    if (device.id.startsWith("android:serial:")) return device.id.slice("android:serial:".length);
    const name = device.id.slice("android:avd:".length);
    const live = (await this.running()).find((r) => r.avd === name);
    if (!live) throw new Error(`${device.name} is not running`);
    return live.serial;
  }

  async boot(device: SimDevice, onPhase?: Parameters<Backend["boot"]>[1]): Promise<SimDevice> {
    if (device.id.startsWith("android:serial:")) return { ...device, state: "on" };
    const sdk = findSdk();
    if (!sdk.emulator) throw new Error("The Android emulator was not found. Install it with the SDK Manager.");
    const name = device.id.slice("android:avd:".length);
    onPhase?.({ phase: "booting", name: device.name, model: device.model });
    if (!(await this.running()).some((r) => r.avd === name)) {
      const dir = join(getStateDir(), "android");
      await mkdir(dir, { recursive: true });
      const logPath = join(dir, `${name}.log`);
      const log = await open(logPath, "a");
      const child = spawn(
        sdk.emulator,
        ["-avd", name, "-no-window", "-no-audio", "-no-snapshot-save", "-no-boot-anim"],
        { detached: true, stdio: ["ignore", log.fd, log.fd], env: sdkEnv(sdk) },
      );
      await log.close();
      let exited: string | null = null;
      child.on("exit", (code) => {
        exited = `the emulator exited with code ${code}`;
        this.children.delete(name);
      });
      child.on("error", (err) => (exited = err.message));
      child.unref();
      this.children.set(name, child);
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        if (exited) {
          const tail = (await readFile(logPath, "utf8").catch(() => "")).trim().split("\n").slice(-3).join(" ");
          throw new Error(`${name} did not start: ${exited}${tail ? `. ${tail}` : ""}`);
        }
        const live = (await this.running()).find((r) => r.avd === name);
        if (live?.booted) break;
        if (Date.now() > deadline) throw new Error(`${name} did not finish booting in 5 minutes`);
        await sleep(2000);
      }
    } else {
      const deadline = Date.now() + 5 * 60_000;
      while (!(await this.running()).some((r) => r.avd === name && r.booted)) {
        if (Date.now() > deadline) throw new Error(`${name} did not finish booting in 5 minutes`);
        await sleep(2000);
      }
    }
    return { ...device, state: "on" };
  }

  async shutdown(device: SimDevice) {
    if (device.id.startsWith("android:serial:")) throw new Error("Band does not turn off a phone; unplug it or use the phone");
    await this.release(device);
    const name = device.id.slice("android:avd:".length);
    const live = (await this.running()).find((r) => r.avd === name);
    if (!live) return;
    await this.adb(live.serial, ["emu", "kill"], 15_000).catch(() => undefined);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!(await this.running()).some((r) => r.avd === name)) return;
      await sleep(1000);
    }
    this.children.get(name)?.kill("SIGTERM");
  }

  async options(): Promise<AndroidOptions> {
    const sdk = findSdk();
    const avail = await this.available();
    if (!avail.ok || !sdk.root) {
      return { available: false, reason: avail.ok ? "The Android SDK folder was not found." : avail.reason, profiles: [], images: [] };
    }
    const images = installedImages(sdk.root);
    const abi = hostAbi();
    let profiles: AndroidOptions["profiles"] = [];
    if (sdk.avdmanager) {
      try {
        const { stdout } = await run(sdk.avdmanager, ["list", "device", "-c"], { timeoutMs: 60_000, env: sdkEnv(sdk) });
        profiles = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((id) => /^[A-Za-z0-9_.-]+$/.test(id) && !/^(tv_|wear_|automotive_|desktop_|Galaxy|Nexus_)/i.test(id))
          .map((id) => ({ id, name: profileLabel(id) }));
      } catch {
        profiles = [];
      }
    }
    const reason = !sdk.avdmanager
      ? 'avdmanager was not found. Install "Android SDK Command-line Tools" in the SDK Manager.'
      : images.length === 0
        ? `No Android system image is installed. Install one first, for example: sdkmanager "system-images;android-35;google_apis;${abi}"`
        : undefined;
    return {
      available: true,
      ...(reason ? { reason } : {}),
      profiles,
      images,
      ...(images.length === 0 ? { hint: `sdkmanager "system-images;android-35;google_apis;${abi}"` } : {}),
    };
  }

  async create(spec: CreateSpec): Promise<SimDevice> {
    const sdk = findSdk();
    const options = await this.options();
    if (options.reason || !sdk.avdmanager) throw new Error(options.reason ?? "avdmanager was not found");
    const profile = options.profiles.find((p) => p.id === spec.profile);
    if (!profile) throw new Error("profile must be one of the device profiles the picker lists");
    const image = options.images.find((i) => i.pkg === spec.image);
    if (!image) throw new Error("image must be one of the installed system images the picker lists");
    const taken = new Set((await this.list()).map((d) => d.name));
    const base = `${avdPrefix(config().namePrefix)}${profile.id}`;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    await run(sdk.avdmanager, ["create", "avd", "-n", name, "-k", image.pkg, "-d", profile.id], {
      timeoutMs: 120_000,
      env: sdkEnv(sdk),
      stdin: "no\n",
    });
    const api = Number(/android-(\d+)/.exec(image.pkg)?.[1]);
    return {
      id: avdId(name),
      platform: "android",
      name,
      state: "off",
      model: profile.name,
      os: Number.isFinite(api) ? androidLabel(api) : "Android",
      owned: true,
    };
  }

  async screen(device: SimDevice): Promise<Screen | null> {
    try {
      return this.sizeOf(await this.serialOf(device));
    } catch {
      return null;
    }
  }

  private async sizeOf(serial: string): Promise<Screen | null> {
    const { stdout } = await this.adb(serial, ["shell", "wm", "size"], 10_000);
    const m = /Override size:\s*(\d+)x(\d+)/.exec(stdout) ?? /Physical size:\s*(\d+)x(\d+)/.exec(stdout);
    if (!m) return null;
    const [w, h] = [Number(m[1]), Number(m[2])];
    // `wm size` is the natural orientation; the screen may be turned.
    const rotation = await this.adb(serial, ["shell", "settings", "get", "system", "user_rotation"], 10_000)
      .then((r) => Number(r.stdout.trim()))
      .catch(() => 0);
    return rotation === 1 || rotation === 3 ? { width: h, height: w } : { width: w, height: h };
  }

  private png(serial: string): Promise<Buffer> {
    return runBuffer(this.adbBin(), ["-s", serial, "exec-out", "screencap", "-p"], {
      timeoutMs: 20_000,
      env: sdkEnv(findSdk()),
    });
  }

  async rotate(device: SimDevice, orientation: string) {
    if (orientation !== "portrait" && orientation !== "landscape_left") {
      throw new Error("orientation must be one of portrait, landscape_left");
    }
    const serial = await this.serialOf(device);
    await this.adb(serial, ["shell", "settings", "put", "system", "accelerometer_rotation", "0"], 10_000);
    await this.adb(serial, ["shell", "settings", "put", "system", "user_rotation", orientation === "portrait" ? "0" : "1"], 10_000);
  }

  async openStream(device: SimDevice, params: unknown): Promise<ScreenStream> {
    const serial = await this.serialOf(device);
    const stream = new ScreencapStream(
      (a) => this.adb(serial, a, 15_000).then(() => undefined),
      () => this.png(serial),
      streamProfile(params),
      { udid: device.id, name: device.name, model: device.model, platform: "android" },
      () => this.sizeOf(serial),
    );
    this.screens.add(stream);
    const close = stream.close.bind(stream);
    stream.close = () => {
      this.screens.delete(stream);
      close();
    };
    return stream;
  }

  async release(_device: SimDevice) {
    // Nothing is kept per device: each stream polls on its own and stops with its viewer.
  }

  async stopAll() {
    for (const s of this.screens) s.close();
    this.screens.clear();
    for (const child of this.children.values()) child.kill("SIGTERM");
    this.children.clear();
  }
}

/** A PNG as a JPEG with `sips` (macOS, the only system the simulator service runs on), scaled by `scale`. */
export async function toJpeg(png: Buffer, scale: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "band-sim-png-"));
  try {
    const input = join(dir, "in.png");
    const output = join(dir, "out.jpg");
    await writeFile(input, png);
    const args = ["-s", "format", "jpeg", "-s", "formatOptions", "75"];
    if (scale < 1) {
      args.push("-z", String(Math.max(1, Math.floor(png.readUInt32BE(20) * scale))), String(Math.max(1, Math.floor(png.readUInt32BE(16) * scale))));
    }
    await new Promise<void>((resolve, reject) =>
      execFile("/usr/bin/sips", [...args, input, "--out", output], { timeout: 10_000 }, (err) => (err ? reject(err) : resolve())),
    );
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Frame period of the Android stream: `screencap` itself takes 150 to 300 ms. */
const FRAME_MS = 200;
const HUB_SCALE = 0.5;

/**
 * The live screen of an Android device: `adb exec-out screencap -p` in a loop, each PNG turned
 * into a JPEG, and the viewer's touches, keys and text sent back with `adb shell input`. This
 * reaches about 3 to 5 frames a second, where scrcpy's H.264 stream would reach 30 or more.
 */
export class ScreencapStream implements ScreenStream {
  readonly output: AsyncIterable<string | Uint8Array>;
  private readonly latest = new Latest<Buffer>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private press: { x: number; y: number; at: number; lx: number; ly: number } | null = null;
  private size: Screen | null = null;

  private readonly shell: (args: string[]) => Promise<void>;
  private readonly shot: () => Promise<Buffer>;
  private readonly profile: "hub" | "direct";

  constructor(
    shell: (args: string[]) => Promise<void>,
    shot: () => Promise<Buffer>,
    profile: "hub" | "direct",
    info: { udid: string; name: string; model?: string; platform: string },
    sizeOf: () => Promise<Screen | null>,
  ) {
    this.shell = shell;
    this.shot = shot;
    this.profile = profile;
    const latest = this.latest;
    this.output = (async function* () {
      const size = await sizeOf().catch(() => null);
      yield JSON.stringify({ type: "info", ...info, width: size?.width ?? 0, height: size?.height ?? 0 });
      yield* latest;
    })();
    void this.poll();
  }

  private async poll(): Promise<void> {
    let failures = 0;
    while (!this.closed) {
      const started = Date.now();
      try {
        const png = await this.shot();
        this.size = { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
        const jpeg = await toJpeg(png, this.profile === "hub" ? HUB_SCALE : 1);
        if (!this.closed) this.latest.push(jpeg);
        failures = 0;
      } catch {
        // A device that stops answering ends the stream, and the viewer reconnects.
        if (++failures >= 5) break;
      }
      await sleep(Math.max(0, FRAME_MS - (Date.now() - started)));
    }
    this.latest.end();
  }

  private input(args: string[]): void {
    if (this.queued >= 20) return;
    this.queued++;
    this.queue = this.queue.then(() => this.shell(["shell", "input", ...args])).catch(() => undefined).finally(() => this.queued--);
  }

  write(message: string | Uint8Array): void {
    if (typeof message !== "string") return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }
    const unit = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
    switch (msg.type) {
      case "touch": {
        const x = unit(msg.x);
        const y = unit(msg.y);
        if (x === null || y === null || !this.size) return;
        const px = x * this.size.width;
        const py = y * this.size.height;
        if (msg.phase === "begin") this.press = { x: px, y: py, at: Date.now(), lx: px, ly: py };
        else if (msg.phase === "move" && this.press) {
          this.press.lx = px;
          this.press.ly = py;
        } else if (msg.phase === "end" && this.press) {
          const p = this.press;
          this.press = null;
          const moved = Math.hypot(px - p.x, py - p.y);
          const r = Math.round;
          if (moved < 12) this.input(["tap", String(r(p.x)), String(r(p.y))]);
          else {
            const ms = Math.min(2000, Math.max(100, Date.now() - p.at));
            this.input(["swipe", String(r(p.x)), String(r(p.y)), String(r(px)), String(r(py)), String(ms)]);
          }
        }
        return;
      }
      case "button": {
        const name = typeof msg.name === "string" ? msg.name : "";
        if (ANDROID_BUTTONS.includes(name)) this.input(["keyevent", String(KEYCODES[name])]);
        return;
      }
      case "key": {
        const code = typeof msg.key === "string" ? KEYCODES[msg.key] : undefined;
        if (code !== undefined) this.input(["keyevent", String(code)]);
        return;
      }
      case "text": {
        const text = msg.text;
        if (typeof text !== "string" || text === "" || text.length > 1000) return;
        try {
          this.input(["text", inputTextArg(text)]);
        } catch {
          // A character `input text` cannot type is dropped.
        }
        return;
      }
    }
  }

  close(): void {
    this.closed = true;
    this.latest.end();
  }
}
