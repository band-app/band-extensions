// Copied from storytold/wordcraft apps/wordcraft-web/src/main.rs at rev ae5c65b9dd11 (MIT OR Apache-2.0,
// see LICENSE-MIT and LICENSE-APACHE at the repo root).
// Changes: dropped 'mod host', 'mod prefs' and 'mod save_fallback' and the `?host=parent` text, added
// 'mod editor' and 'mod mcp', renamed the crate in messages.

//! WordCraft in the browser.
//!
//! Runs the same [`wordcraft_ui_egui::WordApp`] as the desktop app through eframe's web runner
//! (wgpu: WebGPU where available, WebGL2 otherwise). Build with `trunk build --release` from this
//! directory (output in `dist/web`).
//!
//! Differences from the desktop app: no TCP control channel; Open and Insert > Pictures use the
//! browser file picker (bytes arrive through `Services::inbox`). Inside Band's `<iframe>` the file
//! to edit arrives over Band's editor port (`editor`), and Save sends it back over that port.
//! URL flags: `?webgl` forces WebGL2; `?sample` opens the sample document.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

#[cfg(target_arch = "wasm32")]
mod editor;
#[cfg(target_arch = "wasm32")]
mod mcp;
#[cfg(target_arch = "wasm32")]
mod web;

#[cfg(target_arch = "wasm32")]
fn main() {
    web::start();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!("wordcraft-band only runs in the browser: build it with `trunk build --release` in app/");
}
