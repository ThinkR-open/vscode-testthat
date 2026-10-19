import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { execFile } from "child_process";

const TEST_RE = /\btest_that\(\s*(["'])((?:\\.|(?!\1).)*)\1/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Test Explorer integration: one item per tests/testthat/test-*.R, one child per test_that(). */
export function registerTesting(ctx: vscode.ExtensionContext, root: vscode.Uri): void {
  const ctrl = vscode.tests.createTestController("testthat", "testthat");
  const dir = vscode.Uri.joinPath(root, "tests", "testthat");
  const isTestFile = (uri: vscode.Uri) => path.dirname(uri.fsPath) === dir.fsPath && /^test-.*\.R$/.test(path.basename(uri.fsPath));

  const fileItem = (uri: vscode.Uri): vscode.TestItem => {
    const id = path.basename(uri.fsPath);
    let item = ctrl.items.get(id);
    if (!item) {
      item = ctrl.createTestItem(id, id, uri);
      item.canResolveChildren = true;
      ctrl.items.add(item);
    }
    return item;
  };

  async function parse(item: vscode.TestItem, text?: string): Promise<void> {
    if (text === undefined) {
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(item.uri!)).toString("utf8");
      } catch {
        return;
      }
    }
    const children: vscode.TestItem[] = [];
    let line = 0;
    let from = 0;
    for (const m of text.matchAll(TEST_RE)) {
      line += (text.slice(from, m.index).match(/\n/g) ?? []).length;
      from = m.index!;
      const child = ctrl.createTestItem(`${item.id}::${m[2]}`, m[2], item.uri);
      child.range = new vscode.Range(line, 0, line, 0);
      children.push(child);
    }
    item.children.replace(children);
    item.canResolveChildren = false;
  }

  async function discover(): Promise<void> {
    let entries: [string, vscode.FileType][] = [];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    const names = entries.filter(([n, t]) => t === vscode.FileType.File && /^test-.*\.R$/.test(n)).map(([n]) => n);
    ctrl.items.forEach((i) => names.includes(i.id) || ctrl.items.delete(i.id));
    names.forEach((n) => fileItem(vscode.Uri.joinPath(dir, n)));
  }

  ctrl.resolveHandler = (item) => (item ? parse(item) : discover());

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, "test-*.R"));
  watcher.onDidCreate((u) => parse(fileItem(u)));
  watcher.onDidChange((u) => parse(fileItem(u)));
  watcher.onDidDelete((u) => ctrl.items.delete(path.basename(u.fsPath)));
  ctx.subscriptions.push(
    ctrl,
    watcher,
    vscode.workspace.onDidChangeTextDocument((e) => isTestFile(e.document.uri) && parse(fileItem(e.document.uri), e.document.getText()))
  );

  ctrl.createRunProfile("Run", vscode.TestRunProfileKind.Run, (request, token) => runTests(request, token), true);

  async function runTests(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    const run = ctrl.createTestRun(request);
    const include = request.include ?? [...collect(ctrl.items)];
    for (const i of include) {
      if (i.canResolveChildren) await parse(i);
      run.enqueued(i);
      i.children.forEach((c) => run.enqueued(c));
    }

    // Whole files go through test_local(filter = ), single tests through test_file(desc = ).
    const opts = `reporter = "summary", stop_on_failure = FALSE, stop_on_warning = FALSE`;
    const whole = include.filter((i) => !i.parent).map((i) => i.id.replace(/^test-/, "").replace(/\.R$/, ""));
    const calls = include
      .filter((i) => i.parent)
      .map((i) => `testthat::test_file(${JSON.stringify(`tests/testthat/${i.parent!.id}`)}, desc = ${JSON.stringify(i.label)}, package = pkgload::pkg_name("."), load_package = "source", ${opts})`);
    if (whole.length) calls.push(`testthat::test_local(".", filter = ${JSON.stringify(`^(${whole.map(escapeRe).join("|")})$`)}, ${opts})`);

    const out = path.join(os.tmpdir(), `testthat-${Date.now()}.tsv`);
    const code = `
Sys.setenv(NOT_CRAN = "true")
res <- structure(c(${calls.join(", ")}), class = "testthat_results")
df <- as.data.frame(res)
msg <- vapply(res, function(t) {
  bad <- Filter(function(e) inherits(e, c("expectation_failure", "expectation_error")), t$results)
  URLencode(paste(vapply(bad, function(e) e$message, ""), collapse = "\\n\\n"), reserved = TRUE)
}, "")
status <- ifelse(df$error, "error", ifelse(df$failed > 0, "failed", ifelse(df$skipped, "skipped", "passed")))
write.table(data.frame(df$file, URLencode(df$test, reserved = TRUE), status, msg, df$real), ${JSON.stringify(out)}, sep = "\\t", row.names = FALSE, col.names = FALSE, quote = FALSE)
`;
    const { output, failed } = await new Promise<{ output: string; failed: boolean }>((resolve) => {
      const child = execFile("Rscript", ["-e", code], { cwd: root.fsPath, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
        resolve({ output: stdout + stderr, failed: !!err })
      );
      token.onCancellationRequested(() => child.kill());
    });
    run.appendOutput(output.replace(/\r?\n/g, "\r\n"));

    let rows: string[] = [];
    try {
      rows = fs.readFileSync(out, "utf8").split("\n").filter(Boolean);
      fs.unlinkSync(out);
    } catch {
      /* no results file: everything errored below */
    }
    if (failed && rows.length === 0) {
      include.forEach((i) => run.errored(i, new vscode.TestMessage(output.trim().split("\n").slice(-20).join("\n"))));
    }
    for (const row of rows) {
      const [file, rawTest, status, rawMsg, time] = row.split("\t");
      const test = decodeURIComponent(rawTest);
      const parent = ctrl.items.get(file);
      if (!parent) continue;
      let item = parent.children.get(`${file}::${test}`);
      if (!item) {
        item = ctrl.createTestItem(`${file}::${test}`, test, parent.uri);
        parent.children.add(item);
      }
      const ms = Number(time) * 1000;
      if (status === "passed") run.passed(item, ms);
      else if (status === "skipped") run.skipped(item);
      else if (status === "failed") run.failed(item, new vscode.TestMessage(decodeURIComponent(rawMsg)), ms);
      else run.errored(item, new vscode.TestMessage(decodeURIComponent(rawMsg)), ms);
    }
    run.end();
  }
}

function* collect(items: vscode.TestItemCollection): Generator<vscode.TestItem> {
  const all: vscode.TestItem[] = [];
  items.forEach((i) => all.push(i));
  yield* all;
}
