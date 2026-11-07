import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { initializeServer } from "../../../scripts/language-server-smoke.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "band-extension.json"), "utf8"));
const [server] = manifest.contributes.languageServers;

describe("python-lsp", () => {
  it("serves Python files in a project", () => {
    assert.deepEqual(server.languages, ["python"]);
    assert.deepEqual(server.files, ["*.py", "*.pyi"]);
    assert.deepEqual(server.rootMarkers, ["pyproject.toml", "setup.py", "requirements.txt", ".git"]);
    assert.deepEqual(server.requires, ["node"]);
  });

  it("answers initialize from the built folder", async () => {
    const result = await initializeServer({
      dist: join(root, "dist", "web"),
      server,
      projectFiles: { "pyproject.toml": "", "a.py": "a = 1\n" },
    });
    assert.ok(result.capabilities.hoverProvider, "hover");
    assert.ok(result.capabilities.definitionProvider, "go to definition");
  });
});
