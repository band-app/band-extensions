// Builds extensions/python-lsp/dist/web: Pyright, which bundles its own dependencies.
//   node build.mjs
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLanguageServer } from "../../scripts/build-language-server.mjs";

buildLanguageServer(dirname(fileURLToPath(import.meta.url)), { pyright: "all" });
