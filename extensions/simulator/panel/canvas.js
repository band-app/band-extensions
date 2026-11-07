// Pure helpers of the Simulator tab's canvas: the split tree and its edits. No DOM here, so
// test/pure.test.mjs can run this file in a plain VM context. The service validates the same tree
// before it stores it (src/layout.ts).
(() => {
  "use strict";

  /** The panel streams at most this many screens at once. */
  const MAX_PANES = 4;

  const pane = (id, device) => ({ type: "pane", id, device: device ?? null });

  function panes(node) {
    return node.type === "pane" ? [node] : [...panes(node.a), ...panes(node.b)];
  }

  function paneCount(node) {
    return panes(node).length;
  }

  /** A pane id not used in the tree: p1, p2, ... */
  function nextPaneId(tree) {
    const used = new Set(panes(tree).map((p) => p.id));
    for (let n = 1; ; n++) if (!used.has(`p${n}`)) return `p${n}`;
  }

  function canSplit(tree) {
    return paneCount(tree) < MAX_PANES;
  }

  /** The tree with pane `id` replaced by `fn(pane)`. */
  function mapPane(node, id, fn) {
    if (node.type === "pane") return node.id === id ? fn(node) : node;
    return { ...node, a: mapPane(node.a, id, fn), b: mapPane(node.b, id, fn) };
  }

  /**
   * Splits pane `id` in two: the pane stays first, an empty pane `newId` comes second. "row"
   * puts them side by side, "column" stacks them. Returns the tree unchanged at the pane limit.
   */
  function split(tree, id, dir, newId) {
    if (!canSplit(tree)) return tree;
    return mapPane(tree, id, (p) => ({ type: "split", dir, ratio: 0.5, a: p, b: pane(newId, null) }));
  }

  /** The tree without pane `id`; its sibling takes the space. The last pane cannot be closed. */
  function close(tree, id) {
    if (tree.type === "pane") return tree;
    if (tree.a.type === "pane" && tree.a.id === id) return tree.b;
    if (tree.b.type === "pane" && tree.b.id === id) return tree.a;
    return { ...tree, a: close(tree.a, id), b: close(tree.b, id) };
  }

  function setDevice(tree, id, device) {
    return mapPane(tree, id, (p) => ({ ...p, device: device ?? null }));
  }

  /** The tree with the split at `path` ("a" and "b" steps from the root) given a new ratio. */
  function setRatio(tree, path, ratio) {
    const r = Math.min(0.85, Math.max(0.15, ratio));
    if (path.length === 0) return tree.type === "split" ? { ...tree, ratio: r } : tree;
    if (tree.type !== "split") return tree;
    const [step, ...rest] = path;
    return { ...tree, [step]: setRatio(tree[step], rest, ratio) };
  }

  /** The device a pane shows in another pane, so the picker can mark it taken. */
  function takenDeviceIds(tree, exceptPaneId) {
    return new Set(panes(tree).filter((p) => p.id !== exceptPaneId && p.device).map((p) => p.device.id));
  }

  /** What the service stores: panes and splits only. */
  function toSaved(tree) {
    if (tree.type === "pane") {
      return { type: "pane", id: tree.id, device: tree.device ? { id: tree.device.id, platform: tree.device.platform, name: tree.device.name } : null };
    }
    return { type: "split", dir: tree.dir, ratio: tree.ratio, a: toSaved(tree.a), b: toSaved(tree.b) };
  }

  const api = { MAX_PANES, pane, panes, paneCount, nextPaneId, canSplit, split, close, setDevice, setRatio, takenDeviceIds, toSaved };
  if (typeof globalThis !== "undefined") globalThis.BandSimCanvas = api;
})();
