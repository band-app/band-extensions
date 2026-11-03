// Copied from storytold/wordcraft apps/wordcraft-web/src/web.rs at rev ae5c65b9dd11 (MIT OR Apache-2.0,
// see LICENSE-MIT and LICENSE-APACHE at the repo root).
// Changes, marked 'wrapper:': the app is wrapped in Rc<RefCell<..>> and driven by the Band editor port
// (band_editor::Bridge with editor::WordcraftEditor) instead of the `?host=parent` bridge. Dropped: that
// bridge, preferences in localStorage, fonts kept in IndexedDB, the unsaved-changes guard, the save picker
// and anchor download, and printing. A sandboxed frame has no storage, no downloads and no print dialog.

//! The browser shell: web `Services`, drag-and-drop and the eframe web runner.

use std::cell::RefCell;
use std::rc::Rc;

use wasm_bindgen::JsCast as _;
use wordcraft_engine::Session;
use wordcraft_ui_egui::{Inbox, Services, WordApp};

const DOC_EXTS: &[&str] =
    &["docx", "docm", "dotx", "dotm", "doc", "dot", "odt", "rtf", "txt", "md", "html", "htm", "mht", "mhtml", "tex", "json", "xml"];
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "wmf", "emf"];
const RECIPIENT_EXTS: &[&str] = wordcraft_engine::cmd::mailings::RECIPIENT_EXTENSIONS;
const CANVAS_ID: &str = "wordcraft_canvas";
const LOADING_ID: &str = "wordcraft_loading";

pub fn start() {
    eframe::WebLogger::init(log::LevelFilter::Info).ok();
    wasm_bindgen_futures::spawn_local(async {
        let Some(document) = web_sys::window().and_then(|w| w.document()) else {
            log::error!("no document");
            return;
        };
        let Some(canvas) = document.get_element_by_id(CANVAS_ID).and_then(|e| e.dyn_into::<web_sys::HtmlCanvasElement>().ok()) else {
            log::error!("missing <canvas id=\"{CANVAS_ID}\">");
            return;
        };
        // wrapper: a framed page is a Band editor tab, which talks over a MessagePort.
        let band = band_editor::Bridge::listen();
        let app_band = band.clone();
        let mut options = eframe::WebOptions::default();
        if query().contains("webgl")
            && let eframe::egui_wgpu::WgpuSetup::CreateNew(create) = &mut options.wgpu_options.wgpu_setup
        {
            create.instance_descriptor.backends = eframe::wgpu::Backends::GL;
        }
        let result = eframe::WebRunner::new()
            .start(
                canvas,
                options,
                Box::new(move |cc| {
                    if let Some(rs) = &cc.wgpu_render_state {
                        log::info!("wordcraft-band: wgpu backend {:?}", rs.adapter.get_info().backend);
                    }
                    let inbox: Inbox = Inbox::default();
                    let pasted: Inbox = Inbox::default();
                    if let Err(e) = listen_for_pasted_pictures(pasted.clone(), cc.egui_ctx.clone()) {
                        log::error!("pasting pictures is unavailable: {e}");
                    }
                    // The browser's locale picks the new document's paper, the units and the
                    // decimal separator (#838).
                    let region = wordcraft_ui_egui::i18n::system_region();
                    // wrapper: framed by Band, the file to edit arrives from Band; no sample meanwhile.
                    let sample = app_band.is_none() && query().contains("sample");
                    let doc = if sample { wordcraft_engine::sample::sample_document() } else { wordcraft_engine::blank_document(&region) };
                    let mut session = Session::new(doc);
                    session.system_region = region;
                    let messages = Rc::new(RefCell::new(Vec::new()));
                    let mut services = services(inbox.clone(), cc.egui_ctx.clone(), messages.clone());
                    // wrapper: File > Save inside WordCraft becomes a save request to Band.
                    let want_save = app_band.as_ref().map(|_| crate::editor::WordcraftEditor::route_save(&mut services));
                    // wrapper: the app answers the MCP bridge's screenshot requests over this channel.
                    let (control_tx, control_rx) = std::sync::mpsc::channel();
                    let mut app = WordApp::new(session, services);
                    if app_band.is_some() {
                        app = app.with_control(control_rx);
                    }
                    // Pasted pictures wait apart from dropped files: the app inserts one only when the page is the edit target (#1349).
                    app.services.pasted = Some(pasted);
                    app.autosave = false;
                    // wrapper: the editor shares the app with the frame loop.
                    let app = Rc::new(RefCell::new(app));
                    let band = app_band.zip(want_save).map(|(bridge, want_save)| {
                        let ctx = cc.egui_ctx.clone();
                        bridge.set_repaint(move || ctx.request_repaint());
                        (bridge, crate::editor::WordcraftEditor::new(app.clone(), inbox.clone(), cc.egui_ctx.clone(), want_save, control_tx))
                    });
                    Ok(Box::new(WebShell { app, inbox, messages, band }))
                }),
            )
            .await;
        if let Some(el) = document.get_element_by_id(LOADING_ID) {
            match result {
                Ok(()) => el.remove(),
                Err(e) => el.set_inner_html(&format!("<p>WordCraft failed to start: {e:?}</p><p>A browser with WebGPU or WebGL2 is required.</p>")),
            }
        }
    });
}

fn query() -> String {
    web_sys::window().and_then(|w| w.location().search().ok()).unwrap_or_default()
}

/// Wraps the app to read dropped files asynchronously (browsers can't read them synchronously)
/// and feed them through the inbox.
struct WebShell {
    app: Rc<RefCell<WordApp>>,
    inbox: Inbox,
    messages: Rc<RefCell<Vec<String>>>,
    /// wrapper: Band's editor protocol (framed pages only).
    band: Option<(band_editor::Bridge, crate::editor::WordcraftEditor)>,
}

impl eframe::App for WebShell {
    /// Runs one browser frame: forwards queued messages to the status bar, then advances the app.
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        let msgs = std::mem::take(&mut *self.messages.borrow_mut());
        let mut app = self.app.borrow_mut();
        for msg in msgs {
            app.status(msg);
        }
        app.logic(ctx);
    }

    /// Forwards this frame's raw browser input to the app before widgets run.
    fn raw_input_hook(&mut self, ctx: &egui::Context, raw: &mut egui::RawInput) {
        self.app.borrow_mut().raw_input_hook(ctx, raw);
    }

    /// Draws the app. On the first pass of a visible frame it takes the browser's dropped files and
    /// spawns asynchronous byte reads into the inbox; later passes only draw.
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        // Browser drops are input: take them only in the first real UI pass, never in a hidden
        // `run_logic` tick that still sees the previous shown frame's RawInput.
        if ui.ctx().current_pass_index() == 0 {
            let ctx = ui.ctx().clone();
            let dropped = ctx.input_mut(|i| std::mem::take(&mut i.raw.dropped_files));
            for f in dropped {
                let inbox = self.inbox.clone();
                let ctx = ctx.clone();
                wasm_bindgen_futures::spawn_local(async move {
                    let name = f.path().file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "dropped".into());
                    match f.bytes_async().await {
                        Ok(bytes) => {
                            inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes));
                            ctx.request_repaint();
                        }
                        Err(e) => log::error!("couldn't read dropped file {name}: {e}"),
                    }
                });
            }
        }
        self.app.borrow_mut().ui(ui);
        // wrapper: the editor borrows the app itself, so it runs once the borrow above is dropped.
        if let Some((bridge, editor)) = &mut self.band {
            bridge.sync(editor);
        }
    }
}

/// Largest picture pasted from the browser's clipboard (as `insert.picture` allows).
const MAX_PASTED_BYTES: f64 = (200u32 << 20) as f64;
/// Most pictures one paste inserts.
const MAX_PASTED_PICTURES: u32 = 20;

/// Pasting a picture (#45): eframe's paste handler only reads text, so a clipboard holding just
/// pictures (a screenshot, a browser's Copy Image) is read here and the pictures arrive through
/// the app's `pasted` queue, which inserts them only when the page is the edit target (#1349). A clipboard with text is left to eframe.
fn listen_for_pasted_pictures(inbox: Inbox, ctx: egui::Context) -> Result<(), String> {
    let document = web_sys::window().and_then(|w| w.document()).ok_or("no document")?;
    let on_paste = wasm_bindgen::closure::Closure::<dyn FnMut(web_sys::ClipboardEvent)>::new(move |e: web_sys::ClipboardEvent| {
        // The target is always eframe's hidden text input while the page has focus; the app decides (#1349).
        let Some(data) = e.clipboard_data() else { return };
        if !data.get_data("text").unwrap_or_default().is_empty() {
            return;
        }
        let Some(files) = data.files() else { return };
        for i in 0..files.length().min(MAX_PASTED_PICTURES) {
            let Some(file) = files.get(i) else { continue };
            if !file.type_().starts_with("image/") {
                continue;
            }
            if file.size() > MAX_PASTED_BYTES {
                log::warn!("pasted picture is larger than 200 MB; not inserted");
                continue;
            }
            let inbox = inbox.clone();
            let ctx = ctx.clone();
            wasm_bindgen_futures::spawn_local(async move {
                match wasm_bindgen_futures::JsFuture::from(file.array_buffer()).await {
                    Ok(buf) => {
                        let bytes = js_sys::Uint8Array::new(&buf).to_vec();
                        // The engine reads the format from the bytes; the name is ignored.
                        inbox.lock().unwrap_or_else(|e| e.into_inner()).push(("pasted.png".into(), bytes));
                        ctx.request_repaint();
                    }
                    Err(e) => log::error!("couldn't read the pasted picture: {e:?}"),
                }
            });
        }
    });
    document.add_event_listener_with_callback("paste", on_paste.as_ref().unchecked_ref()).map_err(|e| format!("{e:?}"))?;
    // The listener lives as long as the page.
    on_paste.forget();
    Ok(())
}

/// wrapper: the services of a page in a Band tab. There is no picker to save with, so saves and
/// exports reach `Services::download` and `Services::host_save`, which `editor` sets when Band
/// frames the page. Printing and font storage need browser features the sandbox lacks.
fn services(inbox: Inbox, ctx: egui::Context, messages: Rc<RefCell<Vec<String>>>) -> Services {
    let open_inbox = inbox.clone();
    let font_ctx = ctx.clone();
    let font_messages = messages.clone();
    Services {
        open_async: Some(Box::new(move |purpose: &str| {
            let inbox = open_inbox.clone();
            let ctx = ctx.clone();
            let dialog = if purpose == "picture" {
                rfd::AsyncFileDialog::new().add_filter("Pictures", IMAGE_EXTS)
            } else if purpose == "font" {
                rfd::AsyncFileDialog::new().add_filter("Fonts", wordcraft_fonts::FONT_FILE_EXTS)
            } else if purpose == "recipients" {
                rfd::AsyncFileDialog::new().add_filter("Recipient lists", RECIPIENT_EXTS)
            } else {
                rfd::AsyncFileDialog::new().add_filter("Documents", DOC_EXTS)
            };
            let many = purpose == "font";
            wasm_bindgen_futures::spawn_local(async move {
                // Add Font takes every selected file (#1789); the others one.
                let files = if many { dialog.pick_files().await.unwrap_or_default() } else { dialog.pick_file().await.into_iter().collect() };
                for file in files.into_iter().take(MAX_PICKED_FILES) {
                    let mut bytes = file.read().await;
                    let mut pending = inbox.lock().unwrap_or_else(|e| e.into_inner());
                    // Fonts waiting for the app to drain them stay under a byte cap. A file
                    // over it is queued empty, so Add Font reports that file on its own.
                    let held: usize = pending.iter().map(|(_, b)| b.len()).fold(0, usize::saturating_add);
                    if many && held.saturating_add(bytes.len()) > MAX_PENDING_PICKED_BYTES {
                        bytes = Vec::new();
                    }
                    pending.push((file.file_name(), bytes));
                    drop(pending);
                    ctx.request_repaint();
                }
            });
        })),
        inbox: Some(inbox),
        animations_enabled: Some(animations_enabled()),
        load_system_fonts: Some(Box::new(move || {
            load_system_fonts(font_ctx.clone(), font_messages.clone());
        })),
        ..Default::default()
    }
}

/// Most files one multi-select pick (Add Font) reads.
const MAX_PICKED_FILES: usize = 2000;
/// Most bytes of picked fonts held in the inbox before the app drains them.
const MAX_PENDING_PICKED_BYTES: usize = 256 << 20;
/// Most local fonts one Load System Installed Fonts installs (a designer's machine has thousands).
const MAX_SYSTEM_FONTS: usize = 500;
/// Most font bytes one Load System Installed Fonts reads into memory (wasm memory is small).
const MAX_SYSTEM_FONT_BYTES: usize = 256 << 20;
/// Most local fonts looked at, installed or not (already available, unreadable, too big).
const MAX_SYSTEM_FONTS_TRIED: u32 = 4000;

/// Query the browser's Local Font Access API (`window.queryLocalFonts()`) and install the faces
/// into the global font database, up to [`MAX_SYSTEM_FONTS`] faces and [`MAX_SYSTEM_FONT_BYTES`].
fn load_system_fonts(ctx: egui::Context, messages: Rc<RefCell<Vec<String>>>) {
    wasm_bindgen_futures::spawn_local(async move {
        let Some(window) = web_sys::window() else {
            return;
        };
        let query_fn = match js_sys::Reflect::get(&window, &wasm_bindgen::JsValue::from_str("queryLocalFonts")) {
            Ok(val) if val.is_function() => js_sys::Function::from(val),
            _ => {
                messages.borrow_mut().push(wordcraft_ui_egui::i18n::t("Local font access is not supported by your browser.").to_string());
                ctx.request_repaint();
                return;
            }
        };
        let fonts_promise = match query_fn.call0(&window) {
            Ok(p) => js_sys::Promise::from(p),
            Err(e) => {
                log::warn!("queryLocalFonts call failed: {e:?}");
                messages.borrow_mut().push(wordcraft_ui_egui::i18n::t("Local font access was denied.").to_string());
                ctx.request_repaint();
                return;
            }
        };
        let fonts_val = match wasm_bindgen_futures::JsFuture::from(fonts_promise).await {
            Ok(val) => val,
            Err(e) => {
                log::warn!("queryLocalFonts promise rejected: {e:?}");
                messages.borrow_mut().push(wordcraft_ui_egui::i18n::t("Local font access was denied.").to_string());
                ctx.request_repaint();
                return;
            }
        };
        let font_list = js_sys::Array::from(&fonts_val);
        let len = font_list.length();
        let mut loaded = 0usize;
        let mut total_bytes = 0usize;
        for i in 0..len.min(MAX_SYSTEM_FONTS_TRIED) {
            if loaded >= MAX_SYSTEM_FONTS || total_bytes >= MAX_SYSTEM_FONT_BYTES {
                log::warn!("local fonts: stopped after {loaded} fonts ({total_bytes} bytes)");
                break;
            }
            let font_data = font_list.get(i);
            let Ok(blob_fn) = js_sys::Reflect::get(&font_data, &wasm_bindgen::JsValue::from_str("blob")) else {
                continue;
            };
            if !blob_fn.is_function() {
                continue;
            }
            let Ok(blob_val) = js_sys::Function::from(blob_fn).call0(&font_data) else {
                continue;
            };
            let Ok(blob_js) = wasm_bindgen_futures::JsFuture::from(js_sys::Promise::from(blob_val)).await else {
                continue;
            };
            let Ok(blob) = blob_js.dyn_into::<web_sys::Blob>() else {
                continue;
            };
            // Skip a face too big on its own or for what is left of the budget, before reading it.
            let size = blob.size().clamp(0.0, usize::MAX as f64) as usize;
            if size > wordcraft_fonts::MAX_FONT_FILE_BYTES || total_bytes.saturating_add(size) > MAX_SYSTEM_FONT_BYTES {
                continue;
            }
            let Ok(array_buffer) = wasm_bindgen_futures::JsFuture::from(blob.array_buffer()).await else {
                continue;
            };
            let bytes = js_sys::Uint8Array::new(&array_buffer).to_vec();
            if bytes.len() > wordcraft_fonts::MAX_FONT_FILE_BYTES {
                continue;
            }
            total_bytes = total_bytes.saturating_add(bytes.len());
            let ps_name = js_sys::Reflect::get(&font_data, &wasm_bindgen::JsValue::from_str("postscriptName"))
                .ok()
                .and_then(|v| v.as_string())
                .unwrap_or_else(|| format!("local-font-{i}"));
            let name = format!("{ps_name}.ttf");
            match wordcraft_fonts::FontDb::global().install_font(&name, &bytes) {
                Ok(_) => loaded += 1,
                Err(wordcraft_fonts::UserFontError::AlreadyAvailable(_)) => {}
                Err(e) => log::warn!("local font {name} skipped: {e}"),
            }
        }
        if loaded > 0 {
            let msg = wordcraft_ui_egui::i18n::fmt(wordcraft_ui_egui::i18n::t("Loaded {count} system fonts."), &[("count", &loaded.to_string())]);
            messages.borrow_mut().push(msg);
        } else {
            messages.borrow_mut().push(wordcraft_ui_egui::i18n::t("All system fonts are already available.").to_string());
        }
        ctx.request_repaint();
    });
}

/// Whether the system has animation effects on, as the browser passes it on: off while the
/// `prefers-reduced-motion: reduce` media query matches. `None` when the browser can't say. The
/// query is made once and asked every frame; it follows the system's setting by itself.
fn animations_enabled() -> Box<dyn Fn() -> Option<bool>> {
    let reduce = web_sys::window().and_then(|w| w.match_media("(prefers-reduced-motion: reduce)").ok().flatten());
    Box::new(move || reduce.as_ref().map(|query| !query.matches()))
}
