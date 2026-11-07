/**
 * The Simulator tab's canvas: a binary tree of splits whose leaves are panes. The panel draws it
 * and the service stores it, so a worktree reopens with the same splits and devices.
 */
export type Platform = "ios" | "android";

/** A device a pane shows. `id` is "ios:<udid>", "android:avd:<name>" or "android:serial:<serial>". */
export interface DeviceRef {
  id: string;
  platform: Platform;
  name: string;
}

export interface PaneNode {
  type: "pane";
  id: string;
  device: DeviceRef | null;
}

export interface SplitNode {
  type: "split";
  /** "row" puts the panes side by side, "column" stacks them. */
  dir: "row" | "column";
  /** The share of the first child, between 0.15 and 0.85. */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}

export type LayoutNode = PaneNode | SplitNode;

/** The panel streams at most this many screens at once. */
export const MAX_PANES = 4;

const ID_RE = /^(ios:[A-Za-z0-9-]+|android:(avd|serial):[A-Za-z0-9._:\-]+)$/;

export function emptyLayout(): PaneNode {
  return { type: "pane", id: "p1", device: null };
}

export function paneCount(node: LayoutNode): number {
  return node.type === "pane" ? 1 : paneCount(node.a) + paneCount(node.b);
}

export function panes(node: LayoutNode): PaneNode[] {
  return node.type === "pane" ? [node] : [...panes(node.a), ...panes(node.b)];
}

export function deviceIds(node: LayoutNode): string[] {
  return panes(node).flatMap((p) => (p.device ? [p.device.id] : []));
}

function cleanDevice(raw: unknown): DeviceRef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, platform, name } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !ID_RE.test(id) || id.length > 200) return null;
  if (platform !== "ios" && platform !== "android") return null;
  if (!id.startsWith(`${platform}:`)) return null;
  if (typeof name !== "string" || name === "" || name.length > 200) return null;
  return { id, platform, name };
}

/**
 * A layout from untrusted input, or null when it is not one. Rejects more than `MAX_PANES` panes,
 * a tree deeper than the panes could need, and a device shown in two panes.
 */
export function sanitizeLayout(raw: unknown): LayoutNode | null {
  let count = 0;
  const seenPanes = new Set<string>();
  const seenDevices = new Set<string>();
  const visit = (node: unknown, depth: number): LayoutNode | null => {
    if (depth > MAX_PANES || typeof node !== "object" || node === null) return null;
    const n = node as Record<string, unknown>;
    if (n.type === "pane") {
      if (++count > MAX_PANES) return null;
      if (typeof n.id !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(n.id) || seenPanes.has(n.id)) return null;
      seenPanes.add(n.id);
      const device = n.device === null || n.device === undefined ? null : cleanDevice(n.device);
      if (n.device !== null && n.device !== undefined && !device) return null;
      if (device) {
        if (seenDevices.has(device.id)) return null;
        seenDevices.add(device.id);
      }
      return { type: "pane", id: n.id, device };
    }
    if (n.type === "split") {
      if (n.dir !== "row" && n.dir !== "column") return null;
      const ratio = typeof n.ratio === "number" && Number.isFinite(n.ratio) ? n.ratio : 0.5;
      const a = visit(n.a, depth + 1);
      const b = a ? visit(n.b, depth + 1) : null;
      if (!a || !b) return null;
      return { type: "split", dir: n.dir, ratio: Math.min(0.85, Math.max(0.15, ratio)), a, b };
    }
    return null;
  };
  return visit(raw, 0);
}
