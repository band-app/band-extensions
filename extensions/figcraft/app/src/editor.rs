//! FigCraft as a Band editor: the app side of `band_editor::Bridge`.
//!
//! Band opens one file per tab. A `.figcraft` file is saved as `.figcraft`, and a `.fig` file is saved
//! as a `.fig` export (experimental in FigCraft: see the README). File > Save inside FigCraft counts
//! as a save request when it would download a `.figcraft` file; other downloads (exports, plugins)
//! have nowhere to go and are refused.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;

use band_editor::{Editor, Layout, Rect, Selection};
use base64::Engine as _;
use figcraft_doc::Document;
use figcraft_ui_egui::{FigApp, control};
use serde_json::{Value, json};

use crate::mcp::McpHost;
use crate::preview::Preview;

/// The file's format, from its name.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Figcraft,
    Fig,
}

impl Format {
    fn of(name: &str) -> Self {
        if name.to_ascii_lowercase().ends_with(".fig") { Self::Fig } else { Self::Figcraft }
    }
}

pub struct FigcraftEditor {
    app: Rc<RefCell<FigApp>>,
    ctx: egui::Context,
    mcp: McpHost,
    format: Format,
    /// The name Band gave the file, which tells FigCraft the format.
    name: String,
    /// Set by FigCraft's own File > Save through `Services::download`.
    want_save: Rc<Cell<bool>>,
    /// The file could not be opened, so what is on screen is not the file: saving would replace it.
    broken: bool,
    /// Band refused the last save, so the file stays dirty even if FigCraft marked it saved.
    failed: bool,
    /// The document as of each `save` that Band has not answered yet, oldest first.
    sent: VecDeque<Arc<Document>>,
    /// The panels as they were before the compact layout, restored by the regular one:
    /// `left_collapsed` and `ui_minimized`.
    regular_ui: Option<(bool, bool)>,
    /// The HTML preview a compact layout opens first.
    preview: Preview,
}

impl FigcraftEditor {
    pub fn new(app: Rc<RefCell<FigApp>>, ctx: egui::Context, want_save: Rc<Cell<bool>>) -> Self {
        let mcp = McpHost::new(app.clone(), ctx.clone(), want_save.clone());
        let preview = Preview::new(app.clone(), ctx.clone());
        Self {
            app,
            ctx,
            mcp,
            format: Format::Figcraft,
            name: String::new(),
            want_save,
            broken: false,
            failed: false,
            sent: VecDeque::new(),
            regular_ui: None,
            preview,
        }
    }

    /// Run once per frame, before the bridge: drives the preview.
    pub fn tick(&mut self) {
        self.preview.tick();
    }

    /// Close every tab and open `bytes` as the only one.
    fn replace_with(&mut self, bytes: &[u8]) {
        let Ok(mut app) = self.app.try_borrow_mut() else {
            self.broken = true;
            return;
        };
        while !app.session.docs.is_empty() {
            let closed = control::handle(&mut app, &self.ctx, "engine.execute", &json!({"command": "file.close", "params": {"force": true}}));
            if closed.is_err() {
                break;
            }
        }
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let opened =
            control::handle(&mut app, &self.ctx, "engine.execute", &json!({"command": "file.open", "params": {"name": self.name, "data": data}}));
        self.broken = false;
        if let Err(why) = opened {
            log::error!("couldn't open {}: {why}", self.name);
            app.show_error(why);
            self.broken = true;
        }
        self.ctx.request_repaint();
    }

    /// The bytes to save, in the format the file was opened in.
    fn encode(&mut self) -> Option<(Vec<u8>, Arc<Document>)> {
        let mut app = self.app.try_borrow_mut().ok()?;
        let snapshot = app.session.ds().ok()?.doc.clone();
        let (command, params) = match self.format {
            Format::Figcraft => ("file.saveAs", json!({"data": true})),
            Format::Fig => ("file.export", json!({"format": "fig"})),
        };
        let reply = control::handle(&mut app, &self.ctx, "engine.execute", &json!({"command": command, "params": params}));
        let bytes = reply
            .map_err(|why| log::error!("couldn't encode {}: {why}", self.name))
            .ok()
            .and_then(|r| r.get("data").and_then(Value::as_str).and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok()));
        bytes.map(|b| (b, snapshot))
    }
}

impl Editor for FigcraftEditor {
    fn open(&mut self, name: &str, bytes: Vec<u8>) {
        self.name = if name.is_empty() { "Design.figcraft".to_string() } else { name.to_string() };
        self.format = Format::of(&self.name);
        self.replace_with(&bytes);
        self.preview.reset();
    }

    fn is_open(&self) -> bool {
        true
    }

    fn reload(&mut self, bytes: Vec<u8>) {
        // Band reloads only a tab without unsaved edits, so closing the open file loses nothing.
        // A `saved` that arrives after this reload belongs to the old file; drop the snapshots.
        self.sent.clear();
        self.failed = false;
        self.replace_with(&bytes);
        self.preview.invalidate();
    }

    fn is_dirty(&self) -> bool {
        self.failed || self.app.try_borrow().is_ok_and(|app| app.session.docs.iter().any(figcraft_engine::DocState::is_dirty))
    }

    fn take_save_request(&mut self) -> bool {
        self.want_save.replace(false)
    }

    fn save(&mut self) -> Option<Vec<u8>> {
        if self.broken {
            log::error!("{} did not open, so it is not saved", self.name);
            return None;
        }
        let (bytes, snapshot) = self.encode()?;
        self.sent.push_back(snapshot);
        Some(bytes)
    }

    fn save_answered(&mut self, saved: bool) {
        let Some(snapshot) = self.sent.pop_front() else { return };
        self.failed = !saved;
        if saved
            && let Ok(mut app) = self.app.try_borrow_mut()
            && let Some(ds) = app.session.docs.iter_mut().find(|d| Arc::ptr_eq(&d.doc, &snapshot))
        {
            // Edits made since the save stay unsaved: only the document as sent counts as saved.
            ds.mark_saved();
        }
    }

    fn mcp(&mut self, requests: Vec<String>) -> Vec<String> {
        self.mcp.frame(requests)
    }

    /// FigCraft already shows one side panel at a time in a window narrower than `NARROW_WIDTH`.
    /// Compact also closes the open panel and minimizes the interface (the toolbar stays), so a wide
    /// frame such as an iPad gets the same canvas-first layout.
    fn set_layout(&mut self, layout: Layout) {
        self.preview.set_compact(layout.is_compact());
        let Ok(mut app) = self.app.try_borrow_mut() else { return };
        if layout.is_compact() {
            if self.regular_ui.is_none() {
                let minimized = app.session.ds().is_ok_and(|d| d.view.ui_minimized);
                self.regular_ui = Some((app.ui.left_collapsed, minimized));
            }
            app.ui.close_left_panel();
            app.ui.mobile_panel = None;
            let _ = app.session.execute("view.minimize", &json!({"on": true}));
        } else if let Some((left_collapsed, minimized)) = self.regular_ui.take() {
            app.ui.left_collapsed = left_collapsed;
            let _ = app.session.execute("view.minimize", &json!({"on": minimized}));
        }
        self.ctx.request_repaint();
    }

    fn set_theme(&mut self, mode: &str, tokens: &Value) {
        self.preview.set_theme(mode, tokens);
    }

    /// The first selected node, addressed by the id every FigCraft tool takes (`get_node`, `create_node`
    /// parents, `execute` commands).
    fn selection(&mut self) -> Option<Selection> {
        // The preview reports none: the editor's selection is out of sight while it shows.
        if self.preview.is_previewing() {
            return None;
        }
        let app = self.app.try_borrow().ok()?;
        let ds = app.session.ds().ok()?;
        let id = *ds.selection.first()?;
        let node = ds.doc.node(id)?;
        let name = if node.name.is_empty() { node.kind.type_name().to_string() } else { node.name.clone() };
        let mut label = name;
        if ds.selection.len() > 1 {
            label.push_str(&format!(" and {} more", ds.selection.len() - 1));
        }
        let kind = if node.kind.text().is_some() { "text" } else { "node" };
        let mut selection = Selection::new(id.to_string(), kind, label);
        if let Some(text) = node.kind.text() {
            selection = selection.with_text(text.characters.clone());
        }
        if let Some(b) = ds.doc.world_bounds(id) {
            selection = selection.with_rect(Rect { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 });
        }
        Some(selection)
    }
}
