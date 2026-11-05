//! DeckCraft as a Band editor: the app side of `band_editor::Bridge`.
//!
//! Saving always sends the presentation as `.pptx`. File > Save inside DeckCraft counts as a save
//! request when it would download a `.pptx` or `.deckcraft` file; other downloads (PDF, pictures,
//! Save As to another format) have nowhere to go and are dropped.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;

use band_editor::{Editor, Layout, Rect, Selection};
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
    /// The interface as it was before the compact layout, restored by the regular one.
    regular_ui: Option<RegularUi>,
}

/// The interface settings the compact layout changes.
struct RegularUi {
    ribbon_collapsed: bool,
    pane: Option<String>,
    notes: bool,
    thumbs_width: f32,
}

/// Width of the slide list while compact, the narrowest DeckCraft allows.
const COMPACT_THUMBS_WIDTH: f32 = 150.0;

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
        Self { app, ctx, mcp, name: "Presentation.pptx".to_string(), uid: None, want_save, sent: VecDeque::new(), regular_ui: None }
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

    fn set_layout(&mut self, layout: Layout) {
        let Ok(mut app) = self.app.try_borrow_mut() else { return };
        if layout.is_compact() {
            if self.regular_ui.is_none() {
                self.regular_ui = Some(RegularUi {
                    ribbon_collapsed: app.ui.ribbon_collapsed,
                    pane: app.ui.pane.clone(),
                    notes: app.ui.notes,
                    thumbs_width: app.ui.thumbs_width,
                });
            }
            app.ui.ribbon_collapsed = true;
            app.ui.pane = None;
            app.ui.notes = false;
            app.ui.thumbs_width = COMPACT_THUMBS_WIDTH;
        } else if let Some(regular) = self.regular_ui.take() {
            app.ui.ribbon_collapsed = regular.ribbon_collapsed;
            app.ui.pane = regular.pane;
            app.ui.notes = regular.notes;
            app.ui.thumbs_width = regular.thumbs_width;
        }
        self.ctx.request_repaint();
    }

    /// The first selected shape, addressed as `slide<index>!<shape id>`: the index `go_to_slide` and
    /// `inspect_slide` take (from 0) and the id `inspect_slide` and `set_text` take. Selected text
    /// inside it is reported as `text`.
    fn selection(&mut self) -> Option<Selection> {
        let uid = self.uid?;
        let app = self.app.try_borrow().ok()?;
        let doc = app.session.documents().iter().find(|d| d.uid == uid)?;
        // Only the main slide view; a master or layout has no slide to address.
        if doc.selection.target != deckcraft_engine::Target::Slides {
            return None;
        }
        let shape = doc.selected_shapes().into_iter().next()?;
        let slide = doc.selection.slide;
        let name = if shape.name.is_empty() { format!("Shape {}", shape.id.0) } else { shape.name.clone() };
        let mut label = format!("{name} on slide {}", slide + 1);
        if doc.selection.shapes.len() > 1 {
            label.push_str(&format!(" and {} more", doc.selection.shapes.len() - 1));
        }
        let all_text = shape.text.as_ref().map(|t| t.text()).unwrap_or_default();
        let (kind, text) = match doc.selection.text.as_ref().filter(|t| t.shape == shape.id && t.cell.is_none() && !t.notes) {
            Some(sel) if sel.anchor != sel.caret => ("text", selected_text(shape, sel.anchor, sel.caret).unwrap_or(all_text)),
            _ => ("shape", all_text),
        };
        let mut selection = Selection::new(format!("slide{slide}!{}", shape.id.0), kind, label);
        if !text.is_empty() {
            selection = selection.with_text(text);
        }
        if let Some(x) = &shape.xfrm {
            selection = selection.with_rect(Rect { x: x.x, y: x.y, width: x.w, height: x.h });
        }
        Some(selection)
    }
}

/// The text between two (paragraph, char) positions of a shape's text, `\n` between paragraphs.
fn selected_text(shape: &deckcraft_engine::model::Shape, a: (usize, usize), b: (usize, usize)) -> Option<String> {
    let (start, end) = if a <= b { (a, b) } else { (b, a) };
    let body = shape.text.as_ref()?;
    let mut lines = Vec::new();
    for (i, paragraph) in body.paragraphs.iter().enumerate().take(end.0 + 1).skip(start.0) {
        let chars: Vec<char> = paragraph.text().chars().collect();
        let from = if i == start.0 { start.1.min(chars.len()) } else { 0 };
        let to = if i == end.0 { end.1.min(chars.len()) } else { chars.len() };
        lines.push(chars[from..to.max(from)].iter().collect::<String>());
    }
    Some(lines.join("\n"))
}
