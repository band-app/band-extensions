import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { initializeServer } from "../../../scripts/language-server-smoke.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "band-extension.json"), "utf8"));
const [server] = manifest.contributes.languageServers;

describe("typescript-lsp", () => {
  it("serves the TypeScript and JavaScript family", () => {
    assert.deepEqual(server.languages, ["typescript", "typescriptreact", "javascript", "javascriptreact"]);
    assert.ok(server.files.includes("*.ts") && server.files.includes("*.jsx"));
    assert.deepEqual(server.rootMarkers, ["package.json", "tsconfig.json", "jsconfig.json"]);
    assert.deepEqual(server.requires, ["node"]);
  });

  it("answers initialize from the built folder", async () => {
    const result = await initializeServer({
      dist: join(root, "dist", "web"),
      server,
      projectFiles: { "tsconfig.json": "{}", "a.ts": "export const a = 1;\n" },
    });
    assert.ok(result.capabilities.hoverProvider, "hover");
    assert.ok(result.capabilities.definitionProvider, "go to definition");
  });
});
