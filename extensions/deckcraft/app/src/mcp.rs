//! MCP over Band's editor port: DeckCraft's own MCP server (`deckcraft-mcp`, the one behind
//! `deckcraft-cli mcp`) answering Band, so an agent lists and calls the same tools as the CLI.
//!
//! `band_editor::Bridge` hands in the `mcp` messages as JSON text each frame and posts the replies
//! this returns, with the request's `id`. Notifications get no reply.
//!
//! The server runs on the frame loop with the running app as its [`Backend`]. `Backend::call` is
//! synchronous, and the stock `screenshot` tool needs the desktop app's capture loop, so the
//! wrapper answers it itself and passes every other call to the server unchanged:
//!
//! - `screenshot` is answered by asking egui for a screenshot and building the image reply when
//!   the frame arrives, like `ui.screenshot` does on the desktop.
//!
//! The file tools (`open_presentation`, `save_presentation`, `new_presentation`, `export`) take file
//! paths. They stay in the server, and `tools.json` marks them `"agent": false`, so Band leaves
//! them out of the agent's tools.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use deckcraft_mcp::{Backend, Server};
use deckcraft_ui_egui::SlideApp;
use deckcraft_ui_egui::control::{self, ControlRequest, Outcome};
use serde_json::{Value, json};

/// Frames to wait after a `screenshot` call before asking egui for the picture, so edits made by
/// earlier tool calls are drawn.
const SETTLE_FRAMES: u32 = 3;

/// Frames after which a screenshot that never arrived is answered with an error.
const SHOT_TIMEOUT_FRAMES: u32 = 600;

/// The running app as a control-channel backend.
struct AppBackend {
    app: Rc<RefCell<SlideApp>>,
    ctx: egui::Context,
}

impl Backend for AppBackend {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let mut app = self.app.try_borrow_mut().map_err(|_| "DeckCraft is busy".to_string())?;
        let (request, _reply) = ControlRequest::new(method, params);
        match control::handle(&mut app, &self.ctx, &request) {
            Outcome::Done(reply) if reply.get("ok").and_then(Value::as_bool) == Some(true) => Ok(reply.get("result").cloned().unwrap_or(Value::Null)),
            Outcome::Done(reply) => Err(reply.get("error").and_then(Value::as_str).unwrap_or("failed").to_string()),
            Outcome::Screenshot { .. } => Err("ui.screenshot is not available through call_app on the web; call the `screenshot` tool".to_string()),
        }
    }

    fn has_ui(&self) -> bool {
        true
    }

    fn describe(&self) -> String {
        "the DeckCraft web app".to_string()
    }
}

/// Screenshots egui has delivered, by the token of the request. The callback may run on any
/// thread, so the list sits behind a mutex.
type Arrived = Arc<Mutex<Vec<(u64, Arc<egui::ColorImage>)>>>;

struct PendingShot {
    /// The JSON-RPC id of the `tools/call`.
    id: Value,
    token: u64,
    /// Frames seen since the call; the request goes out after `SETTLE_FRAMES`.
    frames: u32,
    requested: bool,
}

pub struct McpHost {
    server: Server,
    arrived: Arrived,
    shots: Vec<PendingShot>,
    next_token: u64,
}

impl McpHost {
    pub fn new(app: Rc<RefCell<SlideApp>>, ctx: egui::Context) -> Self {
        Self { server: Server::new(Box::new(AppBackend { app, ctx })), arrived: Arrived::default(), shots: Vec::new(), next_token: 0 }
    }

    /// Run once per frame, after the app's own borrow is dropped: answers the messages in `lines`
    /// and advances the pending screenshots. Returns the replies (JSON text) ready now.
    pub fn frame(&mut self, ctx: &egui::Context, lines: Vec<String>) -> Vec<String> {
        let mut replies = Vec::new();
        for line in lines {
            if let Some(id) = tool_call(&line, "screenshot") {
                self.next_token += 1;
                self.shots.push(PendingShot { id, token: self.next_token, frames: 0, requested: false });
            } else if let Some(reply) = self.server.handle_line(&line) {
                replies.push(reply);
            }
        }
        if !self.shots.is_empty() {
            replies.extend(self.advance_shots(ctx));
        }
        replies
    }

    fn advance_shots(&mut self, ctx: &egui::Context) -> Vec<String> {
        let arrived = std::mem::take(&mut *self.arrived.lock().unwrap_or_else(|e| e.into_inner()));
        let mut replies = Vec::new();
        self.shots.retain_mut(|shot| {
            if let Some((_, image)) = arrived.iter().find(|(t, _)| *t == shot.token) {
                replies.push(screenshot_reply(&shot.id, encode_png(image)));
                return false;
            }
            shot.frames += 1;
            if shot.frames >= SHOT_TIMEOUT_FRAMES {
                replies.push(screenshot_reply(&shot.id, Err("no frame came back for the screenshot".to_string())));
                return false;
            }
            if !shot.requested && shot.frames >= SETTLE_FRAMES {
                let (arrived, token, repaint) = (self.arrived.clone(), shot.token, ctx.clone());
                ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(egui::ScreenshotCallback::new(move |image| {
                    arrived.lock().unwrap_or_else(|e| e.into_inner()).push((token, image));
                    repaint.request_repaint();
                })));
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

/// The screenshot as base64 PNG.
fn encode_png(image: &egui::ColorImage) -> Result<String, String> {
    let [width, height] = image.size;
    let rgba: Vec<u8> = image.pixels.iter().flat_map(|p| p.to_array()).collect();
    let buffer = image::RgbaImage::from_raw(width as u32, height as u32, rgba).ok_or("the screenshot has an unexpected size")?;
    let mut png = std::io::Cursor::new(Vec::new());
    buffer.write_to(&mut png, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(deckcraft_engine::cmd::base64_encode(&png.into_inner()))
}

/// The `tools/call` response for a screenshot: an image block, or an error result.
fn screenshot_reply(id: &Value, png_base64: Result<String, String>) -> String {
    let result = match png_base64 {
        Ok(data) => json!({"content": [{"type": "image", "data": data, "mimeType": "image/png"}], "isError": false}),
        Err(error) => json!({"content": [{"type": "text", "text": format!("screenshot: {error}")}], "isError": true}),
    };
    json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string()
}
