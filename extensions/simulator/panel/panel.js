// The Simulator panel. Band frames this page in a sandboxed iframe and posts one "band:hello"
// message with a MessagePort. Everything else goes over that port (docs/extensions.md, Panels).
//
// The page opens the extension's "screen" stream. The worker service sends one text message
// {"type":"booting"} and {"type":"info"} and then one JPEG per frame. Input goes back as JSON
// through "stream.send". Input is always on: Band has no Take control step for panels, so this page
// ignores the "control" message. The toolbar calls the service (devices, select, shutdown, rotate)
// with "call". Pure helpers (shell geometry, theme tokens, picker groups) are in shell.js.
(() => {
  "use strict";

  const Shell = globalThis.BandSimShell;

  const STREAM_ID = "screen";
  /** Waits before each reconnect after the stream drops. A fourth drop stays closed. */
  const RECONNECT_DELAYS_MS = [500, 1500, 4000];
  /** Close codes the hub sends when retrying cannot help (4001: the worker cannot open the stream). */
  const FINAL_CLOSE_CODES = new Set([4001, 1008]);
  const NAMED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape"]);

  const $ = (id) => document.getElementById(id);
  const canvas = $("screen");
  const ctx = canvas.getContext("2d");
  const stage = $("stage");

  let port = null;
  let visible = true;
  let pressed = false;
  let opened = false;
  let retries = 0;
  let reconnectTimer = null;
  let pending = null;
  let drawing = false;
  let nextStream = 0;
  let streamId = STREAM_ID;
  /** The device the stream shows: {udid, name}. */
  let current = null;
  let deviceList = [];
  /** True from the Power press that shuts the device down until it is turned on again. */
  let off = false;
  /** True once a frame was drawn, so the canvas size is the device's screen size. */
  let hasFrame = false;
  let framed = true;
  let nextCall = 0;
  const calls = new Map();

  const STATUS = { connecting: "Connecting", booting: "Booting", live: "Connected", closed: "Disconnected", off: "Off" };
  const BOOT_TEXT = { connecting: "Connecting\u2026", booting: "Booting\u2026" };

  function setPhase(phase, text) {
    document.body.dataset.phase = phase;
    $("status").textContent = STATUS[phase] ?? phase;
    $("boot-text").textContent = text ?? BOOT_TEXT[phase] ?? "";
    $("off").textContent = phase === "off" ? "Off" : phase === "closed" ? "Disconnected" : "";
    const live = phase === "live";
    $("home").disabled = !live;
    $("rotate").disabled = !live;
    $("power").disabled = !(live || phase === "off");
    const turnOn = phase === "off";
    $("power").setAttribute("aria-label", turnOn ? "Turn on" : "Turn off");
    $("power").title = turnOn ? "Turn on" : "Turn off";
    if (!live) pressed = false;
  }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      if (!port) return reject(new Error("not connected"));
      const id = `call-${nextCall++}`;
      calls.set(id, { resolve, reject });
      port.postMessage({ type: "call", id, method, params: params ?? {} });
    });
  }

  /** An error shows as an icon in the toolbar. Its text is in a popover the icon opens. */
  function showError(text) {
    $("error-pop").textContent = text;
    $("error-wrap").hidden = !text;
    if (!text) setErrorOpen(false);
  }

  function setErrorOpen(open) {
    $("error-pop").hidden = !open;
    $("error-btn").setAttribute("aria-expanded", String(open));
  }

  // The theme: Band's tokens set the panel's variables, from init.theme and from each later "theme" message (the same shape). Without a theme the page keeps the colors
  // of its stylesheet.
  function applyTheme(theme) {
    const { vars, scheme } = Shell.themeVars(theme);
    const root = document.documentElement;
    // A token the new theme lacks goes back to the stylesheet's color instead of keeping the old one.
    for (const name of Shell.themeVarNames) {
      if (name in vars) root.style.setProperty(name, vars[name]);
      else root.style.removeProperty(name);
    }
    if (scheme) root.style.colorScheme = scheme;
    else root.style.removeProperty("color-scheme");
  }

  // The frame toggle is remembered per device. Storage can throw (private windows), so the choice
  // then lasts until the panel closes.
  function frameKey(udid) {
    return `sim-frame:${udid ?? "none"}`;
  }

  /** The choice per device for this session, used when storage is blocked (a sandbox without allow-same-origin). */
  const framedInSession = new Map();

  function loadFramed() {
    const key = frameKey(current?.udid);
    try {
      return localStorage.getItem(key) !== "0";
    } catch {
      return framedInSession.get(key) ?? true;
    }
  }

  function setFramed(value, save) {
    framed = value;
    if (save) {
      framedInSession.set(frameKey(current?.udid), value);
      try {
        localStorage.setItem(frameKey(current?.udid), value ? "1" : "0");
      } catch {
        // Not remembered.
      }
    }
    const toggle = $("frame-toggle");
    toggle.setAttribute("aria-pressed", String(value));
    toggle.title = value ? "Hide frame" : "Show frame";
    toggle.setAttribute("aria-label", toggle.title);
    relayout();
  }

  /** Sizes the shell and the screen to the room in <main>. Taps use the canvas's own rectangle, so they stay exact. */
  function relayout() {
    const main = document.querySelector("main");
    const cs = getComputedStyle(main);
    const avail = {
      width: main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      height: main.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
    };
    const screen = hasFrame ? { width: canvas.width, height: canvas.height } : Shell.DEFAULT_SCREEN;
    const l = Shell.layout(avail, screen, framed);
    const edge = l.button;
    stage.dataset.framed = String(framed);
    stage.style.width = `${l.shell.width + 2 * edge}px`;
    stage.style.height = `${l.shell.height}px`;
    const shell = $("shell");
    shell.style.left = `${edge}px`;
    shell.style.top = "0px";
    shell.style.width = `${l.shell.width}px`;
    shell.style.height = `${l.shell.height}px`;
    shell.style.borderRadius = `${l.shellRadius}px`;
    const box = $("screen-box");
    box.style.left = `${edge + l.bezel}px`;
    box.style.top = `${l.bezel}px`;
    box.style.width = `${l.screen.width}px`;
    box.style.height = `${l.screen.height}px`;
    box.style.borderRadius = `${l.screenRadius}px`;
    // Side buttons are drawn in portrait only: in landscape they would sit on the top and bottom edges.
    const portrait = l.screen.height >= l.screen.width;
    const bw = Math.max(2, edge);
    const place = (id, left, top, height) => {
      const el = $(id);
      el.style.display = framed && portrait && edge > 0 ? "block" : "none";
      el.style.left = `${left}px`;
      el.style.top = `${Math.round(top * l.shell.height)}px`;
      el.style.width = `${bw}px`;
      el.style.height = `${Math.round(height * l.shell.height)}px`;
    };
    place("side-action", edge - bw, 0.14, 0.035);
    place("side-up", edge - bw, 0.21, 0.07);
    place("side-down", edge - bw, 0.3, 0.07);
    place("side-power", edge + l.shell.width, 0.25, 0.11);
  }

  function deviceInfo(udid) {
    return deviceList.find((d) => d.udid === udid);
  }

  function renderDevice() {
    const name = current?.name ?? "iOS Simulator";
    $("device").textContent = name;
    const wasFramed = framed;
    const stored = loadFramed();
    if (stored !== wasFramed) setFramed(stored, false);
    $("picker-name").textContent = name;
    const info = current ? deviceInfo(current.udid) : undefined;
    $("picker-version").textContent = info ? `iOS ${info.runtime}` : "";
  }

  async function refreshDevices() {
    try {
      const res = await call("devices");
      deviceList = res.devices ?? [];
      if (!current || current.udid !== res.current) {
        const d = deviceInfo(res.current);
        if (d) current = { udid: d.udid, name: d.name };
      }
      renderDevice();
    } catch {
      // The picker keeps its last list.
    }
  }

  function send(message) {
    if (port && opened && !off) port.postMessage({ type: "stream.send", id: streamId, message: JSON.stringify(message) });
  }

  function openStream() {
    clearTimeout(reconnectTimer);
    $("reconnect").hidden = true;
    showError("");
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
        if (!hasFrame || canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          hasFrame = true;
          relayout();
        }
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        if (document.body.dataset.phase !== "live" && !off) setPhase("live");
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
    // A stream the page closed itself (Power off, a new pick) is not a drop.
    if (off) return;
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

  function closeStream() {
    clearTimeout(reconnectTimer);
    if (port) port.postMessage({ type: "stream.close", id: streamId });
    opened = false;
    pending = null;
  }

  function onMessage(m) {
    switch (m.type) {
      case "init":
        visible = m.visible !== false;
        document.body.dataset.layout = m.layout === "compact" ? "compact" : "regular";
        if (m.theme) applyTheme(m.theme);
        relayout();
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
          if (info.type === "booting") setPhase("booting", Shell.bootText(info));
          if (info.type === "info" && typeof info.name === "string") {
            current = { udid: info.udid, name: info.name };
            renderDevice();
            void refreshDevices();
          }
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
      case "call.result": {
        const c = calls.get(m.id);
        calls.delete(m.id);
        c?.resolve(m.result);
        break;
      }
      case "call.error": {
        const c = calls.get(m.id);
        calls.delete(m.id);
        c?.reject(new Error(m.message));
        break;
      }
      case "control":
        // Input is always on; Band's message is only for pages written for the old protocol.
        break;
      case "visible":
        visible = m.visible !== false;
        if (visible) void draw();
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
    if (!opened) return;
    canvas.setPointerCapture(e.pointerId);
    pressed = true;
    touch("begin", e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (pressed) touch("move", e);
  });
  const release = (e) => {
    if (!pressed) return;
    pressed = false;
    touch("end", e);
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("keydown", (e) => {
    if (!opened || e.metaKey || e.ctrlKey || e.altKey) return;
    if (NAMED_KEYS.has(e.key)) {
      e.preventDefault();
      send({ type: "key", key: e.key });
    } else if (e.key.length === 1) {
      e.preventDefault();
      send({ type: "text", text: e.key });
    }
  });
  $("home").addEventListener("click", () => send({ type: "button", name: "HOME" }));

  $("rotate").addEventListener("click", async () => {
    // The frame is wider than tall in landscape.
    const orientation = canvas.width > canvas.height ? "portrait" : "landscape_left";
    $("rotate").disabled = true;
    try {
      await call("rotate", { orientation });
    } catch (err) {
      showError(err.message);
    } finally {
      if (document.body.dataset.phase === "live") $("rotate").disabled = false;
    }
  });

  $("power").addEventListener("click", async () => {
    $("power").disabled = true;
    if (off) {
      off = false;
      retries = 0;
      openStream();
      return;
    }
    off = true;
    closeStream();
    setPhase("off");
    $("power").disabled = true;
    try {
      await call("shutdown");
    } catch (err) {
      showError(err.message);
    }
    $("power").disabled = false;
  });

  const menu = $("menu");
  const picker = $("picker");

  function closeMenu() {
    menu.hidden = true;
    picker.setAttribute("aria-expanded", "false");
  }

  function renderMenu() {
    menu.textContent = "";
    if (deviceList.length === 0) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No devices";
      menu.append(li);
      return;
    }
    const own = deviceList.find((d) => d.group === "this");
    if (own && current && own.udid !== current.udid) {
      const use = document.createElement("li");
      use.className = "use-own";
      use.setAttribute("role", "option");
      use.setAttribute("aria-selected", "false");
      use.textContent = "Use this worktree's device";
      use.addEventListener("click", () => {
        closeMenu();
        void choose(own);
      });
      menu.append(use);
    }
    for (const group of Shell.pickerGroups(deviceList)) {
      const heading = document.createElement("li");
      heading.className = "group";
      heading.setAttribute("role", "presentation");
      heading.dataset.group = group.key;
      heading.textContent = group.label;
      menu.append(heading);
      for (const d of group.devices) menu.append(menuRow(d));
    }
  }

  function menuRow(d) {
    {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.udid = d.udid;
      li.setAttribute("aria-selected", String(d.udid === current?.udid));
      for (const [cls, text] of [["name", d.name], ["meta", `iOS ${d.runtime}`], ["meta", d.state === "Booted" ? "On" : "Off"]]) {
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = text;
        li.append(span);
      }
      li.addEventListener("click", () => {
        closeMenu();
        void choose(d);
      });
      return li;
    }
  }

  async function choose(d) {
    if (d.udid === current?.udid) return;
    showError("");
    clearTimeout(reconnectTimer);
    try {
      await call("select", { udid: d.udid });
    } catch (err) {
      showError(err.message);
      return;
    }
    closeStream();
    off = false;
    retries = 0;
    current = { udid: d.udid, name: d.name };
    hasFrame = false;
    renderDevice();
    relayout();
    openStream();
  }

  picker.addEventListener("click", async () => {
    if (!menu.hidden) return closeMenu();
    await refreshDevices();
    renderMenu();
    menu.hidden = false;
    picker.setAttribute("aria-expanded", "true");
  });
  document.addEventListener("click", (e) => {
    if (!$("error-pop").hidden && !$("error-wrap").contains(e.target)) setErrorOpen(false);
    if (!menu.hidden && !$("picker-wrap").contains(e.target)) closeMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  $("frame-toggle").addEventListener("click", () => setFramed(!framed, true));
  $("error-btn").addEventListener("click", () => setErrorOpen($("error-pop").hidden));
  new ResizeObserver(relayout).observe(document.querySelector("main"));
  relayout();

  $("reconnect").addEventListener("click", () => {
    retries = 0;
    openStream();
  });
})();
