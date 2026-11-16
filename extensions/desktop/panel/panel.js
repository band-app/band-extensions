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
// "keychain" when the host stores secrets in the OS keychain, else "none" (also on an older Band
// that sends no `secrets`): the password form shows every time and nothing is saved.
let secretsMode = "none";
let nextSecret = 0;
const pendingSecrets = new Map();
let serviceError = "";
let formOpen = false;
let savedTried = false;
let login = null;
// A password was sent and the service has not answered yet; the timer ends a wait that never does.
let signingIn = false;
let signInTimer = null;
// Longer than the service's own limits (45 s unlock + 20 s login), so its message wins.
const SIGN_IN_TIMEOUT_MS = 90_000;
// Why the last sign-in did not finish, shown on the form the next stream asks with.
let carriedReason = "";

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
  if (control && visible && !formOpen) rfb.focus();
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
  for (const child of [...screen.children]) if (child.id !== "notice" && child.id !== "login") child.remove();
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
  serviceError = "";
  savedTried = false;
  login = null;
  hideLogin();
  // A new id per attempt, so a late message of the old stream is not taken for this one.
  streamId = `${STREAM_NAME}-${nextStream++}`;
  port.postMessage({ type: "stream.open", id: streamId, name: STREAM_NAME, params: {} });
}

/** Asks the host to keep, return or forget a secret. Resolves null when the host keeps none. */
function secretCall(type, key, value) {
  if (secretsMode !== "keychain" || !port) return Promise.resolve(null);
  const id = `secret-${nextSecret++}`;
  return new Promise((resolve, reject) => {
    pendingSecrets.set(id, { resolve, reject });
    port.postMessage({ type, id, key, ...(type === "secret.set" ? { value } : {}) });
  });
}

function onSecretReply(m) {
  const waiting = pendingSecrets.get(m.id);
  if (!waiting) return;
  pendingSecrets.delete(m.id);
  if (m.type === "secret.error") waiting.reject(new Error(typeof m.message === "string" ? m.message : "secret failed"));
  else waiting.resolve(typeof m.value === "string" ? m.value : null);
}

function sendToService(message) {
  if (port && streamId && streamOpen) port.postMessage({ type: "stream.send", id: streamId, message: JSON.stringify(message) });
}

function endSignIn() {
  signingIn = false;
  clearTimeout(signInTimer);
  signInTimer = null;
}

/** Sends the password and starts waiting for the service's answer. */
function sendPassword(password) {
  signingIn = true;
  clearTimeout(signInTimer);
  signInTimer = setTimeout(() => {
    if (!signingIn) return;
    carriedReason = "the Mac did not answer the sign-in within 90 seconds. Check that Screen Sharing is on, then enter the password again";
    endSignIn();
    closeStream();
    retries = 0;
    openStream();
  }, SIGN_IN_TIMEOUT_MS);
  sendToService({ type: "password", password });
}

function hideLogin() {
  formOpen = false;
  $("login").hidden = true;
  $("login-password").value = "";
}

function showLogin(user, reason) {
  formOpen = true;
  $("login-title").textContent = `Sign in to the Mac as ${user}`;
  $("login-reason").textContent = reason;
  $("login-reason").hidden = !reason;
  $("login-remember-label").hidden = secretsMode !== "keychain";
  $("login").hidden = false;
  if (rfb) rfb.blur();
  setPhase("connecting", "Sign-in needed");
  $("login-password").focus();
}

/** The service wants the Mac password: a saved one first, else the form. A refused one is forgotten. */
async function onNeedPassword(m) {
  const id = streamId;
  const user = typeof m.user === "string" ? m.user : "";
  endSignIn();
  const refused = typeof m.reason === "string" ? m.reason : "";
  const reason = refused || carriedReason;
  carriedReason = "";
  const key = `mac:${typeof m.worker === "string" && m.worker ? m.worker : "worker"}:${user}`.slice(0, 200);
  login = { key, user, save: null };
  if (!reason && !savedTried && secretsMode === "keychain") {
    savedTried = true;
    try {
      const saved = await secretCall("secret.get", key);
      if (id !== streamId) return;
      if (saved) {
        setPhase("connecting", "Signing in");
        sendPassword(saved);
        return;
      }
    } catch {
      // The keychain could not be read (Touch ID cancelled): ask for the password instead.
      if (id !== streamId) return;
    }
  }
  if (refused && secretsMode === "keychain") secretCall("secret.delete", key).catch(() => undefined);
  showLogin(user, reason);
}

function onServiceMessage(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  if (!m || typeof m !== "object") return;
  if (m.type === "need-password") void onNeedPassword(m);
  else if (m.type === "signed-in") {
    endSignIn();
    carriedReason = "";
    hideLogin();
    setPhase("connecting");
    const save = login?.save;
    if (save) secretCall("secret.set", save.key, save.password).catch(() => undefined);
    if (login) login.save = null;
  } else if (m.type === "error" && typeof m.message === "string") {
    endSignIn();
    serviceError = m.message;
    hideLogin();
    showError(m.message);
  }
}

// Band frames the panel with sandbox="allow-scripts" and no allow-forms, so the browser drops a
// form submission before any submit event fires. Connect and Enter call this directly instead.
function submitLogin() {
  const password = $("login-password").value;
  if (!login) return;
  if (password === "") {
    // `required` showed a validation bubble here; the sandbox cannot, so put the cursor back in the field.
    $("login-password").focus();
    return;
  }
  if (!streamOpen) {
    // The password cannot reach the service: say so instead of closing the form on nothing.
    hideLogin();
    setPhase("closed");
    showError("The connection to the desktop is closed, so the password was not sent. Press Reconnect, then sign in again.");
    $("reconnect").hidden = false;
    return;
  }
  login.save = secretsMode === "keychain" && $("login-remember").checked ? { key: login.key, password } : null;
  hideLogin();
  setPhase("connecting", "Signing in");
  sendPassword(password);
}

$("login-submit").addEventListener("click", submitLogin);
$("login-password").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    submitLogin();
  }
});

function closeStream() {
  clearTimeout(reconnectTimer);
  if (port && streamId) port.postMessage({ type: "stream.close", id: streamId });
  streamOpen = false;
  streamId = null;
  teardownRfb();
}

function onClosed(code, reason) {
  streamOpen = false;
  const interrupted = signingIn || formOpen;
  const during = signingIn;
  endSignIn();
  teardownRfb();
  hideLogin();
  setPhase("closed");
  // The service's own reason beats the hub's generic one, and retrying cannot fix it.
  let why = serviceError || reason;
  if (!why && during) why = "The connection to the desktop ended while signing in. Enter the password again.";
  if (why) showError(why);
  // The next stream asks again from the start; tell the person why.
  if (interrupted && !serviceError) carriedReason = why || "the connection to the desktop ended before you signed in";
  const delay = RECONNECT_DELAYS_MS[retries];
  if (!serviceError && !FINAL_CLOSE_CODES.has(code) && delay !== undefined) {
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
      secretsMode = m.secrets === "keychain" ? "keychain" : "none";
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
    case "stream.message":
      if (m.id !== streamId) break;
      if (typeof m.text === "string") onServiceMessage(m.text);
      break;
    case "secret.result":
    case "secret.error":
      onSecretReply(m);
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

// The clipboard goes to the desktop only in control mode, and never when the paste is meant for a
// field of the panel itself (the sign-in password).
document.addEventListener("paste", (event) => {
  if (!control || !rfb || formOpen) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable]")) return;
  const text = event.clipboardData?.getData("text/plain");
  if (text) {
    event.preventDefault();
    rfb.clipboardPasteFrom(text);
  }
});
