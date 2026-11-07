# python-lsp

A language server for Python files in Band's code viewer: completions, hover, diagnostics and go to definition. It ships [Pyright](https://github.com/microsoft/pyright) 1.1.414, which is JavaScript, so one archive runs on every platform.

Band bundles no language server. Install this one from Settings > Extensions. It needs Band 0.64.0 or later (`minBand`).

| | |
|---|---|
| Files | `*.py *.pyi` |
| Starts when | the worktree root has `pyproject.toml`, `setup.py`, `requirements.txt` or `.git` |
| Needs | `node` on the worker's PATH (reported as "needs node" when missing) |
| Runs on | workers with standard or admin trust. A restricted worker and the hub's own machine run none. |

Pyright finds the Python environment from the worker's PATH, so activate a virtualenv before starting the worker if the project needs one.

## Build

```sh
cd extensions/python-lsp
npm ci --ignore-scripts
npm run build        # copies pyright into dist/web/node_modules
npm run typecheck    # the manifest's command exists in what is shipped
npm test             # starts the built server and checks it answers initialize
```

`scripts/package.sh python-lsp` packs `dist/python-lsp-<version>.tar.gz`.
