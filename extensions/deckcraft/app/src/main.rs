// Copied from storytold/deckcraft apps/deckcraft-web/src/main.rs at rev 1eec8b266cba (MIT OR Apache-2.0,
// see LICENSE-MIT and LICENSE-APACHE at the repo root).
// Changes: replaced 'mod presenter' with 'mod editor' and 'mod mcp', renamed the crate in messages.

//! DeckCraft in the browser.
//!
//! Runs the same [`deckcraft_ui_egui::SlideApp`] as the desktop app through eframe's web
//! runner (wgpu: WebGPU where available, WebGL2 otherwise). Build with `trunk build --release`
//! from this directory (output in `dist/web`).
//!
//! Differences from the desktop app:
//! - no TCP control channel (browsers can't listen on sockets);
//! - File → Open and Insert → Pictures/Audio/Video use the browser file picker; bytes arrive
//!   asynchronously through `Services::inbox`, applied to the document, slide and operation
//!   that started the pick (a dismissed picker or a closed document drops the file);
//! - Save and Export trigger a browser download;
//! - dropped files are read asynchronously by `web::WebShell` and delivered through the inbox;
//! - preferences are not persisted.
//!
//! Inside Band's `<iframe>` the file to edit arrives over Band's editor port (`editor`) instead of the
//! sample deck, and the presenter popup is gone.
//!
//! URL query flags: `?webgl` forces the WebGL2 backend instead of WebGPU; `?blank` starts with an
//! empty presentation instead of the sample deck; `?show` starts the slide show.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]
#![forbid(unsafe_code)]

#[cfg(target_arch = "wasm32")]
mod editor;
#[cfg(target_arch = "wasm32")]
mod mcp;
#[cfg(target_arch = "wasm32")]
mod preview;
#[cfg(target_arch = "wasm32")]
mod web;

#[cfg(target_arch = "wasm32")]
fn main() {
    web::start();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("deckcraft-band only runs in the browser: build it with `trunk build --release` in app/");
}
