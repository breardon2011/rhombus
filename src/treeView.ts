import * as vscode from "vscode";
import { PromptStore } from "./promptStore";

export class PromptTreeView {
  private tree: vscode.TreeView<vscode.TreeItem>;
  constructor(private store: PromptStore) {
    this.tree = vscode.window.createTreeView("aiGuidance.prompts", {
      treeDataProvider: {
        getChildren: (el?: vscode.TreeItem) => this.getChildren(el),
        getTreeItem: (e) => e,
      },
    });
  }
  private getChildren(el?: vscode.TreeItem) {
    if (!el) {
      // root = list of files
      return [...this.store["map"].keys()].map(
        (k) => new vscode.TreeItem(k, vscode.TreeItemCollapsibleState.Collapsed)
      );
    }
    if (el.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
      const uri = vscode.Uri.parse(el.label as string);
      return this.store.listByFile(uri).map((p) => {
        const item = new vscode.TreeItem(p.prompt);
        item.command = {
          command: "aiGuidance.runPrompt",
          title: "",
          arguments: [uri, p.id],
        };
        return item;
      });
    }
    return [];
  }
}
