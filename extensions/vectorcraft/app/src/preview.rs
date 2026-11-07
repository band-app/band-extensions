//! The compact preview: the drawing as an SVG that VectorCraft's own exporter writes, shown as
//! plain HTML over the egui canvas.
//!
//! In the compact layout the page opens on this preview instead of the editor. The browser scrolls
//! it, so scrolling, momentum and text selection of the surrounding page are native. The page
//! script handles a two-finger pinch, because the page's viewport forbids the browser's own zoom
//! (the editor needs the gestures). The canvas keeps running underneath, so Edit only hides the
//! overlay and the document, its unsaved edits and its dirty state are the editor's, untouched.
//! Back builds the SVG again from the document the editor holds.
//!
//! The overlay is marked `data-band-native`, which the touch shim in `band-editor` leaves alone.
//! The SVG goes into an `<img>` as a `data:` URI, so a script inside it cannot run and nothing is
//! fetched.

use std::cell::Cell;
use std::rc::Rc;

use band_editor::Theme;
use vectorcraft_svg::{ExportOptions, ObjectIds};
use wasm_bindgen::JsCast as _;
use wasm_bindgen::closure::Closure;
use web_sys::{Element, HtmlElement};

use crate::editor::SharedApp;

const MAX_SCALE: f64 = 8.0;

const ROOT_CSS: &str = "position:fixed;inset:0;z-index:10;display:none;flex-direction:column;background:var(--bg);color:var(--fg);\
    font:15px system-ui,sans-serif;-webkit-user-select:text;user-select:text;";
const BAR_CSS: &str = "flex:none;display:flex;align-items:center;gap:12px;padding:calc(8px + env(safe-area-inset-top,0px)) 12px 8px;\
    border-bottom:1px solid var(--bd);background:var(--bg);";
const TITLE_CSS: &str = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;";
const BUTTON_CSS: &str = "flex:none;border:0;border-radius:8px;padding:8px 16px;font:inherit;font-weight:600;background:var(--ac);color:var(--acfg);";
const SCROLLER_CSS: &str = "flex:1;min-height:0;overflow:auto;touch-action:pan-x pan-y;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;\
    padding:12px 12px calc(12px + env(safe-area-inset-bottom,0px));background:var(--well);";
const PAGE_CSS: &str = "width:100%;margin:0 auto;background:#fff;box-shadow:0 1px 6px rgba(0,0,0,.25);";
const STATUS_CSS: &str = "padding:24px 12px;text-align:center;opacity:.7;";
const BACK_CSS: &str = "position:fixed;z-index:10;display:none;top:calc(8px + env(safe-area-inset-top,0px));left:calc(8px + env(safe-area-inset-left,0px));\
    border:1px solid var(--bd);border-radius:999px;padding:6px 14px;font:600 14px system-ui,sans-serif;background:var(--bg);color:var(--fg);\
    box-shadow:0 1px 6px rgba(0,0,0,.3);";

#[derive(Clone)]
pub struct Preview(Rc<Inner>);

struct Inner {
    app: SharedApp,
    uid: Rc<Cell<Option<u64>>>,
    ctx: egui::Context,
    root: HtmlElement,
    title: HtmlElement,
    scroller: HtmlElement,
    page: HtmlElement,
    img: Element,
    status: HtmlElement,
    back: HtmlElement,
    compact: Cell<bool>,
    showing: Cell<bool>,
    scale: Cell<f64>,
    /// Distance between two fingers and the zoom when they went down.
    pinch: Cell<Option<(f64, f64)>>,
}

fn element(document: &web_sys::Document, tag: &str, css: &str) -> Option<HtmlElement> {
    let el = document.create_element(tag).ok()?.dyn_into::<HtmlElement>().ok()?;
    el.set_attribute("style", css).ok()?;
    Some(el)
}

fn on_click(el: &HtmlElement, f: impl Fn() + 'static) {
    let handler = Closure::<dyn Fn()>::new(f);
    let _ = el.add_event_listener_with_callback("click", handler.as_ref().unchecked_ref());
    // The listener lives as long as the page.
    handler.forget();
}

fn on_touch(el: &HtmlElement, kind: &str, f: impl Fn(&web_sys::TouchEvent) + 'static) {
    let handler = Closure::<dyn Fn(web_sys::TouchEvent)>::new(move |event: web_sys::TouchEvent| f(&event));
    let options = web_sys::AddEventListenerOptions::new();
    options.set_passive(false);
    let _ = el.add_event_listener_with_callback_and_add_event_listener_options(kind, handler.as_ref().unchecked_ref(), &options);
    handler.forget();
}

impl Preview {
    /// Build the overlay and add it to the page, hidden. `None` when the page has no body.
    pub fn new(app: SharedApp, uid: Rc<Cell<Option<u64>>>, ctx: egui::Context) -> Option<Self> {
        let document = web_sys::window()?.document()?;
        let body = document.body()?;
        let root = element(&document, "div", ROOT_CSS)?;
        root.set_attribute("data-band-native", "").ok()?;
        let bar = element(&document, "div", BAR_CSS)?;
        let title = element(&document, "div", TITLE_CSS)?;
        let edit = element(&document, "button", BUTTON_CSS)?;
        edit.set_text_content(Some("Edit"));
        let scroller = element(&document, "div", SCROLLER_CSS)?;
        let page = element(&document, "div", PAGE_CSS)?;
        let img = element(&document, "img", "display:block;width:100%;height:auto;")?;
        img.set_attribute("alt", "").ok()?;
        img.set_attribute("draggable", "false").ok()?;
        let status = element(&document, "div", STATUS_CSS)?;
        let back = element(&document, "button", BACK_CSS)?;
        back.set_attribute("data-band-native", "").ok()?;
        back.set_text_content(Some("Preview"));
        bar.append_child(&title).ok()?;
        bar.append_child(&edit).ok()?;
        page.append_child(&img).ok()?;
        scroller.append_child(&status).ok()?;
        scroller.append_child(&page).ok()?;
        root.append_child(&bar).ok()?;
        root.append_child(&scroller).ok()?;
        body.append_child(&root).ok()?;
        body.append_child(&back).ok()?;
        let this = Self(Rc::new(Inner {
            app,
            uid,
            ctx,
            root,
            title,
            scroller: scroller.clone(),
            page,
            img: img.into(),
            status,
            back: back.clone(),
            compact: Cell::new(false),
            showing: Cell::new(false),
            scale: Cell::new(1.0),
            pinch: Cell::new(None),
        }));
        this.set_theme(&Theme::default());
        let p = this.clone();
        on_click(&edit, move || p.edit());
        let p = this.clone();
        on_click(&back, move || p.show());
        this.pinch_handlers(&scroller);
        Some(this)
    }

    /// True while the preview covers the editor.
    pub fn showing(&self) -> bool {
        self.0.showing.get()
    }

    pub fn set_title(&self, name: &str) {
        self.0.title.set_text_content(Some(name));
    }

    /// The compact layout opens on the preview. The regular one has no preview.
    pub fn set_compact(&self, compact: bool) {
        let was = self.0.compact.replace(compact);
        if compact {
            // A repeated compact layout must not pull someone out of the editor.
            if !was {
                self.show();
            }
        } else {
            self.0.showing.set(false);
            self.apply();
        }
        self.0.ctx.request_repaint();
    }

    /// Show the preview of the document as it is now.
    fn show(&self) {
        self.0.showing.set(true);
        self.apply();
        self.refresh();
    }

    /// Hide the preview and let the editor take the touches.
    fn edit(&self) {
        self.0.showing.set(false);
        self.apply();
        self.0.ctx.request_repaint();
    }

    fn apply(&self) {
        let i = &self.0;
        let _ = i.root.style().set_property("display", if i.showing.get() { "flex" } else { "none" });
        let _ = i.back.style().set_property("display", if i.compact.get() && !i.showing.get() { "block" } else { "none" });
    }

    /// Follow Band's theme. The drawing keeps its own colors; only the bar, the well around the
    /// page and the buttons change.
    pub fn set_theme(&self, theme: &Theme) {
        let dark = theme.mode != "light";
        let pick = |name: &str, light: &str, dark_value: &str| {
            theme.token(name).map(str::to_string).unwrap_or_else(|| (if dark { dark_value } else { light }).to_string())
        };
        let bg = pick("background", "#ffffff", "#262626");
        let fg = pick("foreground", "#1a1a1a", "#e6e6e6");
        let bd = pick("border", "#d4d4d4", "#454545");
        let well = pick("muted", "#f0f0f0", "#1c1c1c");
        let ac = pick("primary", "#1a1a1a", "#e6e6e6");
        let acfg = pick("primary-foreground", "#ffffff", "#1a1a1a");
        for el in [&self.0.root, &self.0.back] {
            let style = el.style();
            for (k, v) in [("--bg", &bg), ("--fg", &fg), ("--bd", &bd), ("--well", &well), ("--ac", &ac), ("--acfg", &acfg)] {
                let _ = style.set_property(k, v);
            }
            let _ = style.set_property("color-scheme", if dark { "dark" } else { "light" });
        }
    }

    /// Build the SVG from the document the editor holds and show it.
    pub fn refresh(&self) {
        let i = &self.0;
        if !i.showing.get() {
            return;
        }
        let Some(uid) = i.uid.get() else {
            i.status.set_text_content(Some("Opening\u{2026}"));
            return;
        };
        let svg = {
            let Ok(guard) = i.app.try_borrow() else { return };
            let Some(app) = guard.as_ref() else { return };
            let Some(doc) = app.session.documents().iter().find(|d| d.uid == uid) else { return };
            // Text becomes paths, so the browser needs none of the drawing's fonts. Hidden layers
            // stay out, as in the file. The artboard sets the viewBox and `responsive` leaves out
            // the fixed size, so the image fits the width.
            let options = ExportOptions { responsive: true, outline_text: true, object_ids: ObjectIds::Unique, ..ExportOptions::default() };
            vectorcraft_svg::export(&doc.doc, &options)
        };
        let uri = format!("data:image/svg+xml;charset=utf-8,{}", String::from(js_sys::encode_uri_component(&svg)));
        let _ = i.img.set_attribute("src", &uri);
        i.status.set_text_content(None);
        let _ = i.status.style().set_property("display", "none");
    }

    /// Two fingers zoom the page about their midpoint; one finger is the browser's own scroll.
    fn pinch_handlers(&self, scroller: &HtmlElement) {
        let p = self.clone();
        on_touch(scroller, "touchstart", move |e| {
            let touches = e.touches();
            let start = (touches.length() == 2).then(|| p.finger_distance(e)).flatten().map(|d| (d, p.0.scale.get()));
            p.0.pinch.set(start);
        });
        let p = self.clone();
        on_touch(scroller, "touchmove", move |e| {
            let (Some((d0, s0)), 2) = (p.0.pinch.get(), e.touches().length()) else { return };
            let Some(d) = p.finger_distance(e) else { return };
            if e.cancelable() {
                e.prevent_default();
            }
            p.zoom_to((s0 * d / d0).clamp(1.0, MAX_SCALE), e);
        });
        let p = self.clone();
        on_touch(scroller, "touchend", move |e| {
            if e.touches().length() < 2 {
                p.0.pinch.set(None);
            }
        });
    }

    fn finger_distance(&self, e: &web_sys::TouchEvent) -> Option<f64> {
        let touches = e.touches();
        let (a, b) = (touches.get(0)?, touches.get(1)?);
        let d = f64::from(a.client_x() - b.client_x()).hypot(f64::from(a.client_y() - b.client_y()));
        (d > 1.0).then_some(d)
    }

    fn zoom_to(&self, scale: f64, e: &web_sys::TouchEvent) {
        let i = &self.0;
        let touches = e.touches();
        let (Some(a), Some(b)) = (touches.get(0), touches.get(1)) else { return };
        let rect = i.scroller.get_bounding_client_rect();
        let cx = f64::from(a.client_x() + b.client_x()) / 2.0 - rect.left();
        let cy = f64::from(a.client_y() + b.client_y()) / 2.0 - rect.top();
        let fx = (f64::from(i.scroller.scroll_left()) + cx) / f64::from(i.scroller.scroll_width().max(1));
        let fy = (f64::from(i.scroller.scroll_top()) + cy) / f64::from(i.scroller.scroll_height().max(1));
        i.scale.set(scale);
        let _ = i.page.style().set_property("width", &format!("{}%", scale * 100.0));
        // Keep the point between the fingers where it was.
        i.scroller.set_scroll_left((fx * f64::from(i.scroller.scroll_width()) - cx) as i32);
        i.scroller.set_scroll_top((fy * f64::from(i.scroller.scroll_height()) - cy) as i32);
    }
}
