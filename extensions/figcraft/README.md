# FigCraft

A web build of [FigCraft](https://github.com/storytold/figcraft) that runs as a Band editor extension. Band frames it in `<iframe sandbox="allow-scripts">` and speaks its editor protocol over a `MessagePort`. The extension opens `*.figcraft` and `*.fig`.

FigCraft's crates are git dependencies pinned at rev `35684eaa028e`, the head of `main` when this was written (FigCraft 0.15.0). Nothing in FigCraft is edited, patched or vendored. Install and release steps are in the [root README](../../README.md).

## This extension is its own Cargo workspace

`extensions/figcraft/Cargo.toml` is a workspace of its own, with its own `Cargo.lock`, and the root workspace excludes it. FigCraft pins forks of egui and winit through `[patch.crates-io]` and uses a different egui release than GridCraft. One shared lock cannot hold both. Build from this folder:

```sh
cd extensions/figcraft
cargo fmt --check
cargo clippy -- -D warnings
cargo clippy --target wasm32-unknown-unknown -- -D warnings
(cd app && trunk build --release)       # writes dist/web
cargo run --release -p figcraft-band --bin tools-json > dist/web/tools.json
```

`scripts/package.sh figcraft` and the CI jobs detect the `[workspace]` in this folder's `Cargo.toml` and run Cargo from here.

## Rust toolchain

The pinned FigCraft rev uses `u64::isolate_lowest_one`, which is unstable on Rust 1.95 and 1.96, although FigCraft's `rust-version` says 1.95. `extensions/figcraft/rust-toolchain.toml` pins 1.99, which rustup picks up for any command run in this folder. The root `rust-toolchain.toml` (1.95) still applies to the other extensions and to the CI setup step, which installs 1.95 first and then installs 1.99 on the first Cargo call in this folder.

## Formats

- `.figcraft` is FigCraft's own format. Saving writes `.figcraft` bytes (`file.saveAs` with `data`, the same encoder as File > Save As), including the thumbnail and version history.
- `.fig` is Figma's format. FigCraft imports it, and saving writes a `.fig` export (`file.export` with `format: "fig"`). FigCraft marks that export experimental: it round-trips through FigCraft's own importer, and it leaves out what the `.fig` format cannot hold, so a save can drop things the original file had. Open a `.fig` for a quick edit, not as the master copy.

If a file does not open (a damaged or unsupported file), the tab shows FigCraft's error and Save sends nothing, so the file on disk is never replaced by an empty design.

## What the files do

- `app/src/editor.rs` implements `band_editor::Editor` for FigCraft. The shared bridge in `crates/band-editor` handles the port, `init`, `ready`, `dirty`, `save`, `saved`, `saveFailed`, `reload` and `mcp`. Opening closes FigCraft's starting Untitled tab and runs `file.open` with the bytes. A confirmed `saved` marks the document as sent clean, so edits made while the save was in flight stay unsaved.
- `app/src/mcp.rs` answers `mcp` messages with FigCraft's own MCP server (`figcraft-mcp`, the one behind `figcraft-cli mcp`), so an agent gets the same 19 tools as the CLI, running against the open document. The wrapper answers four tools itself:
  - `save_file` writes to a path and the browser has no file system. The wrapper asks Band to save the open file, as File > Save does.
  - `export` with `path` would write a file. The wrapper refuses it with an error that says to leave `path` out. Without `path`, the export comes back in the reply.
  - `open_file` reads a path. It answers with an error.
  - `screenshot` with `window` set needs a drawn frame and an attached window. It answers with an error that says to leave `window` out. Without `window` the page is rendered, as in the headless server.
- `app/src/tools_json.rs` prints `tools.json` (`{ "tools": [...] }`, the `tools/list` answer of the same `figcraft_mcp::Server`) with `"agent": false` on `open_file` and `save_file`. It needs no browser.
- `verify.mjs` plays Band in headless Chrome: a test page frames the build from another origin with `sandbox="allow-scripts"`, so the frame has a `null` origin. For both `.figcraft` and `.fig` it checks `init`, `ready`, `dirty`, `save`, `saved`, `saveFailed`, `reload`, `mcp` (`tools/list` against `tools.json`, an edit, `export` with and without `path`, a screenshot), that a saved file reopens with the edit, that a file that does not open is not saved, and that forged messages from a sibling frame are ignored. Run it after the build above:

  ```sh
  PLAYWRIGHT=<path to playwright-core> node extensions/figcraft/verify.mjs
  ```

  FigCraft renders in headless Chrome only with `--enable-unsafe-swiftshader`, which the script passes. The repository has no FigCraft file, so the script makes its fixtures: it opens a small SVG and has the build write it out as `.figcraft` and as `.fig`.

A frame scrolled out of view or in a background tab stops drawing, and MCP requests are answered on the frame loop, so such a tab answers when it is shown again.

## Files copied from FigCraft

`app/src/web.rs`, `main.rs`, `kept.rs`, `local_fonts.rs`, `pasted.rs`, `query.rs` and `recovery.rs` come from `apps/figcraft-web/src/` at `35684eaa028e` (MIT OR Apache-2.0, see the root `LICENSE-MIT` and `LICENSE-APACHE`, and `NOTICE`) and say so in their first lines. They are copied because `apps/figcraft-web` is a binary crate, not a library.

- `web.rs`: the eframe runner and browser services. Changed to wrap the app in `Rc<RefCell<..>>`, start the Band bridge and run it after each frame (marked `wrapper:`), and turn a File > Save download into a save request. Other downloads (exports, plugins) are refused when framed, because Band has no place to put them.
- `main.rs`: `mod editor` and `mod mcp` added, `mod api`, `mod saved_files` and the test modules dropped.
- `query.rs`: `control` dropped.
- `kept.rs`, `local_fonts.rs`, `pasted.rs`, `recovery.rs`: unchanged. In a sandboxed frame the browser refuses local storage, so `kept` and `recovery` find none and do nothing.
- `index.html` and `Trunk.toml` are adapted: the crate is `figcraft-band`, `dist` is `../dist/web`, and a head script keeps the Band hello port.
- `Cargo.toml` repeats FigCraft's `[workspace.lints]`, `[profile.release]`, `[profile.web-release]` and `[patch.crates-io]`, because Cargo ignores those in a dependency.
- `Cargo.lock` started as FigCraft's lock at that rev, so egui, wgpu and the rest resolve to the versions FigCraft tests. Cargo drops the entries FigCraft's other crates need.
- The root `rustfmt.toml` repeats FigCraft's formatting settings, which the copied files follow.

## Dropped from the web build

- `app/src/api.rs` and `saved_files.rs`: `window.figcraft` (the `?control` page API) and its captured downloads. The MCP tools do that job over Band's port.
- The tests of the copied modules (`query_tests.rs`, `recovery_tests.rs`), which need the upstream test setup.

## Upgrading the pinned rev

1. Change `rev` for the `figcraft-*` entries in `Cargo.toml`.
2. Diff `apps/figcraft-web/src/*.rs`, `index.html` and `Trunk.toml` between the old and new rev, and port the changes into the copies.
3. Copy FigCraft's `[patch.crates-io]`, `[profile.*]`, `[workspace.lints]` and the egui, eframe versions from its root `Cargo.toml`. Replace `Cargo.lock` with FigCraft's at the new rev, then `cargo update -p` as needed. If `wasm-bindgen` changes, CI follows the new lock version by itself.
4. Bump `version` in `band-extension.json` (the first three parts follow FigCraft, the last is this wrapper's revision), then tag.
