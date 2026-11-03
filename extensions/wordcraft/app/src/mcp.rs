//! MCP over Band's editor port: WordCraft's own MCP server (`wordcraft-mcp`, the one behind
//! `wordcraft-cli mcp`) answering Band, so an agent lists and calls the same tools as the CLI.
//!
//! `band_editor::Bridge` hands in the `mcp` messages as JSON text each frame and posts the replies
//! this returns, with the request's `id`. Notifications get no reply.
//!
//! The server runs on the frame loop with the running app as its [`Backend`]. `Backend::call` is
//! synchronous, and a screenshot finishes over several frames, so the wrapper answers the
//! `screenshot` tool itself and passes every other call to the server unchanged. It sends the
//! app's own `ui.screenshot` request over the control channel (`WordApp::with_control`), which
//! the app answers on a later frame, and builds the image reply from the answer.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::mpsc::{Receiver, Sender, TryRecvError};

use serde_json::{Value, json};
use wordcraft_mcp::{Backend, Server};
use wordcraft_ui_egui::WordApp;
use wordcraft_ui_egui::control::{self, ControlRequest, Outcome};

/// The running app as a control-channel backend.
struct AppBackend {
    app: Rc<RefCell<WordApp>>,
    ctx: egui::Context,
}

impl Backend for AppBackend {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let mut app = self.app.try_borrow_mut().map_err(|_| "WordCraft is busy".to_string())?;
        let (request, _reply) = ControlRequest::new(method, params);
        match control::handle(&mut app, &self.ctx, &request) {
            Outcome::Done(reply) if reply.get("ok").and_then(Value::as_bool) == Some(true) => Ok(reply.get("result").cloned().unwrap_or(Value::Null)),
            Outcome::Done(reply) => Err(reply.get("error").and_then(Value::as_str).unwrap_or("failed").to_string()),
            Outcome::Screenshot { .. } => Err("ui.screenshot is answered by the `screenshot` tool".to_string()),
        }
    }

    fn has_ui(&self) -> bool {
        true
    }

    fn describe(&self) -> String {
        "the WordCraft web app".to_string()
    }
}

struct PendingShot {
    /// The JSON-RPC id of the `tools/call`.
    id: Value,
    reply: Receiver<Value>,
}

pub struct McpHost {
    server: Server,
    control: Sender<ControlRequest>,
    shots: Vec<PendingShot>,
}

impl McpHost {
    pub fn new(app: Rc<RefCell<WordApp>>, ctx: egui::Context, control: Sender<ControlRequest>) -> Self {
        Self { server: Server::new(Box::new(AppBackend { app, ctx })), control, shots: Vec::new() }
    }

    /// Run once per frame, after the app's own borrow is dropped: answers the messages in `lines`
    /// and collects the screenshots the app has finished. Returns the replies (JSON text) ready now.
    pub fn frame(&mut self, ctx: &egui::Context, lines: Vec<String>) -> Vec<String> {
        let mut replies = Vec::new();
        for line in lines {
            if let Some(id) = tool_call(&line, "screenshot") {
                let (request, reply) = ControlRequest::new("ui.screenshot", json!({}));
                if self.control.send(request).is_ok() {
                    self.shots.push(PendingShot { id, reply });
                } else {
                    replies.push(screenshot_reply(&id, &json!({"ok": false, "error": "the app is not taking requests"})));
                }
            } else if let Some(reply) = self.server.handle_line(&line) {
                replies.push(reply);
            }
        }
        self.shots.retain(|shot| match shot.reply.try_recv() {
            Ok(answer) => {
                replies.push(screenshot_reply(&shot.id, &answer));
                false
            }
            Err(TryRecvError::Empty) => true,
            Err(TryRecvError::Disconnected) => {
                replies.push(screenshot_reply(&shot.id, &json!({"ok": false, "error": "the app dropped the screenshot request"})));
                false
            }
        });
        // Frames only come while something asks for them, and the app answers on a frame.
        if !self.shots.is_empty() {
            ctx.request_repaint();
        }
        replies
    }
}

/// The request id when `line` is a `tools/call` of the tool `name`.
fn tool_call(line: &str, name: &str) -> Option<Value> {
    let m: Value = serde_json::from_str(line).ok()?;
    let is_call = m.get("method").and_then(Value::as_str) == Some("tools/call") && m.pointer("/params/name").and_then(Value::as_str) == Some(name);
    if is_call { m.get("id").filter(|id| id.is_string() || id.is_number()).cloned() } else { None }
}

/// The `tools/call` response for a screenshot: an image block and its size, or an error result.
/// `shot` is the app's `ui.screenshot` reply.
fn screenshot_reply(id: &Value, shot: &Value) -> String {
    let png = shot.pointer("/result/base64").or_else(|| shot.pointer("/result/png")).and_then(Value::as_str);
    let result = match png {
        Some(data) if shot.get("ok").and_then(Value::as_bool) == Some(true) && !data.is_empty() => {
            let info = json!({"width": shot.pointer("/result/width"), "height": shot.pointer("/result/height")});
            json!({"content": [{"type": "image", "data": data, "mimeType": "image/png"}, {"type": "text", "text": info.to_string()}], "isError": false})
        }
        _ => {
            let error = shot.get("error").and_then(Value::as_str).unwrap_or("screenshot failed");
            json!({"content": [{"type": "text", "text": format!("screenshot: {error}")}], "isError": true})
        }
    };
    json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()
}
