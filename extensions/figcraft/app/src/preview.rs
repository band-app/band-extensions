//! The compact preview: the page's own HTML (`index.html`, `window.figPreview`) showing what the
//! engine exports, so a phone scrolls, zooms and selects text natively instead of driving the egui
//! canvas.
//!
//! The page owns the interface: the frame list, the lazy loading, pinch zoom and the Edit and back
//! buttons. This module owns the engine side. Once per frame [`Preview::tick`]:
//!
//! 1. reads the events the page queued (Edit, back),
//! 2. tells the page which of the three modes is showing (`off` in the regular layout, `preview`, or
//!    `edit`, which is the egui editor with a back button on top),
//! 3. while previewing, sends the list of pages and top-level frames when the document changed, and
//! 4. answers at most one image job per frame by exporting that frame as a PNG with `file.export`,
//!    the command the `export` tool runs.
//!
//! The document is the one the editor holds, so unsaved edits show and nothing is saved or reloaded
//! by switching. The preview reports no selection: the egui editor's selection is hidden while
//! previewing, so [`crate::editor::FigcraftEditor`] returns `None` for it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use base64::Engine as _;
use figcraft_doc::{Document, NodeId, NodeKind};
use figcraft_ui_egui::{FigApp, control};
use js_sys::{Array, Function, Reflect, Uint8Array};
use serde_json::{Value, json};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast as _, JsValue};

/// The largest side of an exported image, in pixels. The browser decodes it, so this bounds memory.
const MAX_SIDE: f64 = 4096.0;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// The regular layout: the editor alone.
    Off,
    Preview,
    /// The compact layout after Edit: the editor, with a button back to the preview.
    Edit,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Preview => "preview",
            Self::Edit => "edit",
        }
    }
}

/// What changes when the document does: the document version, and how many steps the undo and redo
/// stacks hold (an edit that keeps the same allocation still adds a step).
type Fingerprint = (usize, usize, usize);

pub struct Preview {
    app: Rc<RefCell<FigApp>>,
    ctx: egui::Context,
    compact: bool,
    /// The person pressed Edit, and has not gone back.
    editing: bool,
    /// The mode the page was last told.
    shown: Option<Mode>,
    fingerprint: Option<Fingerprint>,
    /// Image key to the layers it exports: a top-level frame, or a page's loose layers.
    entries: HashMap<String, Vec<NodeId>>,
    /// The theme the page was last told, in case it is not up yet.
    theme: Option<(String, String)>,
}

impl Preview {
    pub fn new(app: Rc<RefCell<FigApp>>, ctx: egui::Context) -> Self {
        // The page calls this when it has something for us (a tap on Edit, an image it wants), so
        // a frame runs without waiting for other input.
        let wake_ctx = ctx.clone();
        let wake = Closure::<dyn FnMut()>::new(move || wake_ctx.request_repaint());
        let _ = Reflect::set(&js_sys::global(), &"figPreviewWake".into(), wake.as_ref());
        wake.forget();
        Self { app, ctx, compact: false, editing: false, shown: None, fingerprint: None, entries: HashMap::new(), theme: None }
    }

    pub fn set_compact(&mut self, compact: bool) {
        self.compact = compact;
        self.ctx.request_repaint();
    }

    /// True while the page shows the preview over the editor.
    pub fn is_previewing(&self) -> bool {
        self.mode() == Mode::Preview
    }

    /// A different file is open: show it from the preview.
    pub fn reset(&mut self) {
        self.fingerprint = None;
        self.editing = false;
        self.ctx.request_repaint();
    }

    /// The file bytes were replaced: draw the new document.
    pub fn invalidate(&mut self) {
        self.fingerprint = None;
        self.ctx.request_repaint();
    }

    pub fn set_theme(&mut self, mode: &str, tokens: &Value) {
        self.theme = Some((mode.to_string(), tokens.to_string()));
        self.send_theme();
    }

    fn send_theme(&self) {
        if let Some((mode, tokens)) = &self.theme {
            call("theme", &[JsValue::from_str(mode), JsValue::from_str(tokens)]);
        }
    }

    fn mode(&self) -> Mode {
        match (self.compact, self.editing) {
            (false, _) => Mode::Off,
            (true, false) => Mode::Preview,
            (true, true) => Mode::Edit,
        }
    }

    /// Run once per frame, with no borrow of the app held.
    pub fn tick(&mut self) {
        if api().is_none() {
            return;
        }
        for event in self.events() {
            match event.as_str() {
                "edit" => self.editing = true,
                "back" => {
                    self.editing = false;
                    // Edits made in the editor show, whether or not the fingerprint noticed them.
                    self.fingerprint = None;
                }
                _ => {}
            }
        }
        let mode = self.mode();
        if self.shown != Some(mode) {
            if self.shown.is_none() {
                self.send_theme();
            }
            call("show", &[JsValue::from_str(mode.name())]);
            self.shown = Some(mode);
            // The editor canvas was hidden: draw it again.
            self.ctx.request_repaint();
        }
        if mode != Mode::Preview {
            return;
        }
        self.sync_frames();
        self.serve_one();
    }

    /// The events the page queued since the last frame.
    fn events(&self) -> Vec<String> {
        call("drain", &[]).and_then(|v| v.as_string()).and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()).unwrap_or_default()
    }

    /// Send the page the pages and frames when the document changed.
    fn sync_frames(&mut self) {
        let Ok(app) = self.app.try_borrow() else { return };
        let Ok(ds) = app.session.ds() else {
            if self.fingerprint.take().is_some() {
                self.entries.clear();
                call("frames", &[JsValue::from_str("{\"pages\":[]}")]);
            }
            return;
        };
        let print = (Arc::as_ptr(&ds.doc) as usize, ds.history.undo.len(), ds.history.redo.len());
        if self.fingerprint == Some(print) {
            return;
        }
        self.fingerprint = Some(print);
        let (listing, entries) = list_frames(&ds.doc);
        self.entries = entries;
        call("frames", &[JsValue::from_str(&listing.to_string())]);
    }

    /// Export the next frame the page wants, if any. One per frame keeps the page responsive.
    fn serve_one(&mut self) {
        let Some(job) = call("nextJob", &[]).and_then(|v| v.as_string()).filter(|s| !s.is_empty()) else { return };
        let Ok(job) = serde_json::from_str::<Value>(&job) else { return };
        let (Some(key), Some(px)) = (job["key"].as_str(), job["px"].as_f64()) else { return };
        let png = self.entries.get(key).and_then(|ids| self.export(ids, px));
        match png {
            Some(bytes) => {
                call("image", &[JsValue::from_str(key), JsValue::from_f64(px), Uint8Array::from(bytes.as_slice()).into()]);
            }
            None => {
                call("fail", &[JsValue::from_str(key)]);
            }
        }
        // More may be waiting.
        self.ctx.request_repaint();
    }

    /// `ids` as a PNG about `px` pixels wide.
    fn export(&self, ids: &[NodeId], px: f64) -> Option<Vec<u8>> {
        let mut app = self.app.try_borrow_mut().ok()?;
        let doc = app.session.ds().ok()?.doc.clone();
        let (w, h) = bounds(&doc, ids).map(|(w, h)| (w.max(1.0), h.max(1.0)))?;
        let scale = (px / w).min(MAX_SIDE / w.max(h)).clamp(0.01, 16.0);
        let params =
            json!({"command": "file.export", "params": {"ids": ids.iter().map(|i| i.0).collect::<Vec<_>>(), "format": "png", "scale": scale}});
        let reply = control::handle(&mut app, &self.ctx, "engine.execute", &params)
            .map_err(|why| log::error!("couldn't render a frame for the preview: {why}"))
            .ok()?;
        reply.get("data").and_then(Value::as_str).and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok())
    }
}

/// The size of the layers together, in document units.
fn bounds(doc: &Document, ids: &[NodeId]) -> Option<(f64, f64)> {
    let mut all: Option<(f64, f64, f64, f64)> = None;
    for id in ids {
        let Some(b) = doc.world_bounds(*id) else { continue };
        all = Some(match all {
            Some((x0, y0, x1, y1)) => (x0.min(b.x0), y0.min(b.y0), x1.max(b.x1), y1.max(b.y1)),
            None => (b.x0, b.y0, b.x1, b.y1),
        });
    }
    all.map(|(x0, y0, x1, y1)| (x1 - x0, y1 - y0))
}

/// The page listing for the preview, and the layers each image key exports. A page lists its visible
/// top-level frames and sections. A page with none lists its other visible layers as one image, so a
/// design made of loose shapes still shows.
fn list_frames(doc: &Document) -> (Value, HashMap<String, Vec<NodeId>>) {
    let mut entries = HashMap::new();
    let mut pages = Vec::new();
    for &page_id in &doc.pages {
        if doc.is_divider(page_id) {
            continue;
        }
        let Some(page) = doc.node(page_id) else { continue };
        let visible: Vec<NodeId> = page.children.iter().copied().filter(|c| doc.node(*c).is_some_and(|n| n.visible)).collect();
        let framed: Vec<NodeId> = visible
            .iter()
            .copied()
            .filter(|c| doc.node(*c).is_some_and(|n| n.kind.is_frame_like() || matches!(n.kind, NodeKind::Section { .. })))
            .collect();
        let mut frames = Vec::new();
        let groups: Vec<(String, String, Vec<NodeId>)> = if framed.is_empty() {
            if visible.is_empty() { Vec::new() } else { vec![(format!("p{page_id}"), page.name.clone(), visible)] }
        } else {
            framed.into_iter().map(|id| (format!("n{id}"), doc.node(id).map(|n| n.name.clone()).unwrap_or_default(), vec![id])).collect()
        };
        for (key, name, ids) in groups {
            let Some((w, h)) = bounds(doc, &ids) else { continue };
            frames.push(json!({"key": key, "name": name, "w": w.max(1.0), "h": h.max(1.0)}));
            entries.insert(key, ids);
        }
        pages.push(json!({"name": page.name, "frames": frames}));
    }
    (json!({"pages": pages}), entries)
}

fn api() -> Option<JsValue> {
    Reflect::get(&js_sys::global(), &"figPreview".into()).ok().filter(JsValue::is_object)
}

/// Call `window.figPreview[name](...args)`; `None` when the page has no such function.
fn call(name: &str, args: &[JsValue]) -> Option<JsValue> {
    let api = api()?;
    let function: Function = Reflect::get(&api, &name.into()).ok()?.dyn_into().ok()?;
    let list = Array::new();
    for arg in args {
        list.push(arg);
    }
    function.apply(&api, &list).ok()
}
