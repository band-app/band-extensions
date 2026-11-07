// The Desktop panel. Band frames this page in a sandboxed iframe and posts one "band:hello" message
// with a MessagePort. Everything else goes over that port (docs/extensions.md, Panels).
//
// The page opens the extension's "screen" stream, which carries the RFB bytes between noVNC and the
// worktree's x11vnc, and draws the desktop with noVNC. Band's panel input is always on: it sends
// control {enabled: true} when the first stream opens, and the manifest's binaryInput lets noVNC's
// bytes through. An older Band that sends control {enabled: false} makes the page view-only.
import RFB from "@novnc/novnc";

const STREAM_NAME = "screen";
/** Waits before each reconnect after the stream drops. A fourth drop stays closed. */
const RECONNECT_DELAYS_MS = [1000, 2000, 5000];
/** Close codes the hub sends when retrying cannot help (4001: the worker cannot open the stream). */
const FINAL_CLOSE_CODES = new Set([4001, 1008]);

const $ = (id) => document.getElementById(id);
const screen = $("screen");

let port = null;
let visible = true;
let control = false;
let wasReleased = false;
let nextStream = 0;
let streamId = null;
let streamOpen = false;
let channel = null;
let rfb = null;
let retries = 0;
let reconnectTimer = null;
let scaleMode = "fit";
let framebuffer = null;
let area = null;
let sizeObserver = null;

/**
 * The object noVNC drives in place of a WebSocket: it has the properties noVNC checks for and
 * moves bytes to and from Band's port. Frames that arrive before noVNC attaches its handler are
 * kept, because the server speaks first.
 */
class PortChannel {
  constructor(id) {
    this.id = id;
    this.binaryType = "arraybuffer";
    this.protocol = "";
    this.readyState = "open";
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.queue = [];
    this._onmessage = null;
  }

  get onmessage() {
    return this._onmessage;
  }

  set onmessage(handler) {
    this._onmessage = handler;
    if (handler) {
      for (const data of this.queue.splice(0)) handler({ data });
    }
  }

  deliver(data) {
    if (this._onmessage) this._onmessage({ data });
    else this.queue.push(data);
  }

  send(data) {
    if (!port || !streamOpen || this.readyState !== "open") return;
    // noVNC reuses its send buffer, so the port gets a copy.
    const bytes = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    port.postMessage({ type: "stream.send", id: this.id, message: bytes }, [bytes.buffer]);
  }

  close() {
    this.readyState = "closed";
  }
}

/**
 * Band's theme: `init.theme` and later `theme` messages are `{ mode, tokens }`, tokens being Band's
 * CSS color values by name. They replace the panel's own colors. With no theme (or a missing token)
 * the colors from panel.html stay.
 */
const THEME_MAP = {
  background: "--bg",
  foreground: "--fg",
  "muted-foreground": "--muted",
  border: "--border",
  accent: "--accent",
  destructive: "--danger",
};
function applyTheme(theme) {
  if (!theme || typeof theme !== "object") return;
  const root = document.documentElement.style;
  if (theme.mode === "dark" || theme.mode === "light") root.setProperty("color-scheme", theme.mode);
  const tokens = theme.tokens && typeof theme.tokens === "object" ? theme.tokens : {};
  for (const [name, variable] of Object.entries(THEME_MAP)) {
    const value = tokens[name];
    if (typeof value === "string" && value.trim() !== "" && !/[;{}]/.test(value)) root.setProperty(variable, value);
    else root.removeProperty(variable);
  }
}

function setPhase(phase, text) {
  document.body.dataset.phase = phase;
  const labels = { connecting: "Connecting", live: control ? "In control" : "View only", closed: "Disconnected" };
  $("status").textContent = text ?? labels[phase] ?? phase;
}

function showError(text) {
  $("error").textContent = text;
  $("error").title = text;
  $("error").hidden = !text;
}

function showNotice(text, released) {
  const notice = $("notice");
  notice.textContent = text ?? "";
  notice.hidden = !text;
  notice.classList.toggle("released", Boolean(released));
}

function needsDownscale() {
  if (!framebuffer || !area || area.w === 0 || area.h === 0) return false;
  return framebuffer.w > area.w || framebuffer.h > area.h;
}

/** In fit mode noVNC scales only when the desktop is larger than the area; a smaller one stays 1:1. */
function applyScale() {
  if (!rfb) return;
  const downscale = scaleMode === "fit" && needsDownscale();
  rfb.clipViewport = false;
  // Setting the same value again makes noVNC rescale to the current area.
  rfb.scaleViewport = !downscale;
  rfb.scaleViewport = downscale;
}

function readSize() {
  const canvas = screen.querySelector("canvas");
  if (!canvas || canvas.width === 0 || canvas.height === 0) return;
  const next = { w: canvas.width, h: canvas.height };
  if (framebuffer && framebuffer.w === next.w && framebuffer.h === next.h) return;
  framebuffer = next;
  $("resolution").textContent = `${next.w}x${next.h}`;
  applyScale();
}

function applyControl() {
  document.body.dataset.control = control ? "true" : "false";
  if (!rfb) return;
  rfb.viewOnly = !control;
  rfb.focusOnClick = control;
  if (control && visible) rfb.focus();
  else rfb.blur();
  if (document.body.dataset.phase === "live") setPhase("live");
  showNotice(control ? "" : "Released. Take control in Band's toolbar to continue.", !control);
}

function teardownRfb() {
  sizeObserver?.disconnect();
  sizeObserver = null;
  if (rfb) {
    try {
      rfb.disconnect();
    } catch {
      // Already closed.
    }
  }
  rfb = null;
  channel?.close();
  channel = null;
  for (const child of [...screen.children]) if (child.id !== "notice") child.remove();
  framebuffer = null;
  $("resolution").textContent = "no signal";
}

function startRfb() {
  teardownRfb();
  channel = new PortChannel(streamId);
  rfb = new RFB(screen, channel, { shared: true });
  rfb.background = "transparent";
  rfb.addEventListener("connect", () => {
    retries = 0;
    setPhase("live");
    applyControl();
    readSize();
    const canvas = screen.querySelector("canvas");
    if (canvas) {
      sizeObserver = new MutationObserver(readSize);
      sizeObserver.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
    }
  });
  rfb.addEventListener("disconnect", (event) => {
    // A deliberate disconnect (a new stream, a close) is not a drop.
    if (rfb && event.detail && event.detail.clean === false) showError("The connection to the desktop ended");
  });
  applyControl();
}

function openStream() {
  clearTimeout(reconnectTimer);
  $("reconnect").hidden = true;
  showError("");
  setPhase("connecting");
  streamOpen = false;
  // A new id per attempt, so a late message of the old stream is not taken for this one.
  streamId = `${STREAM_NAME}-${nextStream++}`;
  port.postMessage({ type: "stream.open", id: streamId, name: STREAM_NAME, params: {} });
}

function closeStream() {
  clearTimeout(reconnectTimer);
  if (port && streamId) port.postMessage({ type: "stream.close", id: streamId });
  streamOpen = false;
  streamId = null;
  teardownRfb();
}

function onClosed(code, reason) {
  streamOpen = false;
  teardownRfb();
  setPhase("closed");
  if (reason) showError(reason);
  const delay = RECONNECT_DELAYS_MS[retries];
  if (!FINAL_CLOSE_CODES.has(code) && delay !== undefined) {
    retries += 1;
    reconnectTimer = setTimeout(openStream, delay);
  } else {
    $("reconnect").hidden = false;
  }
}

function onMessage(m) {
  switch (m.type) {
    case "init":
      visible = m.visible !== false;
      document.body.dataset.layout = m.layout === "compact" ? "compact" : "regular";
      applyTheme(m.theme);
      port.postMessage({ type: "ready" });
      openStream();
      break;
    case "stream.opened":
      if (m.id !== streamId) break;
      streamOpen = true;
      startRfb();
      break;
    case "stream.frame":
      if (m.id !== streamId) break;
      channel?.deliver(m.data);
      break;
    case "stream.closed":
      if (m.id !== streamId) break;
      onClosed(m.code, m.reason);
      break;
    case "control": {
      const was = control;
      control = m.enabled === true;
      if (was && !control) wasReleased = true;
      applyControl();
      // While released the hub dropped what noVNC sent, so the picture is stale: start a new session.
      if (control && wasReleased && streamOpen) {
        wasReleased = false;
        retries = 0;
        closeStream();
        openStream();
      } else if (control) {
        wasReleased = false;
      }
      break;
    }
    case "visible":
      visible = m.visible !== false;
      if (rfb) {
        if (visible && control) rfb.focus();
        else rfb.blur();
        applyScale();
      }
      break;
    case "theme":
      applyTheme(m);
      break;
    case "layout":
      document.body.dataset.layout = m.layout === "compact" ? "compact" : "regular";
      break;
    default:
      break;
  }
}

function adopt(event) {
  // The first message with a port is Band's. Every other window message is ignored.
  if (port || event.data?.type !== "band:hello" || !event.ports[0]) return;
  port = event.ports[0];
  port.onmessage = (e) => onMessage(e.data ?? {});
}
window.addEventListener("message", adopt);
// The hello may have arrived while noVNC was still loading (panel.html keeps it).
if (window.__bandHello) adopt(window.__bandHello);

new ResizeObserver(([entry]) => {
  const w = Math.floor(entry.contentRect.width);
  const h = Math.floor(entry.contentRect.height);
  if (area && area.w === w && area.h === h) return;
  area = { w, h };
  applyScale();
}).observe(screen);

function setScaleMode(mode) {
  scaleMode = mode;
  document.body.dataset.scale = mode;
  $("fit").setAttribute("aria-pressed", String(mode === "fit"));
  $("actual").setAttribute("aria-pressed", String(mode === "actual"));
  applyScale();
}
$("fit").addEventListener("click", () => setScaleMode("fit"));
$("actual").addEventListener("click", () => setScaleMode("actual"));

// iPhone Safari has no element fullscreen, and a frame without allowfullscreen is refused.
if (document.fullscreenEnabled === true) $("fullscreen").hidden = false;
$("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  else void document.documentElement.requestFullscreen().catch(() => undefined);
});
document.addEventListener("fullscreenchange", () => {
  $("fullscreen").setAttribute("aria-pressed", String(document.fullscreenElement !== null));
});

$("reconnect").addEventListener("click", () => {
  retries = 0;
  if (port) openStream();
});

// The clipboard goes to the desktop only in control mode.
document.addEventListener("paste", (event) => {
  if (!control || !rfb) return;
  const text = event.clipboardData?.getData("text/plain");
  if (text) {
    event.preventDefault();
    rfb.clipboardPasteFrom(text);
  }
});
