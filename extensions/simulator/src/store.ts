import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getStateDir } from "./config.ts";
import { deviceIds, type LayoutNode, sanitizeLayout } from "./layout.ts";

interface Saved {
  worktrees: Record<string, LayoutNode>;
  repos: Record<string, LayoutNode>;
}

/**
 * The canvas layouts, kept in `layouts.json` in the state dir. Each worktree has its own. The
 * last layout saved by any worktree of a repo is also the repo's, which a worktree that never
 * opened the tab starts from.
 */
export class LayoutStore {
  private data: Saved | null = null;
  private loading: Promise<Saved> | null = null;
  private readonly repoKeys = new Map<string, Promise<string>>();
  private writing: Promise<unknown> = Promise.resolve();

  private load(): Promise<Saved> {
    if (this.data) return Promise.resolve(this.data);
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<Saved> {
    const out: Saved = { worktrees: {}, repos: {} };
    try {
      const parsed = JSON.parse(await readFile(join(getStateDir(), "layouts.json"), "utf8")) as Partial<Saved>;
      for (const part of ["worktrees", "repos"] as const) {
        for (const [k, v] of Object.entries(parsed[part] ?? {})) {
          const layout = sanitizeLayout(v);
          if (layout) out[part][k] = layout;
        }
      }
    } catch {
      // No file yet, or no state dir (tests): nothing is saved.
    }
    this.data = out;
    return out;
  }

  private persist(): void {
    this.writing = this.writing.then(async () => {
      try {
        const dir = getStateDir();
        await mkdir(dir, { recursive: true });
        const file = join(dir, "layouts.json");
        await writeFile(`${file}.tmp`, JSON.stringify(this.data));
        await rename(`${file}.tmp`, file);
      } catch {
        // The layout then lasts until the service restarts.
      }
    });
  }

  /** Worktrees of one repository share its git common dir. A folder outside git is its own repo. */
  private repoKey(worktreePath: string): Promise<string> {
    let key = this.repoKeys.get(worktreePath);
    if (!key) {
      key = new Promise<string>((done) => {
        execFile(
          "git",
          ["-C", worktreePath, "rev-parse", "--git-common-dir"],
          { timeout: 5000 },
          async (err, stdout) => {
            const raw = String(stdout).trim();
            if (err || raw === "") return done(await realpath(worktreePath).catch(() => resolve(worktreePath)));
            const abs = resolve(worktreePath, raw);
            done(await realpath(abs).catch(() => abs));
          },
        );
      });
      this.repoKeys.set(worktreePath, key);
    }
    return key;
  }

  /** The worktree's own layout, else its repo's, else null (the panel then shows one empty pane). */
  async get(worktreeKey: string, worktreePath: string): Promise<{ layout: LayoutNode | null; from: "worktree" | "repo" | null }> {
    const data = await this.load();
    const own = data.worktrees[worktreeKey];
    if (own) return { layout: own, from: "worktree" };
    const repo = data.repos[await this.repoKey(worktreePath)];
    return repo ? { layout: repo, from: "repo" } : { layout: null, from: null };
  }

  /** The worktree's own layout only. */
  async own(worktreeKey: string): Promise<LayoutNode | null> {
    return (await this.load()).worktrees[worktreeKey] ?? null;
  }

  async save(worktreeKey: string, worktreePath: string, raw: unknown): Promise<LayoutNode> {
    const layout = sanitizeLayout(raw);
    if (!layout) throw new Error("layout is not a valid canvas of at most 4 panes");
    const data = await this.load();
    data.worktrees[worktreeKey] = layout;
    data.repos[await this.repoKey(worktreePath)] = layout;
    this.persist();
    return layout;
  }

  /** Forgets a removed worktree's layout. The repo's stays. */
  async forget(worktreeKey: string): Promise<void> {
    const data = await this.load();
    if (delete data.worktrees[worktreeKey]) this.persist();
  }

  /** Every device id any saved layout shows. The orphan sweep must never delete one of these. */
  async savedDeviceIds(): Promise<Set<string>> {
    const data = await this.load();
    const ids = new Set<string>();
    for (const layout of [...Object.values(data.worktrees), ...Object.values(data.repos)]) {
      for (const id of deviceIds(layout)) ids.add(id);
    }
    return ids;
  }

  /** For tests. */
  async flush(): Promise<void> {
    await this.writing;
  }
}
