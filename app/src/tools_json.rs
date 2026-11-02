//! Prints `tools.json` for Band: the `tools/list` answer of GridCraft's MCP server, with
//! `"agent": false` on the tools an agent must not call. It builds the same `gridcraft_mcp::Server`
//! the web build runs, over a backend that answers nothing, because `tools/list` needs none.
//!
//! Run by `scripts/install.sh`: `cargo run -p gridcraft-webmcp --bin tools-json > tools.json`.

use gridcraft_mcp::{Backend, Server};
use serde_json::{Value, json};

/// The person decides when the file is saved or replaced, so agents don't get these.
const NOT_FOR_AGENTS: &[&str] = &["save_workbook", "open_workbook"];

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
    let request = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).to_string();
    let reply = server.handle_line(&request).ok_or("tools/list got no reply")?;
    let reply: Value = serde_json::from_str(&reply).map_err(|e| e.to_string())?;
    let mut tools = reply.pointer("/result/tools").and_then(Value::as_array).cloned().ok_or("tools/list returned no tools")?;
    for name in NOT_FOR_AGENTS {
        if !tools.iter().any(|t| t.get("name").and_then(Value::as_str) == Some(name)) {
            return Err(format!("the server lists no tool named {name}"));
        }
    }
    for tool in &mut tools {
        let hidden = tool.get("name").and_then(Value::as_str).is_some_and(|n| NOT_FOR_AGENTS.contains(&n));
        if hidden && let Some(tool) = tool.as_object_mut() {
            tool.insert("agent".to_string(), Value::Bool(false));
        }
    }
    println!("{}", serde_json::to_string_pretty(&json!({"tools": tools})).map_err(|e| e.to_string())?);
    Ok(())
}
