//! The compact layout's reading view: the document as reflowed HTML in the page itself.
//!
//! `index.html` holds the markup (`#wc_preview`, `#wc_doc`, the Edit and back buttons) and the
//! styles. This module fills `#wc_doc` with the engine's own HTML export
//! (`wordcraft_formats::html::export_fragment`) and tells the page which view to show through two
//! attributes on `<body>`: `data-layout` (`compact` or `regular`) and `data-view` (`preview` or
//! `edit`). The browser scrolls, zooms and selects the text, so nothing here handles touch.

use std::cell::Cell;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::rc::Rc;

use wasm_bindgen::JsCast as _;
use wasm_bindgen::closure::Closure;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum View {
    Preview,
    Edit,
}

/// A press on one of the page's buttons.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Click {
    Edit,
    Back,
}

pub struct Preview {
    clicks: Rc<Cell<Option<Click>>>,
    body: web_sys::HtmlElement,
    doc: web_sys::Element,
    titles: Vec<web_sys::Element>,
    /// Hash of the HTML and title on screen; `None` before the first render.
    shown: Option<u64>,
    /// The attributes last written to `<body>`.
    mode: Option<(bool, View)>,
}

impl Preview {
    /// `None` when the page lacks the preview markup. `repaint` runs on a button press so the
    /// frame loop wakes and handles it.
    pub fn install(repaint: impl Fn() + Clone + 'static) -> Option<Self> {
        let document = web_sys::window()?.document()?;
        let clicks = Rc::new(Cell::new(None));
        for (id, click) in [("wc_edit", Click::Edit), ("wc_back", Click::Back)] {
            let button = document.get_element_by_id(id)?;
            let (clicks, repaint) = (clicks.clone(), repaint.clone());
            let handler = Closure::<dyn FnMut()>::new(move || {
                clicks.set(Some(click));
                repaint();
            });
            button.add_event_listener_with_callback("click", handler.as_ref().unchecked_ref()).ok()?;
            // The listener lives as long as the page.
            handler.forget();
        }
        Some(Self {
            clicks,
            body: document.body()?,
            doc: document.get_element_by_id("wc_doc")?,
            titles: ["wc_title", "wc_title_edit"].iter().filter_map(|id| document.get_element_by_id(id)).collect(),
            shown: None,
            mode: None,
        })
    }

    pub fn take_click(&self) -> Option<Click> {
        self.clicks.take()
    }

    /// Show the page for this layout and view. Writes only when something changed.
    pub fn set_mode(&mut self, compact: bool, view: View) {
        if self.mode == Some((compact, view)) {
            return;
        }
        self.mode = Some((compact, view));
        let _ = self.body.set_attribute("data-layout", if compact { "compact" } else { "regular" });
        let _ = self.body.set_attribute("data-view", if view == View::Preview { "preview" } else { "edit" });
    }

    /// Put `html` in the reading view. Nothing changes (and the scroll position stays) when it
    /// equals what is shown already.
    pub fn show(&mut self, title: &str, html: &str) {
        let html = lazy_images(html);
        let mut hasher = DefaultHasher::new();
        (title, &html).hash(&mut hasher);
        let hash = hasher.finish();
        if self.shown == Some(hash) {
            return;
        }
        self.shown = Some(hash);
        for el in &self.titles {
            el.set_text_content(Some(title));
        }
        self.doc.set_inner_html(&html);
    }
}

/// Drop the export's `<meta>` and let the browser load and decode pictures when they come near.
fn lazy_images(html: &str) -> String {
    html.trim_start_matches("<meta charset=\"utf-8\">").replace("<img ", "<img loading=\"lazy\" decoding=\"async\" ")
}
