# windows-look

A client mod that gives Band a Windows 11 (Fluent) look. A client mod runs in the page with the device token and can change anything on it. Installing the extension is the approval.

The numbers are the documented Fluent design tokens and WinUI 3 metrics (14 px body, 32 px controls, 4 px control radius, 8 px flyout radius, the default accent), not measurements taken on a Windows machine. Segoe UI is not on a Mac, so the system font stands in.

Parts in `src/parts/*.css`: tokens (light and dark), type, navigation pane and tab view, controls, flyouts. `node build.mjs` joins them into `dist/web/mod.css`.
