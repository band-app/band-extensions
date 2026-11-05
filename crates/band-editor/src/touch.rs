//! One-finger touch for the compact layout.
//!
//! eframe turns a touch into a pointer press, so on a canvas that selects on press a one-finger
//! drag selects a range and the document cannot be scrolled with a finger. While the layout is
//! compact this shim sits in front of eframe's listeners:
//!
//! - A tap (the finger moves less than [`SLOP`] pixels) reaches the app as a touch start and end
//!   at the tap position, so it selects.
//! - A drag never reaches the app as a touch. It becomes `wheel` events on the canvas, which every
//!   egui scroll area and canvas pan already handles.
//! - eframe also reads `pointerdown` and `pointerup` for a touch, so the shim swallows those too and
//!   replays them with the tap.
//! - A gesture with two fingers passes through untouched as touch events, but its pointer events
//!   are swallowed, so two fingers do nothing in compact mode.
//!
//! The events the shim creates are not trusted events, and the shim lets those through to eframe.
//! Dispatching one runs the shim's own listener again, so the listener is an `Fn`, not an `FnMut`.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use wasm_bindgen::JsCast as _;
use wasm_bindgen::JsValue;
use wasm_bindgen::closure::Closure;

/// Pixels a finger may move and still count as a tap.
const SLOP: f64 = 8.0;

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    /// The finger went down and has not moved past the slop.
    Pressed,
    /// The finger is dragging; every move scrolls.
    Panning,
}

struct State {
    enabled: Cell<bool>,
    phase: Cell<Phase>,
    id: Cell<i32>,
    start: Cell<(f64, f64)>,
    last: Cell<(f64, f64)>,
    target: RefCell<Option<web_sys::EventTarget>>,
}

/// Installs the listeners once and returns the switch for compact mode.
pub struct TouchShim(Rc<State>);

impl TouchShim {
    pub fn install() -> Option<Self> {
        let window = web_sys::window()?;
        let state = Rc::new(State {
            enabled: Cell::new(false),
            phase: Cell::new(Phase::Idle),
            id: Cell::new(0),
            start: Cell::new((0.0, 0.0)),
            last: Cell::new((0.0, 0.0)),
            target: RefCell::new(None),
        });
        for kind in ["touchstart", "touchmove", "touchend", "touchcancel"] {
            let st = state.clone();
            let handler = Closure::<dyn Fn(web_sys::TouchEvent)>::new(move |event: web_sys::TouchEvent| st.handle(kind, &event));
            let options = web_sys::AddEventListenerOptions::new();
            options.set_capture(true);
            options.set_passive(false);
            window.add_event_listener_with_callback_and_add_event_listener_options(kind, handler.as_ref().unchecked_ref(), &options).ok()?;
            // The listener lives as long as the page.
            handler.forget();
        }
        for kind in ["pointerdown", "pointerup", "pointercancel", "pointermove"] {
            let st = state.clone();
            let handler = Closure::<dyn Fn(web_sys::PointerEvent)>::new(move |event: web_sys::PointerEvent| {
                // Trusted touch pointers only: the replayed ones, a mouse and a pen go through.
                if event.is_trusted() && st.enabled.get() && event.pointer_type() == "touch" {
                    event.stop_immediate_propagation();
                }
            });
            let options = web_sys::AddEventListenerOptions::new();
            options.set_capture(true);
            window.add_event_listener_with_callback_and_add_event_listener_options(kind, handler.as_ref().unchecked_ref(), &options).ok()?;
            handler.forget();
        }
        Some(Self(state))
    }

    pub fn set_enabled(&self, on: bool) {
        self.0.enabled.set(on);
        if !on {
            self.0.phase.set(Phase::Idle);
        }
    }
}

impl State {
    fn handle(&self, kind: &str, event: &web_sys::TouchEvent) {
        // Our own synthetic events, and everything while the layout is regular.
        if !event.is_trusted() || !self.enabled.get() {
            return;
        }
        if event.touches().length() > 1 || (kind == "touchstart" && event.touches().length() != 1) {
            self.phase.set(Phase::Idle);
            return;
        }
        match kind {
            "touchstart" => {
                let Some(touch) = event.changed_touches().get(0) else { return };
                self.phase.set(Phase::Pressed);
                self.id.set(touch.identifier());
                let at = (f64::from(touch.client_x()), f64::from(touch.client_y()));
                self.start.set(at);
                self.last.set(at);
                *self.target.borrow_mut() = event.target();
                swallow(event);
            }
            "touchmove" => {
                if self.phase.get() == Phase::Idle {
                    return;
                }
                let Some(touch) = self.find(event) else { return };
                swallow(event);
                let at = (f64::from(touch.client_x()), f64::from(touch.client_y()));
                if self.phase.get() == Phase::Pressed {
                    let (sx, sy) = self.start.get();
                    if (at.0 - sx).hypot(at.1 - sy) < SLOP {
                        return;
                    }
                    self.phase.set(Phase::Panning);
                    // The first step covers the slop too, so the document follows the finger from where it went down.
                    self.last.set((sx, sy));
                }
                let (lx, ly) = self.last.get();
                self.last.set(at);
                self.wheel(at, lx - at.0, ly - at.1);
            }
            "touchend" | "touchcancel" => {
                let phase = self.phase.replace(Phase::Idle);
                if phase == Phase::Idle {
                    return;
                }
                let Some(touch) = self.find(event) else { return };
                swallow(event);
                if phase == Phase::Pressed && kind == "touchend" {
                    // A tap: replay it to eframe at the position where it began.
                    let (x, y) = self.start.get();
                    // In the order a browser sends them, so eframe sees one press and one release, not two clicks.
                    self.replay_pointer("pointerdown", x, y);
                    self.replay("touchstart", &touch, x, y);
                    self.replay_pointer("pointerup", x, y);
                    self.replay("touchend", &touch, x, y);
                }
            }
            _ => {}
        }
    }

    fn find(&self, event: &web_sys::TouchEvent) -> Option<web_sys::Touch> {
        let list = event.changed_touches();
        (0..list.length()).filter_map(|i| list.get(i)).find(|t| t.identifier() == self.id.get())
    }

    /// A wheel event on the canvas. A finger that moves up scrolls down, as a wheel does.
    fn wheel(&self, at: (f64, f64), dx: f64, dy: f64) {
        let Some(target) = self.target.borrow().clone() else { return };
        // egui scrolls the area under the pointer, and the touch pointer was swallowed, so put the
        // pointer there first.
        let hover = web_sys::MouseEventInit::new();
        hover.set_bubbles(true);
        hover.set_client_x(at.0 as i32);
        hover.set_client_y(at.1 as i32);
        if let Ok(event) = web_sys::MouseEvent::new_with_mouse_event_init_dict("mousemove", &hover) {
            let _ = target.dispatch_event(&event);
        }
        let init = web_sys::WheelEventInit::new();
        init.set_bubbles(true);
        init.set_cancelable(true);
        init.set_client_x(at.0 as i32);
        init.set_client_y(at.1 as i32);
        init.set_delta_x(dx);
        init.set_delta_y(dy);
        init.set_delta_mode(web_sys::WheelEvent::DOM_DELTA_PIXEL);
        if let Ok(event) = web_sys::WheelEvent::new_with_event_init_dict("wheel", &init) {
            let _ = target.dispatch_event(&event);
        }
    }

    /// The pointer event a touch makes, which eframe reads for the press and release.
    fn replay_pointer(&self, kind: &str, x: f64, y: f64) {
        let Some(target) = self.target.borrow().clone() else { return };
        let init = web_sys::PointerEventInit::new();
        init.set_bubbles(true);
        init.set_cancelable(true);
        init.set_pointer_type("touch");
        init.set_is_primary(true);
        init.set_pointer_id(self.id.get() + 1);
        init.set_client_x(x as i32);
        init.set_client_y(y as i32);
        init.set_button(0);
        init.set_buttons(if kind == "pointerdown" { 1 } else { 0 });
        if let Ok(event) = web_sys::PointerEvent::new_with_event_init_dict(kind, &init) {
            let _ = target.dispatch_event(&event);
        }
    }

    fn replay(&self, kind: &str, like: &web_sys::Touch, x: f64, y: f64) {
        let Some(target) = self.target.borrow().clone() else { return };
        let init = web_sys::TouchInit::new(like.identifier(), &target);
        init.set_client_x(x as i32);
        init.set_client_y(y as i32);
        init.set_page_x(x as i32);
        init.set_page_y(y as i32);
        init.set_screen_x(x as i32);
        init.set_screen_y(y as i32);
        let Ok(touch) = web_sys::Touch::new(&init) else { return };
        let list = js_sys::Array::of1(&JsValue::from(touch));
        let event_init = web_sys::TouchEventInit::new();
        event_init.set_bubbles(true);
        event_init.set_cancelable(true);
        event_init.set_changed_touches(&list.clone().into());
        // A touch that has ended is no longer in `touches`.
        event_init.set_touches(&if kind == "touchend" { js_sys::Array::new() } else { list }.into());
        if let Ok(event) = web_sys::TouchEvent::new_with_event_init_dict(kind, &event_init) {
            let _ = target.dispatch_event(&event);
        }
    }
}

/// Keep the event from eframe and from the browser's own scrolling.
fn swallow(event: &web_sys::TouchEvent) {
    event.stop_immediate_propagation();
    if event.cancelable() {
        event.prevent_default();
    }
}
