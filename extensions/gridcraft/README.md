# GridCraft

A web build of [GridCraft](https://github.com/storytold/gridcraft) that runs as a Band editor extension. Band frames it in `<iframe sandbox="allow-scripts">` and speaks its editor protocol over a `MessagePort`. The extension opens `*.xlsx` and `*.csv`, and saving writes the format the file was opened in.

GridCraft's crates are git dependencies pinned at rev `e6b6b349708a`. Nothing in GridCraft is edited, patched or vendored. Install and release steps are in the [root README](../../README.md).

## What the files do

- `app/src/editor.rs` implements `band_editor::Editor` for GridCraft. The shared bridge in `crates/band-editor` handles the port, `init`, `ready`, `dirty`, `save`, `saved`, `saveFailed`, `reload` and `mcp`.
- `app/src/mcp.rs` answers `mcp` messages with GridCraft's own MCP server (`gridcraft-mcp`, the one behind `gridcraft-cli mcp`), so an agent gets the same 21 tools as the CLI. Two stock tools do not work on wasm, so it answers them itself:
  - `screenshot` needs `ui.screenshot`, which times shots with `now_ms()` (always 0 on wasm) and never finishes. The wrapper sends egui's `ViewportCommand::Screenshot`, waits for the `Event::Screenshot` frame, and encodes it with `control::save_image` into an MCP image block. Waiting 3 frames first lets earlier edits draw.
  - `save_workbook` calls `file.save` with a path, and the browser has no file system. The wrapper runs `file.saveAs`, which hands `.xlsx` bytes to the app's download service, and that becomes a save request to Band. `tools.json` marks it `"agent": false`, so Band leaves it out of the agent's tools.
- `app/src/tools_json.rs` prints `tools.json` (`{ "tools": [...] }`, the `tools/list` answer of the same `gridcraft_mcp::Server`) with `"agent": false` on `save_workbook` and `open_workbook`. It needs no browser.
- `verify.mjs` plays Band in headless Chrome: a test page frames the build from another origin with `sandbox="allow-scripts"`, so the frame has a `null` origin. It checks `init`, `ready`, `dirty`, `save`, `saved`, `saveFailed`, `reload`, `mcp` (`tools/list` against `tools.json`, `set_cell`, a screenshot) for `.xlsx` and `.csv`, and that forged messages from a sibling frame are ignored. Run it after `scripts/package.sh gridcraft`:

  ```sh
  PLAYWRIGHT=<path to playwright-core> node extensions/gridcraft/verify.mjs
  ```

  GridCraft renders in headless Chrome only with `--enable-unsafe-swiftshader`, which the script passes.

A frame scrolled out of view or in a background tab stops drawing, and MCP requests are answered on the frame loop, so such a tab answers when it is shown again.

## Files copied from GridCraft

`app/src/web.rs` and `app/src/main.rs` come from `apps/gridcraft-web/src/` at `e6b6b349708a` (MIT OR Apache-2.0, see the root `LICENSE-MIT` and `LICENSE-APACHE`, and `NOTICE`) and say so in their first lines. They are copied because `apps/gridcraft-web` is a binary crate, not a library.

- `web.rs`: the eframe runner and browser services (picker, download, clipboard, print). Changed to wrap the app in `Rc<RefCell<..>>`, start the Band bridge and run it after each frame (marked `wrapper:`), and drop the `?host=parent` code. One blank line after a doc comment is gone, so clippy passes.
- `main.rs`: `mod editor` and `mod mcp` added, and the `?host=parent` text removed.
- `index.html` and `Trunk.toml` are adapted. The icon link is dropped, because the icon lives in GridCraft's repo, and a head script keeps the Band hello port.
- The root `rustfmt.toml` repeats GridCraft's formatting settings, which the copied files follow.
- The root `Cargo.lock` started as GridCraft's lock at that rev, so egui, wgpu and the rest resolve to the versions GridCraft tests. `[profile.release]` is repeated in the root `Cargo.toml` because Cargo ignores a dependency's profile.

## Dropped from the spike

`app/host.html`, `app/src/host.rs`, `scripts/verify-host.mjs` and the `?host=parent` same-origin path are gone. They only served the earlier postMessage spike, and nothing in the Band extension uses them.

## Upgrading the pinned rev

1. Change `rev` for the three `gridcraft-*` entries in the root `Cargo.toml`.
2. Diff `apps/gridcraft-web/src/{main,web}.rs`, `index.html` and `Trunk.toml` between the old and new rev, and port the changes into the copies. `host.rs` upstream is not used here.
3. Replace `Cargo.lock` with GridCraft's at the new rev, then `cargo update -p` as needed. Keep `egui`, `eframe` and `rfd` in sync with GridCraft's `[workspace.dependencies]`. If `wasm-bindgen` changes, CI follows the new lock version by itself.
4. Bump `version` in `band-extension.json` (the first three parts follow GridCraft, the last is this wrapper's revision), then tag.
