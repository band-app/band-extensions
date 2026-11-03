//! Prints `tools.json` for Band: the `tools/list` answer of WordCraft's MCP server, with
//! `"agent": false` on the tools an agent must not call. It builds the same `wordcraft_mcp::Server`
//! the web build runs, over a backend that answers nothing, because `tools/list` needs none.
//!
//! Run by `scripts/package.sh`: `cargo run -p wordcraft-band --bin tools-json > tools.json`.

use band_editor::tools_json;
use serde_json::Value;
use wordcraft_mcp::{Backend, Server};

/// Both take a file system path, and a browser tab has none. Band decides where the open file is
/// read from and written to.
const NOT_FOR_AGENTS: &[&str] = &["open_document", "save_document"];

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
