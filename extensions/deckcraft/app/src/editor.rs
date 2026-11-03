//! DeckCraft as a Band editor: the app side of `band_editor::Bridge`.
//!
//! Saving always sends the presentation as `.pptx`. File > Save inside DeckCraft counts as a save
//! request when it would download a `.pptx` or `.deckcraft` file; other downloads (PDF, pictures,
//! Save As to another format) have nowhere to go and are dropped.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;

use band_editor::Editor;
use deckcraft_engine::cmd::base64_encode;
use deckcraft_ui_egui::{Services, SlideApp};
use serde_json::json;

use crate::mcp::McpHost;

pub struct DeckcraftEditor {
    app: Rc<RefCell<SlideApp>>,
    ctx: egui::Context,
    mcp: McpHost,
    /// The name Band gave the file, reused when the file is reloaded.
    name: String,
    /// The `uid` of the presentation Band's file is open as. `None` until `open` succeeds.
    uid: Option<u64>,
    /// Set by DeckCraft's own File > Save through `Services::download`.
    want_save: Rc<Cell<bool>>,
    /// The presentation as of each `save` that Band has not answered yet, oldest first.
    sent: VecDeque<Arc<deckcraft_engine::model::Presentation>>,
}

impl DeckcraftEditor {
    /// Route DeckCraft's File > Save to the returned flag, which the editor reads as a save request.
    pub fn route_save(services: &mut Services) -> Rc<Cell<bool>> {
        let want_save = Rc::new(Cell::new(false));
        let flag = want_save.clone();
        services.download = Some(Box::new(move |name: &str, _bytes: &[u8]| {
            let name = name.to_ascii_lowercase();
            if name.ends_with(".pptx") || name.ends_with(".deckcraft") {
                flag.set(true);
            } else {
                log::warn!("{name} was not sent to Band: only a save of the open file has a destination");
            }
        }));
        want_save
    }

    pub fn new(app: Rc<RefCell<SlideApp>>, ctx: egui::Context, want_save: Rc<Cell<bool>>) -> Self {
        let mcp = McpHost::new(app.clone(), ctx.clone());
        Self { app, ctx, mcp, name: "Presentation.pptx".to_string(), uid: None, want_save, sent: VecDeque::new() }
    }

    /// Open `bytes` as a new presentation and remember which one it is.
    fn open_bytes(&mut self, name: &str, bytes: &[u8]) {
        let result = match self.app.try_borrow_mut() {
            Ok(mut app) => {
                app.run("file.openBytes", json!({"name": name, "data": base64_encode(bytes)})).map(|_| app.session.active().map(|d| d.uid))
            }
            Err(_) => Err("DeckCraft is busy".to_string()),
        };
        match result {
            Ok(uid) => self.uid = uid,
            Err(e) => log::error!("couldn't open {name}: {e}"),
        }
        self.ctx.request_repaint();
    }

    fn with_doc<T>(&self, f: impl FnOnce(&deckcraft_engine::DocState) -> T) -> Option<T> {
        let uid = self.uid?;
        let app = self.app.try_borrow().ok()?;
        app.session.documents().iter().find(|d| d.uid == uid).map(f)
    }
}

impl Editor for DeckcraftEditor {
    fn open(&mut self, name: &str, bytes: Vec<u8>) {
        if !name.is_empty() {
            self.name = name.to_string();
        }
        let name = self.name.clone();
        self.open_bytes(&name, &bytes);
    }

    fn is_open(&self) -> bool {
        self.with_doc(|_| ()).is_some()
    }

    fn reload(&mut self, bytes: Vec<u8>) {
        // Band reloads only a tab without unsaved edits, so closing the open presentation loses nothing.
        if let (Some(uid), Ok(mut app)) = (self.uid.take(), self.app.try_borrow_mut())
            && let Some(i) = app.session.documents().iter().position(|d| d.uid == uid)
        {
            app.session.close_document(i);
        }
        // A `saved` that arrives after this reload belongs to the old presentation; drop the snapshots.
        self.sent.clear();
        let name = self.name.clone();
        self.open_bytes(&name, &bytes);
    }

    fn is_dirty(&self) -> bool {
        self.with_doc(|d| d.is_dirty()).unwrap_or(false)
    }

    fn take_save_request(&mut self) -> bool {
        self.want_save.replace(false)
    }

    fn save(&mut self) -> Option<Vec<u8>> {
        let (snapshot, bytes) = self.with_doc(|d| (d.doc.clone(), deckcraft_engine::cmd::file::save_bytes(&d.doc, "pptx")))?;
        match bytes {
            Ok(bytes) => {
                self.sent.push_back(snapshot);
                Some(bytes)
            }
            Err(e) => {
                log::error!("couldn't encode the presentation as pptx: {e}");
                None
            }
        }
    }

    fn save_answered(&mut self, saved: bool) {
        let Some(snapshot) = self.sent.pop_front() else { return };
        let Some(uid) = self.uid else { return };
        if !saved {
            return;
        }
        let Ok(mut app) = self.app.try_borrow_mut() else { return };
        let Some(i) = app.session.documents().iter().position(|d| d.uid == uid) else { return };
        // The session hands out only the active document mutably, so switch to it and back.
        let previous = app.session.active_index();
        app.session.set_active(i);
        if let Some(doc) = app.session.active_mut() {
            doc.saved_doc = snapshot;
        }
        if let Some(previous) = previous {
            app.session.set_active(previous);
        }
    }

    fn mcp(&mut self, requests: Vec<String>) -> Vec<String> {
        self.mcp.frame(&self.ctx, requests)
    }
}
