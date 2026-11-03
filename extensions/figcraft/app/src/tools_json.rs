//! Prints `tools.json` for Band: the `tools/list` answer of FigCraft's MCP server, with
//! `"agent": false` on the tools an agent must not call. It builds the same `figcraft_mcp::Server`
//! the web build runs, over a backend that answers nothing, because `tools/list` needs none.
//!
//! Run by `scripts/package.sh`: `cargo run -p figcraft-band --bin tools-json > tools.json`.

use band_editor::tools_json;
use figcraft_mcp::{Backend, Server};
use serde_json::Value;

/// These read or write a path, and the browser has no file system. The person decides when the file
/// is saved or replaced.
const NOT_FOR_AGENTS: &[&str] = &["open_file", "save_file"];

struct NoBackend;

impl Backend for NoBackend {
    fn call(&mut self, method: &str, _params: Value) -> Result<Value, String> {
        Err(format!("{method}: tools.json generation runs no tools"))
    }

    fn has_ui(&self) -> bool {
        true
    }

    fn describe(&self) -> String {
        "tools.json generation".to_string()
    }
}

fn main() -> Result<(), String> {
    let mut server = Server::new(Box::new(NoBackend));
    let reply = server.handle_line(&tools_json::tools_list_request()).ok_or("tools/list got no reply")?;
    println!("{}", tools_json::render(&reply, NOT_FOR_AGENTS)?);
    Ok(())
}
