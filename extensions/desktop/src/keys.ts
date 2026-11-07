// X11 keysyms for the keys a tool can name.

const NAMED: Record<string, number> = {
  backspace: 0xff08,
  tab: 0xff09,
  enter: 0xff0d,
  return: 0xff0d,
  escape: 0xff1b,
  esc: 0xff1b,
  delete: 0xffff,
  del: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  pageup: 0xff55,
  page_up: 0xff55,
  pagedown: 0xff56,
  page_down: 0xff56,
  end: 0xff57,
  space: 0x20,
  menu: 0xff67,
};
for (let i = 1; i <= 12; i++) NAMED[`f${i}`] = 0xffbd + i;

const MODIFIERS: Record<string, number> = {
  shift: 0xffe1,
  ctrl: 0xffe3,
  control: 0xffe3,
  alt: 0xffe9,
  option: 0xffe9,
  super: 0xffeb,
  meta: 0xffeb,
  cmd: 0xffeb,
  win: 0xffeb,
};

/** The keysym of one character. Latin-1 characters are their own keysym; others use the Unicode range. */
export function keysymOfChar(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (ch === "\n" || ch === "\r") return NAMED.enter as number;
  if (ch === "\t") return NAMED.tab as number;
  if (cp >= 0x20 && cp < 0x7f) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  return 0x01000000 + cp;
}

/**
 * `ctrl+shift+t` to the keysyms to press in order: the modifiers, then the key. A single character
 * is typed as it is. Throws on a name it does not know.
 */
export function parseKeys(spec: string): { modifiers: number[]; key: number } {
  const parts = spec.split("+").map((p) => p.trim());
  if (parts.some((p) => p === "")) {
    // "+" alone is the plus key.
    if (spec.trim() === "+") return { modifiers: [], key: 0x2b };
    throw new Error(`"${spec}" is not a key or a combination such as ctrl+l`);
  }
  const last = parts.pop() as string;
  const modifiers = parts.map((p) => {
    const sym = MODIFIERS[p.toLowerCase()];
    if (sym === undefined) throw new Error(`"${p}" is not a modifier (shift, ctrl, alt, super)`);
    return sym;
  });
  const named = NAMED[last.toLowerCase()] ?? MODIFIERS[last.toLowerCase()];
  if (named !== undefined) return { modifiers, key: named };
  if ([...last].length === 1) return { modifiers, key: keysymOfChar(last) };
  throw new Error(`"${last}" is not a key name Desktop knows (Enter, Tab, Escape, Up, F5, a single character)`);
}
