// src/directiveIndexer.ts
import * as vscode from "vscode";

export interface Directive {
  file: string; // absolute path
  range: vscode.Range; // span the directive applies to
  text: string; // directive text
  id?: string; // optional id for specific directives
}

export class DirectiveIndexer {
  private map = new Map<string, Directive[]>(); // file -> directives[]
  private _onDidUpdate = new vscode.EventEmitter<void>();
  public readonly onDidUpdate = this._onDidUpdate.event;

  constructor(ctx: vscode.ExtensionContext) {
    // The constructor already sets up event listeners automatically
    // No need to call index manually from extension.ts
  }

  /** Index/scan a document for directives */
  async index(doc: vscode.TextDocument): Promise<void> {
    await this.scan(doc);
  }

  /** Get a specific directive by file and id */
  get(uri: vscode.Uri, id: string): { prompt: string; range: vscode.Range } {
    const directives = this.map.get(uri.fsPath) ?? [];
    const directive = directives.find((d) => d.id === id);
    if (!directive) {
      throw new Error(`Directive with id ${id} not found in ${uri.fsPath}`);
    }
    return { prompt: directive.text, range: directive.range };
  }

  /** Get all directives for a file */
  async getAllDirectives(
    uri: vscode.Uri
  ): Promise<{ prompt: string; range: vscode.Range; id?: string }[]> {
    const directives = this.map.get(uri.fsPath) ?? [];
    return directives.map((d) => ({
      prompt: d.text,
      range: d.range,
      id: d.id,
    }));
  }

  /** All directives whose ranges intersect `range`. */
  getAllForRange(file: string, range: vscode.Range): string[] {
    return (this.map.get(file) ?? [])
      .filter((d) => d.range.intersection(range))
      .map((d) => d.text);
  }

  /** All directives for a file (includes file-level ones). */
  getForFile(file: string): string[] {
    return (this.map.get(file) ?? []).map((d) => d.text);
  }

  // ────────────────────────────────────────────────────────────

  private async scan(doc: vscode.TextDocument): Promise<void> {
    const directives: Directive[] = [];

    const LINE_TAG = /(?:\/\/|#|--)\s*@ai:\s*(.+)$/;
    const GLOBAL_TAG = /(?:\/\/|#|--)\s*@ai-global:\s*$/;
    const PROMPT_TAG =
      /(?:\/\/|#|--)\s*@ai\s+prompt="([^"]+)"(?:\s+id="([a-f0-9-]+)")?/;

    for (let i = 0; i < doc.lineCount; i++) {
      const text = doc.lineAt(i).text;

      // Prompt-style directive with id (for CodeLens)
      const promptMatch = PROMPT_TAG.exec(text);
      if (promptMatch) {
        const [, prompt, rawId] = promptMatch;
        const id = rawId ?? crypto.randomUUID();
        const symRange =
          (await this.nextTopSymbolRange(doc, i)) ??
          new vscode.Range(i + 1, 0, doc.lineCount, 0);
        directives.push({
          file: doc.fileName,
          range: symRange,
          text: prompt,
          id: id,
        });
        continue;
      }

      // Single-line directive just before a symbol
      const m = LINE_TAG.exec(text);
      if (m) {
        const symRange =
          (await this.nextTopSymbolRange(doc, i)) ??
          new vscode.Range(i + 1, 0, doc.lineCount, 0);
        directives.push({
          file: doc.fileName,
          range: symRange,
          text: m[1].trim(),
        });
        continue;
      }

      // File-level block starting with @ai-global:
      if (GLOBAL_TAG.test(text)) {
        const lines: string[] = [];
        let j = i + 1;
        while (j < doc.lineCount) {
          const l = doc.lineAt(j).text;
          if (/^\s*(?:\/\/|#|--)\s?/.test(l)) {
            lines.push(l.replace(/^\s*(?:\/\/|#|--)\s?/, ""));
            j++;
          } else {
            break;
          }
        }
        directives.push({
          file: doc.fileName,
          range: new vscode.Range(0, 0, 0, 0),
          text: lines.join("\n"),
        });
        i = j;
      }
    }

    this.map.set(doc.fileName, directives);
    this._onDidUpdate.fire();
  }

  /** Best-effort: find the next top-level symbol after `fromLine`. */
  private async nextTopSymbolRange(
    doc: vscode.TextDocument,
    fromLine: number
  ): Promise<vscode.Range | undefined> {
    const symbols = await vscode.commands.executeCommand<
      vscode.DocumentSymbol[]
    >("vscode.executeDocumentSymbolProvider", doc.uri);
    if (!symbols) return undefined;

    const flatten = (arr: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] =>
      arr.flatMap((s) => [s, ...flatten(s.children)]);

    const all = flatten(symbols);
    const target = all.find((s) => s.range.start.line > fromLine);
    return target?.range;
  }
}
