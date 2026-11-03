# WordCraft

A web build of [WordCraft](https://github.com/storytold/wordcraft) that runs as a Band editor extension. Band frames it in `<iframe sandbox="allow-scripts">` and speaks its editor protocol over a `MessagePort`. The extension opens `*.docx`, `*.odt` and `*.rtf`, and saving writes the format the file was opened in. Those three are the formats the web build both opens and saves. WordCraft also opens `.doc`, `.md`, `.html` and others, but cannot save a `.doc`, and the other formats lose formatting on save, so the manifest leaves them out.

WordCraft's crates are git dependencies pinned at rev `ae5c65b9dd11`, the head of `main` when this extension was written (WordCraft 0.15.0). Nothing in WordCraft is edited, patched or vendored. Install and release steps are in the [root README](../../README.md).

## Own Cargo workspace

Unlike GridCraft, WordCraft is not in the root workspace. `extensions/wordcraft/Cargo.toml` is its own workspace root, with its own `Cargo.lock`, and the root `Cargo.toml` excludes it. WordCraft patches `egui`, `eframe`, `winit` and `krilla` with git forks through `[patch.crates-io]`, and Cargo reads `[patch]` only from the root of the workspace being built. The block is copied into this `Cargo.toml`. Build and test from this folder:

```sh
cd extensions/wordcraft
cargo clippy --target wasm32-unknown-unknown --workspace -- -D warnings
```

`scripts/package.sh wordcraft` and the CI jobs detect a `[workspace]` in the extension's `Cargo.toml` and run Cargo from that folder.

## What the files do

- `app/src/editor.rs` implements `band_editor::Editor` for WordCraft. The shared bridge in `crates/band-editor` handles the port, `init`, `ready`, `dirty`, `save`, `saved`, `saveFailed`, `reload` and `mcp`. Details:
  - Save encodes the active document with `wordcraft_engine::io::save_bytes_with` in the format of the name Band sent. It stamps the document's modified time and revision first, as WordCraft's own save does.
  - File > Save inside WordCraft goes through `Services::host_save`. When the name has the open file's extension, the editor treats it as a save request. Any other name (PDF export, Save As to another format) is refused, so WordCraft reports the failure and keeps the document unsaved.
  - WordCraft marks the document saved as soon as it hands over the bytes. `save_answered` corrects that: after `saved` it re-encodes the document and clears the dirty flag only when the bytes equal what was sent. After `saveFailed`, or after an edit made while the save was in flight, the document stays dirty.
  - Dirty is true while any open document has unsaved changes.
  - Reload closes the open documents and opens the new bytes.
- `app/src/mcp.rs` answers `mcp` messages with WordCraft's own MCP server (`wordcraft-mcp`, the one behind `wordcraft-cli mcp`), so an agent gets the same tools as the CLI. The `screenshot` tool finishes over several frames, so the wrapper answers it itself: it sends WordCraft's `ui.screenshot` request over the control channel (`WordApp::with_control`) and builds the image reply from the app's answer. Every other call goes to the server unchanged.
- `app/src/tools_json.rs` prints `tools.json` (`{ "tools": [...] }`, the `tools/list` answer of the same `wordcraft_mcp::Server`) with `"agent": false` on `open_document` and `save_document`. Both take a file system path, and a browser tab has none. It needs no browser.
- `verify.mjs` plays Band in headless Chrome: a test page frames the build from another origin with `sandbox="allow-scripts"`, so the frame has a `null` origin. For `.docx`, `.odt` and `.rtf` it checks `init`, `ready`, `dirty`, `save`, `saved`, `saveFailed`, an edit during a save, File > Save inside the app, a refused PDF export, reopening the saved bytes and `reload`. It also checks `tools/list` against `tools.json`, a screenshot, and that forged messages from a sibling frame are ignored. The fixtures are built in the script, so the repository holds no binary files. Run it after `scripts/package.sh wordcraft`:

  ```sh
  PLAYWRIGHT=<path to playwright-core> node extensions/wordcraft/verify.mjs
  ```

  WordCraft renders in headless Chrome only with `--enable-unsafe-swiftshader`, which the script passes.

A frame scrolled out of view or in a background tab stops drawing, and MCP requests are answered on the frame loop, so such a tab answers when it is shown again.

## Files copied from WordCraft

`app/src/web.rs` and `app/src/main.rs` come from `apps/wordcraft-web/src/` at `ae5c65b9dd11` (MIT OR Apache-2.0, see the root `LICENSE-MIT` and `LICENSE-APACHE`, and `NOTICE`) and say so in their first lines. They are copied because `apps/wordcraft-web` is a binary crate, not a library. `NOTICE` is WordCraft's own.

- `web.rs`: the eframe runner and browser services. Changed to wrap the app in `Rc<RefCell<..>>`, start the Band bridge, give the app a control channel and run the bridge after each frame (marked `wrapper:`).
- `main.rs`: `mod editor` and `mod mcp` added, the other modules and the `?host=parent` text removed.
- `index.html` and `Trunk.toml` are adapted. The icon link is dropped, because the icon lives in WordCraft's repo, and a head script keeps the Band hello port.
- The root `rustfmt.toml` equals WordCraft's.
- `Cargo.lock` started as WordCraft's lock at that rev, so egui, wgpu and the rest resolve to the versions WordCraft tests. `[profile.release]` and `[patch.crates-io]` are repeated in `Cargo.toml` because Cargo ignores a dependency's profile and patch sections.

## Dropped from the web build

- `host.rs` and the `?host=parent` path. Band's editor port replaces them.
- `prefs.rs` (preferences in `localStorage`), `web/font_store.rs` (added fonts in IndexedDB) and `save_fallback.rs`. A sandboxed frame with a null origin has no storage, so they would do nothing.
- The `beforeunload` guard, the save picker, the anchor download and printing. Band guards unsaved tabs, takes saves over the port, and the sandbox has no `allow-modals`.

## Language data

WordCraft's official builds embed translations and proofing data from `storytold/craft-i18n` (`CRAFT_I18N_DIR`) and Japanese fonts from `craft-fonts` (`CRAFT_FONTS_DIR`). This build sets neither, as WordCraft's build allows. The interface is English only, and spelling, grammar and hyphenation data for other languages are missing.

## Upgrading the pinned rev

1. Change `rev` for the `wordcraft-*` entries in `Cargo.toml`.
2. Diff `apps/wordcraft-web/src/{main,web}.rs`, `index.html` and `Trunk.toml` between the old and new rev, and port the changes into the copies. Copy the `[patch.crates-io]` block and the `egui`, `eframe` and `rfd` versions from WordCraft's `Cargo.toml`.
3. Replace `Cargo.lock` with WordCraft's at the new rev, then run a build so Cargo adds this workspace's packages. If `wasm-bindgen` changes, CI follows the new lock version by itself.
4. Bump `version` in `band-extension.json` (the first three parts follow WordCraft, the last is this wrapper's revision), then tag.
