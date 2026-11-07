import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import zlib from "node:zlib";

// Stand-ins for adb, emulator and avdmanager are scripts on disk that keep their state in JSON
// files, so tests run without an Android SDK and nothing touches a real device.

export function script(path, body) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!${process.execPath}\n${body}`);
  chmodSync(path, 0o755);
}

/** A real 100x200 PNG, so sips can turn it into a JPEG. */
export function png() {
  const crc = (buf) => {
    let c;
    let crcv = 0xffffffff;
    for (const b of buf) {
      c = (crcv ^ b) & 0xff;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcv = (crcv >>> 8) ^ c;
    }
    return (crcv ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(100, 0);
  ihdr.writeUInt32BE(200, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 200 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(300, 120)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Builds a fake SDK under `dir`: adb, emulator and avdmanager that share one state file, one AVD
 * folder and one log of the commands that reached a device. Returns their paths.
 */
export function makeAndroidSdk(dir, avds = ["Pixel_8"]) {
  mkdirSync(dir, { recursive: true });
  const sdk = join(dir, "sdk");
  const avdHome = join(dir, "avd");
  const stateFile = join(dir, "android-state.json");
  const logFile = join(dir, "adb.log");
  const pngFile = join(dir, "screen.png");
  writeFileSync(pngFile, png());
  writeFileSync(stateFile, "[]");
  writeFileSync(logFile, "");
  for (const name of avds) {
    mkdirSync(join(avdHome, name + ".avd"), { recursive: true });
    writeFileSync(join(avdHome, name + ".avd", "config.ini"), "hw.device.name=pixel_8\nimage.sysdir.1=system-images/android-35/google_apis/arm64-v8a/\n");
  }
  // Only arm64 hosts are asked for arm64 images; the stand-in offers the host's.
  const abi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
  mkdirSync(join(sdk, "system-images", "android-35", "google_apis", abi), { recursive: true });
  writeFileSync(join(sdk, "system-images", "android-35", "google_apis", abi, "system.img"), "");
  const common = `const fs = require("node:fs");
const state = () => JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const save = (s) => fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify(s));
const log = (...a) => fs.appendFileSync(${JSON.stringify(logFile)}, a.join(" ") + "\\n");
`;
  script(
    join(sdk, "platform-tools", "adb"),
    `${common}
let args = process.argv.slice(2);
let serial = null;
if (args[0] === "-s") { serial = args[1]; args = args.slice(2); }
const key = args.join(" ");
if (key === "devices -l") {
  console.log("List of devices attached");
  for (const e of state()) console.log(e.serial + "          device product:sdk model:sdk_gphone transport_id:1");
} else if (key === "emu avd name") console.log(state().find((e) => e.serial === serial).avd + "\\nOK");
else if (key === "emu kill") save(state().filter((e) => e.serial !== serial));
else if (key === "shell getprop sys.boot_completed") console.log("1");
else if (key === "shell wm size") console.log("Physical size: 1080x2400");
else if (key === "shell settings get system user_rotation") console.log("0");
else if (key === "exec-out screencap -p") process.stdout.write(fs.readFileSync(${JSON.stringify(pngFile)}));
else if (key === "exec-out uiautomator dump /dev/tty") console.log('<?xml version="1.0"?><hierarchy rotation="0"><node text="" class="android.widget.FrameLayout" clickable="false" enabled="true" bounds="[0,0][1080,2400]"><node text="OK" resource-id="a:id/ok" class="android.widget.Button" content-desc="" clickable="true" enabled="true" bounds="[0,0][200,100]" /></node></hierarchy>\\nUI hierchary dumped to: /dev/tty');
else { log(serial, key); }
`,
  );
  script(
    join(sdk, "emulator", "emulator"),
    `${common}
const args = process.argv.slice(2);
if (args[0] === "-list-avds") { for (const f of fs.readdirSync(${JSON.stringify(avdHome)})) if (f.endsWith(".avd")) console.log(f.slice(0, -4)); process.exit(0); }
const avd = args[args.indexOf("-avd") + 1];
log("emulator", args.join(" "));
const serial = "emulator-" + (5554 + 2 * state().length);
setTimeout(() => save([...state(), { serial, avd }]), 300);
const t = setInterval(() => { if (!fs.existsSync(${JSON.stringify(stateFile)}) || (!state().some((e) => e.avd === avd) && Date.now() > start + 2000)) process.exit(0); }, 200);
const start = Date.now();
`,
  );
  script(
    join(sdk, "cmdline-tools", "latest", "bin", "avdmanager"),
    `${common}
const args = process.argv.slice(2);
if (args[0] === "list") { console.log("pixel_8\\npixel_6a\\ntv_1080p\\nwear_round\\nNexus_5"); process.exit(0); }
const val = (f) => args[args.indexOf(f) + 1];
const name = val("-n"); const pkg = val("-k");
const d = ${JSON.stringify(avdHome)} + "/" + name + ".avd";
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(d + "/config.ini", "hw.device.name=" + val("-d") + "\\nimage.sysdir.1=" + pkg.split(";").join("/") + "/\\n");
log("avdmanager", args.join(" "));
`,
  );
  return { sdk, avdHome, stateFile, logFile, pngFile };
}
