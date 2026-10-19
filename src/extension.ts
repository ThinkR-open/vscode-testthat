import * as vscode from "vscode";
import { registerTesting } from "./testing";

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, "tests", "testthat"));
    } catch {
      continue;
    }
    registerTesting(ctx, folder.uri);
    return;
  }
}

export function deactivate(): void {}
