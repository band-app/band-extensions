//! The Band side of an editor extension, shared by every app in this repo.
//!
//! - [`bridge`] (wasm only) speaks Band's editor protocol (extension API 1) on a `MessagePort`
//!   and drives an app through the [`Editor`] trait.
//! - [`tools_json`] turns an MCP `tools/list` reply into the `tools.json` Band reads at install.
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unimplemented, clippy::todo, clippy::unreachable)]

#[cfg(target_arch = "wasm32")]
mod bridge;
pub mod protocol;
pub mod tools_json;
#[cfg(target_arch = "wasm32")]
mod touch;

#[cfg(target_arch = "wasm32")]
pub use bridge::{Bridge, Editor, message_text};
pub use protocol::{Layout, Rect, Selection, Theme};
