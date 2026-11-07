// Builds extensions/typescript-lsp/dist/web: typescript-language-server and the typescript it drives.
//   node build.mjs
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLanguageServer } from "../../scripts/build-language-server.mjs";

buildLanguageServer(dirname(fileURLToPath(import.meta.url)), {
  "typescript-language-server": ["package.json", "LICENSE", "lib"],
  typescript: "all",
});
