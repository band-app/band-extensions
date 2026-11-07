// Copied from storytold/gridcraft apps/gridcraft-web/src/main.rs at rev e6b6b349708a (MIT OR Apache-2.0,
// see LICENSE-MIT and LICENSE-APACHE at the repo root).
// Changes: dropped the `?host=parent` text, added 'mod editor', 'mod mcp' and 'mod sheet_html', renamed the crate in messages.

//! GridCraft in the browser.
//!
//! Runs the same [`gridcraft_ui_egui::SheetApp`] as the desktop app through eframe's web runner
//! (wgpu: WebGPU where available, WebGL2 otherwise). Build with `trunk build --release` from
//! this directory (output in `dist/web`).
//!
//! Differences from the desktop app: no TCP control channel; Open uses the browser file picker
//! (bytes arrive asynchronously through `Services::inbox`); Save downloads the file; dropped
//! files are read asynchronously.
//!
//! URL query flags: `?webgl` forces WebGL2; `?sample=sales|budget|grades` opens a sample. Inside
//! Band's `<iframe>` the file to edit arrives over Band's editor port (`editor`) instead.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

#[cfg(target_arch = "wasm32")]
mod editor;
#[cfg(target_arch = "wasm32")]
mod mcp;
// The preview table is plain Rust over the engine, so its tests run natively.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod sheet_html;
#[cfg(target_arch = "wasm32")]
mod web;

#[cfg(target_arch = "wasm32")]
fn main() {
    web::start();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("gridcraft-band only runs in the browser: build it with `trunk build --release` in app/");
}
