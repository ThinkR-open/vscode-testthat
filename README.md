# testthat for VS Code

Shows every `tests/testthat/test-*.R` file and its `test_that()` blocks in VS Code's Testing view, with run buttons in
the gutter and results inline.

Runs happen in a separate `Rscript` process started from the project root, so an `renv` project uses its own library.
A file runs through `testthat::test_local(".", filter = ...)`, a single test through `testthat::test_file(path, desc = ...)`.

Requirements: R on the `PATH` as `Rscript`, plus `testthat` (>= 3.2.0) and `pkgload`. No debug profile.

Activates when the workspace contains `tests/testthat/*.R`.

## Installation

Not on the Marketplace yet. Build the VSIX from source and install it:

```
git clone https://github.com/ThinkR-open/vscode-testthat
cd vscode-testthat
npm install
npx @vscode/vsce package
code --install-extension testthat-0.1.0.vsix
```

## Development

```
npm install
npm run compile
```

Then `F5` to launch an Extension Development Host and open an R package in it.
