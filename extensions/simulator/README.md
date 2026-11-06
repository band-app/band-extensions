# iOS Simulator

An iOS simulator for each worktree on a Mac worker, as a Band extension. Agents drive it with nine tools. A person watches and controls it in a Simulator tab opened from the center "+" menu. This is a port of the `simulator` plugin that Band bundles (`plugins/simulator`), built on Band's extension API: a worker service (`service.mjs`), a panel (`panel.html`) and tools declared in `band-extension.json`. Capture and input come from [serve-sim](https://www.npmjs.com/package/serve-sim) 0.1.47, shipped in the archive with `ws`.

## Requirements

- A Mac worker with Xcode (`xcrun simctl`). serve-sim runs only on Apple Silicon. The manifest requires `os=darwin` and `xcrun`, so other workers never run the service.
- Band 0.61.0 or later, and a worker with `standard` or `admin` trust. A `restricted` worker never receives the archive.
- Install it from Settings > Extensions, or `band extensions install --official simulator`.

Band 0.61.0 still bundles the same plugin. A bundled plugin with the same capability wins on the worker, so this extension takes effect once Band removes it (the follow-up PR in band-app/band). Until then the Settings list shows it running but the bundled plugin answers.

## Devices

Each worktree has one device named `Band – <worktree id>` in the machine's default device set, cloned from `Band – base` (the newest iOS runtime and the newest iPhone Pro). At most 2 devices are booted at once. Booting a third shuts down the least recently used one, which is shut down and kept. Removing the worktree deletes its device. A lease fence or stopping the worker shuts devices down and keeps them. Only devices whose name starts with the prefix are touched.

## Settings

Band starts a worker service with an allowlisted environment, so the `BAND_SIMULATOR_*` variables of the bundled plugin do not reach it. The service reads `<worker state dir>/extension-state/simulator/main/config.json` on every call instead:

```json
{ "namePrefix": "Band", "maxBooted": 2, "deviceType": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", "runtime": "26.5", "serveSimEntry": "/path/to/serve-sim.js" }
```

Every key is optional. The old variables still apply when the service runs outside a worker.

## Tools

`simulator_status`, `simulator_screenshot`, `simulator_describe`, `simulator_tap`, `simulator_type`, `simulator_button` (`HOME`, `LOCK`, `SIDE_BUTTON`, `SIRI`), `simulator_open_url`, `simulator_install` (an `.app` inside the worktree) and `simulator_launch` (a bundle id). Each acts on the calling chat's worktree only. Coordinates are points: screenshot pixels divided by the scale.

## Differences from the bundled plugin

Band's extension API v1 cannot express these, so they are missing or changed:

- A tool result is JSON text, so `simulator_screenshot` cannot return an image. It saves a PNG under the service's state dir (the newest 10 are kept) and returns its path, size and scale. The agent opens the file.
- The service gets no `BAND_*` variable. Settings come from `config.json` (above).
- No "Open simulator" button on a tool call in the chat, no `band simulators open`, and no "Reveal in Simulator.app". The Simulator tab opens from the "+" menu.
- The stream always uses the hub route, so frames are half size at up to 15 per second. There is no direct loopback path.

## The panel

`panel.html` runs in Band's sandboxed iframe and draws the JPEG frames of the `screen` stream on a canvas. It is view-only. Pointer and key events go to the device only after the person presses Take control in Band's toolbar above the frame (the hub drops everything the panel sends before that, and the panel ignores input too). Pointer positions are fractions of the screen, so scaling does not move a tap.

## Build and test

```sh
cd extensions/simulator
npm ci && npm run typecheck && npm test      # unit tests, no Xcode needed
cd ../.. && scripts/package.sh simulator     # dist/simulator-<version>.tar.gz and .sha256
BAND_SRC=/path/to/band extensions/simulator/integration/run.sh   # needs Xcode, about 6 GB of disk
```

`integration/run.sh` needs a Band v0.61.0 checkout that is installed and built (`pnpm install`, `pnpm build:web`). It copies a vitest file and a Playwright spec into it and runs them against a real hub and worker with a temp HOME and no `BAND_*` variables. The tests give the worker a device name prefix of their own and delete every device with it.

serve-sim uses private Apple APIs (`SimulatorKit`, `CoreSimulator`, `IndigoHID`). A new Xcode can break capture or input until serve-sim is updated. Bump the pin by hand after the integration test passes.
