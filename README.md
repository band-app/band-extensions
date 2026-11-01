# gridcraft-webmcp

A web build of [GridCraft](https://github.com/storytold/gridcraft) that serves GridCraft's own MCP tools to a host page over `postMessage`, so a browser tab can expose them as WebMCP tools. GridCraft's crates are git dependencies pinned at rev `e6b6b349708a`. Nothing in GridCraft is edited, patched or vendored. This is a spike, not a product.

## Build and run

```sh
cd app
RUSTUP_TOOLCHAIN=1.95 CARGO_TARGET_DIR=/tmp/gridcraft-webmcp-target trunk build --release
```

The output is `dist/web`. Serve it from any static server (wasm needs `application/wasm`) and open:

- `index.html?sample=sales` for the stock app.
- `host.html` for the host page, which frames `index.html?host=parent` and registers the tools.

A cold build takes about 6 minutes, an incremental one about 2. `scripts/verify.mjs` runs the end-to-end checks in headless Chrome (`PLAYWRIGHT=<path to playwright-core> node scripts/verify.mjs`).

## How it works

```
agent -> document.modelContext tool -> host.html -> postMessage -> app/src/mcp.rs -> gridcraft-mcp Server -> control::handle -> SheetApp
```

- The page posts `{ type: "gridcraft:mcp", message }` with one MCP JSON-RPC message, and gets the response back in the same envelope with the same `id`. Notifications get no reply.
- `app/src/mcp.rs` feeds each message to `gridcraft_mcp::Server`. Its `Backend` runs `gridcraft_ui_egui::control::handle` on the live `SheetApp` during the frame loop. The tools are the same 21 as `gridcraft-cli mcp`, and the check against a CLI built from the same rev passes.
- `app/host.html` knows no tool names. It runs `initialize` and `tools/list`, then registers every tool on `document.modelContext`. It installs a recording stand-in only when the browser has none, and never replaces an existing one, so Band's shim wins.
- Two stock tools do not work on wasm, so `mcp.rs` answers them itself and passes every other call to the server unchanged:
  - `screenshot` needs `ui.screenshot`, which times shots with `now_ms()` (always 0 on wasm) and never finishes. The wrapper sends egui's `ViewportCommand::Screenshot`, waits for the `Event::Screenshot` frame, and encodes it with `control::save_image` into an MCP image block. It reads egui's frame buffer, so there is no WebGL `toDataURL` blank-canvas problem. Waiting 3 frames first lets earlier edits draw.
  - `save_workbook` calls `file.save` with a path, and the browser has no file system ("no file system in the browser"). The wrapper runs `file.saveAs`, which hands `.xlsx` bytes to the app's download service, so the host page receives `gridcraft:save` as it does for File > Save As. The `path` argument is ignored.
- `gridcraft:open`, `gridcraft:save`, `gridcraft:dirty` and `gridcraft:ready` are GridCraft's stock host bridge, unchanged.

## Files copied from GridCraft

All three come from `apps/gridcraft-web/src/` at `e6b6b349708a`, are MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE` and `NOTICE` are copied to the root), and say so in their first lines.

- `app/src/host.rs`: the stock `?host=parent` bridge, verbatim. Reusing it keeps `gridcraft:open/save` identical to the stock build.
- `app/src/web.rs`: the eframe runner and browser services (picker, download, clipboard, print). Changed only to wrap the app in `Rc<RefCell<..>>` and call `McpHost::new` and `McpHost::frame` (marked `wrapper:`).
- `app/src/main.rs`: `mod mcp` added.
- `app/index.html` and `app/Trunk.toml` are adapted. The icon link is dropped, because the icon lives in GridCraft's repo, and `host.html` is copied to `dist`.
- `Cargo.lock` started as GridCraft's lock at that rev, so egui, wgpu and the rest resolve to the versions GridCraft tests. `[profile.release]` is repeated in the root `Cargo.toml` because Cargo ignores a dependency's profile.

They are copied because `apps/gridcraft-web` is a binary crate, not a library, so its shell cannot be depended on.

## Upgrading the pinned rev

1. Change `rev` for the three `gridcraft-*` entries in the root `Cargo.toml`.
2. Diff `apps/gridcraft-web/src/{main,web,host}.rs`, `index.html` and `Trunk.toml` between the old and new rev, and port the changes into the copies.
3. Replace `Cargo.lock` with GridCraft's at the new rev, then `cargo update -p` as needed. Keep `egui`, `eframe` and `rfd` in sync with GridCraft's `[workspace.dependencies]`.
4. Raise `rust-toolchain.toml` if GridCraft's needs it (1.95 at this rev).
5. Run `scripts/verify.mjs` and compare `tools/list` with a `gridcraft-cli mcp` built from the new rev.

## What would break on upgrade

- Public items `mcp.rs` uses: `gridcraft_mcp::{Backend, Server}`, `SheetApp`, `control::{handle, Outcome, save_image}`, and the `Backend` trait's methods (`call`, `has_ui`, `describe`). A rename is a compile error.
- Silent: the `engine.execute` and `file.saveAs` command ids, `Outcome::Screenshot`, and the `save_workbook` and `screenshot` tool names. If upstream fixes `ui.screenshot` or `file.save` on wasm, the interception becomes redundant but harmless.
- Silent: new `Services` fields or host-bridge messages in the stock web shell that the copies miss.
- The copied shell drifts from upstream by design. Step 2 above is the cost of not patching GridCraft.

## Measured costs

Release build, rev `e6b6b349708a`, Apple silicon, Chrome with SwiftShader (software WebGL):

- wasm: 19.3 MB raw, 7.1 MB gzip -9, plus a 160 KB JS loader. The extra code the wrapper adds over the stock shell is small next to GridCraft itself.
- Time from loading `host.html` on a local static server to all 21 tools registered: 1.3 s, 2.9 s and 4.0 s in three runs (mostly wasm compile and first frame, so it varies with the machine). A real network adds the 7 MB download.
- Build: about 6 minutes cold, 1.5 to 2 minutes after a change to the wrapper.

## Evidence

`.am/evidence/` holds the W2 and W5 screenshots, the tool lists of the wrapper and the stock CLI, the `band browsers` outputs against a throwaway playground hub, and the saved `.xlsx`. The Band side is one edited script in the Band spike worktree, `apps/hub/tests/playground-webmcp.ts`, which now takes `GRIDCRAFT_PAGE` (use `host.html`) and `GRIDCRAFT_WAIT_TOOL` (use `set_cell`) next to `GRIDCRAFT_DIST`.

## Limits

- `save_workbook` always sends bytes to the page. It cannot write to a path.
- `open_workbook` with a path fails on the web for the same reason. Use `gridcraft:open` with bytes.
- No icon, no PWA, no desktop app.
