//! VectorCraft as a Band editor: the app side of `band_editor::Bridge`.
//!
//! The document Band opens is saved in the format the file has (`.svg`, `.svgz` or `.vectorcraft`).
//! Saving runs VectorCraft's own File > Save with the document's path set to the file's name, so
//! the web build hands the encoded bytes to its download service, which is [`SaveHook`] here. That
//! holds for Band's `requestSave` and for File > Save or Cmd+S inside VectorCraft alike. Other
//! downloads (PDF export, Save As to another format) have nowhere to go and fail with a message.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;

use band_editor::Editor;
use serde_json::json;
use vectorcraft_ui_egui::Services;
use vectorcraft_ui_egui::VectorcraftApp;

use crate::web::Inbox;

/// The app, shared by the frame loop, this editor and the MCP server. `None` while the app moves
/// to new graphics after a loss.
pub type SharedApp = Rc<RefCell<Option<VectorcraftApp>>>;

/// What VectorCraft's download service received for the open file.
#[derive(Default)]
pub struct SaveHook {
    /// The open file's extension in lower case, without the dot.
    ext: RefCell<String>,
    /// Set when a save of the open file arrived.
    want: Cell<bool>,
    bytes: RefCell<Option<Vec<u8>>>,
}

impl SaveHook {
    /// Route VectorCraft's downloads to the returned hook.
    pub fn route(services: &mut Services) -> Rc<SaveHook> {
        let hook = Rc::new(SaveHook::default());
        let this = hook.clone();
        services.download = Some(Box::new(move |name: &str, bytes: &[u8]| {
            let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
            if ext.is_empty() || ext != *this.ext.borrow() {
                log::warn!("{name} was not sent to Band: only a save of the open file has a destination");
                return Err(format!("{name} can't be saved from Band: only the open file's own format goes back to it"));
            }
            *this.bytes.borrow_mut() = Some(bytes.to_vec());
            this.want.set(true);
            Ok(())
        }));
        hook
    }
}

pub struct VectorcraftEditor {
    app: SharedApp,
    inbox: Inbox,
    ctx: egui::Context,
    hook: Rc<SaveHook>,
    /// The file's name as Band gave it.
    name: RefCell<String>,
    /// The document Band's file is open in.
    uid: Cell<Option<u64>>,
    /// The document as of the last time Band had the file: when it opened, and each `saved`. VectorCraft
    /// marks a document saved as soon as its download service accepts the bytes, so this puts the
    /// mark back until Band confirms.
    baseline: RefCell<Option<Arc<vectorcraft_doc::Document>>>,
    /// The document as of each `save` that Band has not answered yet, oldest first.
    sent: VecDeque<Arc<vectorcraft_doc::Document>>,
}

impl VectorcraftEditor {
    pub fn new(app: SharedApp, inbox: Inbox, ctx: egui::Context, hook: Rc<SaveHook>) -> Self {
        Self { app, inbox, ctx, hook, name: RefCell::new(String::new()), uid: Cell::new(None), baseline: RefCell::new(None), sent: VecDeque::new() }
    }

    fn push_to_inbox(&self, name: String, bytes: Vec<u8>) {
        self.inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes));
        self.ctx.request_repaint();
    }

    /// Find the document the last `open` made and give it the file's name as its path, so File >
    /// Save writes it without asking for a name.
    fn adopt(&self) {
        if self.uid.get().is_some() || !self.inbox.lock().unwrap_or_else(|e| e.into_inner()).is_empty() {
            return;
        }
        let Ok(mut guard) = self.app.try_borrow_mut() else { return };
        let Some(app) = guard.as_mut() else { return };
        if let Some(doc) = app.session.active_mut() {
            doc.path = Some(self.name.borrow().clone());
            // Save writes the format of the file, not the native one a document opened from bytes has.
            doc.format = match self.hook.ext.borrow().as_str() {
                "svg" => "svg",
                "svgz" => "svgz",
                _ => "vectorcraft",
            };
            *self.baseline.borrow_mut() = Some(doc.doc.clone());
            self.uid.set(Some(doc.uid));
        }
    }
}

impl Editor for VectorcraftEditor {
    fn open(&mut self, name: &str, bytes: Vec<u8>) {
        let name = if name.is_empty() { "drawing.svg" } else { name };
        *self.hook.ext.borrow_mut() = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
        *self.name.borrow_mut() = name.to_string();
        self.uid.set(None);
        self.push_to_inbox(name.to_string(), bytes);
    }

    fn is_open(&self) -> bool {
        self.adopt();
        self.uid.get().is_some()
    }

    fn reload(&mut self, bytes: Vec<u8>) {
        // Band reloads only a tab without unsaved edits, so closing the open document loses nothing.
        if let Ok(mut guard) = self.app.try_borrow_mut()
            && let Some(app) = guard.as_mut()
            && let Some(uid) = self.uid.get()
            && let Some(i) = app.session.documents().iter().position(|d| d.uid == uid)
        {
            let _ = app.session.execute("file.close", &json!({"index": i}));
        }
        // A `saved` that arrives after this reload belongs to the old document; drop the snapshots.
        self.sent.clear();
        self.hook.bytes.borrow_mut().take();
        self.uid.set(None);
        let name = self.name.borrow().clone();
        self.push_to_inbox(name, bytes);
    }

    fn is_dirty(&self) -> bool {
        self.adopt();
        let Some(uid) = self.uid.get() else { return false };
        self.app
            .try_borrow()
            .ok()
            .is_some_and(|guard| guard.as_ref().is_some_and(|app| app.session.documents().iter().any(|d| d.uid == uid && d.is_dirty())))
    }

    fn take_save_request(&mut self) -> bool {
        self.hook.want.replace(false) && self.uid.get().is_some()
    }

    fn save(&mut self) -> Option<Vec<u8>> {
        let uid = self.uid.get()?;
        let mut guard = self.app.try_borrow_mut().ok()?;
        let app = guard.as_mut()?;
        // File > Save inside VectorCraft already produced the bytes; Band's own request runs it here.
        if self.hook.bytes.borrow().is_none() {
            let i = app.session.documents().iter().position(|d| d.uid == uid)?;
            app.session.set_active(i);
            app.ui.answering_control = true;
            let saved = app.run("file.save", json!({}));
            app.ui.answering_control = false;
            if let Err(e) = saved {
                log::error!("couldn't encode the document: {e}");
                return None;
            }
        }
        self.hook.want.set(false);
        let bytes = self.hook.bytes.borrow_mut().take();
        if bytes.is_none() {
            log::error!("File > Save produced no bytes");
        }
        let bytes = bytes?;
        let snapshot = app.session.documents().iter().find(|d| d.uid == uid).map(|d| d.doc.clone())?;
        // Keep the file unsaved until Band says it was written.
        if let Some(baseline) = &*self.baseline.borrow()
            && let Some(doc) = app.session.document_mut(uid)
        {
            doc.mark_saved_as(baseline);
        }
        self.sent.push_back(snapshot);
        Some(bytes)
    }

    fn save_answered(&mut self, saved: bool) {
        let Some(snapshot) = self.sent.pop_front() else { return };
        let Some(uid) = self.uid.get() else { return };
        if !saved {
            return;
        }
        *self.baseline.borrow_mut() = Some(snapshot.clone());
        if let Ok(mut guard) = self.app.try_borrow_mut()
            && let Some(app) = guard.as_mut()
            && let Some(doc) = app.session.document_mut(uid)
        {
            doc.mark_saved_as(&snapshot);
        }
    }

    /// `tools.json` lists no tools, so Band should send none. A request that arrives anyway gets
    /// an error instead of silence.
    fn mcp(&mut self, requests: Vec<String>) -> Vec<String> {
        requests
            .iter()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter_map(|m| m.get("id").cloned())
            .map(|id| json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "VectorCraft offers no tools in Band"}}).to_string())
            .collect()
    }
}
