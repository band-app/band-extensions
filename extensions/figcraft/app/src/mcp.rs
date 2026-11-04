//! MCP over Band's editor port: FigCraft's own MCP server (`figcraft-mcp`, the one behind
//! `figcraft-cli mcp`) answering Band, so an agent lists and calls the same tools as the CLI.
//!
//! `band_editor::Bridge` hands in the `mcp` messages as JSON text each frame and posts the replies
//! this returns, with the request's id. Notifications get no reply.
//!
//! The server runs on the frame loop with the running app as its [`Backend`], which calls the app's
//! control channel handler (`figcraft_ui_egui::control::handle`) directly. Every call is synchronous.
//! Four tools need more than that, so the wrapper answers them itself and passes every other call
//! to the server unchanged:
//!
//! - `save_file` writes to a path, and the browser has no file system. The wrapper asks Band to save
//!   the open file instead (the same request as File > Save). `tools.json` marks it `"agent": false`.
//! - `open_file` reads a path. It answers with an error. `tools.json` marks it `"agent": false`.
//! - `export` with `path` would write a file, and the browser has no file system. The wrapper
//!   refuses it with an error that says to leave `path` out, which returns the bytes in the reply.
//! - `screenshot` with `window` set captures the window, which needs a drawn frame. The wrapper
//!   answers with an error that says to leave `window` out, which renders the page. A screenshot
//!   without `window` renders the document and works as it does headless.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use figcraft_mcp::{Backend, Server};
use figcraft_ui_egui::{FigApp, control};
use serde_json::{Value, json};

/// The running app as a control-channel backend.
struct AppBackend {
    app: Rc<RefCell<FigApp>>,
    ctx: egui::Context,
}

impl Backend for AppBackend {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if method == "ui.screenshot" {
            return Err("a window capture is not available in Band: call `screenshot` without `window` to render the page".to_string());
        }
        let mut app = self.app.try_borrow_mut().map_err(|_| "FigCraft is busy".to_string())?;
        control::handle(&mut app, &self.ctx, method, &params)
    }

    fn has_ui(&self) -> bool {
        true
    }

    fn describe(&self) -> String {
        "the FigCraft web app".to_string()
    }
}

pub struct McpHost {
    server: Server,
    want_save: Rc<Cell<bool>>,
}

impl McpHost {
    pub fn new(app: Rc<RefCell<FigApp>>, ctx: egui::Context, want_save: Rc<Cell<bool>>) -> Self {
        Self { server: Server::new(Box::new(AppBackend { app, ctx })), want_save }
    }

    /// Run once per frame, after the app's own borrow is dropped: answers the messages in `lines`.
    /// Returns the replies (JSON text) ready now.
    pub fn frame(&mut self, lines: Vec<String>) -> Vec<String> {
        let mut replies = Vec::new();
        for line in lines {
            if let Some(id) = tool_call(&line, "save_file") {
                self.want_save.set(true);
                replies.push(tool_reply(&id, "Asked Band to save the open file.", false));
            } else if let Some(id) = tool_call_with(&line, "export", "path") {
                replies.push(tool_reply(
                    &id,
                    "export: `path` is not available in Band, there is no file system. Call export without `path` to get the file in the reply.",
                    true,
                ));
            } else if let Some(id) = tool_call(&line, "open_file") {
                replies.push(tool_reply(&id, "open_file: Band opens the file, there is no path to read here.", true));
            } else if let Some(reply) = self.server.handle_line(&line) {
                replies.push(reply);
            }
        }
        replies
    }
}

/// The request id when `line` is a `tools/call` of the tool `name`.
fn tool_call(line: &str, name: &str) -> Option<Value> {
    call_id(line, name, None)
}

/// The request id when `line` is a `tools/call` of the tool `name` that sets the argument `arg`.
fn tool_call_with(line: &str, name: &str, arg: &str) -> Option<Value> {
    call_id(line, name, Some(arg))
}

fn call_id(line: &str, name: &str, arg: Option<&str>) -> Option<Value> {
    let m: Value = serde_json::from_str(line).ok()?;
    let is_call = m.get("method").and_then(Value::as_str) == Some("tools/call") && m.pointer("/params/name").and_then(Value::as_str) == Some(name);
    let has_arg = arg.is_none_or(|a| m.pointer("/params/arguments").and_then(|args| args.get(a)).is_some_and(|v| !v.is_null()));
    if is_call && has_arg { m.get("id").filter(|id| id.is_string() || id.is_number()).cloned() } else { None }
}

/// The `tools/call` response for `id`: a text block.
fn tool_reply(id: &Value, text: &str, is_error: bool) -> String {
    json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": text}], "isError": is_error}}).to_string()
}
