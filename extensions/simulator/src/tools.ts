import { execFile } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** "300 ms" or "60 s". */
export const span = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

/** The error `run` rejects with when the binary did not finish in time. */
export class CallTimeout extends Error {
  readonly call: string;
  readonly timeoutMs: number;
  constructor(call: string, timeoutMs: number) {
    super(`${call} did not finish in ${span(timeoutMs)} and was stopped`);
    this.call = call;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Runs a binary and rejects with its stderr (or the spawn error) when it fails. A call that runs
 * past `timeoutMs` is killed by its pid with SIGKILL and rejects at once with a `CallTimeout`,
 * without waiting for the process to exit: a hung `simctl` can ignore SIGTERM and never close.
 */
export function run(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv; stdin?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const label = `${bin} ${args.slice(0, 3).join(" ")}`;
    const timeoutMs = options.timeoutMs ?? 120_000;
    let settled = false;
    const child = execFile(
      bin,
      args,
      { maxBuffer: 16 * 1024 * 1024, env: options.env ?? process.env },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (err) {
          const detail = String(stderr || stdout || err.message).trim();
          reject(new Error(`${label}: ${detail}`));
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child.pid !== undefined) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // It exited in the meantime.
        }
      }
      reject(new CallTimeout(label, timeoutMs));
    }, timeoutMs);
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

/** Runs a binary and resolves with its raw stdout, for output that is not text (a PNG). */
export function runBuffer(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 64 * 1024 * 1024,
        env: options.env ?? process.env,
        encoding: "buffer",
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr?.toString() || err.message).trim();
          reject(new Error(`${bin} ${args.slice(0, 3).join(" ")}: ${detail}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
