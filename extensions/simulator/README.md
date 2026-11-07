# Simulator

iOS simulators and Android emulators on a Mac worker, as a Band extension. A person watches and controls them in a Simulator tab opened from the center "+" menu: a canvas of up to 4 panes, each showing one device. Agents and scripts run their apps with their own tools and show the device they used with `simulator_show`. This is the `simulator` plugin that Band used to bundle (`plugins/simulator`), moved onto Band's extension API: a worker service (`service.mjs`), a panel (`panel.html`) and tools declared in `band-extension.json`. Capture and input come from [serve-sim](https://www.npmjs.com/package/serve-sim) 0.1.47, shipped in the archive with `ws`.

## Requirements

- A Mac worker with Xcode (`xcrun simctl`). serve-sim runs only on Apple Silicon. The manifest requires `os=darwin` and `xcrun`, so other workers never run the service.
- For Android, the Android SDK with `platform-tools` (adb), `emulator`, `cmdline-tools` (avdmanager) and at least one installed system image. The service looks in `androidSdk` of `config.json`, `ANDROID_HOME`, `~/Library/Android/sdk` and `~/Android/Sdk`, then on `PATH`. Without an SDK the picker says so and the iOS side works as before.
- Band 0.62.0 or later (the first release without the bundled plugin, with image tool results and the direct panel stream), and a worker with `standard` or `admin` trust. A `restricted` worker never receives the archive.
- Install it from Settings > Extensions, or `band extensions install --official simulator`.

Band 0.61.0 and earlier bundle the same plugin, and a bundled plugin with the same capability wins on the worker. The catalog's `minBand` keeps this extension off those versions. The Band change that removes the bundled plugin and this extension's release must merge together: without the extension, a Band without the plugin has no simulator.

## Devices

Band creates no device on its own. Each pane of the Simulator tab shows one device the person picked or created. The picker lists every iOS simulator (`simctl`) and every Android emulator (the AVDs, plus any phone adb sees), grouped by platform, with the OS version and whether it is on. A device that another pane shows is greyed out.

The picker also creates devices. "New iOS simulator..." takes a model and an iOS runtime from the installed ones (`simctl create`). "New Android emulator..." takes a device profile and an installed system image (`avdmanager create avd`). When no system image is installed the form says so and prints the `sdkmanager "system-images;..."` command to run. Band never downloads one. A created device is named `<prefix> – <model>` on iOS and `<prefix>-<profile>` on Android (AVD names allow no spaces), so the prefix marks it as Band's.

At most 2 iOS simulators and 2 Android emulators are on at once (`maxBooted`, `maxBootedAndroid`). Turning on a device over the limit shuts down the least recently used one that no pane shows. If every device that could be shut down is shown in a pane, nothing is shut down: the pane that needed room shows an error listing the shown devices, each with a button that shuts it down and retries. A device that is booting or shutting down neither counts toward the limit nor gets picked. Only a device Band created or turned on itself is ever shut down this way. A device the person had already started, and any phone, stays. Stopping the service shuts down the devices Band started.

Earlier versions made one device per worktree, named `<prefix> – <worktree id>`. Once a day and when a worktree is removed, the service deletes such a device when its worktree's folder is gone. It never deletes a device that a saved layout shows, one a pane is watching, the person's own devices, or one created in the picker.

## The canvas

The tab is a tree of splits. Each pane has a toolbar with the picker, a frame toggle, Rotate, Home (and Back on Android), Power, split side by side, split top and bottom, and Close. Panes are resized by dragging a divider or with the arrow keys on it. Pressing a pane focuses it, and keyboard input goes to the focused pane.

The service stores the layout in `layouts.json` in its state dir, for the worktree. A worktree that has never opened the tab starts from the last layout any worktree of the same repository saved (matched by git's common dir). With nothing saved anywhere the tab shows one empty pane with the picker. Removing a worktree deletes its layout and keeps the repository's.

## Settings

Band starts a worker service with an allowlisted environment, so the `BAND_SIMULATOR_*` variables of the bundled plugin do not reach it. The service reads `<worker state dir>/extension-state/simulator/main/config.json` on every call instead:

```json
{ "namePrefix": "Band", "maxBooted": 2, "maxBootedAndroid": 2, "shutdownTimeoutMs": 60000, "bootTimeoutMs": 180000, "bootTimeoutAndroidMs": 300000, "androidSdk": "/path/to/Android/sdk", "serveSimEntry": "/path/to/serve-sim.js" }
```

Every key is optional. A shutdown that runs past `shutdownTimeoutMs`, or a boot past `bootTimeoutMs` (iOS) or `bootTimeoutAndroidMs`, is abandoned: Band kills the `simctl` call by its pid, the queue moves on, and the pane that needed it shows an error naming the device and the stuck call. Band does not restart CoreSimulatorService, because that stops every simulator on the Mac; the error says how. The old variables still apply when the service runs outside a worker.

## Tools

The tab is a viewer. Run apps with your own tools: `xcrun simctl`, `xcodebuild`, Expo, `adb`, Maestro. The extension no longer taps, types, installs, launches or takes screenshots for you.

- `simulator_devices` lists every device and the one the tab has focused.
- `simulator_status` answers with one device's state and screen size. It turns nothing on.
- `simulator_show` puts a device in this worktree's tab.

**For agents.** After you boot a simulator or emulator, or install or launch an app on one, call `simulator_show` with its UDID or adb serial. Find it with `xcrun simctl list devices booted` or `adb devices`. From a shell, run `band tools call simulator_show --json '{"device":"<id>"}'`. The person then sees the device you used.

`device` is an id (`ios:<udid>`, `android:avd:Pixel_8`), a raw iOS UDID, the adb serial of a running emulator (`emulator-5554`) or a device name. An unknown device is a tool error that lists the devices. `status` takes the same `device`, or else uses the device in the pane focused last.

`show` writes the worktree's saved layout. The device goes in the pane focused last, else the first pane, else a new single-pane layout when nothing is saved. A device that a pane already shows stays where it is. The answer says which pane ("pane 2 of 3"). An open tab switches that pane without a reload.

### Offers

While the tab is open it polls the service's `events` call every 2 seconds. That poll is the only thing that makes the service read the device list (`simctl list`, `adb devices`), at most once every 2 seconds for all tabs, and nothing runs when no tab is open. When a device that no pane shows goes from off to on, the tab shows a bar "<name> started, show it?" with Show and Dismiss. Show calls `show`. Dismiss hides the offer until the device turns off and on again. The tab never switches a pane on its own.

The service cannot see which app path an install used (`simctl install` and `adb install` copy the app into the device), so there is no offer on install. The start of a device is the only trigger. An agent that installs onto a device that was already on should call `simulator_show`.

## Android

The Android backend (`src/android.ts`) boots an AVD with `emulator -avd <name> -no-window` and waits for `sys.boot_completed`. Discovery and the stream's input follow the approach of [Orca](https://github.com/stablyai/orca)'s emulator code (MIT License, Copyright (c) 2026 Lovecast Inc.). No Orca source is copied, so no notice travels with it.

The stream is not scrcpy. The service polls `adb exec-out screencap -p`, turns each PNG into a JPEG with `sips` and sends it as it does on iOS, which gives about 3 to 5 frames a second. Input is `adb shell input` (tap, swipe, keyevent, text), so a drag becomes one swipe when the finger lifts. scrcpy would give 30 frames a second and live drags, at the price of downloading and deploying scrcpy's server jar to each device. That is a follow-up if the frame rate matters.

## Simulator.app stays hidden

serve-sim runs `open -a Simulator`, which puts a visible Simulator window in front of the person. The service starts serve-sim with a shim `open` first on its `PATH` (`<state dir>/bin/open`, written by `src/shim.ts`). A call that names Simulator becomes `/usr/bin/open -gj -a Simulator`, which launches the app in the background and hidden. Any other call goes to `/usr/bin/open` unchanged. The Simulator tab is how a person sees the device.

## Streams

Band adds a `profile` to the params of every stream it opens. With `"direct"` (the desktop app, for a worktree on this Mac's own worker, over the worker's loopback listener) the frames are serve-sim's own, at full size and rate. With `"hub"` (every other path) the service halves each side in process with sharp (libvips, quality 70, no process per frame) and sends at most 15 frames a second. One frame is encoded at a time and older waiting frames are dropped, so a slow viewer sees the newest frame. The archive carries sharp's prebuilds for darwin-arm64 and darwin-x64 (about 32 MB). `node bench-hub.mjs` measures it. A stream with no profile gets the `hub` one.

## Differences from the bundled plugin

- One device per worktree, cloned from a base device, is gone. The person picks or creates devices, and the layout is remembered.
- The service gets no `BAND_*` variable. Settings come from `config.json` (above).
- There is no "Open simulator" button on a tool call in the chat, no `band simulators open`, and no "Reveal in Simulator.app". The Simulator tab opens from the "+" menu. These were dropped on purpose.

## The panel

`panel.html` runs in Band's sandboxed iframe and draws the JPEG frames of one `screen` stream per pane on a canvas, opened with `params.device`. Input is always on: Band has no Take control step for panels, so the panel sends touches, keys and Home from the moment a stream opens. Pointer positions are fractions of the screen, so scaling does not move a tap. Power shuts the shown device down, and while it is off the same button turns it on again. When the service turns a device off (another pane, or to make room) it sends `{"type":"off"}` and the pane shows Off instead of reconnecting. The create forms are plain elements, not an HTML form, because Band's sandbox has no `allow-forms`.

## Build and test

```sh
cd extensions/simulator
npm ci && npm run typecheck && npm test      # unit tests with stand-ins for simctl, adb, emulator and avdmanager; no Xcode or Android SDK needed
PLAYWRIGHT=<playwright-core> node verify.mjs ../../.am/evidence   # headless Chrome check of the canvas with stand-in streams
cd ../.. && scripts/package.sh simulator     # dist/simulator-<version>.tar.gz and .sha256
BAND_SRC=/path/to/band extensions/simulator/integration/run.sh   # needs Xcode, about 6 GB of disk
```

`integration/run.sh` and its two tests are skipped: they test one auto-created device per worktree, which the canvas replaced, and need a rewrite for the picker and layout calls. `verify.mjs` and the unit tests cover the canvas, the Android backend and the tools meanwhile. When rewritten, `integration/run.sh` needs a checkout of the simulator-as-extension branch of Band (0.62.0 or later) that is installed and built (`pnpm install`, `pnpm build:web`). It copies a vitest file and a Playwright spec into it and runs them against a real hub and worker with a temp HOME and no `BAND_*` variables. The tests give the worker a device name prefix of their own and delete every device with it.

serve-sim uses private Apple APIs (`SimulatorKit`, `CoreSimulator`, `IndigoHID`). A new Xcode can break capture or input until serve-sim is updated. Bump the pin by hand after the integration test passes.
