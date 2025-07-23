// src/chatPanel.ts
import * as vscode from "vscode";
import { DirectiveIndexer } from "./directiveIndexer";
import { LlmProvider } from "./providers/base";

export class ChatPanel {
  public static readonly viewType = "aiAssistant.chat";
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly indexer: DirectiveIndexer,
    private readonly provider: LlmProvider,
    private readonly ctx: vscode.ExtensionContext
  ) {
    this.open();
  }

  private open() {
    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      "AI Assistant",
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    panel.webview.html = this.html();

    panel.webview.onDidReceiveMessage(
      async (msg) => {
        if (msg.type !== "userPrompt") return;

        const { code, range, directives, diagnostics } =
          await this.collectContext();

        panel.webview.postMessage({ type: "status", text: "Thinking…" });

        const sysPrompt =
          "Follow these project directives strictly:\n" +
          directives.map((d) => "• " + d).join("\n");

        const reply = await this.provider.complete({
          prompt: sysPrompt,
          context: `User request:\n${msg.text}\n\nCode:\n${code}\n\nDiagnostics:\n${diagnostics}`,
          model:
            vscode.workspace
              .getConfiguration("aiAssistant")
              .get<string>("model") || "llama3",
          temperature: 0.2,
        });

        panel.webview.postMessage({ type: "assistantReply", text: reply });

        // Offer to apply
        const choice = await vscode.window.showInformationMessage(
          "Apply AI edits?",
          "Apply",
          "Ignore"
        );
        if (choice === "Apply" && vscode.window.activeTextEditor) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            vscode.window.activeTextEditor.document.uri,
            range,
            reply
          );
          await vscode.workspace.applyEdit(edit);
        }
      },
      undefined,
      this.disposables
    );

    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private async collectContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
      return {
        code: "",
        directives: [],
        diagnostics: "",
        range: new vscode.Range(0, 0, 0, 0),
      };

    const doc = editor.document;
    const sel = editor.selection;
    const range = sel.isEmpty ? new vscode.Range(0, 0, doc.lineCount, 0) : sel;

    const code = doc.getText(range);
    const directives = this.indexer.getAllForRange(doc.fileName, range);

    const diagnostics = vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => !!d.range.intersection(range))
      .map((d) => d.message)
      .join("\n");

    return { code, directives, diagnostics, range };
  }

  private html() {
    const nonce = Date.now().toString();
    return /*html*/ `
<!DOCTYPE html>
<html>
  <body>
    <style>
      body{font-family:sans-serif;margin:0;padding:0 1rem;}
      #log{height:80vh;overflow:auto;white-space:pre-wrap;}
      #in{width:100%;padding:.5rem;}
    </style>
    <div id="log"></div>
    <input id="in" placeholder="Ask me..." />
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const log = document.getElementById('log');
      const input = document.getElementById('in');

      window.addEventListener('message', e => {
        if(e.data.type==='assistantReply') add('🤖 '+e.data.text);
        if(e.data.type==='status')         add('… '+e.data.text);
      });

      input.addEventListener('keydown', e=>{
        if(e.key==='Enter'){
          const t=input.value.trim(); if(!t) return;
          add('🧑 '+t);
          vscode.postMessage({type:'userPrompt', text:t});
          input.value='';
        }
      });

      function add(t){ log.textContent+=t+'\\n\\n'; log.scrollTop=log.scrollHeight; }
    </script>
  </body>
</html>`;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
