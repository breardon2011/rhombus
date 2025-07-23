// src/codeLens.ts
import * as vscode from "vscode";
import { PromptStore } from "./promptStore";

const TAG = /(?:\/\/|#|--)\s*@ai\s+prompt="([^"]+)"(?:\s+id="([a-f0-9-]+)")?/;

export class AiCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private store: PromptStore) {}

  provideCodeLenses(doc: vscode.TextDocument) {
    const lenses: vscode.CodeLens[] = [];
    for (let i = 0; i < doc.lineCount; i++) {
      const m = TAG.exec(doc.lineAt(i).text);
      if (!m) continue;

      const [, prompt, rawId] = m;
      const id = rawId ?? crypto.randomUUID();
      this.store.registerAnchor(doc.uri, id, prompt, i);

      lenses.push(
        new vscode.CodeLens(new vscode.Range(i, 0, i, 0), {
          title: "▶ Run AI Prompt",
          command: "aiGuidance.runPrompt",
          arguments: [doc.uri, id],
        })
      );
    }
    return lenses;
  }
}
