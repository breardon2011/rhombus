import * as vscode from "vscode";
import { DirectiveIndexer } from "./directiveIndexer";
import { DirectiveTreeView } from "./treeView";
import { OllamaProvider } from "./providers/ollama";
import { ChatViewProvider } from "./chatPanel";

export async function activate(ctx: vscode.ExtensionContext) {
  const provider = new OllamaProvider("http://localhost:11434");
  const directiveIndexer = new DirectiveIndexer(ctx);
  const treeView = new DirectiveTreeView(directiveIndexer, ctx);

  // Register the static chat view with model/provider selection
  const chatProvider = new ChatViewProvider(
    ctx.extensionUri,
    directiveIndexer,
    provider
  );
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatProvider
    )
  );

  // Command for directive tree view
  ctx.subscriptions.push(
    vscode.commands.registerCommand(
      "aiAssistant.fixHere",
      async (uri: vscode.Uri) => {
        try {
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            vscode.window.showErrorMessage("No active text editor");
            return;
          }

          const doc = editor.document;
          const directives = await directiveIndexer.getAllDirectives(uri);

          if (directives.length === 0) {
            vscode.window.showInformationMessage(
              "No directives found in this file"
            );
            return;
          }

          const directive =
            directives.length === 1
              ? directives[0]
              : await vscode.window.showQuickPick(
                  directives.map((d) => ({ label: d.prompt, directive: d })),
                  { placeHolder: "Select a directive to run" }
                );

          if (!directive) return;

          const targetDirective =
            "directive" in directive ? directive.directive : directive;
          const code = doc.getText(targetDirective.range);

          const reply = await provider.complete({
            prompt: targetDirective.prompt,
            context: code,
            model: "mistral",
            temperature: 0.2,
          });

          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, targetDirective.range, reply);
          await vscode.workspace.applyEdit(edit);
        } catch (error) {
          vscode.window.showErrorMessage(`Error fixing code: ${error}`);
        }
      }
    )
  );

  // Show chat command (focuses the chat view)
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aiGuidance.openChat", async () => {
      await vscode.commands.executeCommand("aiAssistant.chatView.focus");
    })
  );
}

export function deactivate() {}
