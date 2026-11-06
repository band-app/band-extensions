# iOS Simulator

An iOS simulator for each worktree on a Mac worker, as a Band extension. Agents drive it with nine tools. A person watches and controls it in a Simulator tab opened from the center "+" menu. This is the `simulator` plugin that Band used to bundle (`plugins/simulator`), moved onto Band's extension API: a worker service (`service.mjs`), a panel (`panel.html`) and tools declared in `band-extension.json`. Capture and input come from [serve-sim](https://www.npmjs.com/package/serve-sim) 0.1.47, shipped in the archive with `ws`.

## Requirements

- A Mac worker with Xcode (`xcrun simctl`). serve-sim runs only on Apple Silicon. The manifest requires `os=darwin` and `xcrun`, so other workers never run the service.
- Band 0.62.0 or later (the first release without the bundled plugin, with image tool results and the direct panel stream), and a worker with `standard` or `admin` trust. A `restricted` worker never receives the archive.
- Install it from Settings > Extensions, or `band extensions install --official simulator`.

Band 0.61.0 and earlier bundle the same plugin, and a bundled plugin with the same capability wins on the worker. The catalog's `minBand` keeps this extension off those versions. The Band change that removes the bundled plugin and this extension's release must merge together: without the extension, a Band without the plugin has no simulator.

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

## Simulator.app stays hidden

serve-sim runs `open -a Simulator`, which puts a visible Simulator window in front of the person. The service starts serve-sim with a shim `open` first on its `PATH` (`<state dir>/bin/open`, written by `src/shim.ts`). A call that names Simulator becomes `/usr/bin/open -gj -a Simulator`, which launches the app in the background and hidden. Any other call goes to `/usr/bin/open` unchanged. The Simulator tab is how a person sees the device.

## Streams

Band adds a `profile` to the params of every stream it opens. With `"direct"` (the desktop app, for a worktree on this Mac's own worker, over the worker's loopback listener) the frames are serve-sim's own, at full size and rate. With `"hub"` (every other path) the service halves each side and sends at most 15 frames a second. A stream with no profile gets the `hub` one.

## Differences from the bundled plugin

- The service gets no `BAND_*` variable. Settings come from `config.json` (above).
- There is no "Open simulator" button on a tool call in the chat, no `band simulators open`, and no "Reveal in Simulator.app". The Simulator tab opens from the "+" menu. These were dropped on purpose.

`simulator_screenshot` answers with an image block and a short text block with the pixel size and the scale, as the bundled plugin did.

## The panel

`panel.html` runs in Band's sandboxed iframe and draws the JPEG frames of the `screen` stream on a canvas. The panel sets `defaultControl`, so Band takes control for the person as soon as the stream connects and input works at once. Release in Band's toolbar returns it to view-only until the stream reconnects. Until control is on, the hub drops everything the panel sends, and the panel ignores input too. Pointer positions are fractions of the screen, so scaling does not move a tap.

## Build and test

```sh
cd extensions/simulator
npm ci && npm run typecheck && npm test      # unit tests, no Xcode needed
cd ../.. && scripts/package.sh simulator     # dist/simulator-<version>.tar.gz and .sha256
BAND_SRC=/path/to/band extensions/simulator/integration/run.sh   # needs Xcode, about 6 GB of disk
```

`integration/run.sh` needs a checkout of the simulator-as-extension branch of Band (0.62.0 or later) that is installed and built (`pnpm install`, `pnpm build:web`). It copies a vitest file and a Playwright spec into it and runs them against a real hub and worker with a temp HOME and no `BAND_*` variables. The tests give the worker a device name prefix of their own and delete every device with it.

serve-sim uses private Apple APIs (`SimulatorKit`, `CoreSimulator`, `IndigoHID`). A new Xcode can break capture or input until serve-sim is updated. Bump the pin by hand after the integration test passes.
