# DeckCraft

A web build of [DeckCraft](https://github.com/storytold/deckcraft) that runs as a Band editor extension. Band frames it in `<iframe sandbox="allow-scripts">` and speaks its editor protocol over a `MessagePort`. The extension opens `*.pptx` and saves the presentation as `.pptx`.

DeckCraft's crates are git dependencies pinned at rev `1eec8b266cba` (the head of `main` in `storytold/deckcraft` when this was written, app version 0.15.0). Nothing in DeckCraft is edited, patched or vendored. Install and release steps are in the [root README](../../README.md).

This extension is its own Cargo workspace (`extensions/deckcraft/Cargo.toml`, with its own `Cargo.lock`), unlike GridCraft, which is a member of the root workspace. DeckCraft builds against forks of egui, winit and krilla through a `[patch.crates-io]` section, and Cargo ignores a dependency's `[patch]`, so the section is repeated here. A patch in the root workspace would change GridCraft's build. Build and check from this directory:

```sh
cd extensions/deckcraft
cargo fmt --check
cargo clippy -- -D warnings
cargo clippy --target wasm32-unknown-unknown -- -D warnings
```

## What the files do

- `app/src/editor.rs` implements `band_editor::Editor` for DeckCraft. The shared bridge in `crates/band-editor` handles the port, `init`, `ready`, `dirty`, `save`, `saved`, `saveFailed`, `reload` and `mcp`. It opens the file with DeckCraft's own `file.openBytes` command and tracks the presentation by its `uid`, so a second presentation opened by a tool call or a drop is never the one Band saves. It encodes with `deckcraft_engine::cmd::file::save_bytes(.., "pptx")`.
- `app/src/mcp.rs` answers `mcp` messages with DeckCraft's own MCP server (`deckcraft-mcp`, the one behind `deckcraft-cli mcp`), so an agent gets the same tools as the CLI. It answers `screenshot` itself, because the stock tool depends on the desktop app's capture loop: the wrapper sends egui's `ViewportCommand::Screenshot`, waits for the callback, and encodes the image as PNG into an MCP image block. Waiting 3 frames first lets earlier edits draw.
- `app/src/tools_json.rs` prints `tools.json` (`{ "tools": [...] }`, the `tools/list` answer of the same `deckcraft_mcp::Server`). `new_presentation`, `open_presentation`, `save_presentation` and `export` carry `"agent": false`, because they take file paths or replace the open presentation, and the browser has no file system. It needs no browser.
- `verify.mjs` plays Band in headless Chrome: a test page frames the build from another origin with `sandbox="allow-scripts"`, so the frame has a `null` origin. It checks `init`, `ready`, `dirty`, `save`, `saved`, `saveFailed`, `reload` and `mcp` (`tools/list` against `tools.json`, an edit, a screenshot) on `fixtures/sample.pptx`, and that forged messages from a sibling frame are ignored. Run it after packaging:

  ```sh
  PLAYWRIGHT=<path to playwright-core> node extensions/deckcraft/verify.mjs
  ```

  DeckCraft renders in headless Chrome only with `--enable-unsafe-swiftshader`, which the script passes.
- `fixtures/sample.pptx` is a one-slide presentation written by DeckCraft's `file.saveBytes` at the pinned rev.

File > Save inside DeckCraft counts as a save request when it would download a `.pptx` or `.deckcraft` file. Other downloads (PDF, pictures, Save As to another format) have nowhere to go and are dropped with a log warning.

A frame scrolled out of view or in a background tab stops drawing, and MCP requests are answered on the frame loop, so such a tab answers when it is shown again.

## Files copied from DeckCraft

`app/src/web.rs` and `app/src/main.rs` come from `apps/deckcraft-web/src/` at `1eec8b266cba` (MIT OR Apache-2.0, see the root `LICENSE-MIT` and `LICENSE-APACHE`, and `NOTICE`) and say so in their first lines. They are copied because `apps/deckcraft-web` is a binary crate, not a library.

- `web.rs`: the eframe runner and browser services (picker, download, drops). Changed to wrap the app in `Rc<RefCell<..>>`, start the Band bridge and run it after each frame (marked `wrapper:`), and skip the sample deck when Band frames the page.
- `main.rs`: `mod presenter` replaced by `mod editor` and `mod mcp`.
- `index.html` and `Trunk.toml` are adapted. The icon link is dropped, because the icon lives in DeckCraft's repo, and a head script keeps the Band hello port.
- `NOTICE` is DeckCraft's own, unchanged.
- The root `rustfmt.toml` matches DeckCraft's formatting settings, which the copied files follow.
- `Cargo.lock` started as DeckCraft's lock at that rev, so egui, wgpu and the rest resolve to the versions DeckCraft tests. `[profile.release]` and `[patch.crates-io]` are repeated in `Cargo.toml`, minus the patches for crates the extension does not use.

## Dropped from the web build

- `presenter.rs` and the presenter popup. It opens a same-origin popup window, and a sandboxed frame without `allow-popups` cannot. The slide show runs in the frame instead.
- `*.deckcraft` is not in the selector. Band's `binary` flag would work for it, but a save always writes `.pptx`, so a `.deckcraft` file would be overwritten with another format.

## Upgrading the pinned rev

1. Change `rev` for the three `deckcraft-*` entries in `Cargo.toml`.
2. Diff `apps/deckcraft-web/src/{main,web}.rs`, `index.html` and `Trunk.toml` between the old and new rev, and port the changes into the copies. `presenter.rs` upstream is not used here.
3. Replace `Cargo.lock` with DeckCraft's at the new rev, then `cargo update -p` as needed. Copy the `[patch.crates-io]` section and keep `egui`, `eframe`, `rfd` and `image` in sync with DeckCraft's `[workspace.dependencies]`. If `wasm-bindgen` changes, CI follows the new lock version by itself.
4. Bump `version` in `band-extension.json` (the first three parts follow DeckCraft, the last is this wrapper's revision), then tag.

## Compact layout and selection

`DeckcraftEditor::set_layout` collapses the ribbon, closes the task pane and notes, and sets the slide list to its narrowest width (150 points). `selection` reports the first selected shape as `slide<index>!<shape id>`, with the shape's text, or the selected text when a range inside it is selected. `inspect_slide {index}` lists the shape with that id. The protocol is described in the [root README](../../README.md#compact-layout-and-selection), and `verify.mjs` runs the shared scenarios from `scripts/verify-compact.mjs`.

## Compact preview

In the compact layout the extension opens a preview first and shows the egui editor only after the person presses **Edit**. The regular layout opens the editor directly and never shows the preview.

- `app/index.html` holds the preview as plain HTML over the canvas (`window.bandPreview`): a horizontal scroll-snap track with one slide per screen, a slide counter, previous and next buttons, arrow and page keys, pinch zoom and double tap zoom (up to 4x, panned by native scrolling), and a Notes toggle that shows the slide's speaker notes as selectable text.
- `app/src/preview.rs` draws the slides. For a slide near the one on screen it calls `deckcraft_engine::cmd::file::render_png` (the renderer behind `render_slide`) at 1200 pixels wide and hands the PNG to the page as a `blob:` URL. It draws one slide per frame and the page keeps the current slide and one on each side, so a long deck stays responsive. Nothing leaves the frame.
- `DeckcraftEditor::preview_frame` runs after every `Bridge::sync`. It compares the open presentation's allocation with the one the preview was built from. A `reload`, an edit in the editor and an agent's tool call each replace it, and the preview redraws the slides it shows. The pictures stay on screen until the new ones arrive.
- Edit and the **Preview** pill shown over the editor only switch which view is visible. The presentation, its unsaved edits, the dirty state and saving stay in the editor, so none of them changes. Layout changes keep the choice: after Edit, a switch to regular and back to compact stays in the editor.
- The page also listens on Band's port for `init.theme` and `theme` and sets the preview's colors from the `background`, `foreground`, `muted-foreground`, `border`, `primary` and `primary-foreground` tokens. The slides keep their own colors. Without tokens it follows the system color scheme.
- The preview reports no `selection`. A picture has no shapes to address, so while the preview is up the extension sends `null`, and the editor's selection returns when Edit is pressed.
- While the preview is up it swallows key events, so an arrow key pages through slides and never nudges a shape in the editor behind it.

The touch shim in `crates/band-editor` swallows every touch in compact mode and replays it on the canvas, which would break taps and scrolling on the preview. It leaves a touch alone when it starts inside an element marked `data-band-native`, and the preview's root and the Preview pill carry that attribute.

`verify.mjs` covers the preview with real touch input (swipe, pinch, Edit and Notes). The next button and the Preview pill get a `click` event instead of a tap, because headless Chrome drops pointer input to this framed page below about y=750.
