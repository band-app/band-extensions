//! GridCraft as a Band editor: the app side of `band_editor::Bridge`.
//!
//! Saving always sends the workbook in the format the file was opened in (`.xlsx` or `.csv`).
//! File > Save inside GridCraft counts as a save request when it would download an `.xlsx`; other
//! downloads (PDF export, Save As to another format) have nowhere to go and are dropped.
//!
//! In the compact layout the document opens in a preview first: an HTML table built from the
//! engine's own values and styles (`sheet_html`), drawn by the page script in `index.html` over the
//! egui canvas. The canvas keeps running underneath, so the document, its unsaved edits, its dirty
//! state and the agent's tools are the same in both modes. "Edit" hides the preview and "Preview"
//! shows it again; neither touches the workbook.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;

use band_editor::{Editor, Layout, Selection};
use gridcraft_engine::model::Workbook;
use gridcraft_ui_egui::{Inbox, Services, SheetApp};
use serde_json::json;
use wasm_bindgen::prelude::*;

use crate::mcp::McpHost;
use crate::sheet_html;

#[wasm_bindgen]
extern "C" {
    /// The page script in `index.html`.
    #[wasm_bindgen(js_namespace = gcPreview, js_name = setWake)]
    fn preview_set_wake(f: &JsValue);
    #[wasm_bindgen(js_namespace = gcPreview, js_name = drain)]
    fn preview_drain() -> js_sys::Array;
    #[wasm_bindgen(js_namespace = gcPreview, js_name = show)]
    fn preview_show(on: bool, back: bool);
    #[wasm_bindgen(js_namespace = gcPreview, js_name = render)]
    fn preview_render(html: &str, sheets: &str, active: usize, more: bool, cut_cols: bool);
}

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
    /// The interface as it was before the compact layout, restored by the regular one.
    regular_ui: Option<RegularUi>,
    /// The selection last computed, with what it was computed from (the text is the costly part).
    selection: Option<(SelectionKey, Option<Selection>)>,
    /// The layout is compact: the document opens in the preview.
    compact: bool,
    /// The person pressed Edit, so the egui editor shows instead of the preview.
    editing: bool,
    /// What the page shows now, to redraw only on a change.
    drawn: Option<PreviewKey>,
    /// The sheet the preview shows, when the person picked one. The workbook's active sheet is not changed.
    view_sheet: Option<usize>,
    /// Rows the preview draws; each page adds [`sheet_html::PAGE_ROWS`].
    rows: u32,
    /// What `show` last got, as (preview, back button).
    shown: Option<(bool, bool)>,
}

#[derive(PartialEq, Clone, Copy)]
struct PreviewKey {
    uid: u64,
    revision: u64,
    sheet: usize,
    rows: u32,
}

/// The interface settings the compact layout changes.
struct RegularUi {
    ribbon_collapsed: bool,
    status_bar: bool,
    formula_bar: bool,
    scale: u16,
}

/// Interface size in percent while compact: a row is about 42 points, close to a finger.
const COMPACT_SCALE: u16 = 125;

/// Most cells whose text is read for a selection. A larger range is still addressed, without text.
const MAX_TEXT_CELLS: u64 = 5000;

#[derive(PartialEq)]
struct SelectionKey {
    uid: u64,
    revision: u64,
    sheet: usize,
    address: String,
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
        let wake = {
            let ctx = ctx.clone();
            Closure::<dyn Fn()>::new(move || ctx.request_repaint())
        };
        preview_set_wake(wake.as_ref());
        // The page keeps the callback for its lifetime.
        wake.forget();
        Self {
            app,
            inbox,
            ctx,
            mcp,
            format: "xlsx".to_string(),
            want_save,
            sent: VecDeque::new(),
            regular_ui: None,
            selection: None,
            compact: false,
            editing: false,
            drawn: None,
            view_sheet: None,
            rows: sheet_html::PAGE_ROWS,
            shown: None,
        }
    }

    /// The preview is what the person sees: compact layout and Edit not pressed.
    fn previewing(&self) -> bool {
        self.compact && !self.editing
    }

    /// Once per frame, after the bridge: take the page's button presses, then show or hide the
    /// preview and redraw it if the document or the view changed.
    pub fn frame(&mut self) {
        for event in preview_drain().iter() {
            let Some(event) = event.as_string() else { continue };
            match event.as_str() {
                "edit" => self.editing = true,
                "back" => self.editing = false,
                "more" => self.rows = self.rows.saturating_add(sheet_html::PAGE_ROWS),
                other => {
                    if let Some(index) = other.strip_prefix("sheet:").and_then(|n| n.parse().ok()) {
                        self.view_sheet = Some(index);
                        self.rows = sheet_html::PAGE_ROWS;
                    }
                }
            }
        }
        let state = (self.previewing(), self.compact && self.editing);
        if self.shown != Some(state) {
            preview_show(state.0, state.1);
            self.shown = Some(state);
            // Show the editor's canvas again at once, and redraw it for the new size.
            self.ctx.request_repaint();
        }
        if !self.previewing() {
            return;
        }
        // No document yet (opening, or between a reload's close and open): keep what is drawn.
        let Ok(app) = self.app.try_borrow() else { return };
        let Some(doc) = app.session.active() else { return };
        let (names, active) = sheet_html::sheet_names(&doc.wb);
        let sheet = self.view_sheet.filter(|i| names.iter().any(|(n, _)| n == i)).or_else(|| names.get(active).map(|(i, _)| *i)).unwrap_or(0);
        let key = PreviewKey { uid: doc.uid, revision: doc.revision, sheet, rows: self.rows };
        if self.drawn == Some(key) {
            return;
        }
        let rendered = sheet_html::render(&doc.wb, sheet, self.rows);
        let names_json = serde_json::Value::Array(names.iter().map(|(i, n)| json!([i, n])).collect()).to_string();
        preview_render(&rendered.html, &names_json, sheet, rendered.more, rendered.cut_cols);
        self.drawn = Some(key);
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

    fn set_layout(&mut self, layout: Layout) {
        self.compact = layout.is_compact();
        let Ok(mut app) = self.app.try_borrow_mut() else { return };
        if layout.is_compact() {
            if self.regular_ui.is_none() {
                self.regular_ui = Some(RegularUi {
                    ribbon_collapsed: app.ui.ribbon_collapsed,
                    status_bar: app.ui.status_bar,
                    formula_bar: app.session.prefs.formula_bar,
                    scale: app.ui.interface_scale,
                });
            }
            app.ui.ribbon_collapsed = true;
            app.ui.status_bar = false;
            let _ = app.run("view.formulaBar", json!({"on": false}));
            let _ = app.run("view.interfaceScale", json!({"percent": COMPACT_SCALE}));
        } else if let Some(regular) = self.regular_ui.take() {
            app.ui.ribbon_collapsed = regular.ribbon_collapsed;
            app.ui.status_bar = regular.status_bar;
            let _ = app.run("view.formulaBar", json!({"on": regular.formula_bar}));
            let _ = app.run("view.interfaceScale", json!({"percent": regular.scale}));
        }
        self.ctx.request_repaint();
    }

    fn selection(&mut self) -> Option<Selection> {
        // The preview reports no selection: the active cell of the editor underneath is not what
        // the person is looking at, and following taps in the preview would need the engine to move it.
        if self.previewing() {
            return None;
        }
        let mut app = self.app.try_borrow_mut().ok()?;
        let (key, range_count) = {
            let doc = app.session.active()?;
            let sheet = doc.wb.sheet(doc.wb.active_sheet)?;
            let sel = &doc.selection;
            let address = format!("{}!{}", quote_sheet(&sheet.name), sel.a1());
            (
                SelectionKey { uid: doc.uid, revision: doc.revision, sheet: doc.wb.active_sheet, address },
                sel.ranges.iter().map(|r| r.count()).sum::<u64>(),
            )
        };
        if let Some((cached, value)) = &self.selection
            && *cached == key
        {
            return value.clone();
        }
        let single = app.session.active().is_some_and(|d| d.selection.is_single_cell());
        let kind = if single { "cell" } else { "range" };
        let mut selection = Selection::new(key.address.clone(), kind, key.address.clone());
        if range_count <= MAX_TEXT_CELLS
            && let Ok(read) = app.session.run("sheet.read", json!({"range": key.address, "formatted": true}))
        {
            selection = selection.with_text(tsv(&read));
        }
        self.selection = Some((key, Some(selection.clone())));
        Some(selection)
    }
}

/// `Sheet1` stays as it is; `My Sheet` becomes `'My Sheet'`, the form GridCraft's tools accept.
fn quote_sheet(name: &str) -> String {
    if name.chars().all(|c| c.is_alphanumeric() || c == '_') { name.to_string() } else { format!("'{}'", name.replace('\'', "''")) }
}

/// The `values` rows of a `sheet.read` reply as tab-separated text.
fn tsv(read: &serde_json::Value) -> String {
    let cell = |v: &serde_json::Value| match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    read.get("values")
        .and_then(serde_json::Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| row.as_array().map(|cols| cols.iter().map(cell).collect::<Vec<_>>().join("\t")).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
