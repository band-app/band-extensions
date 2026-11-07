// Copied from storytold/vectorcraft apps/vectorcraft-web/src/main.rs at rev 1008166fa7c6 (MIT OR Apache-2.0,
// see LICENSE-MIT and LICENSE-APACHE at the repo root).
// Changes: added 'mod editor', renamed the crate in messages, and shortened the docs.

//! VectorCraft in the browser, as a Band editor.
//!
//! Runs the same [`vectorcraft_ui_egui::VectorcraftApp`] as the desktop app through eframe's web
//! runner (wgpu: WebGPU where available, WebGL2 otherwise). Build with `trunk build --release`
//! from this directory (output in `../dist/web`).
//!
//! Differences from the desktop app: no TCP control server; Open uses the browser file picker
//! (bytes arrive asynchronously through `Services::inbox`); Save downloads the file; dropped files
//! are read asynchronously; pen and finger input is read from Pointer Events (`pencil`).
//!
//! URL query flags: `?webgl` forces WebGL2; `?lang=es` stands in for the browser's languages.
//! Inside Band's `<iframe>` the file to edit arrives over Band's editor port (`editor`) instead,
//! The VectorCraft MCP server does not build for wasm, so the extension offers agents no tools.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

#[cfg(target_arch = "wasm32")]
mod api;
#[cfg(target_arch = "wasm32")]
mod editor;
#[cfg(target_arch = "wasm32")]
mod fonts;
#[cfg(target_arch = "wasm32")]
mod keys;
#[cfg(target_arch = "wasm32")]
mod pencil;
#[cfg(target_arch = "wasm32")]
mod preview;
#[cfg(target_arch = "wasm32")]
mod saved_files;
#[cfg(target_arch = "wasm32")]
mod web;

#[cfg(target_arch = "wasm32")]
fn main() {
    web::start();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("vectorcraft-band only runs in the browser: build it with `trunk build --release` in app/");
}
