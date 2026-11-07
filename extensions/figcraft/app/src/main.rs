// Copied from storytold/figcraft apps/figcraft-web/src/main.rs at rev 35684eaa028e (MIT OR Apache-2.0,
// see LICENSE-MIT and LICENSE-APACHE at the repo root).
// Changes: added `mod editor`, `mod mcp` and `mod preview`, dropped `mod api`, `mod saved_files` and the tests of the
// copied modules, and trimmed the doc comment to what this build does.

//! FigCraft in the browser, as a Band editor.
//!
//! Runs the same [`figcraft_ui_egui::FigApp`] as the desktop app through eframe's web runner
//! (wgpu: WebGPU where available, WebGL2 otherwise). Build with `trunk build --release` from
//! this directory (output in `../dist/web`).
//!
//! Differences from the desktop app: no TCP control server; Open uses the browser file picker;
//! links open in a new browser tab; an internal error stops the page. Inside Band's `<iframe>` the
//! file to edit arrives over Band's editor port (`editor`), File > Save sends the file back to Band,
//! and the agent's MCP requests arrive on the same port (`mcp`).
//!
//! URL query flag: `?webgl` forces the WebGL2 backend instead of WebGPU.

#[cfg(target_arch = "wasm32")]
mod editor;
#[cfg(target_arch = "wasm32")]
mod kept;
#[cfg(target_arch = "wasm32")]
mod local_fonts;
#[cfg(target_arch = "wasm32")]
mod mcp;
#[cfg(target_arch = "wasm32")]
mod pasted;
#[cfg(target_arch = "wasm32")]
mod preview;
#[cfg(target_arch = "wasm32")]
mod query;
#[cfg(target_arch = "wasm32")]
mod recovery;
#[cfg(target_arch = "wasm32")]
mod web;

#[cfg(target_arch = "wasm32")]
fn main() {
    web::start();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("figcraft-band only runs in the browser: build it with `trunk build --release` in app/");
}
