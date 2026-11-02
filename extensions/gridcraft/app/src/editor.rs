//! GridCraft as a Band editor: the app side of `band_editor::Bridge`.
//!
//! Saving always sends the workbook in the format the file was opened in (`.xlsx` or `.csv`).
//! File > Save inside GridCraft counts as a save request when it would download an `.xlsx`; other
//! downloads (PDF export, Save As to another format) have nowhere to go and are dropped.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;

use band_editor::Editor;
use gridcraft_engine::model::Workbook;
use gridcraft_ui_egui::{Inbox, Services, SheetApp};
use serde_json::json;

use crate::mcp::McpHost;

pub struct GridcraftEditor {
    app: Rc<RefCell<SheetApp>>,
    inbox: Inbox,
    ctx: egui::Context,
    mcp: McpHost,
    /// The file's extension in lower case: `xlsx` or `csv`.
    format: String,
    /// Set by GridCraft's own File > Save through `Services::download`.
    want_save: Rc<Cell<bool>>,
    /// The workbook as of each `save` that Band has not answered yet, oldest first.
    sent: VecDeque<Arc<Workbook>>,
}

impl GridcraftEditor {
    /// Route GridCraft's File > Save to the returned flag, which the editor reads as a save request.
    pub fn route_save(services: &mut Services) -> Rc<Cell<bool>> {
        let want_save = Rc::new(Cell::new(false));
        let flag = want_save.clone();
        services.download = Some(Box::new(move |name: &str, _bytes: &[u8]| {
            if name.to_ascii_lowercase().ends_with(".xlsx") {
                flag.set(true);
            } else {
                log::warn!("{name} was not sent to Band: only a save of the open file has a destination");
            }
        }));
        want_save
    }

    pub fn new(app: Rc<RefCell<SheetApp>>, inbox: Inbox, ctx: egui::Context, want_save: Rc<Cell<bool>>) -> Self {
        let mcp = McpHost::new(app.clone(), ctx.clone());
        Self { app, inbox, ctx, mcp, format: "xlsx".to_string(), want_save, sent: VecDeque::new() }
    }

    fn push_to_inbox(&self, name: String, bytes: Vec<u8>) {
        self.inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes));
        self.ctx.request_repaint();
    }
}

impl Editor for GridcraftEditor {
    fn open(&mut self, name: &str, bytes: Vec<u8>) {
        let name = if name.is_empty() { "Book.xlsx" } else { name };
        self.format = if name.to_ascii_lowercase().ends_with(".csv") { "csv" } else { "xlsx" }.to_string();
        self.push_to_inbox(name.to_string(), bytes);
    }

    fn is_open(&self) -> bool {
        self.inbox.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
    }

    fn reload(&mut self, bytes: Vec<u8>) {
        // Band reloads only a tab without unsaved edits, so closing the open workbook loses nothing.
        if let Ok(mut app) = self.app.try_borrow_mut() {
            for _ in 0..app.session.documents().len() {
                let _ = app.session.execute("file.close", json!({"force": true}));
            }
        }
        // A `saved` that arrives after this reload belongs to the old workbook; drop the snapshots.
        self.sent.clear();
        self.push_to_inbox(format!("Book.{}", self.format), bytes);
    }

    fn is_dirty(&self) -> bool {
        self.app.try_borrow().is_ok_and(|app| app.session.documents().iter().any(|d| d.is_dirty()))
    }

    fn take_save_request(&mut self) -> bool {
        self.want_save.replace(false)
    }

    fn save(&mut self) -> Option<Vec<u8>> {
        let mut app = self.app.try_borrow_mut().ok()?;
        if !app.commit_edit(0, 0, false, false) {
            return None;
        }
        let snapshot = app.session.active().map(|d| d.wb.clone())?;
        let bytes = app
            .session
            .execute("file.saveBytes", json!({"format": self.format}))
            .ok()
            .and_then(|r| r.get("base64").and_then(serde_json::Value::as_str).and_then(gridcraft_engine::io::base64_decode));
        if bytes.is_none() {
            log::error!("couldn't encode the workbook as {}", self.format);
        }
        let bytes = bytes?;
        self.sent.push_back(snapshot);
        Some(bytes)
    }

    fn save_answered(&mut self, saved: bool) {
        let Some(snapshot) = self.sent.pop_front() else { return };
        if saved
            && let Ok(mut app) = self.app.try_borrow_mut()
            && let Some(doc) = app.session.active_mut()
        {
            doc.saved = snapshot;
        }
    }

    fn mcp(&mut self, requests: Vec<String>) -> Vec<String> {
        self.mcp.frame(&self.ctx, requests)
    }
}
