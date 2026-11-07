// Starts a built language server the way a worker does (its script under node, in a project
// folder) and checks that it answers `initialize`. Used by the extensions' tests.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Resolves with the server's `initialize` result. `dist` is the built extension folder. */
export async function initializeServer({ dist, server, projectFiles }) {
  const project = mkdtempSync(join(tmpdir(), "band-lsp-smoke-"));
  try {
    for (const [name, text] of Object.entries(projectFiles)) {
      mkdirSync(join(project, name, ".."), { recursive: true });
      writeFileSync(join(project, name), text);
    }
    const child = spawn(process.execPath, [join(dist, server.command), ...server.args], {
      cwd: project,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { processId: null, rootUri: `file://${project}`, capabilities: {} },
      });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`);
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no answer to initialize in 30 s")), 30_000);
        let buffer = Buffer.alloc(0);
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`the server exited with ${code} before it answered`)));
        child.stdout.on("data", (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          // The server may send notifications first. Read frames until the response to id 1.
          for (;;) {
            const sep = buffer.indexOf("\r\n\r\n");
            if (sep === -1) return;
            const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, sep).toString())?.[1]);
            if (buffer.length < sep + 4 + length) return;
            const message = JSON.parse(buffer.subarray(sep + 4, sep + 4 + length).toString("utf8"));
            buffer = buffer.subarray(sep + 4 + length);
            if (message.id !== 1) continue;
            clearTimeout(timer);
            if (message.result === undefined) reject(new Error(`initialize failed: ${JSON.stringify(message)}`));
            else resolve(message.result);
            return;
          }
        });
      });
    } finally {
      child.kill();
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}
