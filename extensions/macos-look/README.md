# macos-look

A client mod that gives Band's desktop app a macOS 26 look. It needs a Band with `contributes.mod`, `window.toolbar` and the native addon (band-app/band#1190).

A client mod runs in the page with the device token and can change anything on it. Installing the extension is the approval.

## What it changes

- Type: the system font at AppKit sizes (13 pt body, 11 pt secondary). Band's rem scale is set so `text-sm` is 13 px.
- Colors: AppKit's label, separator and selection colors and the accent. In the desktop app they are the live system values (`--mac-*`), in a browser the measured fallbacks.
- A source-list sidebar over the window's `sidebar` vibrancy: 32 px rows, a neutral selection fill, 11 pt section headers, a compact footer and inline notices.
- A 52 px toolbar row: the sidebar toggle and history buttons in one capsule right of the traffic lights, the selected tab as a pill, and the right panel's tabs as a segmented control. A capsule is a translucent fill with `backdrop-filter` blur, a light rim and a shadow, which imitates Liquid Glass.
- Controls at AppKit heights: push buttons 28, 24 and 20 px, text fields and popups 24 px, a 54 x 24 switch, a segmented control, accent focus rings, overlay scrollbars.
- Menus, popovers, tooltips, dialogs and sheets as translucent surfaces with blur, AppKit radii, a hairline and a shadow. Menu items highlight in the accent color. Settings, a full-window dialog, stays opaque.
- 74 SF Symbols in place of Lucide icons, drawn by macOS (desktop app only, nothing changes in a browser).
- Window options: `sidebar` vibrancy material, an empty unified toolbar for the native corner radius, `hiddenInset` title bar.

The CSS reads Band's variables, so Settings > Appearance and light and dark mode keep working. On battery Band removes the vibrancy and fills the sidebar with a solid color. The glass is a CSS imitation: `backdrop-filter` blurs what is behind an element inside the page, not the desktop, and refracts nothing. There is no native glass view.

## Parts

`src/parts/*.css` are joined in file name order by `node build.mjs` into `dist/web/mod.css`: tokens, type, sidebar, toolbar, right panel tabs, controls, surfaces, symbols, symbol map.

## Fidelity check

`test/native-reference.json` holds what AppKit reports on macOS 26.5 (colors in light and dark, font sizes, control heights, the switch). `test/fidelity.mjs` measures Band with the mod in Chromium and compares every number:

```sh
HUB_URL=http://127.0.0.1:PORT HUB_TOKEN=... PLAYWRIGHT_DIR=<dir where @playwright/test resolves> \
  node test/fidelity.mjs --out report.md
```

It needs a hub with the extension installed. It measures sizes, type, colors and radii. It does not judge the vibrancy.

## Build

```sh
cd extensions/macos-look
npm test                       # builds dist/web and checks the manifest and the CSS
cd ../.. && scripts/package.sh macos-look
band extensions install dist/macos-look-0.3.0.tar.gz
```

Install it into a test hub (a temporary `BAND_HOME`), not your real profile, while you work on it.
