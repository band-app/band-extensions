// The Simulator panel. Band frames this page in a sandboxed iframe and posts one "band:hello"
// message with a MessagePort. Everything else goes over that port (docs/extensions.md, Panels).
//
// The page opens the extension's "screen" stream. The worker service sends one text message
// {"type":"booting"} and {"type":"info"} and then one JPEG per frame. Input goes back as JSON through "stream.send", and
// Band's hub drops it until the person presses Take control in Band's toolbar above this frame.
// This page ignores input as well until it gets control {enabled: true}.
(() => {
  "use strict";

  const STREAM_ID = "screen";
  /** Waits before each reconnect after the stream drops. A fourth drop stays closed. */
  const RECONNECT_DELAYS_MS = [500, 1500, 4000];
  /** Close codes the hub sends when retrying cannot help (4001: the worker cannot open the stream). */
  const FINAL_CLOSE_CODES = new Set([4001, 1008]);
  const NAMED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape"]);

  const $ = (id) => document.getElementById(id);
  const canvas = $("screen");
  const ctx = canvas.getContext("2d");

  let port = null;
  let visible = true;
  let controlling = false;
  let pressed = false;
  let opened = false;
  let retries = 0;
  let reconnectTimer = null;
  let pending = null;
  let drawing = false;
  let nextStream = 0;
  let streamId = STREAM_ID;

  function setPhase(phase, text) {
    document.body.dataset.phase = phase;
    $("status").textContent = text ?? phase;
  }

  function refreshStatus() {
    if (document.body.dataset.phase === "live") {
      $("status").textContent = controlling ? "Controlling" : "View only";
    }
  }

  function setControlling(on) {
    controlling = on;
    if (!on) pressed = false;
    document.body.dataset.controlling = on ? "true" : "false";
    $("home").disabled = !on;
    refreshStatus();
    if (on) canvas.focus();
  }

  function send(message) {
    if (port && opened) port.postMessage({ type: "stream.send", id: streamId, message: JSON.stringify(message) });
  }

  function openStream() {
    clearTimeout(reconnectTimer);
    $("reconnect").hidden = true;
    $("error").hidden = true;
    setPhase("connecting");
    opened = false;
    // A new id per attempt, so a late message of the old stream is not taken for this one.
    streamId = `${STREAM_ID}-${nextStream++}`;
    port.postMessage({ type: "stream.open", id: streamId, name: "screen", params: {} });
  }

  async function draw() {
    if (drawing || !visible) return;
    drawing = true;
    try {
      while (pending && visible) {
        const bytes = pending;
        pending = null;
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        if (document.body.dataset.phase !== "live") {
          setPhase("live");
          refreshStatus();
        }
      }
    } catch {
      // A frame that does not decode is skipped.
    } finally {
      drawing = false;
    }
  }

  function onClosed(code, reason) {
    opened = false;
    pending = null;
    setControlling(false);
    setPhase("closed");
    if (reason) {
      $("error").textContent = reason;
      $("error").hidden = false;
    }
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
        port.postMessage({ type: "ready" });
        openStream();
        break;
      case "stream.opened":
        if (m.id !== streamId) break;
        opened = true;
        retries = 0;
        break;
      case "stream.message":
        if (m.id !== streamId) break;
        try {
          const info = JSON.parse(m.text);
          if (info.type === "booting") setPhase("connecting", "booting device");
          if (info.type === "info" && typeof info.name === "string") $("device").textContent = info.name;
        } catch {
          // Not JSON: ignored.
        }
        break;
      case "stream.frame":
        if (m.id !== streamId) break;
        pending = m.data;
        void draw();
        break;
      case "stream.closed":
        if (m.id !== streamId) break;
        onClosed(m.code, m.reason);
        break;
      case "control":
        setControlling(m.enabled === true);
        break;
      case "visible":
        visible = m.visible !== false;
        if (visible) void draw();
        break;
      case "layout":
        document.body.dataset.layout = m.layout === "compact" ? "compact" : "regular";
        break;
      default:
        break;
    }
  }

  window.addEventListener("message", (event) => {
    // The first message with a port is Band's. Every other window message is ignored.
    if (port || event.data?.type !== "band:hello" || !event.ports[0]) return;
    port = event.ports[0];
    port.onmessage = (e) => onMessage(e.data ?? {});
  });

  function touch(phase, e) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    send({ type: "touch", phase, x, y });
  }

  canvas.addEventListener("pointerdown", (e) => {
    if (!controlling) return;
    canvas.setPointerCapture(e.pointerId);
    pressed = true;
    touch("begin", e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (controlling && pressed) touch("move", e);
  });
  const release = (e) => {
    if (!controlling || !pressed) return;
    pressed = false;
    touch("end", e);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("keydown", (e) => {
    if (!controlling || e.metaKey || e.ctrlKey || e.altKey) return;
    if (NAMED_KEYS.has(e.key)) {
      e.preventDefault();
      send({ type: "key", key: e.key });
    } else if (e.key.length === 1) {
      e.preventDefault();
      send({ type: "text", text: e.key });
    }
  });
  $("home").addEventListener("click", () => {
    if (controlling) send({ type: "button", name: "HOME" });
  });
  $("reconnect").addEventListener("click", () => {
    retries = 0;
    openStream();
  });
})();
