# craft-extensions

[Band](https://github.com/amirilovic/band) editor extensions for the ArtCraft apps. Each extension is a web build of one app that Band frames in a sandboxed iframe, so a person edits a file in a Band tab and an agent edits the same open document through the app's MCP tools.

| Extension | Opens | App |
|---|---|---|
| [gridcraft](extensions/gridcraft/README.md) | `*.xlsx`, `*.csv` | [GridCraft](https://github.com/storytold/gridcraft) |

## Install a release on a hub

A release asset is a tarball with one top-level folder named after the extension. It holds the built web files, so the hub machine needs no Rust.

```sh
VERSION=0.7.0-1
curl -fsSL -O "https://github.com/band-app/craft-extensions/releases/download/gridcraft-v$VERSION/gridcraft-$VERSION.tar.gz"
curl -fsSL -O "https://github.com/band-app/craft-extensions/releases/download/gridcraft-v$VERSION/gridcraft-$VERSION.tar.gz.sha256"
shasum -a 256 -c "gridcraft-$VERSION.tar.gz.sha256"
mkdir -p ~/.band/extensions
tar -xz -C ~/.band/extensions -f "gridcraft-$VERSION.tar.gz"
band extensions reload
band extensions list
```

Replace `~/.band` with your `BAND_HOME` if you changed it. The `curl | tar` form also works: `curl -fsSL <asset url> | tar -xz -C ~/.band/extensions`.

While this repository is private, `curl` gets a 404. Download with the GitHub CLI and a token that can read the repository instead:

```sh
gh release download "gridcraft-v$VERSION" --repo band-app/craft-extensions --pattern "gridcraft-$VERSION.tar.gz*"
```

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
scripts/check-tag.sh    checks a release tag against the manifest version
.github/workflows/      ci.yml (pull requests and main) and release.yml (tags)
```

## CI and releases

- `ci.yml` runs on pull requests and on pushes to main. It builds only the extensions whose files changed under `extensions/<name>/`. A change to `crates/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `rustfmt.toml`, `scripts/` or `.github/` builds all of them. A change to anything else, such as this README, builds nothing. Each build runs `cargo fmt --check`, clippy for native and wasm32, the tests, `scripts/package.sh`, and the extension's `verify.mjs` in headless Chrome with SwiftShader. The tarball is uploaded as an artifact. Require the `ci` job in branch protection: it passes when every build passed or none was needed.
- `release.yml` runs on a tag `<ext>-v<version>`. It fails at once unless the version in the tag equals `version` in `extensions/<ext>/band-extension.json` (`scripts/check-tag.sh <tag>` runs the same check locally). Then it packages the extension and creates a GitHub release with the tarball and the `.sha256`. Started by hand with an extension name (Actions > Release > Run workflow), it builds the same files as an artifact and creates no release.

To release: bump `version` in the manifest, merge, then `git tag gridcraft-v<version> && git push origin gridcraft-v<version>`.

## Add an extension

1. Create `extensions/<name>/app/` with a crate named `<name>-band` and add it to `members` in the root `Cargo.toml`. Its `Trunk.toml` writes to `../dist/web`, and its `index.html` keeps the `band:hello` script from the GridCraft one, which holds the port until the wasm has loaded.
2. Depend on `band-editor` and implement `band_editor::Editor` for the app: open bytes, report when the file is open, reload, report dirty, encode for save, learn whether Band accepted the save, and answer MCP requests. In `main`, call `band_editor::Bridge::listen()`, give it a repaint function with `set_repaint`, and call `Bridge::sync(&mut editor)` once per frame after the app has drawn. `extensions/gridcraft/app/src/editor.rs` is the worked example.
3. Add a `tools-json` binary to the crate. It builds the app's MCP server over a backend that answers nothing, and prints `band_editor::tools_json::render(..)` with the tools an agent must not call (such as saving) listed in `not_for_agents`. `scripts/package.sh` runs it as `cargo run -p <name>-band --bin tools-json`.
4. Write `extensions/<name>/band-extension.json` (id equal to the folder name) and a `NOTICE`. The root `LICENSE-MIT` and `LICENSE-APACHE` are added to every tarball.
5. Add `extensions/<name>/verify.mjs`, which plays Band against `extensions/<name>/dist/web` (or `$DIST`) and exits non-zero on failure. Copy `extensions/gridcraft/verify.mjs` and change the fixture file.
6. CI picks the new folder up from `extensions/` with no matrix to edit, as long as the CI step that runs `verify.mjs` finds yours at `extensions/<name>/verify.mjs`.
7. Upstream code you copy gets a header naming the source and rev, and a line in the extension's README.

## Licenses

MIT OR Apache-2.0, like GridCraft. See `LICENSE-MIT`, `LICENSE-APACHE` and each extension's `NOTICE`.
