import * as vscode from "vscode";
import { PromptStore } from "./promptStore";
import { AiCodeLensProvider } from "./codeLens";
import { OllamaProvider } from "./providers/ollama";

export function activate(ctx: vscode.ExtensionContext) {
  const store = new PromptStore();
  const provider = new OllamaProvider();

  ctx.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: "file", language: "*" },
      new AiCodeLensProvider(store)
    ),

    vscode.commands.registerCommand(
      "aiGuidance.runPrompt",
      async (uri: vscode.Uri, id: string) => {
        const { prompt, range } = store.get(uri, id);
        const doc = await vscode.workspace.openTextDocument(uri);
        const code = doc.getText(range);

        const reply = await provider.complete({
          prompt,
          context: code,
          model: "mistral", // quick hard‑coded default
          temperature: 0.2,
        });

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, range, reply);
        await vscode.workspace.applyEdit(edit);
      }
    )
  );

  // (Tree view optional)
  // new PromptTreeView(store);
}

export function deactivate() {}
