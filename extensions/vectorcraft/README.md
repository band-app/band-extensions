# VectorCraft

A web build of [VectorCraft](https://github.com/storytold/vectorcraft) that runs as a Band editor extension. Band frames it in `<iframe sandbox="allow-scripts">` and speaks its editor protocol over a `MessagePort`. The extension opens `*.svg`, `*.svgz` and `*.vectorcraft`, and saving writes the format the file was opened in.

VectorCraft's crates are git dependencies pinned at rev `1008166fa7c6` (the head of `main` on 2026-11-03, version 0.21.0). Nothing in VectorCraft is edited, patched or vendored. Install and release steps are in the [root README](../../README.md).

## No agent tools

`tools.json` lists no tools. VectorCraft's MCP server (`vectorcraft-mcp`) does not build for `wasm32-unknown-unknown`: `crates/mcp/src/headless.rs` calls `vectorcraft_format::write_atomic`, which the format crate compiles out on wasm. Fixing that means a change in VectorCraft, so the extension ships the editor without tools. `editor.rs` answers an `mcp` message with a JSON-RPC error. When VectorCraft builds the server for wasm, add `app/src/mcp.rs` as in `extensions/gridcraft`, list the tools in `tools-json`, and mark `open_file` and `save_file` as `"agent": false`.

## Why a workspace of its own

VectorCraft patches egui, eframe and winit (`[patch.crates-io]` in its root `Cargo.toml`) and needs its own `Cargo.lock`. `extensions/vectorcraft` is its own Cargo workspace, excluded from the root workspace, so those patches and versions do not touch the other extensions. It depends on `band-editor` by path. Build and check from this folder:

```sh
cd extensions/vectorcraft
cargo fmt --check
cargo clippy --target wasm32-unknown-unknown --all-targets -- -D warnings
cd app && trunk build --release
```

The VectorCraft crates are dependencies of the wasm target only, so the native `tools-json` binary compiles little.

## What the files do

- `app/src/editor.rs` implements `band_editor::Editor` for VectorCraft. The shared bridge in `crates/band-editor` handles the port, `init`, `ready`, `dirty`, `save`, `saved`, `saveFailed`, `reload` and `mcp`.
  - When Band opens a file, the editor gives the new document the file's name as its path and sets its format to the file's, so VectorCraft's File > Save (and Cmd+S) writes it without a dialog. Without that, a document opened from bytes saves as the native format.
  - VectorCraft's download service is replaced by `SaveHook`. A download whose extension is the open file's extension is the encoded file, and becomes a `save` message. Any other download (PDF or PNG export, Save As to another format) fails with a message in VectorCraft, because it has nowhere to go.
  - Band's `requestSave` runs File > Save and takes the bytes from the same hook.
  - VectorCraft marks a document saved as soon as its download service accepts the bytes. The editor puts the saved mark back to the document as of the last confirmed save, so the tab stays dirty until Band sends `saved`, and after `saveFailed`.
- `app/src/tools_json.rs` prints `tools.json`, an empty list (see above).
- `app/flatten-snippets.mjs` is a Trunk post-build hook. wasm-bindgen writes eframe's JS snippet into `snippets/`, and `scripts/package.sh` copies files but not folders, so the hook moves the snippet next to the loader and points the loader's `import` and the preload link at it. `index.html` sets `data-integrity="none"` because the hook changes the loader after Trunk hashes it.
- `verify.mjs` plays Band in headless Chrome: a test page frames the build from another origin with `sandbox="allow-scripts"`, so the frame has a `null` origin. For `.svg`, `.svgz` and `.vectorcraft` it checks `init`, `ready`, `dirty`, `save` (in the file's format, holding the edit), `saved`, `saveFailed`, that the saved bytes reopen with the edit, VectorCraft's own File > Save, `reload`, and that an `mcp` request gets an error. It also checks that forged and junk messages are ignored. Edits are made through `window.vectorcraft` inside the frame, which Playwright reaches over CDP. Run it after `scripts/package.sh vectorcraft`:

  ```sh
  PLAYWRIGHT=<path to playwright-core> node extensions/vectorcraft/verify.mjs
  ```

  VectorCraft renders in headless Chrome only with `--enable-unsafe-swiftshader`, which the script passes.

Data Recovery is gone: it kept copies in browser storage and Web Locks, which a sandboxed frame does not have, and Band owns the file.

## Formats

`*.svg`, `*.svgz` and `*.vectorcraft` are the formats VectorCraft opens and writes with its web services. PDF, `.ai` and EPS are left out: VectorCraft writes them, but reading them back does not return the same document, so a save would lose editable content. Opening an SVG that has features VectorCraft cannot read keeps only what it reads, and saving writes that back.

## Files copied from VectorCraft

`app/src/{web,main,api,fonts,keys,pencil,saved_files}.rs` come from `apps/vectorcraft-web/src/` at `1008166fa7c6` (MIT OR Apache-2.0, see the root `LICENSE-MIT` and `LICENSE-APACHE`, and `NOTICE`) and say so in their first lines. They are copied because `apps/vectorcraft-web` is a binary crate, not a library.

- `web.rs`: changed to share the app as `Rc<RefCell<Option<..>>>`, start the Band bridge and run it after each frame (marked `wrapper:`), and drop Data Recovery (`BrowserStore`, `locks.rs`).
- `main.rs`: `mod editor` added, the `locks` module removed, the docs shortened.
- `api.rs`, `fonts.rs`, `keys.rs`, `pencil.rs`, `saved_files.rs`: verbatim.
- `index.html` and `Trunk.toml` are adapted: the icon links are dropped because the icons live in VectorCraft's repo, the head script keeps Band's hello port, and the font-copy hook (`cargo xtask web-fonts`) is replaced by `flatten-snippets.mjs`. VectorCraft's `WEB_FONTS` list is empty in a build without craft-fonts, so no font files are fetched.
- `NOTICE` and `clippy.toml` are copied, and the lints in `Cargo.toml` repeat VectorCraft's `[workspace.lints]`, which the copied files follow.
- `Cargo.lock` started as VectorCraft's lock at that rev, so egui, wgpu and the rest resolve to the versions VectorCraft tests. `[profile.release]` and `[patch.crates-io]` are repeated in `Cargo.toml` because Cargo reads both from the root workspace only.

## Upgrading the pinned rev

1. Change `rev` for the `vectorcraft-*` entries in `Cargo.toml`.
2. Diff `apps/vectorcraft-web/src/*.rs`, `index.html` and `Trunk.toml` between the old and new rev, and port the changes into the copies.
3. Copy `[patch.crates-io]` and the egui, eframe and rfd versions from VectorCraft's root `Cargo.toml`. Replace `Cargo.lock` with VectorCraft's at the new rev, then `cargo update -p` as needed. Raise `rust-toolchain.toml` at the repo root if VectorCraft's `rust-version` needs it (1.95 at this rev).
4. Check whether `vectorcraft-mcp` builds for `wasm32-unknown-unknown`. If it does, add the MCP bridge (see "No agent tools").
5. Bump `version` in `band-extension.json` (the first three parts follow VectorCraft, the last is this wrapper's revision), run `scripts/package.sh vectorcraft` and `verify.mjs`, then tag.

## Measured costs

Release build, rev `1008166fa7c6`: wasm 83.5 MB raw, about 29 MB gzip -9 (the tarball is 75 MB with the `.gz` and `.br` copies). From `band:hello` to `ready` takes 0.4 s once the wasm is cached by the test server. A cold release build takes about 12 minutes on Apple silicon.
