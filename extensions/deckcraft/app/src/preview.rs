//! The compact-layout preview: slides the engine renders, shown as plain HTML.
//!
//! `index.html` defines `window.bandPreview` (the DOM, scrolling, pinch zoom, notes and theme). This
//! side owns the document: it hands the preview the slide count, the notes and, one slide per frame,
//! the PNG that `deckcraft_engine::cmd::file::render_png` draws for a slide the person is near.
//! Nothing leaves the frame: the pictures are `blob:` URLs of bytes made in the page.

use deckcraft_engine::model::Presentation;
use js_sys::{Array, Function, Reflect, Uint8Array};
use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;

/// Width in pixels of the pictures. A 390 pt phone shows them at 1x to 3x, and 4x pinch zoom stays readable.
const PICTURE_WIDTH: f64 = 1200.0;

/// What the person asked for in the preview.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    None,
    /// The Edit button.
    Edit,
    /// The back control shown over the editor.
    Back,
}

#[derive(Clone)]
pub struct Preview {
    api: JsValue,
}

impl Preview {
    /// Connect to `window.bandPreview`; `repaint` runs when the preview needs a frame (a tap, a swipe).
    pub fn new(repaint: impl Fn() + 'static) -> Option<Self> {
        let api = Reflect::get(&web_sys::window()?.into(), &"bandPreview".into()).ok().filter(|a| a.is_object())?;
        let wake = Closure::<dyn Fn()>::new(repaint);
        let preview = Self { api };
        preview.call("setWake", &[wake.as_ref().clone()]);
        // The page keeps the callback for as long as it lives.
        wake.forget();
        Some(preview)
    }

    fn call(&self, name: &str, args: &[JsValue]) -> JsValue {
        let Ok(function) = Reflect::get(&self.api, &name.into()).and_then(|f| f.dyn_into::<Function>()) else { return JsValue::UNDEFINED };
        function.apply(&self.api, &args.iter().collect::<Array>()).unwrap_or(JsValue::UNDEFINED)
    }

    pub fn show(&self, visible: bool) {
        self.call("show", &[visible.into()]);
    }

    pub fn show_back(&self, visible: bool) {
        self.call("showBack", &[visible.into()]);
    }

    /// Tell the preview which deck it shows: the slide count, the aspect ratio and the notes.
    pub fn set_deck(&self, pres: &Presentation) {
        let size = pres.slide_size;
        let notes: Array = pres.slides.iter().map(|s| JsValue::from_str(&s.notes_text())).collect();
        self.call("setDeck", &[(pres.slides.len() as f64).into(), (size.width / size.height).into(), notes.into()]);
    }

    /// The slide to draw next, if one near the current slide has no up-to-date picture.
    pub fn needed(&self) -> Option<usize> {
        Array::from(&self.call("needed", &[])).get(0).as_f64().map(|i| i as usize)
    }

    /// Render slide `index` and give the picture to the preview.
    pub fn draw(&self, pres: &Presentation, index: usize) {
        let width = pres.slide_size.width;
        let scale = if width.is_finite() && width > 0.0 { PICTURE_WIDTH / width } else { 1.0 };
        let (png, _, _) = deckcraft_engine::cmd::file::render_png(pres, index, scale, false);
        let Some(url) = blob_url(&png) else { return };
        self.call("setImage", &[(index as f64).into(), url.into()]);
    }

    pub fn take_action(&self) -> Action {
        match self.call("takeAction", &[]).as_string().as_deref() {
            Some("edit") => Action::Edit,
            Some("back") => Action::Back,
            _ => Action::None,
        }
    }
}

fn blob_url(png: &[u8]) -> Option<String> {
    let options = web_sys::BlobPropertyBag::new();
    options.set_type("image/png");
    let parts = Array::of1(&Uint8Array::from(png));
    let blob = web_sys::Blob::new_with_u8_array_sequence_and_options(&parts, &options).ok()?;
    web_sys::Url::create_object_url_with_blob(&blob).ok()
}
