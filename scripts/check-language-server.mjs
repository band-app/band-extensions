// Checks a language server extension's manifest against what it ships, so a renamed script in an
// npm package fails here and not on a user's worker.
//   node scripts/check-language-server.mjs <extension folder>
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const manifest = JSON.parse(readFileSync(join(root, "band-extension.json"), "utf8"));
const servers = manifest.contributes?.languageServers ?? [];
if (servers.length === 0) throw new Error("the manifest has no languageServers");
for (const server of servers) {
  for (const key of ["id", "command", "languages", "files"]) {
    if (!server[key] || server[key].length === 0) throw new Error(`${server.id}: ${key} is empty`);
  }
  if (!/\.(?:m?js|cjs)$/.test(server.command)) throw new Error(`${server.id}: command must be a script`);
  if (server.command.startsWith("/") || server.command.split("/").includes("..")) {
    throw new Error(`${server.id}: command must stay inside the folder`);
  }
  const script = join(root, "node_modules", ...server.command.split("/").slice(1));
  if (!existsSync(script)) throw new Error(`${server.id}: ${script} does not exist: run npm ci`);
}
console.log(`ok: ${servers.map((s) => s.id).join(", ")}`);
