// Pure helpers of the Simulator panel: the phone shell's geometry, the theme tokens and the
// picker's groups. No DOM here, so test/pure.test.mjs can run this file in a plain VM context.
(() => {
  "use strict";

  /** Screen size used before a frame arrives (an iPhone in portrait, in points). */
  const DEFAULT_SCREEN = { width: 402, height: 874 };

  /**
   * The shell around a screen of `screen.width` x `screen.height` that fits in `avail`. All sizes
   * are CSS pixels. With `framed` false the screen fills the space and has a small radius.
   * The bezel and the corner radius scale with the screen's short side; a tall, narrow screen
   * (aspect 1.9 or more, an iPhone with a notch or island) has big round corners and an iPad or
   * an older iPhone has small ones. Landscape swaps the screen's width and height, so the same
   * rules apply.
   */
  function layout(avail, screen, framed, platform) {
    const sw = screen && screen.width > 0 ? screen.width : DEFAULT_SCREEN.width;
    const sh = screen && screen.height > 0 ? screen.height : DEFAULT_SCREEN.height;
    const short = Math.min(sw, sh);
    const aspect = Math.max(sw, sh) / short;
    // Per unit of the screen's short side. An Android phone has a thinner bezel and less round corners.
    const android = platform === "android";
    const bezelUnit = framed ? (android ? 0.03 : 0.04) : 0;
    const buttonUnit = framed ? 0.012 : 0;
    const radiusUnit = framed ? (aspect >= 1.9 ? (android ? 0.085 : 0.135) : 0.06) : 0;
    const padX = 2 * bezelUnit * short + 2 * buttonUnit * short;
    const padY = 2 * bezelUnit * short;
    // Plain mode keeps room for the 1px border only.
    const margin = framed ? 0 : 2;
    const scale = Math.max(
      0,
      Math.min((avail.width - margin) / (sw + padX), (avail.height - margin) / (sh + padY)),
    );
    const px = (u) => u * short * scale;
    const screenW = Math.max(1, Math.floor(sw * scale));
    const screenH = Math.max(1, Math.floor(sh * scale));
    const bezel = Math.round(px(bezelUnit));
    const button = Math.round(px(buttonUnit));
    return {
      framed,
      platform: android ? "android" : "ios",
      screen: { width: screenW, height: screenH },
      bezel,
      button,
      shell: { width: screenW + 2 * bezel, height: screenH + 2 * bezel },
      screenRadius: framed ? Math.round(px(radiusUnit)) : 6,
      shellRadius: framed ? Math.round(px(radiusUnit)) + bezel : 0,
    };
  }

  /** The text under the spinner. `info` is the service's {"type":"booting", phase?, name?, model?}. */
  function bootText(info) {
    if (info && (info.phase === "creating" || info.phase === "cloning")) return "Creating device…";
    const what = info && (info.model || info.name);
    return what ? `Booting ${what}…` : "Booting…";
  }

  /** The panel's CSS variables, from the tokens Band sends. A missing token leaves the fallback. */
  const TOKEN_VARS = {
    "--bg": ["background"],
    "--fg": ["foreground"],
    "--muted": ["muted-foreground"],
    "--border": ["border"],
    "--accent": ["accent", "muted"],
    "--accent-fg": ["accent-foreground"],
  };

  function readToken(tokens, name) {
    for (const key of [name, `--${name}`, `--color-${name}`]) {
      const v = tokens[key];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return null;
  }

  /** {vars, scheme}: the CSS variables to set and the color-scheme, or nulls when Band sent none. */
  function themeVars(theme) {
    const tokens = theme && typeof theme.tokens === "object" && theme.tokens ? theme.tokens : {};
    const vars = {};
    for (const [cssVar, names] of Object.entries(TOKEN_VARS)) {
      for (const name of names) {
        const v = readToken(tokens, name);
        if (v) {
          vars[cssVar] = v;
          break;
        }
      }
    }
    const scheme = theme && (theme.mode === "light" || theme.mode === "dark") ? theme.mode : null;
    return { vars, scheme };
  }

  const SECTIONS = [
    ["ios", "iOS simulators"],
    ["android", "Android emulators"],
  ];

  /**
   * The picker's sections: one per platform, in order, each with its devices sorted by name and a
   * `reason` when the platform cannot run on this worker. `platforms` is the service's
   * {ios: {ok, reason}, android: {ok, reason}}. A section with neither devices nor a reason is left out.
   */
  function pickerSections(devices, platforms) {
    const out = [];
    for (const [key, label] of SECTIONS) {
      const items = devices.filter((d) => d.platform === key).sort((a, b) => a.name.localeCompare(b.name));
      const status = platforms && platforms[key];
      const reason = status && status.ok === false ? status.reason || "Not available" : null;
      if (items.length || reason) out.push({ key, label, devices: items, reason });
    }
    return out;
  }

  const themeVarNames = Object.keys(TOKEN_VARS);
  const api = { DEFAULT_SCREEN, layout, bootText, themeVars, themeVarNames, pickerSections };
  if (typeof globalThis !== "undefined") globalThis.BandSimShell = api;
})();
