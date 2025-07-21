import * as vscode from "vscode";
import { PromptStore } from "./promptStore";

const TAG = /\/\/\s*@ai\s+prompt="([^"]+)"(?:\s+id="([a-f0-9-]+)")?/;

export class AiCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private store: PromptStore) {}

  provideCodeLenses(doc: vscode.TextDocument) {
    const lenses: vscode.CodeLens[] = [];
    for (let line = 0; line < doc.lineCount; line++) {
      const m = TAG.exec(doc.lineAt(line).text);
      if (!m) continue;
      const [, prompt, idRaw] = m;
      const id = idRaw ?? crypto.randomUUID();
      this.store.registerAnchor(doc.uri, id, prompt, line);

      lenses.push(
        new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
          title: "▶ Run AI Prompt",
          command: "aiGuidance.runPrompt",
          arguments: [doc.uri, id],
        })
      );
    }
    return lenses;
  }
}
