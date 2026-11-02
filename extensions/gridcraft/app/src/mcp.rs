//! MCP over Band's editor port: GridCraft's own MCP server (`gridcraft-mcp`, the one behind
//! `gridcraft-cli mcp`) answering Band, so an agent lists and calls the same tools as the CLI.
//!
//! `band_editor::Bridge` hands in the `mcp` messages as JSON text each frame and posts the replies
//! this returns, with the request's `id`. Notifications get no reply.
//!
//! The server runs on the frame loop with the running app as its [`Backend`]. `Backend::call` is
//! synchronous, and two of GridCraft's tools do not work on wasm, so the wrapper answers them
//! itself and passes every other call to the server unchanged:
//!
//! - `screenshot` needs `ui.screenshot`, which times shots with `now_ms()` (0 on wasm) and never
//!   finishes. The wrapper asks egui for a screenshot and builds the image reply when it arrives.
//! - `save_workbook` calls `file.save`, which writes to a path, and the browser has no file
//!   system. The wrapper runs `file.saveAs` instead, which hands the `.xlsx` bytes to the app's
//!   download service, which sends them to Band as a save request (see `editor`). Band's
//!   `tools.json` marks `save_workbook` as not for agents, so only a person's client reaches it.

use std::cell::RefCell;
use std::rc::Rc;

use gridcraft_mcp::{Backend, Server};
use gridcraft_ui_egui::SheetApp;
use gridcraft_ui_egui::control::{self, Outcome};
use serde_json::{Value, json};

/// Frames to wait after a `screenshot` call before asking egui for the picture, so edits made by
/// earlier tool calls are drawn.
const SETTLE_FRAMES: u32 = 3;

/// Frames after which a screenshot that never arrived is answered with an error.
const SHOT_TIMEOUT_FRAMES: u32 = 600;

/// The running app as a control-channel backend.
struct AppBackend {
    app: Rc<RefCell<SheetApp>>,
    ctx: egui::Context,
}

impl Backend for AppBackend {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let mut app = self.app.try_borrow_mut().map_err(|_| "GridCraft is busy".to_string())?;
        match control::handle(&mut app, &self.ctx, method, &params) {
            Outcome::Done(reply) if reply.get("ok").and_then(Value::as_bool) == Some(true) => Ok(reply.get("result").cloned().unwrap_or(Value::Null)),
            Outcome::Done(reply) => Err(reply.get("error").and_then(Value::as_str).unwrap_or("failed").to_string()),
            Outcome::Screenshot { .. } => Err("ui.screenshot is not available on the web; call the `screenshot` tool".to_string()),
        }
    }

    fn has_ui(&self) -> bool {
        true
    }

    fn describe(&self) -> String {
        "the GridCraft web app".to_string()
    }
}

/// Marks the egui screenshot requests made here, so the app's own (desktop-only) screenshot
/// bookkeeping never mistakes them for its own.
struct ShotToken(u64);

struct PendingShot {
    /// The JSON-RPC id of the `tools/call`.
    id: Value,
    token: u64,
    /// Frames seen since the call; the request goes out after `SETTLE_FRAMES`.
    frames: u32,
    requested: bool,
}

pub struct McpHost {
    app: Rc<RefCell<SheetApp>>,
    server: Server,
    shots: Vec<PendingShot>,
    next_token: u64,
}

impl McpHost {
    pub fn new(app: Rc<RefCell<SheetApp>>, ctx: egui::Context) -> Self {
        Self { server: Server::new(Box::new(AppBackend { app: app.clone(), ctx })), app, shots: Vec::new(), next_token: 0 }
    }

    /// Run once per frame, after the app's own borrow is dropped: answers the messages in `lines`
    /// and advances the pending screenshots. Returns the replies (JSON text) ready now.
    pub fn frame(&mut self, ctx: &egui::Context, lines: Vec<String>) -> Vec<String> {
        let mut replies = Vec::new();
        for line in lines {
            if let Some(id) = tool_call(&line, "screenshot") {
                self.next_token += 1;
                self.shots.push(PendingShot { id, token: self.next_token, frames: 0, requested: false });
            } else if let Some(id) = tool_call(&line, "save_workbook") {
                replies.push(self.save_workbook(&id, ctx));
            } else if let Some(reply) = self.server.handle_line(&line) {
                replies.push(reply);
            }
        }
        if !self.shots.is_empty() {
            replies.extend(self.advance_shots(ctx));
        }
        replies
    }

    /// Hands the workbook to Band as `.xlsx` bytes; the `tools/call` response for `id`.
    fn save_workbook(&mut self, id: &Value, ctx: &egui::Context) -> String {
        let outcome = match self.app.try_borrow_mut() {
            Ok(mut app) => match control::handle(&mut app, ctx, "engine.execute", &json!({"command": "file.saveAs", "params": {}})) {
                Outcome::Done(reply) if reply.get("ok").and_then(Value::as_bool) == Some(true) => Ok(()),
                Outcome::Done(reply) => Err(reply.get("error").and_then(Value::as_str).unwrap_or("failed").to_string()),
                Outcome::Screenshot { .. } => Err("unexpected screenshot request".to_string()),
            },
            Err(_) => Err("GridCraft is busy".to_string()),
        };
        let result = match outcome {
            Ok(()) => {
                json!({"content": [{"type": "text", "text": "Saved: the .xlsx bytes were sent to Band."}], "isError": false})
            }
            Err(e) => json!({"content": [{"type": "text", "text": format!("save_workbook: {e}")}], "isError": true}),
        };
        json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()
    }

    fn advance_shots(&mut self, ctx: &egui::Context) -> Vec<String> {
        let arrived: Vec<(u64, std::sync::Arc<egui::ColorImage>)> = ctx.input(|i| {
            i.raw
                .events
                .iter()
                .filter_map(|e| match e {
                    egui::Event::Screenshot { user_data, image, .. } => {
                        let token = user_data.data.as_ref()?.downcast_ref::<ShotToken>()?.0;
                        Some((token, image.clone()))
                    }
                    _ => None,
                })
                .collect()
        });
        let mut replies = Vec::new();
        self.shots.retain_mut(|shot| {
            if let Some((_, image)) = arrived.iter().find(|(t, _)| *t == shot.token) {
                replies.push(screenshot_reply(&shot.id, &control::save_image(image, None)));
                return false;
            }
            shot.frames += 1;
            if shot.frames >= SHOT_TIMEOUT_FRAMES {
                replies.push(screenshot_reply(&shot.id, &json!({"ok": false, "error": "no frame came back for the screenshot"})));
                return false;
            }
            if !shot.requested && shot.frames >= SETTLE_FRAMES {
                ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(egui::UserData::new(ShotToken(shot.token))));
                shot.requested = true;
            }
            true
        });
        // Frames only come while something asks for them.
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

/// The `tools/call` response for a screenshot: an image block, or an error result. `shot` is
/// `control::save_image`'s reply.
fn screenshot_reply(id: &Value, shot: &Value) -> String {
    let result = match shot.pointer("/result/base64").and_then(Value::as_str) {
        Some(data) if shot.get("ok").and_then(Value::as_bool) == Some(true) => {
            json!({"content": [{"type": "image", "data": data, "mimeType": "image/png"}], "isError": false})
        }
        _ => {
            let error = shot.get("error").and_then(Value::as_str).unwrap_or("screenshot failed");
            json!({"content": [{"type": "text", "text": format!("screenshot: {error}")}], "isError": true})
        }
    };
    json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()
}
