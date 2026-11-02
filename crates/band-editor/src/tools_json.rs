//! Builds `tools.json` for Band: the `tools/list` answer of an editor's MCP server, with
//! `"agent": false` on the tools an agent must not call.
//!
//! An extension's `tools-json` binary builds its MCP server over a backend that answers nothing
//! (`tools/list` needs none), sends it [`TOOLS_LIST_REQUEST`] and prints [`render`] of the reply.
//! `scripts/package.sh` runs it as `cargo run -p <ext>-band --bin tools-json`.

use serde_json::{Value, json};

/// The JSON-RPC request whose reply [`render`] reads.
pub fn tools_list_request() -> String {
    json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).to_string()
}

/// `tools.json` (`{ "tools": [...] }`, pretty printed) from a `tools/list` reply. Fails if a name
/// in `not_for_agents` is not among the tools, so a renamed tool cannot become callable by accident.
pub fn render(reply: &str, not_for_agents: &[&str]) -> Result<String, String> {
    let reply: Value = serde_json::from_str(reply).map_err(|e| e.to_string())?;
    let mut tools = reply.pointer("/result/tools").and_then(Value::as_array).cloned().ok_or("tools/list returned no tools")?;
    for name in not_for_agents {
        if !tools.iter().any(|t| t.get("name").and_then(Value::as_str) == Some(name)) {
            return Err(format!("the server lists no tool named {name}"));
        }
    }
    for tool in &mut tools {
        let hidden = tool.get("name").and_then(Value::as_str).is_some_and(|n| not_for_agents.contains(&n));
        if hidden && let Some(tool) = tool.as_object_mut() {
            tool.insert("agent".to_string(), Value::Bool(false));
        }
    }
    serde_json::to_string_pretty(&json!({"tools": tools})).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPLY: &str = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"set_cell"},{"name":"save_workbook"}]}}"#;

    #[test]
    fn marks_only_the_named_tools() {
        let out: Value = serde_json::from_str(&render(REPLY, &["save_workbook"]).expect("renders")).expect("json");
        assert_eq!(out.pointer("/tools/1/agent"), Some(&Value::Bool(false)));
        assert_eq!(out.pointer("/tools/0/agent"), None);
    }

    #[test]
    fn rejects_an_unknown_name() {
        assert!(render(REPLY, &["open_workbook"]).is_err());
    }
}
