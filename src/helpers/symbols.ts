// src/helpers/symbols.ts
import * as vscode from "vscode";

/** Return the smallest enclosing symbol range for position `pos`, or undefined. */
export async function enclosingTopSymbolRange(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<vscode.Range | undefined> {
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    doc.uri
  );
  if (!symbols) return;

  const find = (
    list: vscode.DocumentSymbol[]
  ): vscode.DocumentSymbol | undefined => {
    for (const s of list) {
      if (s.range.contains(pos)) return find(s.children) ?? s;
    }
    return undefined;
  };

  return find(symbols)?.range;
}
