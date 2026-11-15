# Desktop

A desktop for each worktree on a Linux worker, and the Mac session of the worker's user on a macOS worker, as a Band extension. A person watches and controls it in a Desktop tab opened from the center "+" menu. The worktree's agents and terminals draw on it, so a headed Chromium, a Playwright run or an app the agent built shows up in the tab. Agents also get six tools to look at and drive their own display. This replaces the remote desktop viewer that Band used to bundle in Settings > Workers.

## Requirements

- A Linux worker with `Xvfb` and `x11vnc` on its `PATH` (the manifest requires `os=linux`, `Xvfb` and `x11vnc`, so other workers never run the service). `fluxbox` is used as the window manager when it is installed, and `chromium` (or `chromium-browser`, `google-chrome`) for `desktop_open_url`. The `band-worker-desktop` image (`docker/worker-desktop.Dockerfile` in the Band repo, also what the docker runner hook starts for `desktop: true`) has all of them.
- Band 0.64.0 or later (the first release without the bundled viewer, with panel `binaryInput` and the service `worktreeEnv`), and a worker with `standard` or `admin` trust. A `restricted` worker never receives the archive.
- Install it from Settings > Extensions, or `band extensions install --official desktop`. If you used the old Open desktop button, install the extension: the button is gone.

## How it works

On first need (the Desktop tab opens, a tool is called, or the worker starts an agent or terminal in the worktree) the service starts, for that worktree only:

- `Xvfb` on a display number it picks itself (`-displayfd`), 1280x800x24 by default, no TCP listener.
- `fluxbox`, if installed.
- `x11vnc -localhost -nopw` on a free loopback port. Nothing listens on another interface, and the worker's link is the only way to the port.

Before the worker starts an agent or a terminal in the worktree, it asks the service for the worktree's environment (the manifest lists `worktreeEnv: ["DISPLAY"]`), so everything the agent starts draws on that display. Two worktrees on one worker have two displays.

The panel is noVNC in the extension's iframe, coloured from the theme Band sends (`init.theme` and `theme` messages, with built-in fallbacks), with Fit and 1:1, fullscreen, up to three reconnects, clipboard paste and keyboard focus only while in control, and a compact layout on phones. Panel input is always on in Band 0.64.0 and later, so there is nothing to press to take control. Any number of viewers may open the tab at once.

## macOS workers

On a Mac the Desktop tab and the six tools show and drive the GUI session of the user the worker runs as (`$USER` of the service). All worktrees of that worker share the one session. Nothing is installed: the service talks to the Mac's own Screen Sharing server on `127.0.0.1:5900`, and `worktreeEnv` returns nothing.

Setup on the Mac:

- Turn on Screen Sharing in System Settings > General > Sharing and allow the worker's user.
- Open the Desktop tab and sign in with that user's password. The password never touches the worker's disk (see below).

Sign-in:

- When the Desktop tab opens and the service holds no password, the panel shows a form for the worker user. A wrong password shows "the Mac refused the login" and asks again.
- The service keeps the password in memory only. It is gone when the service stops, and the service ignores `~/.band/screen-password` and the old `macos.passwordFile` setting. It never logs the password or puts it in a stream's params.
- In Band.app the panel can keep the password on the viewer's device. With "Remember on this device" checked, Band.app stores it in the OS keychain (Electron safeStorage), under a key the Desktop extension names `mac:<worker id>:<user>`. Later connects read it back, unlocked with Touch ID or the account password, and skip the form. If the Mac refuses the saved password, the panel deletes it and shows the form with the reason. In a browser, or on a Band older than the one that sends `init.secrets`, nothing is saved and the form shows every time.
- Agent tools (`desktop_status`, `desktop_screenshot`, `desktop_click`, `desktop_type`, `desktop_key`, `desktop_open_url`) log in with the password in memory. Until a viewer has signed in since the service started, they fail with "sign-in needed: open the Desktop tab on this worktree and sign in as <user>". After a viewer signs in, they work. If the Mac later refuses the remembered password, the service forgets it and the tools say "sign-in needed" again.
- Every failure to open the session (Screen Sharing off, a locked session that stays locked, the Mac closing the connection during the login) reaches the panel as the reason. The panel shows it with a Reconnect button and does not retry.

Stream messages between the panel and the service, as text next to the RFB bytes: the service sends `{"type":"need-password","user","worker","reason"}`, the panel answers `{"type":"password","password"}`, the service sends `{"type":"signed-in"}` before the RFB bytes, or `{"type":"error","message"}` before it ends the stream.

How it works:

- The Mac's server offers Apple's user and password login (RFB security type 30). `RfbClient` speaks it for the tools. For the panel, the service logs in itself with the password the panel gave, then shows noVNC a server with no authentication (`RFB 003.008`, security type None) and forwards ClientInit and ServerInit. After that, bytes pass through both ways.
- With the `hub` stream profile the service forwards at most about 15 FramebufferUpdateRequests a second, and sends the latest one when the interval ends. Key, pointer and other messages pass at once and in order. The `direct` profile forwards everything. Frames are not resized, so a big Retina session uses more bandwidth through the hub than a Linux display does.
- If `ioreg` says the user's session is locked when a stream opens or a tool runs, the service taps Shift, waits 1.5 seconds, types the password and presses Return. It types the password only when the session is locked, and it does not retry for a minute after a failure. If the lock screen shows a list of users, or stays locked for another reason, `desktop_status` and the panel say so, and someone has to choose the user at the Mac once.
- `desktop_key` sends `cmd` (also `super`, `meta`, `win`) as Super_L, which Apple's server reads as Command, and `alt` as Option. `desktop_open_url` runs `/usr/bin/open <url>` with the same URL allowlist.

Two manifest entries share the capability `desktop`: `main` (requires `os=linux`, `Xvfb`, `x11vnc`) and `macos` (requires `os=darwin`). Both start `service.mjs`, which picks its code by `process.platform`. Band's worker starts the first entry whose `requires` hold and marks a second entry with the same capability `not-eligible`, so only one runs per worker. A single entry could not replace them, because `requires` are all required and cannot say "Linux with Xvfb, or macOS". The panel and the tools call the capability, so they work on both. List the Linux entry first, so a Mac worker has already marked it `not-eligible` when it reaches the `macos` entry.

## Stopping

On Linux, a display stops when its worktree is removed, when the service stops (lease fence, worker shutdown, extension removal or update), and when it is idle: no open panel, and no program other than a shell, runtime or agent has that `DISPLAY` in its environment (read from `/proc`) for `idleSeconds`. A service that crashed leaves nothing for long: at its next start it ends the processes it recorded in `displays.json` and removes the lock files of those displays only.

## Settings

Band starts a worker service with an allowlisted environment. The service reads `<worker state dir>/extension-state/desktop/main/config.json` on every call:

```json
{ "resolution": "1920x1080x24", "idleSeconds": 1800, "browser": "chromium", "noSandbox": true }
```

Every key is optional. `resolution` applies to displays started afterwards. `noSandbox` defaults to true inside a container (`/.dockerenv`).

## Tools

`desktop_status`, `desktop_screenshot` (a PNG image block; coordinates are screen pixels, and a very large screen is halved until the image is under 4.5 MB, with the scale reported), `desktop_click` (`x`, `y`, `button`, `double`), `desktop_type`, `desktop_key` (`Enter`, `ctrl+l`, `alt+Tab`, `F5`) and `desktop_open_url` (http, https, file, data and about:blank only). Each acts on the calling chat's worktree display only. Screenshots and input go through a private RFB connection to the display's x11vnc, so no extra packages are needed.

## Tests

`npm test` runs the pure tests, including a fake Mac that implements security type 30 (`test/fake-apple.mjs`) for the login, the sign-in flow, the stream proxy and the request cap. `test/panel.test.mjs` drives the built panel in Chromium against a stub of Band's host side (stream and `secret.*` messages); it skips itself when `playwright-core` or a Chromium (`~/Library/Caches/ms-playwright`, or `DESKTOP_TEST_CHROMIUM`) is missing. `integration/run.sh` runs a hub test (S1 to S6) and a Playwright spec against a Band checkout, with the worker in the `band-worker-desktop` image through docker (or natively on Linux). See the header of `run.sh`.
