import * as vscode from "vscode";

type Anchor = { id: string; prompt: string; range: vscode.Range };
export class PromptStore {
  private map = new Map<string, Anchor[]>(); // key = uri.toString()

  registerAnchor(uri: vscode.Uri, id: string, prompt: string, line: number) {
    const list = this.map.get(uri.toString()) ?? [];
    const range = new vscode.Range(line + 1, 0, line + 1, 0);
    const existing = list.find((a) => a.id === id);
    if (existing) existing.prompt = prompt;
    else list.push({ id, prompt, range });
    this.map.set(uri.toString(), list);
  }
  get(uri: vscode.Uri, id: string) {
    const hit = this.map.get(uri.toString())?.find((a) => a.id === id);
    if (!hit) throw new Error("prompt not found");
    return hit;
  }
  listByFile(uri: vscode.Uri) {
    return this.map.get(uri.toString()) ?? [];
  }
}
