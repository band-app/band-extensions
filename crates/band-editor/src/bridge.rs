//! Band's editor protocol (extension API 1) over a `MessagePort`.
//!
//! Band frames an extension in `<iframe sandbox="allow-scripts">`, so the page has a `null` origin
//! and no origin check is possible. The page trusts two things instead: the message comes from
//! `window.parent`, and it is a `band:hello` with `extensionApi: 1` that carries a port. It keeps
//! the first such port, ignores every other window message, and speaks only on that port. A small
//! script in the app's `index.html` applies the same checks and keeps the port of a hello that
//! arrives before the wasm has loaded (it stores the port as `window.bandHelloPort`).
//!
//! Band to editor: `init { file: { name, path, mime, bytes, readOnly }, theme }`,
//! `requestSave`, `saved`, `saveFailed { error }`, `reload { bytes }`, `theme { tokens }`
//! (ignored) and `mcp { message }`.
//!
//! Editor to Band: `ready` (the file from `init` is open), `dirty { dirty }`,
//! `save { bytes }` (a transferred `ArrayBuffer`) and `mcp { message }` with the request's id.
//!
//! The app implements [`Editor`]. [`Bridge::sync`] runs once per frame, after the app has drawn
//! and with no borrow of the app held.

use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;

const EXTENSION_API: f64 = 1.0;

/// What the bridge needs from an app. Every method runs on the frame loop.
pub trait Editor {
    /// Start opening the file from `init`. `name` is empty when Band sent none. Opening may finish
    /// later; see [`Editor::is_open`].
    fn open(&mut self, name: &str, bytes: Vec<u8>);

    /// True when the last file passed to `open` is open. The bridge then sends `ready`.
    fn is_open(&self) -> bool;

    /// Replace the open file with new bytes. Band calls this only for a tab with no unsaved
    /// edits. Forget any save that Band has not answered yet.
    fn reload(&mut self, bytes: Vec<u8>);

    /// True while the open file has unsaved edits.
    fn is_dirty(&self) -> bool;

    /// True once if the app's own UI asked to save (File > Save). Band's `requestSave` does not
    /// go through this.
    fn take_save_request(&mut self) -> bool;

    /// Encode the file in the format it was opened in and remember what is being sent. `None`
    /// when it can't be encoded, in which case nothing is sent.
    fn save(&mut self) -> Option<Vec<u8>>;

    /// Band answered the oldest `save`. `saved` makes the bytes as sent the saved state, so edits
    /// made since stay unsaved. A failed save keeps the file dirty.
    fn save_answered(&mut self, saved: bool);

    /// Handle MCP JSON-RPC requests (JSON text) and return the replies ready now (JSON text).
    /// Called every frame, with an empty slice when nothing arrived, so a tool that finishes over
    /// several frames (a screenshot) can answer later.
    fn mcp(&mut self, requests: Vec<String>) -> Vec<String>;
}

#[derive(Clone, Default)]
pub struct Bridge(Rc<Inner>);

#[derive(Default)]
struct Inner {
    port: RefCell<Option<web_sys::MessagePort>>,
    /// Port messages other than `mcp`, received since the last frame.
    events: RefCell<Vec<JsValue>>,
    /// `mcp` messages (JSON text) received since the last frame.
    mcp: RefCell<Vec<String>>,
    /// Asks the app to draw a frame, so a message is handled without waiting for input.
    repaint: RefCell<Option<Box<dyn Fn()>>>,
    /// `init` was handled and `ready` has not been sent yet.
    awaiting_ready: std::cell::Cell<bool>,
    /// The unsaved-changes state last reported to Band.
    reported: std::cell::Cell<bool>,
}

impl Bridge {
    /// `None` when the page isn't framed. Starts waiting for `band:hello`.
    pub fn listen() -> Option<Self> {
        let window = web_sys::window()?;
        let parent = window.parent().ok().flatten()?;
        if js_sys::Object::is(&parent, &window) {
            return None;
        }
        let bridge = Self::default();
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

    /// Set the function that draws a frame. Call it once the app exists. Messages that arrived
    /// before are waiting, so it is called once now.
    pub fn set_repaint(&self, repaint: impl Fn() + 'static) {
        repaint();
        *self.0.repaint.borrow_mut() = Some(Box::new(repaint));
    }

    fn accept(&self, port: web_sys::MessagePort) {
        let this = self.clone();
        let on_port = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |event: web_sys::MessageEvent| {
            let data = event.data();
            if get(&data, "type").as_string().as_deref() == Some("mcp") {
                if let Some(text) = message_text(&data) {
                    this.0.mcp.borrow_mut().push(text);
                }
            } else {
                this.0.events.borrow_mut().push(data);
            }
            if let Some(repaint) = &*this.0.repaint.borrow() {
                repaint();
            }
        });
        port.set_onmessage(Some(on_port.as_ref().unchecked_ref()));
        // The handler lives as long as the page.
        on_port.forget();
        *self.0.port.borrow_mut() = Some(port);
    }

    /// After each frame: handle what Band sent, then report what changed.
    pub fn sync(&self, editor: &mut dyn Editor) {
        let inner = &self.0;
        if inner.awaiting_ready.get() && editor.is_open() {
            inner.awaiting_ready.set(false);
            self.send(&[("type", "ready".into())], None);
        }
        let mut want_save = editor.take_save_request();
        let events = std::mem::take(&mut *inner.events.borrow_mut());
        for event in events {
            match get(&event, "type").as_string().as_deref() {
                Some("init") => self.init(editor, &event),
                Some("reload") => match bytes(&event) {
                    Some(bytes) => editor.reload(bytes),
                    None => log("reload carried no bytes"),
                },
                Some("requestSave") => want_save = true,
                Some("saved") => editor.save_answered(true),
                Some("saveFailed") => editor.save_answered(false),
                _ => {}
            }
        }
        if want_save {
            self.save(editor);
        }
        let requests = std::mem::take(&mut *inner.mcp.borrow_mut());
        for reply in editor.mcp(requests) {
            if let Ok(message) = js_sys::JSON::parse(&reply) {
                self.send(&[("type", "mcp".into()), ("message", message)], None);
            }
        }
        let dirty = editor.is_dirty();
        if inner.reported.get() != dirty && self.send(&[("type", "dirty".into()), ("dirty", dirty.into())], None) {
            inner.reported.set(dirty);
        }
    }

    fn init(&self, editor: &mut dyn Editor, event: &JsValue) {
        let file = get(event, "file");
        let name = get(&file, "name").as_string().filter(|n| !n.trim().is_empty()).unwrap_or_default();
        let Some(bytes) = bytes(&file) else {
            log("init carried no bytes");
            return;
        };
        editor.open(&name, bytes);
        self.0.awaiting_ready.set(true);
    }

    fn save(&self, editor: &mut dyn Editor) {
        // Without a port nobody would answer, so the editor must not count a save as sent.
        if self.0.port.borrow().is_none() {
            return;
        }
        let Some(bytes) = editor.save() else { return };
        let buffer = js_sys::Uint8Array::from(bytes.as_slice()).buffer();
        self.send(&[("type", "save".into()), ("bytes", buffer.clone().into())], Some(&buffer));
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

/// The `message` field of an envelope as JSON text.
pub fn message_text(envelope: &JsValue) -> Option<String> {
    js_sys::Reflect::get(envelope, &"message".into()).ok().and_then(|m| js_sys::JSON::stringify(&m).ok()).and_then(|s| s.as_string())
}

fn log(message: &str) {
    web_sys::console::error_1(&JsValue::from_str(message));
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
