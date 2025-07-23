// src/extension.ts
import * as vscode from "vscode";
import { DirectiveIndexer } from "./directiveIndexer";
import { startProxy } from "./proxyServer";
import { ChatPanel } from "./chatPanel";
import { enclosingTopSymbolRange } from "./helpers/symbols";
import { PromptStore } from "./promptStore";
import { AiCodeLensProvider } from "./codeLens";
import { OllamaProvider } from "./providers/ollama"; // swap for provider picker
import { LlmProvider } from "./providers/base";

export function activate(ctx: vscode.ExtensionContext) {
  // ── Config ────────────────────────────────────────────
  const cfg = vscode.workspace.getConfiguration("aiAssistant");
  const upstream = cfg.get<string>("llmUrl") || "http://localhost:11434";
  const model = cfg.get<string>("model") || "llama3";
  const port = cfg.get<number>("proxyPort") || 11555;

  // ── Directive indexer ────────────────────────────────
  const indexer = new DirectiveIndexer(ctx);

  // ── LLM provider for in‑editor commands ──────────────
  const provider: LlmProvider = new OllamaProvider(upstream);

  // ── Start proxy so Cursor/Continue can hit us ────────
  startProxy(indexer, upstream, port);
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left
  );
  status.text = `AI Proxy :${port}`;
  status.tooltip = `Forwarding to ${upstream}`;
  status.show();
  ctx.subscriptions.push(status);

  // ── Optional CodeLens for old "prompt anchors" flow ──
  const store = new PromptStore();
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
          model,
          temperature: 0.2,
        });

        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, range, reply);
        await vscode.workspace.applyEdit(edit);
      }
    )
  );

  // ── Chat panel command ────────────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aiAssistant.openChat", () => {
      new ChatPanel(indexer, provider, ctx);
    })
  );

  // ── “Fix Here” quick command ─────────────────────────
  ctx.subscriptions.push(
    vscode.commands.registerCommand("aiAssistant.fixHere", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const doc = editor.document;
      const pos = editor.selection.active;
      const fnRange =
        (await enclosingTopSymbolRange(doc, pos)) ??
        new vscode.Range(0, 0, doc.lineCount, 0);

      const rules = indexer.getAllForRange(doc.fileName, fnRange);

      const diagnostics = vscode.languages
        .getDiagnostics(doc.uri)
        .filter((d) => !!d.range.intersection(fnRange))
        .map((d) => d.message)
        .join("\n");

      const userPrompt = await vscode.window.showInputBox({
        prompt: "Describe what you want the AI to do",
        value: "I have an error in this function. Fix it.",
      });
      if (!userPrompt) return;

      const code = doc.getText(fnRange);

      const reply = await provider.complete({
        prompt: `Follow these project directives strictly:\n${rules
          .map((r) => "• " + r)
          .join("\n")}\nReturn ONLY the corrected code.`,
        context: `User request:\n${userPrompt}\n\nCode:\n${code}\n\nDiagnostics:\n${diagnostics}`,
        model,
        temperature: 0.2,
      });

      // diff preview
      const right = vscode.Uri.parse(`untitled:${doc.fileName}.ai-fix`);
      const wse = new vscode.WorkspaceEdit();
      wse.insert(right, new vscode.Position(0, 0), reply);
      await vscode.workspace.applyEdit(wse);

      await vscode.commands.executeCommand(
        "vscode.diff",
        doc.uri,
        right,
        "AI Fix Preview"
      );

      const decision = await vscode.window.showInformationMessage(
        "Apply AI changes?",
        "Apply",
        "Cancel"
      );
      if (decision === "Apply") {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, fnRange, reply);
        await vscode.workspace.applyEdit(edit);
      }
    })
  );
}

export function deactivate() {}
