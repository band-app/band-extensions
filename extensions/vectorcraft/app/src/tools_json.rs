//! Prints `tools.json` for Band. It lists no tools: VectorCraft's MCP server (`vectorcraft-mcp`)
//! does not build for wasm32 (it calls `vectorcraft_format::write_atomic`, which the format crate
//! compiles out there), and the web build is where Band runs the editor. Nothing in VectorCraft is
//! patched, so there is nothing for an agent to call.
//!
//! Run by `scripts/package.sh`: `cargo run -p vectorcraft-band --bin tools-json > tools.json`.

use band_editor::tools_json;

fn main() -> Result<(), String> {
    println!("{}", tools_json::render(r#"{"result":{"tools":[]}}"#, &[])?);
    Ok(())
}
