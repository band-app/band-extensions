//! MCP over the host bridge (`gridcraft:mcp`) or Band's editor port (`mcp`): GridCraft's own MCP server (`gridcraft-mcp`, the
//! one behind `gridcraft-cli mcp`) answering the framing page, so the page lists and calls the
//! same tools as the CLI.
//!
//! The page posts `{ type: "gridcraft:mcp", message }` with one MCP JSON-RPC message. The reply
//! comes back the same way, with the same `id`. Notifications get no reply. Only the parent
//! window on the page's own origin is heard or answered, as in `host`.
//!
//! The server runs on the frame loop with the running app as its [`Backend`]. `Backend::call` is
//! synchronous, and two of GridCraft's tools do not work on wasm, so the wrapper answers them
//! itself and passes every other call to the server unchanged:
//!
//! - `screenshot` needs `ui.screenshot`, which times shots with `now_ms()` (0 on wasm) and never
//!   finishes. The wrapper asks egui for a screenshot and builds the image reply when it arrives.
//! - `save_workbook` calls `file.save`, which writes to a path, and the browser has no file
//!   system. The wrapper runs `file.saveAs` instead, which hands the `.xlsx` bytes to the app's
//!   download service, so the host page receives `gridcraft:save` as it does for File > Save As.

use std::cell::RefCell;
use std::rc::Rc;

use gridcraft_mcp::{Backend, Server};
use gridcraft_ui_egui::SheetApp;
use gridcraft_ui_egui::control::{self, Outcome};
use serde_json::{Value, json};
use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;

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

/// Where MCP messages come from and go back to: the framing page's `gridcraft:mcp` messages
/// (`?host=parent`), or the `mcp` messages on Band's editor port (`band`).
pub struct Transport {
    /// Messages (JSON text) received since the last frame.
    pub inbox: Rc<RefCell<Vec<String>>>,
    /// Sends one JSON-RPC message back to the other side.
    pub reply: Box<dyn Fn(&JsValue)>,
}

impl Transport {
    /// `None` when the page isn't framed. Starts listening for `gridcraft:mcp` messages from the
    /// parent window on the page's own origin.
    pub fn parent_window(ctx: egui::Context) -> Option<Self> {
        let window = web_sys::window()?;
        let parent = window.parent().ok().flatten()?;
        if js_sys::Object::is(&parent, &window) {
            return None;
        }
        let origin = window.location().origin().ok()?;
        let inbox: Rc<RefCell<Vec<String>>> = Rc::default();
        let on_message = {
            let (parent, origin, inbox) = (parent.clone(), origin.clone(), inbox.clone());
            Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
                if event.origin() != origin || !event.source().is_some_and(|s| js_sys::Object::is(&s, &parent)) {
                    return;
                }
                let data = event.data();
                if js_sys::Reflect::get(&data, &"type".into()).ok().and_then(|t| t.as_string()).as_deref() != Some("gridcraft:mcp") {
                    return;
                }
                if let Some(text) = message_text(&data) {
                    inbox.borrow_mut().push(text);
                    ctx.request_repaint();
                }
            })
        };
        window.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).ok()?;
        // The listener lives as long as the page.
        on_message.forget();
        let reply = Box::new(move |message: &JsValue| {
            let envelope = js_sys::Object::new();
            let set = |key: &str, value: &JsValue| js_sys::Reflect::set(&envelope, &JsValue::from_str(key), value).is_ok();
            if set("type", &"gridcraft:mcp".into()) && set("message", message) {
                let _ = parent.post_message(&envelope, &origin);
            }
        });
        Some(Self { inbox, reply })
    }
}

/// The `message` field of an envelope as JSON text.
pub fn message_text(envelope: &JsValue) -> Option<String> {
    js_sys::Reflect::get(envelope, &"message".into()).ok().and_then(|m| js_sys::JSON::stringify(&m).ok()).and_then(|s| s.as_string())
}

pub struct McpHost {
    app: Rc<RefCell<SheetApp>>,
    server: Server,
    transport: Transport,
    shots: Vec<PendingShot>,
    next_token: u64,
}

impl McpHost {
    pub fn new(app: Rc<RefCell<SheetApp>>, ctx: egui::Context, transport: Transport) -> Self {
        Self { server: Server::new(Box::new(AppBackend { app: app.clone(), ctx })), app, transport, shots: Vec::new(), next_token: 0 }
    }

    /// Run once per frame, after the app's own borrow is dropped: answers the queued messages and
    /// advances the pending screenshots.
    pub fn frame(&mut self, ctx: &egui::Context) {
        let lines = std::mem::take(&mut *self.transport.inbox.borrow_mut());
        for line in lines {
            if let Some(id) = tool_call(&line, "screenshot") {
                self.next_token += 1;
                self.shots.push(PendingShot { id, token: self.next_token, frames: 0, requested: false });
            } else if let Some(id) = tool_call(&line, "save_workbook") {
                let reply = self.save_workbook(&id, ctx);
                self.post(&reply);
            } else if let Some(reply) = self.server.handle_line(&line) {
                self.post(&reply);
            }
        }
        if !self.shots.is_empty() {
            self.advance_shots(ctx);
        }
    }

    /// Hands the workbook to the page as `.xlsx` bytes; the `tools/call` response for `id`.
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
                json!({"content": [{"type": "text", "text": "Saved: the .xlsx bytes were sent to the host page as gridcraft:save."}], "isError": false})
            }
            Err(e) => json!({"content": [{"type": "text", "text": format!("save_workbook: {e}")}], "isError": true}),
        };
        json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()
    }

    fn advance_shots(&mut self, ctx: &egui::Context) {
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
        for reply in replies {
            self.post(&reply);
        }
        // Frames only come while something asks for them.
        if !self.shots.is_empty() {
            ctx.request_repaint();
        }
    }

    /// Sends one JSON-RPC message (JSON text) to the other side.
    fn post(&self, json: &str) {
        if let Ok(message) = js_sys::JSON::parse(json) {
            (self.transport.reply)(&message);
        }
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
