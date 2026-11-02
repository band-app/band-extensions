//! Band's editor protocol (extension API 1) over a `MessagePort`.
//!
//! Band frames this build in `<iframe sandbox="allow-scripts">`, so the page has a `null` origin
//! and no origin check is possible. The page trusts two things instead: the message comes from
//! `window.parent`, and it is a `band:hello` with `extensionApi: 1` that carries a port. It keeps
//! the first such port, ignores every other window message, and speaks only on that port. A small
//! script in `index.html` applies the same checks and keeps the port of a hello that arrives
//! before the wasm has loaded.
//!
//! Band to editor: `init { file: { name, path, mime, bytes, readOnly }, theme }`,
//! `requestSave`, `saved`, `saveFailed { error }`, `reload { bytes }`, `theme { tokens }`
//! (ignored) and `mcp { message }`.
//!
//! Editor to Band: `ready` (the workbook from `init` is open), `dirty { dirty }`,
//! `save { bytes }` (a transferred `ArrayBuffer`) and `mcp { message }` with the request's id.
//!
//! Saving always sends the workbook in the format the file was opened in (`.xlsx` or `.csv`).
//! File > Save inside GridCraft counts as a save request when it would download an `.xlsx`; other
//! downloads (PDF export, Save As to another format) have nowhere to go and are dropped.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;

use gridcraft_engine::model::Workbook;
use gridcraft_ui_egui::{Inbox, Services, SheetApp};
use serde_json::json;
use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;

use crate::mcp::Transport;

const EXTENSION_API: f64 = 1.0;

#[derive(Clone)]
pub struct Bridge(Rc<Inner>);

#[derive(Default)]
struct Inner {
    port: RefCell<Option<web_sys::MessagePort>>,
    /// Port messages other than `mcp`, received since the last frame.
    events: RefCell<Vec<JsValue>>,
    /// `mcp` messages (JSON text), handed to the MCP server through `Bridge::transport`.
    mcp: Rc<RefCell<Vec<String>>>,
    ctx: RefCell<Option<egui::Context>>,
    inbox: RefCell<Option<Inbox>>,
    /// The file's extension in lower case: `xlsx` or `csv`.
    format: RefCell<String>,
    /// Set by GridCraft's own File > Save; `requestSave` acts on the event directly.
    want_save: Cell<bool>,
    /// `init` was queued and the workbook has not been opened yet.
    awaiting_ready: Cell<bool>,
    /// The unsaved-changes state last reported to Band.
    reported: Cell<bool>,
    /// The workbook as of each `save` that Band has not answered yet, oldest first.
    sent: RefCell<VecDeque<Arc<Workbook>>>,
}

impl Bridge {
    /// `None` when the page isn't framed. Starts waiting for `band:hello`.
    pub fn listen() -> Option<Self> {
        let window = web_sys::window()?;
        let parent = window.parent().ok().flatten()?;
        if js_sys::Object::is(&parent, &window) {
            return None;
        }
        let bridge = Self(Rc::default());
        let this = bridge.clone();
        let on_message = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
            if !event.source().is_some_and(|s| js_sys::Object::is(&s, &parent)) {
                return;
            }
            let data = event.data();
            let hello = get(&data, "type").as_string().as_deref() == Some("band:hello") && get(&data, "extensionApi").as_f64() == Some(EXTENSION_API);
            if !hello || this.0.port.borrow().is_some() {
                return;
            }
            if let Ok(port) = event.ports().get(0).dyn_into::<web_sys::MessagePort>() {
                this.accept(port);
            }
        });
        window.add_event_listener_with_callback("message", on_message.as_ref().unchecked_ref()).ok()?;
        // The listener lives as long as the page.
        on_message.forget();
        // `index.html` kept the port of a hello that came before this code ran.
        if let Ok(port) = get(&window, "bandHelloPort").dyn_into::<web_sys::MessagePort>() {
            bridge.accept(port);
        }
        Some(bridge)
    }

    fn accept(&self, port: web_sys::MessagePort) {
        let this = self.clone();
        let on_port = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
            let data = event.data();
            if get(&data, "type").as_string().as_deref() == Some("mcp") {
                if let Some(text) = crate::mcp::message_text(&data) {
                    this.0.mcp.borrow_mut().push(text);
                }
            } else {
                this.0.events.borrow_mut().push(data);
            }
            if let Some(ctx) = &*this.0.ctx.borrow() {
                ctx.request_repaint();
            }
        });
        port.set_onmessage(Some(on_port.as_ref().unchecked_ref()));
        // The handler lives as long as the page.
        on_port.forget();
        *self.0.port.borrow_mut() = Some(port);
    }

    /// Route GridCraft's File > Save to Band, and open the files Band sends through `inbox`.
    pub fn connect(&self, services: &mut Services, inbox: Inbox, ctx: egui::Context) {
        *self.0.inbox.borrow_mut() = Some(inbox);
        *self.0.ctx.borrow_mut() = Some(ctx.clone());
        let this = self.clone();
        services.download = Some(Box::new(move |name: &str, _bytes: &[u8]| {
            if name.to_ascii_lowercase().ends_with(".xlsx") {
                this.0.want_save.set(true);
            } else {
                log::warn!("{name} was not sent to Band: only a save of the open file has a destination");
            }
        }));
        // Events that arrived before the app existed are waiting; draw a frame to handle them.
        ctx.request_repaint();
    }

    /// The MCP server's way to talk over the port.
    pub fn transport(&self) -> Transport {
        let this = self.clone();
        Transport {
            inbox: self.0.mcp.clone(),
            reply: Box::new(move |message: &JsValue| {
                this.send(&[("type", "mcp".into()), ("message", message.clone())], None);
            }),
        }
    }

    /// After each frame: handle what Band sent, then report what changed.
    pub fn sync(&self, app: &mut SheetApp) {
        let inner = &self.0;
        if inner.awaiting_ready.get() && inner.inbox.borrow().as_ref().is_some_and(|i| i.lock().unwrap_or_else(|e| e.into_inner()).is_empty()) {
            inner.awaiting_ready.set(false);
            self.send(&[("type", "ready".into())], None);
        }
        let events = std::mem::take(&mut *inner.events.borrow_mut());
        for event in events {
            match get(&event, "type").as_string().as_deref() {
                Some("init") => self.init(&event),
                Some("reload") => self.reload(app, &event),
                Some("requestSave") => inner.want_save.set(true),
                Some("saved") => self.answer_save(app, true),
                Some("saveFailed") => self.answer_save(app, false),
                _ => {}
            }
        }
        if inner.want_save.replace(false) {
            self.save(app);
        }
        let dirty = app.session.documents().iter().any(|d| d.is_dirty());
        if inner.reported.get() != dirty && self.send(&[("type", "dirty".into()), ("dirty", dirty.into())], None) {
            inner.reported.set(dirty);
        }
    }

    fn init(&self, event: &JsValue) {
        let file = get(event, "file");
        let name = get(&file, "name").as_string().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "Book.xlsx".to_string());
        let Some(bytes) = bytes(&file) else {
            log::error!("init carried no bytes");
            return;
        };
        let format = if name.to_ascii_lowercase().ends_with(".csv") { "csv" } else { "xlsx" };
        *self.0.format.borrow_mut() = format.to_string();
        self.open(name, bytes);
        self.0.awaiting_ready.set(true);
    }

    fn reload(&self, app: &mut SheetApp, event: &JsValue) {
        let Some(bytes) = bytes(event) else {
            log::error!("reload carried no bytes");
            return;
        };
        // Band reloads only a tab without unsaved edits, so closing the open workbook loses nothing.
        for _ in 0..app.session.documents().len() {
            let _ = app.session.execute("file.close", json!({"force": true}));
        }
        let format = self.0.format.borrow().clone();
        self.open(format!("Book.{format}"), bytes);
    }

    fn open(&self, name: String, bytes: Vec<u8>) {
        if let Some(inbox) = &*self.0.inbox.borrow() {
            inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes));
        }
        if let Some(ctx) = &*self.0.ctx.borrow() {
            ctx.request_repaint();
        }
    }

    /// Sends the workbook in the format it was opened in.
    fn save(&self, app: &mut SheetApp) {
        if !app.commit_edit(0, 0, false, false) {
            return;
        }
        let format = self.0.format.borrow().clone();
        let Some(snapshot) = app.session.active().map(|d| d.wb.clone()) else { return };
        let bytes = app
            .session
            .execute("file.saveBytes", json!({"format": format}))
            .ok()
            .and_then(|r| r.get("base64").and_then(serde_json::Value::as_str).and_then(gridcraft_engine::io::base64_decode));
        let Some(bytes) = bytes else {
            log::error!("couldn't encode the workbook as {format}");
            return;
        };
        let buffer = js_sys::Uint8Array::from(bytes.as_slice()).buffer();
        if self.send(&[("type", "save".into()), ("bytes", buffer.clone().into())], Some(&buffer)) {
            self.0.sent.borrow_mut().push_back(snapshot);
        }
    }

    /// Band answered the oldest `save`: `saved` makes the workbook as sent the saved one, so
    /// edits made since stay unsaved. `saveFailed` keeps it dirty.
    fn answer_save(&self, app: &mut SheetApp, saved: bool) {
        let Some(snapshot) = self.0.sent.borrow_mut().pop_front() else { return };
        if saved && let Some(doc) = app.session.active_mut() {
            doc.saved = snapshot;
        }
    }

    /// Post a message on the port; false if it couldn't be sent.
    fn send(&self, fields: &[(&str, JsValue)], transfer: Option<&js_sys::ArrayBuffer>) -> bool {
        let Some(port) = &*self.0.port.borrow() else { return false };
        let message = js_sys::Object::new();
        for (key, value) in fields {
            if js_sys::Reflect::set(&message, &JsValue::from_str(key), value).is_err() {
                return false;
            }
        }
        match transfer {
            Some(buffer) => port.post_message_with_transferable(&message, &js_sys::Array::of1(buffer)).is_ok(),
            None => port.post_message(&message).is_ok(),
        }
    }
}

fn get(data: &JsValue, key: &str) -> JsValue {
    js_sys::Reflect::get(data, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
}

/// `bytes` as an `ArrayBuffer` or `Uint8Array`.
fn bytes(data: &JsValue) -> Option<Vec<u8>> {
    let bytes = get(data, "bytes");
    if let Some(array) = bytes.dyn_ref::<js_sys::Uint8Array>() {
        Some(array.to_vec())
    } else if bytes.is_instance_of::<js_sys::ArrayBuffer>() {
        Some(js_sys::Uint8Array::new(&bytes).to_vec())
    } else {
        None
    }
}
