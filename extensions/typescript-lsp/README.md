# typescript-lsp

A language server for TypeScript and JavaScript files in Band's code viewer: completions, hover, diagnostics and go to definition. It ships [typescript-language-server](https://github.com/typescript-language-server/typescript-language-server) 5.1.3 and TypeScript 5.9.3 as plain JavaScript, so one archive runs on every platform.

Band bundles no language server. Install this one from Settings > Extensions. It needs Band 0.64.0 or later (`minBand`).

| | |
|---|---|
| Files | `*.ts *.tsx *.mts *.cts *.js *.jsx *.mjs *.cjs` |
| Starts when | the worktree root has `package.json`, `tsconfig.json` or `jsconfig.json` |
| Needs | `node` on the worker's PATH (reported as "needs node" when missing) |
| Runs on | workers with standard or admin trust. A restricted worker and the hub's own machine run none. |

A project's own `typescript` in `node_modules` wins over the bundled one.

## Build

```sh
cd extensions/typescript-lsp
npm ci --ignore-scripts
npm run build        # copies the two packages into dist/web/node_modules
npm run typecheck    # the manifest's command exists in what is shipped
npm test             # starts the built server and checks it answers initialize
```

`scripts/package.sh typescript-lsp` packs `dist/typescript-lsp-<version>.tar.gz`. To update a package, change the pin in `package.json` and `npm install`, which rewrites `package-lock.json`.
