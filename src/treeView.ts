// src/treeView.ts
import * as vscode from "vscode";
import { DirectiveIndexer, Directive } from "./directiveIndexer";

type Node = FileNode | DirectiveNode;

interface FileNode {
  type: "file";
  uri: vscode.Uri;
}

interface DirectiveNode {
  type: "directive";
  uri: vscode.Uri;
  directive: Directive;
}

export class DirectiveTreeView
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private view: vscode.TreeView<Node>;
  private disposables: vscode.Disposable[] = [];

  constructor(private indexer: DirectiveIndexer, ctx: vscode.ExtensionContext) {
    // register the provider
    this.view = vscode.window.createTreeView("aiDirectives", {
      treeDataProvider: this,
    });
    ctx.subscriptions.push(this.view, this);

    // refresh when directives change
    this.disposables.push(this.indexer.onDidUpdate(() => this.refresh()));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    if (element.type === "file") {
      const item = new vscode.TreeItem(
        element.uri.fsPath,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.resourceUri = element.uri;
      return item;
    }

    // directive node
    const item = new vscode.TreeItem(
      `💡 ${element.directive.text}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.command = {
      command: "aiAssistant.fixHere", // or whatever command you want to run
      title: "Run with AI",
      arguments: [element.uri], // pass uri, you can extend with directive info
    };
    item.description = `${element.directive.range.start.line + 1}`;
    item.tooltip = `Line ${element.directive.range.start.line + 1}`;
    return item;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    // root = all files that have directives
    if (!element) {
      const files = [...(this as any).indexer["map"].keys()] as string[]; // small hack to access map
      return files.map(
        (f) => ({ type: "file", uri: vscode.Uri.file(f) } as FileNode)
      );
    }

    // file node → list directives
    if (element.type === "file") {
      const ds = (this as any).indexer["map"].get(element.uri.fsPath) as
        | Directive[]
        | undefined;
      if (!ds) return [];
      return ds.map(
        (d) =>
          ({
            type: "directive",
            uri: element.uri,
            directive: d,
          } as DirectiveNode)
      );
    }

    // directive node → no children
    return [];
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
