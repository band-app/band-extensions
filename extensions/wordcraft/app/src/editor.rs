//! WordCraft as a Band editor: the app side of `band_editor::Bridge`.
//!
//! Saving always sends the document in the format the file was opened in (`.docx`, `.odt` or
//! `.rtf`). File > Save inside WordCraft counts as a save request when it would write that
//! format; other downloads (PDF export, Save As to another format) have nowhere to go, so the
//! app reports them as failed.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::rc::Rc;
use std::sync::mpsc::Sender;

use band_editor::{Editor, Layout, Selection};
use serde_json::json;
use wordcraft_ui_egui::control::ControlRequest;
use wordcraft_ui_egui::{Inbox, Services, WordApp};

use crate::mcp::McpHost;
use crate::preview::{Click, Preview, View};

/// What `route_save` shares with the editor.
pub struct SaveRoute {
    /// Set when WordCraft's own File > Save wrote the file's format.
    want_save: Rc<Cell<bool>>,
    /// The open file's extension in lower case.
    format: Rc<RefCell<String>>,
}

pub struct WordcraftEditor {
    app: Rc<RefCell<WordApp>>,
    inbox: Inbox,
    ctx: egui::Context,
    mcp: McpHost,
    /// The name Band gave the file, which Save writes under.
    name: String,
    route: SaveRoute,
    /// A hash of the bytes of each `save` that Band has not answered yet, oldest first.
    sent: VecDeque<u64>,
    /// The interface as it was before the compact layout, restored by the regular one.
    regular_ui: Option<RegularUi>,
    /// The compact layout's reading view; `None` when the page lacks its markup.
    preview: Option<Preview>,
    /// Band asked for the compact layout.
    compact: bool,
    /// What a compact page shows: the reading view first, the editor after Edit.
    view: View,
    /// The reading view must be rebuilt from the document.
    stale: bool,
}

/// The interface settings the compact layout changes.
struct RegularUi {
    ribbon_collapsed: bool,
    quick_access_toolbar: bool,
    nav_pane: bool,
    interface_size: wordcraft_ui_egui::theme::InterfaceSize,
}

/// Interface size in percent while compact.
const COMPACT_SCALE_PERCENT: f64 = 125.0;

fn extension(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

fn fingerprint(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

impl WordcraftEditor {
    /// Route WordCraft's File > Save to the returned flag, which the editor reads as a save request.
    /// `Services::host_save` gets Save back under the opened file's own name and format.
    pub fn route_save(services: &mut Services) -> SaveRoute {
        let route = SaveRoute { want_save: Rc::new(Cell::new(false)), format: Rc::new(RefCell::new("docx".to_string())) };
        let (flag, format) = (route.want_save.clone(), route.format.clone());
        services.host_save = Some(Box::new(move |name: &str, _bytes: &[u8], _save_as: bool| {
            let open_format = format.borrow().clone();
            if extension(name) == open_format {
                flag.set(true);
                Ok(())
            } else {
                Err(format!("Band saves only the open file, as .{open_format}"))
            }
        }));
        // The app takes the download path only when this is set; `host_save` answers first.
        services.download = Some(Box::new(|name: &str, _bytes: &[u8]| Err(format!("{name}: Band has nowhere to put this file"))));
        route
    }

    pub fn new(app: Rc<RefCell<WordApp>>, inbox: Inbox, ctx: egui::Context, route: SaveRoute, control: Sender<ControlRequest>) -> Self {
        let mcp = McpHost::new(app.clone(), ctx.clone(), control);
        let repaint_ctx = ctx.clone();
        let preview = Preview::install(move || repaint_ctx.request_repaint());
        Self {
            app,
            inbox,
            ctx,
            mcp,
            name: "Document.docx".to_string(),
            route,
            sent: VecDeque::new(),
            regular_ui: None,
            preview,
            compact: false,
            view: View::Edit,
            stale: false,
        }
    }

    /// Runs once per frame before the bridge: handles the Edit and back buttons and rebuilds the
    /// reading view when the document may have changed.
    pub fn frame(&mut self) {
        let open = self.is_open();
        let Some(preview) = &mut self.preview else { return };
        match preview.take_click() {
            Some(Click::Edit) => self.view = View::Edit,
            Some(Click::Back) => {
                self.view = View::Preview;
                self.stale = true;
            }
            None => {}
        }
        preview.set_mode(self.compact, self.view);
        if !(self.compact && self.view == View::Preview && self.stale && open) {
            return;
        }
        // A busy app (it is drawing) is tried again on the next frame.
        let Ok(app) = self.app.try_borrow() else { return };
        let html = wordcraft_formats::html::export_fragment(&app.session.doc);
        drop(app);
        preview.show(&self.name, &html);
        self.stale = false;
    }

    fn push_to_inbox(&self, name: String, bytes: Vec<u8>) {
        self.inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes));
        self.ctx.request_repaint();
    }

    /// The active document in the open file's format.
    fn encode(&self, app: &WordApp) -> Option<Vec<u8>> {
        let session = &app.session;
        let password = session.password.as_ref().map(wordcraft_engine::Password::as_str);
        let opts = wordcraft_engine::cmd::file::export_options(session, &json!({}));
        match wordcraft_engine::io::save_bytes_with(&self.name, &session.doc, password, &opts) {
            Ok(bytes) => Some(bytes),
            Err(e) => {
                log::error!("couldn't encode the document as {}: {e}", self.name);
                None
            }
        }
    }
}

impl Editor for WordcraftEditor {
    fn open(&mut self, name: &str, bytes: Vec<u8>) {
        self.name = if name.is_empty() { "Document.docx".to_string() } else { name.to_string() };
        let ext = extension(&self.name);
        *self.route.format.borrow_mut() = if ext.is_empty() { "docx".to_string() } else { ext };
        self.stale = true;
        self.push_to_inbox(self.name.clone(), bytes);
    }

    fn is_open(&self) -> bool {
        self.inbox.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
    }

    fn reload(&mut self, bytes: Vec<u8>) {
        // Band reloads only a tab without unsaved edits, so closing the open documents loses nothing.
        if let Ok(mut app) = self.app.try_borrow_mut() {
            for _ in 0..app.session.documents().len() {
                let _ = app.execute("file.close", json!({"force": true}));
            }
        }
        // A `saved` that arrives after this reload belongs to the old document; drop the snapshots.
        self.sent.clear();
        self.stale = true;
        self.push_to_inbox(self.name.clone(), bytes);
    }

    fn is_dirty(&self) -> bool {
        self.app.try_borrow().is_ok_and(|app| app.session.documents().iter().any(|d| d.dirty))
    }

    fn take_save_request(&mut self) -> bool {
        self.route.want_save.replace(false)
    }

    fn save(&mut self) -> Option<Vec<u8>> {
        let mut app = self.app.try_borrow_mut().ok()?;
        // As Word does on every save: modified time, last modified by, revision.
        app.session.stamp_save();
        let bytes = self.encode(&app)?;
        self.sent.push_back(fingerprint(&bytes));
        Some(bytes)
    }

    fn save_answered(&mut self, saved: bool) {
        let Some(sent) = self.sent.pop_front() else { return };
        let Ok(mut app) = self.app.try_borrow_mut() else { return };
        // The app's own File > Save marked the document saved when it handed the bytes over. Mark
        // it saved only if Band stored them and nothing changed since.
        let unchanged = saved && self.encode(&app).is_some_and(|bytes| fingerprint(&bytes) == sent);
        app.session.dirty = !unchanged;
    }

    fn mcp(&mut self, requests: Vec<String>) -> Vec<String> {
        // A tool call may edit the document; the reading view catches up on the next frame.
        if requests.iter().any(|r| r.contains("\"tools/call\"")) {
            self.stale = true;
            self.ctx.request_repaint();
        }
        self.mcp.frame(&self.ctx, requests)
    }

    fn set_layout(&mut self, layout: Layout) {
        // Compact starts on the reading view. A repeated `compact` leaves a person in the editor.
        if layout.is_compact() && !self.compact {
            self.view = View::Preview;
            self.stale = true;
        }
        self.compact = layout.is_compact();
        if let Some(preview) = &mut self.preview {
            preview.set_mode(self.compact, self.view);
        }
        let Ok(mut app) = self.app.try_borrow_mut() else { return };
        if layout.is_compact() {
            if self.regular_ui.is_none() {
                self.regular_ui = Some(RegularUi {
                    ribbon_collapsed: app.ui.ribbon_collapsed,
                    quick_access_toolbar: app.ui.quick_access_toolbar,
                    nav_pane: app.ui.nav_pane,
                    interface_size: app.ui.interface_size,
                });
            }
            app.ui.ribbon_collapsed = true;
            app.ui.quick_access_toolbar = false;
            app.ui.nav_pane = false;
            if let Some(size) = wordcraft_ui_egui::theme::InterfaceSize::from_percent(COMPACT_SCALE_PERCENT) {
                app.ui.interface_size = size;
            }
        } else if let Some(regular) = self.regular_ui.take() {
            app.ui.ribbon_collapsed = regular.ribbon_collapsed;
            app.ui.quick_access_toolbar = regular.quick_access_toolbar;
            app.ui.nav_pane = regular.nav_pane;
            app.ui.interface_size = regular.interface_size;
        }
        self.ctx.request_repaint();
    }

    /// The selection as WordCraft's own `select.range` parameters, `{"anchor": Pos, "focus": Pos}`: an
    /// agent restores it with `execute select.range <address>`, after which `type_text` replaces it
    /// and `execute` formatting commands act on it. A caret with nothing selected is a `paragraph`
    /// (`select.paragraph` selects the paragraph around it); selected text is `text`.
    ///
    /// The reading view reports no selection: while it is showing, the editor's selection is not
    /// what the person sees, and reflowed text has no address `select.range` could take.
    fn selection(&mut self) -> Option<Selection> {
        if self.compact && self.view == View::Preview && self.preview.is_some() {
            return None;
        }
        let app = self.app.try_borrow().ok()?;
        let session = &app.session;
        if session.documents().is_empty() {
            return None;
        }
        let sel = &session.sel;
        let address = serde_json::to_string(sel).ok()?;
        let block =
            if sel.focus.story == wordcraft_doc::StoryRef::Body { Some(sel.focus.path.0.first().copied().unwrap_or(0) as usize + 1) } else { None };
        let place = block.map_or("a note, header or footer".to_string(), |n| format!("paragraph {n}"));
        if sel.is_collapsed() {
            return Some(Selection::new(address, "paragraph", format!("Caret in {place}")));
        }
        let text = session.selected_text();
        let mut preview: String = text.chars().take(40).collect();
        if text.chars().count() > 40 {
            preview.push('…');
        }
        let preview = preview.replace('\n', " ");
        Some(Selection::new(address, "text", format!("\"{preview}\" in {place}")).with_text(text))
    }
}
