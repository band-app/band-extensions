// The Simulator panel: a canvas of panes. Band frames this page in a sandboxed iframe and posts one
// "band:hello" message with a MessagePort. Everything else goes over that port.
//
// The canvas is a tree of splits whose leaves are panes (canvas.js). Each pane shows one device
// and has its own toolbar and its own "screen" stream, opened with params {device: <id>}. The
// worker service sends text messages ("booting", "info", "off", "error") and then one JPEG per
// frame. Input goes back as JSON through "stream.send"; the focused pane also tells the service it
// is focused, which is how agent tools find "the device on screen". The layout and each pane's
// device are saved through the service ("saveLayout") and restored from it ("layout"). Input is
// always on: Band has no Take control step for panels. Pure helpers are in shell.js and canvas.js.
//
// While visible the page polls the service's "events" call every 2 seconds. The poll carries the
// focused pane and the shown devices. The answer brings "show" events (an agent put a device in a
// pane: that pane switches without a reload) and "offer" events (a device started that no pane
// shows: a bar asks "<name> started, show it?" with Show and Dismiss, and never switches alone).
(() => {
  "use strict";

  const Shell = globalThis.BandSimShell;
  const Canvas = globalThis.BandSimCanvas;

  /** Waits before each reconnect after a stream drops. A fourth drop stays closed. */
  const RECONNECT_DELAYS_MS = [500, 1500, 4000];
  /** Close codes the hub sends when retrying cannot help (4001: the worker cannot open the stream). */
  const FINAL_CLOSE_CODES = new Set([4001, 1008]);
  const NAMED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape"]);
  const SAVE_DELAY_MS = 400;
  const STATUS = { connecting: "Connecting", booting: "Booting", live: "Connected", closed: "Disconnected", off: "Off", empty: "" };
  const BOOT_TEXT = { connecting: "Connecting…", booting: "Booting…" };

  const $ = (id) => document.getElementById(id);

  let port = null;
  let visible = true;
  let tree = Canvas.pane("p1", null);
  let focusedId = "p1";
  let nextCall = 0;
  let nextStream = 0;
  let deviceList = [];
  let platforms = {};
  let saveTimer = null;
  const calls = new Map();
  /** Pane objects by pane id, and the pane each open stream belongs to. */
  const panes = new Map();
  const byStream = new Map();
  /** The frame toggle per device for this session, used when storage is blocked. */
  const framedInSession = new Map();
  const POLL_MS = 2000;
  let pollTimer = null;
  let polling = false;
  let lastSeq;
  /** Offered devices by id, and the ones the person dismissed (until the device turns off). */
  const offers = new Map();
  const dismissed = new Set();

  function call(method, params) {
    return new Promise((resolve, reject) => {
      if (!port) return reject(new Error("not connected"));
      const id = `call-${nextCall++}`;
      calls.set(id, { resolve, reject });
      port.postMessage({ type: "call", id, method, params: params ?? {} });
    });
  }

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

  function frameKey(id) {
    return `sim-frame:${id ?? "none"}`;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      call("saveLayout", { layout: Canvas.toSaved(tree) }).catch(() => {
        // The layout then lasts until the panel closes.
      });
    }, SAVE_DELAY_MS);
  }

  class Pane {
    constructor(id, device) {
      this.id = id;
      this.device = device ?? null;
      this.el = $("pane-tpl").content.firstElementChild.cloneNode(true);
      this.el.dataset.pane = id;
      this.canvas = this.q("canvas.screen");
      this.ctx = this.canvas.getContext("2d");
      this.phase = "empty";
      this.streamId = null;
      this.opened = false;
      this.retries = 0;
      this.reconnectTimer = null;
      this.pending = null;
      this.drawing = false;
      this.off = false;
      this.fatal = false;
      this.hasFrame = false;
      this.pressed = false;
      this.framed = true;
      this.platform = device?.platform ?? "ios";
      this.menuCreate = null;
      this.bind();
      this.renderDevice();
      this.setPhase(device ? "connecting" : "empty");
      new ResizeObserver(() => this.relayout()).observe(this.q("main"));
    }

    q(sel) {
      return this.el.querySelector(sel);
    }

    // ---- state shown ----------------------------------------------------------------------

    setPhase(phase, text) {
      this.phase = phase;
      this.el.dataset.phase = phase;
      this.q(".status").textContent = STATUS[phase] ?? phase;
      this.q(".boot-text").textContent = text ?? BOOT_TEXT[phase] ?? "";
      this.q(".off").textContent = phase === "off" ? "Off" : phase === "closed" ? "Disconnected" : "";
      const live = phase === "live";
      for (const c of ["home", "back", "rotate"]) this.q(`.${c}`).disabled = !live;
      this.q(".power").disabled = !(live || phase === "off");
      const turnOn = phase === "off";
      this.q(".power").setAttribute("aria-label", turnOn ? "Turn on" : "Turn off");
      this.q(".power").title = turnOn ? "Turn on" : "Turn off";
      if (!live) this.pressed = false;
    }

    renderDevice() {
      const d = this.device;
      this.q(".picker-name").textContent = d ? d.name : "Choose a device";
      const info = d ? deviceList.find((x) => x.id === d.id) : null;
      this.q(".picker-version").textContent = info ? info.os : "";
      this.platform = d?.platform ?? this.platform;
      this.q(".stage").dataset.platform = this.platform;
      this.q(".back").hidden = this.platform !== "android";
      this.q(".home").title = this.platform === "android" ? "Home" : "Home";
      const stored = this.loadFramed();
      if (stored !== this.framed) this.setFramed(stored, false);
    }

    showError(text) {
      this.q(".error-pop").textContent = text;
      this.q(".error-wrap").hidden = !text;
      if (!text) this.setErrorOpen(false);
    }

    setErrorOpen(open) {
      this.q(".error-pop").hidden = !open;
      this.q(".error-btn").setAttribute("aria-expanded", String(open));
    }

    loadFramed() {
      const key = frameKey(this.device?.id);
      try {
        return localStorage.getItem(key) !== "0";
      } catch {
        return framedInSession.get(key) ?? true;
      }
    }

    setFramed(value, save) {
      this.framed = value;
      if (save) {
        const key = frameKey(this.device?.id);
        framedInSession.set(key, value);
        try {
          localStorage.setItem(key, value ? "1" : "0");
        } catch {
          // Not remembered.
        }
      }
      const t = this.q(".frame-toggle");
      t.setAttribute("aria-pressed", String(value));
      t.title = value ? "Hide frame" : "Show frame";
      t.setAttribute("aria-label", t.title);
      this.relayout();
    }

    /** Sizes the shell and the screen to the room in <main>. Taps use the canvas's own rectangle, so they stay exact. */
    relayout() {
      const main = this.q("main");
      if (!main.isConnected) return;
      this.el.dataset.narrow = String(this.el.clientWidth < 460);
      const cs = getComputedStyle(main);
      const avail = {
        width: main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        height: main.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
      };
      const screen = this.hasFrame ? { width: this.canvas.width, height: this.canvas.height } : Shell.DEFAULT_SCREEN;
      const l = Shell.layout(avail, screen, this.framed, this.platform);
      const edge = l.button;
      const stage = this.q(".stage");
      stage.dataset.framed = String(this.framed);
      stage.style.width = `${l.shell.width + 2 * edge}px`;
      stage.style.height = `${l.shell.height}px`;
      const shell = this.q(".shell");
      shell.style.left = `${edge}px`;
      shell.style.top = "0px";
      shell.style.width = `${l.shell.width}px`;
      shell.style.height = `${l.shell.height}px`;
      shell.style.borderRadius = `${l.shellRadius}px`;
      const box = this.q(".screen-box");
      box.style.left = `${edge + l.bezel}px`;
      box.style.top = `${l.bezel}px`;
      box.style.width = `${l.screen.width}px`;
      box.style.height = `${l.screen.height}px`;
      box.style.borderRadius = `${l.screenRadius}px`;
      // Side buttons are drawn in portrait only: in landscape they would sit on the top and bottom edges.
      const portrait = l.screen.height >= l.screen.width;
      const bw = Math.max(2, edge);
      const place = (cls, left, top, height) => {
        const el = this.q(cls);
        el.style.display = this.framed && portrait && edge > 0 ? "block" : "none";
        el.style.left = `${left}px`;
        el.style.top = `${Math.round(top * l.shell.height)}px`;
        el.style.width = `${bw}px`;
        el.style.height = `${Math.round(height * l.shell.height)}px`;
      };
      const right = edge + l.shell.width;
      if (this.platform === "android") {
        // Power and volume on the right edge.
        place(".side-1", right, 0.2, 0.09);
        place(".side-2", right, 0.32, 0.05);
        place(".side-3", right, 0.4, 0.05);
        place(".side-4", right, 0, 0);
      } else {
        place(".side-1", edge - bw, 0.14, 0.035);
        place(".side-2", edge - bw, 0.21, 0.07);
        place(".side-3", edge - bw, 0.3, 0.07);
        place(".side-4", right, 0.25, 0.11);
      }
    }

    // ---- stream ---------------------------------------------------------------------------

    send(message) {
      if (port && this.opened && !this.off && this.streamId) {
        port.postMessage({ type: "stream.send", id: this.streamId, message: JSON.stringify(message) });
      }
    }

    openStream() {
      if (!this.device) return;
      clearTimeout(this.reconnectTimer);
      this.q(".reconnect").hidden = true;
      this.showError("");
      this.setPhase("connecting");
      this.opened = false;
      this.fatal = false;
      if (this.streamId) byStream.delete(this.streamId);
      // A new id per attempt, so a late message of the old stream is not taken for this one.
      this.streamId = `screen-${nextStream++}`;
      byStream.set(this.streamId, this);
      port.postMessage({ type: "stream.open", id: this.streamId, name: "screen", params: { device: this.device.id } });
    }

    closeStream() {
      clearTimeout(this.reconnectTimer);
      if (port && this.streamId) port.postMessage({ type: "stream.close", id: this.streamId });
      if (this.streamId) byStream.delete(this.streamId);
      this.streamId = null;
      this.opened = false;
      this.pending = null;
    }

    onStreamMessage(m) {
      switch (m.type) {
        case "stream.opened":
          this.opened = true;
          this.retries = 0;
          if (focusedId === this.id) this.send({ type: "focus" });
          break;
        case "stream.message":
          try {
            const info = JSON.parse(m.text);
            if (info.type === "booting") this.setPhase("booting", Shell.bootText(info));
            else if (info.type === "info" && typeof info.name === "string") {
              if (info.platform === "ios" || info.platform === "android") {
                this.platform = info.platform;
                this.q(".stage").dataset.platform = info.platform;
                this.q(".back").hidden = info.platform !== "android";
                this.relayout();
              }
              if (this.device && info.name !== this.device.name) {
                this.device = { ...this.device, name: info.name };
                tree = Canvas.setDevice(tree, this.id, this.device);
                scheduleSave();
              }
              this.renderDevice();
              void refreshDevices().then(() => this.renderDevice());
            } else if (info.type === "off") {
              // The device was turned off (here, by another pane or to make room): stay off, do not reconnect.
              this.off = true;
              this.opened = false;
              this.pending = null;
              this.setPhase("off");
            } else if (info.type === "error") {
              this.fatal = true;
              this.showError(String(info.message ?? "The device could not be opened"));
            }
          } catch {
            // Not JSON: ignored.
          }
          break;
        case "stream.frame":
          this.pending = m.data;
          void this.draw();
          break;
        case "stream.closed":
          this.onClosed(m.code, m.reason);
          break;
        default:
          break;
      }
    }

    async draw() {
      if (this.drawing || !visible) return;
      this.drawing = true;
      try {
        while (this.pending && visible) {
          const bytes = this.pending;
          this.pending = null;
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
          if (!this.hasFrame || this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
            this.canvas.width = bitmap.width;
            this.canvas.height = bitmap.height;
            this.hasFrame = true;
            this.relayout();
          }
          this.ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          if (this.phase !== "live" && !this.off) this.setPhase("live");
        }
      } catch {
        // A frame that does not decode is skipped.
      } finally {
        this.drawing = false;
      }
    }

    onClosed(code, reason) {
      this.opened = false;
      this.pending = null;
      if (this.streamId) byStream.delete(this.streamId);
      this.streamId = null;
      // A stream the page closed itself or the device turned off is not a drop; neither is an error to show.
      if (this.off) return;
      this.setPhase("closed");
      if (reason) this.showError(reason);
      const delay = RECONNECT_DELAYS_MS[this.retries];
      if (!this.fatal && !FINAL_CLOSE_CODES.has(code) && delay !== undefined) {
        this.retries += 1;
        this.reconnectTimer = setTimeout(() => this.openStream(), delay);
      } else {
        this.q(".reconnect").hidden = false;
      }
    }

    /** Shows another device (or none) in this pane. */
    setDevice(device) {
      this.closeStream();
      this.device = device;
      this.off = false;
      this.fatal = false;
      this.retries = 0;
      this.hasFrame = false;
      tree = Canvas.setDevice(tree, this.id, device);
      this.renderDevice();
      this.relayout();
      scheduleSave();
      if (device) this.openStream();
      else this.setPhase("empty");
      renderOffers();
    }

    // ---- input ----------------------------------------------------------------------------

    touch(phase, e) {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
      this.send({ type: "touch", phase, x, y });
    }

    key(e) {
      if (!this.opened || e.metaKey || e.ctrlKey || e.altKey) return;
      if (NAMED_KEYS.has(e.key)) {
        e.preventDefault();
        this.send({ type: "key", key: e.key });
      } else if (e.key.length === 1) {
        e.preventDefault();
        this.send({ type: "text", text: e.key });
      }
    }

    bind() {
      const c = this.canvas;
      c.addEventListener("pointerdown", (e) => {
        if (!this.opened) return;
        c.setPointerCapture(e.pointerId);
        this.pressed = true;
        this.touch("begin", e);
      });
      c.addEventListener("pointermove", (e) => {
        if (this.pressed) this.touch("move", e);
      });
      const release = (e) => {
        if (!this.pressed) return;
        this.pressed = false;
        this.touch("end", e);
      };
      c.addEventListener("pointerup", release);
      c.addEventListener("pointercancel", release);
      // A press anywhere in the pane makes it the focused one; a press on the screen also gives it the keyboard.
      this.el.addEventListener(
        "pointerdown",
        (e) => focusPane(this.id, this.q("main").contains(e.target) && !this.q(".choose").contains(e.target)),
        true,
      );
      this.q(".home").addEventListener("click", () => this.send({ type: "button", name: "HOME" }));
      this.q(".back").addEventListener("click", () => this.send({ type: "button", name: "BACK" }));
      this.q(".frame-toggle").addEventListener("click", () => this.setFramed(!this.framed, true));
      this.q(".error-btn").addEventListener("click", () => this.setErrorOpen(this.q(".error-pop").hidden));
      this.q(".reconnect").addEventListener("click", () => {
        this.retries = 0;
        this.openStream();
      });
      this.q(".split-row").addEventListener("click", () => splitPane(this.id, "row"));
      this.q(".split-column").addEventListener("click", () => splitPane(this.id, "column"));
      this.q(".close").addEventListener("click", () => closePane(this.id));
      this.q(".choose").addEventListener("click", () => void this.toggleMenu());

      this.q(".rotate").addEventListener("click", async () => {
        if (!this.device) return;
        // The frame is wider than tall in landscape.
        const orientation = this.canvas.width > this.canvas.height ? "portrait" : "landscape_left";
        this.q(".rotate").disabled = true;
        try {
          await call("rotate", { device: this.device.id, orientation });
        } catch (err) {
          this.showError(err.message);
        } finally {
          if (this.phase === "live") this.q(".rotate").disabled = false;
        }
      });

      this.q(".power").addEventListener("click", async () => {
        if (!this.device) return;
        this.q(".power").disabled = true;
        if (this.off) {
          this.off = false;
          this.retries = 0;
          this.openStream();
          return;
        }
        this.off = true;
        this.closeStream();
        this.setPhase("off");
        try {
          await call("shutdown", { device: this.device.id });
        } catch (err) {
          this.showError(err.message);
        }
        this.q(".power").disabled = false;
      });

      this.q(".picker").addEventListener("click", () => void this.toggleMenu());
    }

    // ---- picker ---------------------------------------------------------------------------

    get menu() {
      return this.q(".menu");
    }

    closeMenu() {
      this.menu.hidden = true;
      this.q(".picker").setAttribute("aria-expanded", "false");
      this.menuCreate = null;
    }

    async toggleMenu() {
      if (!this.menu.hidden) return this.closeMenu();
      for (const p of panes.values()) if (p !== this) p.closeMenu();
      await refreshDevices();
      this.renderMenu();
      this.menu.hidden = false;
      this.q(".picker").setAttribute("aria-expanded", "true");
    }

    li(className, text) {
      const li = document.createElement("li");
      if (className) li.className = className;
      if (text !== undefined) li.textContent = text;
      return li;
    }

    renderMenu() {
      const menu = this.menu;
      menu.textContent = "";
      const taken = Canvas.takenDeviceIds(tree, this.id);
      const sections = Shell.pickerSections(deviceList, platforms);
      if (sections.length === 0) menu.append(this.li("empty", "No devices found"));
      for (const s of sections) {
        const heading = this.li("group", s.label);
        heading.setAttribute("role", "presentation");
        heading.dataset.group = s.key;
        menu.append(heading);
        if (s.reason) menu.append(this.li("note", s.reason));
        for (const d of s.devices) menu.append(this.menuRow(d, taken.has(d.id)));
      }
      menu.append(document.createElement("hr"));
      if (!platforms.ios || platforms.ios.ok !== false) menu.append(this.action("New iOS simulator…", "ios"));
      if (!platforms.android || platforms.android.ok !== false) menu.append(this.action("New Android emulator…", "android"));
    }

    action(label, platform) {
      const li = this.li("action", label);
      li.dataset.new = platform;
      li.setAttribute("role", "menuitem");
      li.addEventListener("click", () => void this.renderCreate(platform));
      return li;
    }

    menuRow(d, isTaken) {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.id = d.id;
      li.setAttribute("aria-selected", String(d.id === this.device?.id));
      if (isTaken) li.setAttribute("aria-disabled", "true");
      const state = d.state === "on" ? "On" : d.state === "booting" ? "Booting" : "Off";
      for (const [cls, text] of [["name", d.name], ["meta", d.os], ["meta", isTaken ? "In another pane" : state]]) {
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = text;
        li.append(span);
      }
      li.addEventListener("click", () => {
        if (isTaken) return;
        this.closeMenu();
        this.choose(d);
      });
      return li;
    }

    choose(d) {
      if (d.id === this.device?.id) return;
      this.setDevice({ id: d.id, platform: d.platform, name: d.name });
    }

    /** The "New ..." form in the menu. */
    async renderCreate(platform) {
      const menu = this.menu;
      menu.textContent = "";
      const loading = this.li("empty", "Loading…");
      menu.append(loading);
      let options;
      try {
        options = await call("options");
      } catch (err) {
        loading.textContent = err.message;
        return;
      }
      menu.textContent = "";
      // A div, not a <form>: Band's sandbox has no allow-forms, so a form could not submit.
      const form = document.createElement("div");
      form.className = "newform";
      form.dataset.new = platform;
      const select = (label, items) => {
        const l = document.createElement("label");
        l.textContent = label;
        const s = document.createElement("select");
        for (const [value, text] of items) {
          const o = document.createElement("option");
          o.value = value;
          o.textContent = text;
          s.append(o);
        }
        l.append(s);
        form.append(l);
        return s;
      };
      const note = (text, code) => {
        const p = document.createElement("div");
        p.className = "hint";
        p.textContent = text;
        if (code) {
          p.append(document.createElement("br"));
          const c = document.createElement("code");
          c.textContent = code;
          p.append(c);
        }
        form.append(p);
      };
      const buttons = document.createElement("div");
      buttons.className = "row";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Back";
      cancel.addEventListener("click", () => {
        this.renderMenu();
      });
      const create = document.createElement("button");
      create.type = "button";
      create.className = "create";
      create.textContent = "Create";
      buttons.append(cancel, create);
      let getSpec = null;
      if (platform === "ios") {
        const ios = options.ios ?? { runtimes: [] };
        if (ios.runtimes.length === 0) {
          note(ios.error || "No iOS runtime is installed. Install one in Xcode > Settings > Components.");
          create.disabled = true;
        } else {
          const runtime = select("iOS version", ios.runtimes.map((r) => [r.id, `iOS ${r.version}`]));
          const model = select("Model", []);
          const fill = () => {
            const r = ios.runtimes.find((x) => x.id === runtime.value);
            model.textContent = "";
            const types = r ? r.deviceTypes : [];
            for (const t of types) {
              const o = document.createElement("option");
              o.value = t.id;
              o.textContent = t.name;
              model.append(o);
            }
            const best = types
              .map((t) => ({ t, m: /^iPhone (\d+) Pro$/.exec(t.name) }))
              .filter((x) => x.m)
              .sort((a, b) => Number(b.m[1]) - Number(a.m[1]))[0];
            if (best) model.value = best.t.id;
          };
          runtime.addEventListener("change", fill);
          fill();
          getSpec = () => ({ platform: "ios", runtime: runtime.value, deviceType: model.value });
        }
      } else {
        const a = options.android ?? { available: false, reason: "Android is not available", profiles: [], images: [] };
        if (a.reason || a.profiles.length === 0 || a.images.length === 0) {
          note(a.reason || "No Android device profile or system image is available.", a.hint);
          create.disabled = true;
        } else {
          const profile = select("Device", a.profiles.map((p) => [p.id, p.name]));
          const pixel = a.profiles.find((p) => /^pixel_\d+$/.test(p.id));
          if (pixel) profile.value = pixel.id;
          const image = select("System image", a.images.map((i) => [i.pkg, i.label]));
          getSpec = () => ({ platform: "android", profile: profile.value, image: image.value });
        }
      }
      form.append(buttons);
      create.addEventListener("click", async () => {
        if (!getSpec) return;
        create.disabled = true;
        cancel.disabled = true;
        create.textContent = "Creating…";
        try {
          const res = await call("create", getSpec());
          this.closeMenu();
          void refreshDevices();
          this.choose(res.device);
        } catch (err) {
          create.disabled = false;
          cancel.disabled = false;
          create.textContent = "Create";
          this.showError(err.message);
          this.closeMenu();
        }
      });
      menu.append(form);
    }
  }

  async function refreshDevices() {
    try {
      const res = await call("devices");
      deviceList = res.devices ?? [];
      platforms = res.platforms ?? {};
    } catch {
      // The picker keeps its last list.
    }
  }

  // ---- canvas -----------------------------------------------------------------------------

  function paneFor(node) {
    let p = panes.get(node.id);
    if (!p) {
      p = new Pane(node.id, node.device);
      panes.set(node.id, p);
    }
    return p;
  }

  /** Builds the DOM for a tree node. A pane keeps its element (and its stream) when the tree around it changes. */
  function build(node, path) {
    if (node.type === "pane") return paneFor(node).el;
    const el = document.createElement("div");
    el.className = "split";
    el.dataset.dir = node.dir;
    const cell = (child, sub, share) => {
      const c = document.createElement("div");
      c.className = "cell";
      c.style.flex = `${share} 1 0`;
      c.append(build(child, [...path, sub]));
      return c;
    };
    const a = cell(node.a, "a", node.ratio);
    const b = cell(node.b, "b", 1 - node.ratio);
    const divider = document.createElement("div");
    divider.className = "divider";
    divider.setAttribute("role", "separator");
    divider.setAttribute("aria-orientation", node.dir === "row" ? "vertical" : "horizontal");
    divider.tabIndex = 0;
    divider.dataset.testid = "sim-divider";
    const setRatio = (r) => {
      tree = Canvas.setRatio(tree, path, r);
      const ratio = Math.min(0.85, Math.max(0.15, r));
      a.style.flex = `${ratio} 1 0`;
      b.style.flex = `${1 - ratio} 1 0`;
      return ratio;
    };
    divider.addEventListener("pointerdown", (e) => {
      divider.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const rect = el.getBoundingClientRect();
        setRatio(node.dir === "row" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height);
      };
      const up = () => {
        divider.removeEventListener("pointermove", move);
        divider.removeEventListener("pointerup", up);
        divider.removeEventListener("pointercancel", up);
        scheduleSave();
      };
      divider.addEventListener("pointermove", move);
      divider.addEventListener("pointerup", up);
      divider.addEventListener("pointercancel", up);
    });
    divider.addEventListener("keydown", (e) => {
      const grow = node.dir === "row" ? "ArrowRight" : "ArrowDown";
      const shrink = node.dir === "row" ? "ArrowLeft" : "ArrowUp";
      if (e.key !== grow && e.key !== shrink) return;
      e.preventDefault();
      const current = Number.parseFloat(a.style.flex) || node.ratio;
      setRatio(current + (e.key === grow ? 0.03 : -0.03));
      scheduleSave();
    });
    el.append(a, divider, b);
    return el;
  }

  function render() {
    const root = $("canvas");
    const keep = document.activeElement;
    root.textContent = "";
    root.append(build(tree, []));
    const list = Canvas.panes(tree);
    const multi = list.length > 1;
    const canSplit = Canvas.canSplit(tree);
    for (const node of list) {
      const p = panes.get(node.id);
      p.el.dataset.multi = String(multi);
      p.el.dataset.focused = String(node.id === focusedId);
      p.q(".split-row").disabled = !canSplit;
      p.q(".split-column").disabled = !canSplit;
      p.q(".close").hidden = !multi;
      p.relayout();
    }
    if (keep && keep.isConnected) keep.focus({ preventScroll: true });
  }

  function focusPane(id, takeKeyboard) {
    if (!panes.has(id)) return;
    const changed = focusedId !== id;
    focusedId = id;
    for (const [pid, p] of panes) p.el.dataset.focused = String(pid === id);
    const p = panes.get(id);
    if (changed) p.send({ type: "focus" });
    if (takeKeyboard) p.canvas.focus({ preventScroll: true });
  }

  function splitPane(id, dir) {
    if (!Canvas.canSplit(tree)) return;
    const newId = Canvas.nextPaneId(tree);
    tree = Canvas.split(tree, id, dir, newId);
    panes.set(newId, new Pane(newId, null));
    render();
    focusPane(newId, false);
    scheduleSave();
    void panes.get(newId).toggleMenu();
  }

  function closePane(id) {
    if (Canvas.paneCount(tree) <= 1) return;
    const p = panes.get(id);
    p.closeStream();
    tree = Canvas.close(tree, id);
    panes.delete(id);
    if (focusedId === id) focusedId = Canvas.panes(tree)[0].id;
    render();
    focusPane(focusedId, false);
    scheduleSave();
  }

  /** Builds the panes of a stored layout and opens the stream of each one that has a device. */
  function load(layout) {
    tree = layout;
    for (const node of Canvas.panes(tree)) panes.set(node.id, new Pane(node.id, node.device));
    focusedId = (Canvas.panes(tree).find((n) => n.device) ?? Canvas.panes(tree)[0]).id;
    render();
    for (const p of panes.values()) if (p.device) p.openStream();
    focusPane(focusedId, false);
  }

  // ---- events from the service ------------------------------------------------------------

  function shownIds() {
    return Canvas.panes(tree).flatMap((n) => (n.device ? [n.device.id] : []));
  }

  function renderOffers() {
    const bar = $("offers");
    bar.textContent = "";
    const shown = new Set(shownIds());
    let count = 0;
    for (const [id, d] of offers) {
      if (shown.has(id) || dismissed.has(id)) continue;
      count++;
      const row = document.createElement("div");
      row.className = "offer";
      row.dataset.offer = id;
      row.setAttribute("role", "status");
      const text = document.createElement("span");
      text.className = "offer-text";
      text.textContent = `${d.name} started, show it?`;
      const show = document.createElement("button");
      show.type = "button";
      show.className = "offer-show";
      show.textContent = "Show";
      show.addEventListener("click", async () => {
        show.disabled = true;
        try {
          await call("show", { device: id });
          offers.delete(id);
          await pollEvents();
        } catch {
          show.disabled = false;
        }
        renderOffers();
      });
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "offer-dismiss";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => {
        dismissed.add(id);
        renderOffers();
      });
      row.append(text, show, dismiss);
      bar.append(row);
    }
    bar.hidden = count === 0;
  }

  /** An agent put a device in a pane: switch that pane (else the focused one) without touching the others. */
  function applyShow(ev) {
    const device = ev.device;
    if (!device || shownIds().includes(device.id)) return;
    const target = panes.get(ev.paneId) ?? panes.get(focusedId) ?? [...panes.values()][0];
    if (target) target.setDevice({ id: device.id, platform: device.platform, name: device.name });
  }

  function applyEvent(ev) {
    if (ev.type === "show") {
      applyShow(ev);
      offers.delete(ev.device?.id);
    } else if (ev.type === "offer") {
      if (!shownIds().includes(ev.device.id)) {
        dismissed.delete(ev.device.id);
        offers.set(ev.device.id, ev.device);
      }
    } else if (ev.type === "withdraw") {
      offers.delete(ev.id);
      dismissed.delete(ev.id);
    }
  }

  async function pollEvents() {
    if (polling || !port) return;
    polling = true;
    try {
      const res = await call("events", { since: lastSeq, focus: focusedId, shown: shownIds() });
      for (const ev of res.events ?? []) applyEvent(ev);
      lastSeq = res.seq;
      renderOffers();
    } catch {
      // The next poll tries again.
    } finally {
      polling = false;
    }
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (visible) void pollEvents();
    }, POLL_MS);
  }

  async function start() {
    // The first poll tells the service a tab is open; it comes before the layout is read, so a
    // `show` between the two is in the layout or in the events.
    await pollEvents();
    startPolling();
    let layout = null;
    try {
      layout = (await call("layout")).layout;
    } catch {
      // Start from one empty pane.
    }
    load(layout ?? Canvas.pane("p1", null));
  }

  function onMessage(m) {
    switch (m.type) {
      case "init":
        visible = m.visible !== false;
        document.body.dataset.layout = m.layout === "compact" ? "compact" : "regular";
        if (m.theme) applyTheme(m.theme);
        port.postMessage({ type: "ready" });
        void start();
        break;
      case "stream.opened":
      case "stream.message":
      case "stream.frame":
      case "stream.closed":
        byStream.get(m.id)?.onStreamMessage(m);
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
        if (visible) for (const p of panes.values()) void p.draw();
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

  // Keys go to the focused pane, from its screen or from the page itself, but not from a menu or a button.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") for (const p of panes.values()) p.closeMenu();
    const target = e.target;
    const tag = target && target.tagName;
    if (tag === "BUTTON" || tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || (target.closest && target.closest(".menu, .divider"))) return;
    panes.get(focusedId)?.key(e);
  });

  // The path is taken at dispatch, so a click on a menu row that the click itself removed still counts as inside.
  document.addEventListener("click", (e) => {
    const path = e.composedPath();
    for (const p of panes.values()) {
      if (!p.q(".error-pop").hidden && !path.includes(p.q(".error-wrap"))) p.setErrorOpen(false);
      if (!p.menu.hidden && !path.includes(p.q(".picker-wrap")) && !path.includes(p.q(".choose"))) p.closeMenu();
    }
  });
})();
