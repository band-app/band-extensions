# band-extensions

Official extensions for [Band](https://github.com/band-app/band). Five are editors for the ArtCraft apps: each is a web build of one app that Band frames in a sandboxed iframe, so a person edits a file in a Band tab and an agent edits the same open document through the app's MCP tools. One, the simulator, is a worker service with a panel and agent tools.

| Extension | Opens | App |
|---|---|---|
| [gridcraft](extensions/gridcraft/README.md) | `*.xlsx`, `*.csv` | [GridCraft](https://github.com/storytold/gridcraft) |
| [wordcraft](extensions/wordcraft/README.md) | `*.docx`, `*.odt`, `*.rtf` | [WordCraft](https://github.com/storytold/wordcraft) |
| [deckcraft](extensions/deckcraft/README.md) | `*.pptx` | [DeckCraft](https://github.com/storytold/deckcraft) |
| [figcraft](extensions/figcraft/README.md) | `*.figcraft`, `*.fig` | [FigCraft](https://github.com/storytold/figcraft) |
| [vectorcraft](extensions/vectorcraft/README.md) | `*.svg`, `*.svgz`, `*.vectorcraft` | [VectorCraft](https://github.com/storytold/vectorcraft) |
| [simulator](extensions/simulator/README.md) | a Simulator panel and nine `simulator_*` agent tools | iOS Simulator on a Mac worker, through [serve-sim](https://github.com/EvanBacon/serve-sim) |

## Install from Band

Band lists these extensions under Settings > Extensions. The hub reads one file, `https://github.com/band-app/band-extensions/releases/download/catalog/index.json`, an asset of the release tagged `catalog`. An admin clicks Install, or Update to vX when a newer version is listed. `band extensions install --official <id>` does the same from the CLI. The Catalog workflow regenerates the file after every release, from the newest release of each extension, and `scripts/catalog.mjs` writes it.

Versions are plain `MAJOR.MINOR.PATCH`, because Band's catalog skips any other form. The wrapper versions that earlier releases used (`0.7.0-1`) are gone: gridcraft is `0.7.1`, wordcraft and deckcraft and figcraft are `0.15.1`, vectorcraft is `0.21.1`. The upstream app version is in each extension's README.

## Install a release on a hub by hand

A release asset is a tarball with one top-level folder named after the extension. It holds the built web files, so the hub machine needs no Rust.

```sh
VERSION=0.7.1
curl -fsSL -O "https://github.com/band-app/band-extensions/releases/download/gridcraft-v$VERSION/gridcraft-$VERSION.tar.gz"
curl -fsSL -O "https://github.com/band-app/band-extensions/releases/download/gridcraft-v$VERSION/gridcraft-$VERSION.tar.gz.sha256"
shasum -a 256 -c "gridcraft-$VERSION.tar.gz.sha256"
mkdir -p ~/.band/extensions
tar -xz -C ~/.band/extensions -f "gridcraft-$VERSION.tar.gz"
band extensions reload
band extensions list
```

Replace `~/.band` with your `BAND_HOME` if you changed it. The `curl | tar` form also works: `curl -fsSL <asset url> | tar -xz -C ~/.band/extensions`.

Tags are per extension (`<extension>-v<version>`), so extensions release on their own schedule.

## Build and install from source

Needs the Rust toolchain in `rust-toolchain.toml`, `trunk` 0.21.14, Node and `gzip`. `brotli` is optional and adds `.br` copies.

```sh
scripts/package.sh gridcraft                  # dist/gridcraft-<version>.tar.gz and .sha256
scripts/install.sh gridcraft ~/.band          # package, then unpack into ~/.band/extensions/
```

A cold wasm build takes about 6 minutes. Set `CARGO_TARGET_DIR` outside the repository to reuse build output between worktrees, and `SKIP_BUILD=1` to repackage an existing `extensions/<ext>/dist/web`.

## Layout

```
crates/band-editor/     Band's editor protocol over a MessagePort, the Editor trait each app implements,
                        and the tools.json generator
extensions/<name>/      band-extension.json, NOTICE, README.md, verify.mjs, and app/ (the crate named
                        <name>-band, Trunk.toml, index.html)
scripts/package.sh      build, tools.json, compressed copies, tarball and checksum
scripts/install.sh      package and unpack into a Band home
scripts/next-versions.mjs  plans which extensions to release and their versions (tests: next-versions.test.mjs)
scripts/catalog*.mjs    the catalog generator, Band's catalog schema (a copy) and their tests (npm test)
extensions/<name>/catalog.json  the description and minBand the catalog lists
.github/workflows/      ci.yml (pull requests and main), release.yml (main) and catalog.yml (index.json)
```

## Compact layout and selection

Band adds two optional messages to the editor protocol. The extension API stays 1, and an old editor or an old Band ignores what it does not know.

- Band to editor: `init` may carry `layout: "compact" | "regular"`, and Band sends `{ type: "layout", layout }` when it changes. Compact is a phone-width page or the iOS app. The editor hides ribbons, toolbars and side panels, sizes its interface for touch, and restores the normal interface on `regular`. An unknown value changes nothing.
- Editor to Band: `{ type: "selection", selection }` when the selection has stayed the same for 250 ms. `selection` is `null` when nothing is selected, otherwise `{ address, kind, label, text?, rect? }`. `address` is what the editor's own tools accept, `label` is short text for a person, `text` is the selected content cut to 4 KB with a trailing "…", and `rect` is in the editor's document units.

`crates/band-editor` does the protocol work. An app implements two optional `Editor` methods, `set_layout(Layout)` and `selection() -> Option<Selection>`, and `Bridge::sync` calls `selection()` every frame and sends only a change.

While the layout is compact, the bridge also puts a touch shim in front of eframe (`crates/band-editor/src/touch.rs`). A tap reaches the app as a tap, so it selects. A one-finger drag becomes wheel events on the canvas, so it scrolls or pans and does not select. Two-finger gestures do nothing in compact mode. A touch that starts on an element marked `data-native-touch`, or inside one, is left alone, so an extension can put its own HTML over the canvas.

| Extension | Compact | Selection address | Kind |
|---|---|---|---|
| gridcraft | ribbon collapsed, formula and status bars off, interface 125% | `Sheet1!B2:C4` (a quoted sheet name when it has spaces), with the range as TSV in `text` | `cell`, `range` |
| deckcraft | an HTML preview of the slides first (Edit opens the editor): ribbon collapsed, task pane and notes closed, slide list at its narrowest. See [its README](extensions/deckcraft/README.md#compact-preview) | `slide<index>!<shape id>`, the index `go_to_slide` takes (from 0) and the id `inspect_slide` lists | `shape`, `text` |
| wordcraft | ribbon, quick access toolbar and navigation pane hidden, interface 125% | the `{"anchor": Pos, "focus": Pos}` JSON that `execute select.range` takes | `paragraph` (a caret), `text` |
| figcraft | left panel closed, interface minimized (it already shows one panel at a time below its narrow width) | the node id that `get_node` takes | `node`, `text` |
| vectorcraft | VectorCraft's own Touch workspace | the node id, for the control channel (the web build lists no MCP tools) | `element` |

Gaps that need a change in the upstream app:

- DeckCraft cannot hide its slide list, so a compact page keeps a 150 point strip of thumbnails. It needs a toggle for the thumbnail pane in `UiState`.
- GridCraft, WordCraft and DeckCraft keep a tab row (and DeckCraft a title bar) when the ribbon is collapsed. Their tab rows do not wrap, so the last tabs run off a 390 pixel frame.
- GridCraft always has an active cell, so it reports `null` only when no workbook is open.
- VectorCraft has no agent tools on wasm, so its selection address cannot be checked against an MCP tool. `verify.mjs` checks it against `document.inspect` on the control channel.

`scripts/verify-compact.mjs` holds the scenarios every `verify.mjs` runs at 390x844 (an optional `afterOpen` hook lets an extension that opens a preview first press Edit) with CDP touch events: compact against regular screenshots, a one-finger drag, a tap that selects, the address in the app's own tool, clearing the selection, and an `init` without `layout`.

## CI and releases

- `ci.yml` runs on pull requests and on pushes to main. It builds only the extensions whose files changed under `extensions/<name>/`. A change to `crates/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `rustfmt.toml`, `scripts/` or `.github/` builds all of them. A change to anything else, such as this README, builds nothing. Each build runs `cargo fmt --check`, clippy for native and wasm32, the tests, `scripts/package.sh`, and the extension's `verify.mjs` in headless Chrome with SwiftShader. The tarball is uploaded as an artifact. Require the `ci` job in branch protection: it passes when every build passed or none was needed.
- `release.yml` runs on every push to main and releases each extension whose code changed. `scripts/next-versions.mjs` finds the latest `<ext>-v*` release of each extension and decides:
  - No release yet: the manifest version is released.
  - The manifest version is above the latest release: it is released as written. This is how you ship a major bump.
  - Otherwise, if a commit since the latest release touched `extensions/<ext>/`: a minor bump when any such commit title starts with `feat`, a patch bump for anything else. `feat!:` and `BREAKING CHANGE` do not bump the major version.
  - Otherwise nothing. A change under `scripts/`, `crates/`, the root files or the README releases nothing. Merge a trivial change under the extension's folder to force a release.

  One run handles every extension that changed. It commits the new versions to main as `chore(release): gridcraft v0.7.2, wordcraft v0.15.2` (pushed with `GITHUB_TOKEN`, so it starts no workflow), builds each tarball from that commit, creates the release `<ext>-v<version>` with the tarball and `.sha256`, then regenerates the catalog once. Runs queue in the `release` concurrency group. If the push loses a race with another commit to main, the job rebases and pushes again. If main gets branch protection, the Actions bot needs a bypass for that push.

  Versions are plain `MAJOR.MINOR.PATCH`, because the catalog accepts nothing else. To release 1.0.0, set `version` to `1.0.0` in the manifest and merge. Do not edit the version for routine fixes.

  Started by hand (Actions > Release > Run workflow), the workflow is a dry run. It prints the plan, applies the versions in its own checkout, builds the tarballs as artifacts, and neither pushes nor releases. Locally, `node scripts/next-versions.mjs plan --releases releases.json` prints the plan from a JSON list of tag names (without `--releases` it asks `gh release list`), and `node --test scripts/next-versions.test.mjs` runs the tests.

## Add an extension

1. Create `extensions/<name>/app/` with a crate named `<name>-band` and add it to `members` in the root `Cargo.toml`. If the app needs its own `[patch]` section or lock file (WordCraft does), give `extensions/<name>/Cargo.toml` a `[workspace]` instead, put `exclude = ["extensions/<name>"]` in the root `Cargo.toml`, and keep a `Cargo.lock` there. `scripts/package.sh`, `ci.yml` and `release.yml` then run Cargo from `extensions/<name>/`. `extensions/wordcraft` is the example. Its `Trunk.toml` writes to `../dist/web`, and its `index.html` keeps the `band:hello` script from the GridCraft one, which holds the port until the wasm has loaded.
2. Depend on `band-editor` and implement `band_editor::Editor` for the app: open bytes, report when the file is open, reload, report dirty, encode for save, learn whether Band accepted the save, and answer MCP requests. In `main`, call `band_editor::Bridge::listen()`, give it a repaint function with `set_repaint`, and call `Bridge::sync(&mut editor)` once per frame after the app has drawn. `extensions/gridcraft/app/src/editor.rs` is the worked example.
3. Add a `tools-json` binary to the crate. It builds the app's MCP server over a backend that answers nothing, and prints `band_editor::tools_json::render(..)` with the tools an agent must not call (such as saving) listed in `not_for_agents`. `scripts/package.sh` runs it as `cargo run -p <name>-band --bin tools-json`.
4. Write `extensions/<name>/band-extension.json` (id equal to the folder name) and a `NOTICE`. The root `LICENSE-MIT` and `LICENSE-APACHE` are added to every tarball.
5. Add `extensions/<name>/verify.mjs`, which plays Band against `extensions/<name>/dist/web` (or `$DIST`) and exits non-zero on failure. Copy `extensions/gridcraft/verify.mjs` and change the fixture file.
6. CI picks the new folder up from `extensions/` with no matrix to edit, as long as the CI step that runs `verify.mjs` finds yours at `extensions/<name>/verify.mjs`.
7. Upstream code you copy gets a header naming the source and rev, and a line in the extension's README.

## Licenses

MIT OR Apache-2.0, like GridCraft. See `LICENSE-MIT`, `LICENSE-APACHE` and each extension's `NOTICE`.
