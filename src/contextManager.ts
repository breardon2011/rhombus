// Enhanced Context Manager with codebase search capabilities
import * as vscode from "vscode";
import * as path from "path";
import { DirectiveIndexer } from "./directiveIndexer";

export interface SymbolReference {
  file: string;
  range: vscode.Range;
  kind: "definition" | "reference" | "implementation";
  symbol: string;
}

export interface CodebaseSearchResult {
  definitions: SymbolReference[];
  references: SymbolReference[];
  relatedSymbols: SymbolReference[];
}

export interface ContextItem {
  file: string;
  range: vscode.Range;
  content: string;
  importance: number; // 0-1 scoring
  type: "current" | "import" | "export" | "related" | "test";
  symbols?: vscode.DocumentSymbol[];
}

export interface ProjectContext {
  items: ContextItem[];
  totalTokens: number;
  conversationHistory: ConversationTurn[];
  workspaceInfo: WorkspaceInfo;
}

export interface ConversationTurn {
  request: string;
  response: string;
  filesModified: string[];
  timestamp: number;
}

export interface WorkspaceInfo {
  rootPath: string;
  packageJson?: any;
  tsConfig?: any;
  gitBranch?: string;
  recentFiles: string[];
}

export class EnhancedContextManager {
  private directiveIndexer: DirectiveIndexer;
  private conversationHistory: ConversationTurn[] = [];
  private symbolCache = new Map<string, vscode.DocumentSymbol[]>();
  private dependencyGraph = new Map<string, Set<string>>();
  private maxTokens: number;
  private symbolDefinitionCache = new Map<string, SymbolReference[]>();
  private symbolReferenceCache = new Map<string, SymbolReference[]>();

  constructor(directiveIndexer: DirectiveIndexer, maxTokens = 8000) {
    this.directiveIndexer = directiveIndexer;
    this.maxTokens = maxTokens;
  }

  /**
   * Enhanced context collection with codebase search
   */
  async collectEnhancedContext(
    intent: string,
    targetFile?: string
  ): Promise<ProjectContext> {
    const context: ProjectContext = {
      items: [],
      totalTokens: 0,
      conversationHistory: this.conversationHistory.slice(-3),
      workspaceInfo: await this.getWorkspaceInfo(),
    };

    // 1. Get current file context
    const currentContext = await this.getCurrentFileContext();
    if (currentContext) {
      context.items.push(currentContext);
    }

    // 2. NEW: Find symbols in current context and search for their definitions
    if (currentContext) {
      const codebaseResults = await this.searchCodebaseForSymbols(
        currentContext
      );

      // Add definition files
      for (const def of codebaseResults.definitions) {
        const defContext = await this.getFileContextForRange(
          def.file,
          def.range,
          intent
        );
        if (defContext && this.shouldIncludeContext(defContext, context)) {
          defContext.type = "import"; // Mark as definition/import
          defContext.importance += 0.3; // Boost importance for definitions
          context.items.push(defContext);
        }
      }

      // Add some key references (limit to prevent explosion)
      for (const ref of codebaseResults.references.slice(0, 3)) {
        const refContext = await this.getFileContextForRange(
          ref.file,
          ref.range,
          intent
        );
        if (refContext && this.shouldIncludeContext(refContext, context)) {
          refContext.type = "related";
          refContext.importance += 0.1; // Small boost for references
          context.items.push(refContext);
        }
      }
    }

    // 3. Continue with existing logic...
    const relatedFiles = await this.findRelatedFiles(
      currentContext?.file || "",
      intent
    );

    for (const file of relatedFiles) {
      const item = await this.getFileContext(file, intent);
      if (item && this.shouldIncludeContext(item, context)) {
        context.items.push(item);
      }
    }

    // 4. Add conversation context
    const recentContext = await this.getRecentlyModifiedContext();
    context.items.push(...recentContext);

    // 5. Sort by importance and fit within token limit
    context.items = this.optimizeContextForTokenLimit(context.items);
    context.totalTokens = this.calculateTokens(context);

    return context;
  }

  private async getCurrentFileContext(): Promise<ContextItem | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const doc = editor.document;
    const selection = editor.selection;

    // Smart selection: if no selection, find relevant function/class
    let range: vscode.Range; // Fix: Declare as Range type
    if (selection.isEmpty) {
      range =
        (await this.getSmartRange(doc, selection.start)) ||
        new vscode.Range(0, 0, doc.lineCount, 0);
    } else {
      // Fix: Convert Selection to Range explicitly
      range = new vscode.Range(selection.start, selection.end);
    }

    const symbols = await this.getDocumentSymbols(doc);
    const directives = this.directiveIndexer.getAllForRange(
      doc.fileName,
      range
    );

    return {
      file: doc.fileName,
      range,
      content: doc.getText(range),
      importance: 1.0, // Current file is always most important
      type: "current",
      symbols: symbols?.filter((s) => s.range.intersection(range)),
    };
  }

  private async findRelatedFiles(
    currentFile: string,
    intent: string
  ): Promise<string[]> {
    const related: Set<string> = new Set();

    // 1. Direct imports/exports
    const dependencies = await this.analyzeDependencies(currentFile);
    dependencies.forEach((dep) => related.add(dep));

    // 2. Files that import this file
    const importers = await this.findFilesThatImport(currentFile);
    importers.forEach((imp) => related.add(imp));

    // 3. Semantic similarity based on intent
    if (intent.toLowerCase().includes("test")) {
      const testFiles = await this.findTestFiles(currentFile);
      testFiles.forEach((test) => related.add(test));
    }

    // 4. Recently modified files in conversation
    const recentFiles = this.getRecentlyModifiedFiles();
    recentFiles.forEach((file) => related.add(file));

    // 5. Files with similar names/paths
    const similarFiles = await this.findSimilarFiles(currentFile);
    similarFiles.forEach((file) => related.add(file));

    return Array.from(related).slice(0, 10); // Limit to prevent explosion
  }

  private async analyzeDependencies(filePath: string): Promise<string[]> {
    // Check cache first
    if (this.dependencyGraph.has(filePath)) {
      return Array.from(this.dependencyGraph.get(filePath)!);
    }

    const dependencies: Set<string> = new Set();

    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const content = doc.getText();

      // Parse imports (TypeScript/JavaScript)
      const importRegex = /import.*?from\s+['"`]([^'"`]+)['"`]/g;
      const requireRegex = /require\(['"`]([^'"`]+)['"`]\)/g;

      let match;
      while ((match = importRegex.exec(content)) !== null) {
        const resolved = await this.resolveImportPath(match[1], filePath);
        if (resolved) dependencies.add(resolved);
      }

      while ((match = requireRegex.exec(content)) !== null) {
        const resolved = await this.resolveImportPath(match[1], filePath);
        if (resolved) dependencies.add(resolved);
      }

      this.dependencyGraph.set(filePath, dependencies);
      return Array.from(dependencies);
    } catch (error) {
      console.error(`Error analyzing dependencies for ${filePath}:`, error);
      return [];
    }
  }

  private async resolveImportPath(
    importPath: string,
    fromFile: string
  ): Promise<string | null> {
    // Handle relative imports
    if (importPath.startsWith(".")) {
      const basePath = path.dirname(fromFile);
      const resolved = path.resolve(basePath, importPath);

      // Try common extensions
      for (const ext of [".ts", ".tsx", ".js", ".jsx", ".json"]) {
        const fullPath = resolved + ext;
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
          return fullPath;
        } catch {}
      }

      // Try index files
      for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
        const indexPath = path.join(resolved, `index${ext}`);
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(indexPath));
          return indexPath;
        } catch {}
      }
    }

    return null; // Skip node_modules for now
  }

  private async getSmartRange(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Range | null> {
    const symbols = await this.getDocumentSymbols(doc);
    if (!symbols) return null;

    // Find the smallest symbol containing the position
    const findContaining = (
      syms: vscode.DocumentSymbol[]
    ): vscode.DocumentSymbol | null => {
      for (const sym of syms) {
        if (sym.range.contains(position)) {
          const child = findContaining(sym.children);
          return child || sym;
        }
      }
      return null;
    };

    const containing = findContaining(symbols);
    return containing?.range || null;
  }

  private async getDocumentSymbols(
    doc: vscode.TextDocument
  ): Promise<vscode.DocumentSymbol[] | undefined> {
    // Check cache
    if (this.symbolCache.has(doc.fileName)) {
      return this.symbolCache.get(doc.fileName)!;
    }

    try {
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", doc.uri);

      if (symbols) {
        this.symbolCache.set(doc.fileName, symbols);
        return symbols;
      }

      return undefined; // Fix: Return undefined instead of null
    } catch (error) {
      console.error(`Error getting symbols for ${doc.fileName}:`, error);
      return undefined; // Fix: Return undefined instead of null
    }
  }

  private async findTestFiles(filePath: string): Promise<string[]> {
    const testFiles: string[] = [];
    const baseName = path.basename(filePath, path.extname(filePath));
    const dirName = path.dirname(filePath);

    // Common test patterns
    const testPatterns = [
      `${baseName}.test.*`,
      `${baseName}.spec.*`,
      `**/*test*/**/${baseName}.*`,
      `**/*spec*/**/${baseName}.*`,
    ];

    for (const pattern of testPatterns) {
      try {
        const files = await vscode.workspace.findFiles(pattern, null, 5);
        testFiles.push(...files.map((f) => f.fsPath));
      } catch (error) {
        // Ignore errors
      }
    }

    return testFiles;
  }

  private shouldIncludeContext(
    item: ContextItem,
    context: ProjectContext
  ): boolean {
    // Don't include if already present
    if (context.items.some((existing) => existing.file === item.file)) {
      return false;
    }

    // Include if importance is high enough
    if (item.importance > 0.3) {
      return true;
    }

    // Include if it's a test file and we're working on testing
    if (
      item.type === "test" &&
      context.items.some((i) => i.content.toLowerCase().includes("test"))
    ) {
      return true;
    }

    return false;
  }

  private optimizeContextForTokenLimit(items: ContextItem[]): ContextItem[] {
    // Sort by importance (descending)
    items.sort((a, b) => b.importance - a.importance);

    const optimized: ContextItem[] = [];
    let tokenCount = 0;

    for (const item of items) {
      const itemTokens = this.estimateTokens(item.content);

      if (tokenCount + itemTokens <= this.maxTokens) {
        optimized.push(item);
        tokenCount += itemTokens;
      } else if (item.importance > 0.8) {
        // For very important items, try to truncate instead of excluding
        const truncated = this.truncateContent(
          item,
          this.maxTokens - tokenCount
        );
        if (truncated) {
          optimized.push(truncated);
          break; // This fills our budget
        }
      }
    }

    return optimized;
  }

  private truncateContent(
    item: ContextItem,
    maxTokens: number
  ): ContextItem | null {
    if (maxTokens < 100) return null; // Too small to be useful

    const lines = item.content.split("\n");
    const approximateLines = Math.floor(maxTokens / 10); // Rough estimate

    if (lines.length <= approximateLines) return item;

    // Keep the beginning and end, skip middle
    const keepStart = Math.floor(approximateLines * 0.6);
    const keepEnd = Math.floor(approximateLines * 0.4);

    const truncatedContent = [
      ...lines.slice(0, keepStart),
      "// ... (content truncated) ...",
      ...lines.slice(-keepEnd),
    ].join("\n");

    return {
      ...item,
      content: truncatedContent,
    };
  }

  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  private calculateTokens(context: ProjectContext): number {
    return context.items.reduce(
      (total, item) => total + this.estimateTokens(item.content),
      0
    );
  }

  private async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { rootPath: "", recentFiles: [] };
    }

    const rootPath = workspaceFolder.uri.fsPath;
    const info: WorkspaceInfo = {
      rootPath,
      recentFiles: this.getRecentlyOpenedFiles(),
    };

    // Try to read package.json
    try {
      const packagePath = path.join(rootPath, "package.json");
      const packageDoc = await vscode.workspace.openTextDocument(packagePath);
      info.packageJson = JSON.parse(packageDoc.getText());
    } catch {}

    // Try to read tsconfig.json
    try {
      const tsconfigPath = path.join(rootPath, "tsconfig.json");
      const tsconfigDoc = await vscode.workspace.openTextDocument(tsconfigPath);
      info.tsConfig = JSON.parse(tsconfigDoc.getText());
    } catch {}

    return info;
  }

  private getRecentlyOpenedFiles(): string[] {
    // This would need to be tracked by the extension
    // For now, return empty array
    return [];
  }

  private getRecentlyModifiedFiles(): string[] {
    return this.conversationHistory
      .flatMap((turn) => turn.filesModified)
      .slice(-10); // Last 10 modified files
  }

  private async getRecentlyModifiedContext(): Promise<ContextItem[]> {
    const recentFiles = this.getRecentlyModifiedFiles();
    const contexts: ContextItem[] = [];

    for (const file of recentFiles.slice(0, 3)) {
      // Limit to 3 recent files
      const context = await this.getFileContext(file, "");
      if (context) {
        context.importance *= 0.7; // Slightly lower importance
        contexts.push(context);
      }
    }

    return contexts;
  }

  private async getFileContext(
    file: string,
    intent: string
  ): Promise<ContextItem | null> {
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      const symbols = await this.getDocumentSymbols(doc);
      const directives = this.directiveIndexer.getForFile(file);

      // Calculate importance based on various factors
      let importance = 0.5; // Base importance

      if (
        intent &&
        doc.getText().toLowerCase().includes(intent.toLowerCase())
      ) {
        importance += 0.3;
      }

      if (directives.length > 0) {
        importance += 0.2;
      }

      // Determine type
      let type: ContextItem["type"] = "related";
      if (file.includes(".test.") || file.includes(".spec.")) {
        type = "test";
      }

      return {
        file,
        range: new vscode.Range(0, 0, doc.lineCount, 0),
        content: doc.getText(),
        importance,
        type,
        symbols, // This should now be DocumentSymbol[] | undefined
      };
    } catch (error) {
      console.error(`Error reading file ${file}:`, error);
      return null;
    }
  }

  private async findSimilarFiles(currentFile: string): Promise<string[]> {
    const baseName = path.basename(currentFile, path.extname(currentFile));
    const similar: string[] = [];

    try {
      const files = await vscode.workspace.findFiles(
        `**/*${baseName}*`,
        null,
        10
      );
      similar.push(
        ...files.map((f) => f.fsPath).filter((f) => f !== currentFile)
      );
    } catch {}

    return similar;
  }

  private async findFilesThatImport(filePath: string): Promise<string[]> {
    const importers: string[] = [];
    const relativePath = vscode.workspace.asRelativePath(filePath);

    try {
      const files = await vscode.workspace.findFiles(
        "**/*.{ts,tsx,js,jsx}",
        null,
        100
      );

      for (const file of files) {
        try {
          const doc = await vscode.workspace.openTextDocument(file);
          const content = doc.getText();

          // Check if this file imports our target file
          if (
            content.includes(relativePath) ||
            content.includes(path.basename(filePath, path.extname(filePath)))
          ) {
            importers.push(file.fsPath);
          }
        } catch {}
      }
    } catch {}

    return importers;
  }

  addConversationTurn(
    request: string,
    response: string,
    filesModified: string[]
  ) {
    this.conversationHistory.push({
      request,
      response,
      filesModified,
      timestamp: Date.now(),
    });

    // Keep only last 10 turns
    if (this.conversationHistory.length > 10) {
      this.conversationHistory = this.conversationHistory.slice(-10);
    }
  }

  /**
   * Search the codebase for symbol definitions and references
   */
  private async searchCodebaseForSymbols(
    contextItem: ContextItem
  ): Promise<CodebaseSearchResult> {
    const result: CodebaseSearchResult = {
      definitions: [],
      references: [],
      relatedSymbols: [],
    };

    try {
      const doc = await vscode.workspace.openTextDocument(contextItem.file);

      // Extract symbols from the context
      const symbols = await this.extractSymbolsFromContent(
        doc,
        contextItem.range
      );

      for (const symbolInfo of symbols) {
        // Find definitions
        const definitions = await this.findSymbolDefinitions(
          doc.uri,
          symbolInfo.position,
          symbolInfo.name
        );
        result.definitions.push(...definitions);

        // Find references (limited to prevent explosion)
        const references = await this.findSymbolReferences(
          doc.uri,
          symbolInfo.position,
          symbolInfo.name
        );
        result.references.push(...references.slice(0, 5)); // Limit references
      }

      // Text-based search for additional symbols
      const textBasedResults = await this.textBasedSymbolSearch(
        contextItem.content
      );
      result.relatedSymbols.push(...textBasedResults);
    } catch (error) {
      console.error("Error searching codebase for symbols:", error);
    }

    return result;
  }

  /**
   * Extract symbols from document content
   */
  private async extractSymbolsFromContent(
    doc: vscode.TextDocument,
    range: vscode.Range
  ): Promise<
    Array<{ name: string; position: vscode.Position; kind: vscode.SymbolKind }>
  > {
    const symbols: Array<{
      name: string;
      position: vscode.Position;
      kind: vscode.SymbolKind;
    }> = [];

    try {
      // Get document symbols
      const docSymbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[]
      >("vscode.executeDocumentSymbolProvider", doc.uri);

      if (docSymbols) {
        const extractFromSymbols = (syms: vscode.DocumentSymbol[]) => {
          for (const sym of syms) {
            if (range.intersection(sym.range)) {
              symbols.push({
                name: sym.name,
                position: sym.selectionRange.start,
                kind: sym.kind,
              });
            }
            if (sym.children) {
              extractFromSymbols(sym.children);
            }
          }
        };
        extractFromSymbols(docSymbols);
      }

      // Also extract from text patterns (classes, functions, interfaces, etc.)
      const content = doc.getText(range);
      const patterns = [
        // TypeScript/JavaScript patterns
        /(?:class|interface|type|enum)\s+(\w+)/g,
        /(?:function|const|let|var)\s+(\w+)/g,
        /(\w+)\s*[:=]\s*(?:function|\()/g,
        // Import patterns
        /import\s+(?:\{[^}]*\}|\w+|[^}]*)\s+from\s+['"`]([^'"`]+)/g,
        /import\s*\(\s*['"`]([^'"`]+)/g,
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const symbolName = match[1];
          if (symbolName && symbolName.length > 2) {
            // Filter out very short names
            const position = doc.positionAt(
              range.start.character + match.index
            );
            symbols.push({
              name: symbolName,
              position,
              kind: vscode.SymbolKind.Variable, // Default kind
            });
          }
        }
      }
    } catch (error) {
      console.error("Error extracting symbols:", error);
    }

    return symbols;
  }

  /**
   * Find symbol definitions using VS Code's language server
   */
  private async findSymbolDefinitions(
    uri: vscode.Uri,
    position: vscode.Position,
    symbolName: string
  ): Promise<SymbolReference[]> {
    const cacheKey = `${uri.fsPath}:${position.line}:${position.character}:${symbolName}`;

    if (this.symbolDefinitionCache.has(cacheKey)) {
      return this.symbolDefinitionCache.get(cacheKey)!;
    }

    const definitions: SymbolReference[] = [];

    try {
      // Use VS Code's definition provider
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeDefinitionProvider",
        uri,
        position
      );

      if (locations) {
        for (const location of locations) {
          // Skip if it's the same file and position (self-reference)
          if (
            location.uri.fsPath !== uri.fsPath ||
            !location.range.contains(position)
          ) {
            definitions.push({
              file: location.uri.fsPath,
              range: location.range,
              kind: "definition",
              symbol: symbolName,
            });
          }
        }
      }

      // Fallback: text-based search if no language server results
      if (definitions.length === 0) {
        const textBasedDefs = await this.textBasedDefinitionSearch(
          symbolName,
          uri.fsPath
        );
        definitions.push(...textBasedDefs);
      }

      this.symbolDefinitionCache.set(cacheKey, definitions);
    } catch (error) {
      console.error(`Error finding definitions for ${symbolName}:`, error);
    }

    return definitions;
  }

  /**
   * Find symbol references using VS Code's language server
   */
  private async findSymbolReferences(
    uri: vscode.Uri,
    position: vscode.Position,
    symbolName: string
  ): Promise<SymbolReference[]> {
    const cacheKey = `refs:${uri.fsPath}:${position.line}:${position.character}:${symbolName}`;

    if (this.symbolReferenceCache.has(cacheKey)) {
      return this.symbolReferenceCache.get(cacheKey)!;
    }

    const references: SymbolReference[] = [];

    try {
      // Use VS Code's reference provider
      const locations = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        uri,
        position
      );

      if (locations) {
        for (const location of locations) {
          references.push({
            file: location.uri.fsPath,
            range: location.range,
            kind: "reference",
            symbol: symbolName,
          });
        }
      }

      this.symbolReferenceCache.set(cacheKey, references);
    } catch (error) {
      console.error(`Error finding references for ${symbolName}:`, error);
    }

    return references;
  }

  /**
   * Text-based symbol search as fallback
   */
  private async textBasedDefinitionSearch(
    symbolName: string,
    excludeFile: string
  ): Promise<SymbolReference[]> {
    const definitions: SymbolReference[] = [];

    try {
      // Search for class/interface/type definitions
      const patterns = [
        new RegExp(
          `(?:class|interface|type|enum)\\s+${symbolName}\\s*[\\{<]`,
          "g"
        ),
        new RegExp(
          `(?:function|const|let|var)\\s+${symbolName}\\s*[\\(=:]`,
          "g"
        ),
      ];

      const files = await vscode.workspace.findFiles(
        "**/*.{ts,tsx,js,jsx}",
        "**/node_modules/**",
        50 // Limit files to search
      );

      for (const file of files) {
        if (file.fsPath === excludeFile) continue;

        try {
          const doc = await vscode.workspace.openTextDocument(file);
          const content = doc.getText();

          for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
              const position = doc.positionAt(match.index);
              definitions.push({
                file: file.fsPath,
                range: new vscode.Range(position, position),
                kind: "definition",
                symbol: symbolName,
              });
            }
          }
        } catch (error) {
          // Skip files that can't be read
        }
      }
    } catch (error) {
      console.error(`Error in text-based search for ${symbolName}:`, error);
    }

    return definitions.slice(0, 3); // Limit results
  }

  /**
   * Text-based search for related symbols
   */
  private async textBasedSymbolSearch(
    content: string
  ): Promise<SymbolReference[]> {
    const symbols: SymbolReference[] = [];

    try {
      // Extract import statements and search for those symbols
      const importRegex =
        /import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"`]([^'"`]+)/g;
      let match;

      while ((match = importRegex.exec(content)) !== null) {
        const [, namedImports, namespaceImport, defaultImport, modulePath] =
          match;

        if (namedImports) {
          // Handle named imports: import { A, B, C } from './module'
          const names = namedImports
            .split(",")
            .map((name) => name.trim().split(" as ")[0]);
          for (const name of names) {
            if (name.length > 2) {
              const additionalRefs = await this.textBasedDefinitionSearch(
                name,
                ""
              );
              symbols.push(...additionalRefs);
            }
          }
        }

        if (namespaceImport || defaultImport) {
          const symbolName = namespaceImport || defaultImport;
          if (symbolName && symbolName.length > 2) {
            const additionalRefs = await this.textBasedDefinitionSearch(
              symbolName,
              ""
            );
            symbols.push(...additionalRefs);
          }
        }
      }
    } catch (error) {
      console.error("Error in text-based symbol search:", error);
    }

    return symbols.slice(0, 5); // Limit results
  }

  /**
   * Get file context for a specific range
   */
  private async getFileContextForRange(
    file: string,
    range: vscode.Range,
    intent: string
  ): Promise<ContextItem | null> {
    try {
      const doc = await vscode.workspace.openTextDocument(file);

      // Expand range to include more context (e.g., full function/class)
      const expandedRange = await this.expandRangeToSymbol(doc, range);
      const content = doc.getText(expandedRange);

      const symbols = await this.getDocumentSymbols(doc);
      const directives = this.directiveIndexer.getAllForRange(
        file,
        expandedRange
      );

      // Calculate importance
      let importance = 0.6; // Base importance for symbol-related files

      if (intent && content.toLowerCase().includes(intent.toLowerCase())) {
        importance += 0.2;
      }

      if (directives.length > 0) {
        importance += 0.2;
      }

      return {
        file,
        range: expandedRange,
        content,
        importance,
        type: "related",
        symbols: symbols?.filter((s) => s.range.intersection(expandedRange)),
      };
    } catch (error) {
      console.error(`Error getting context for ${file}:`, error);
      return null;
    }
  }

  /**
   * Expand a range to include the full symbol (function, class, etc.)
   */
  private async expandRangeToSymbol(
    doc: vscode.TextDocument,
    range: vscode.Range
  ): Promise<vscode.Range> {
    try {
      const symbols = await this.getDocumentSymbols(doc);
      if (!symbols) return range;

      // Find the symbol that contains this range
      const findContainingSymbol = (
        syms: vscode.DocumentSymbol[]
      ): vscode.DocumentSymbol | null => {
        for (const sym of syms) {
          if (sym.range.contains(range)) {
            const child = findContainingSymbol(sym.children);
            return child || sym;
          }
        }
        return null;
      };

      const containingSymbol = findContainingSymbol(symbols);
      if (containingSymbol) {
        return containingSymbol.range;
      }
    } catch (error) {
      console.error("Error expanding range to symbol:", error);
    }

    return range;
  }

  /**
   * Search workspace for symbols by name
   */
  async searchWorkspaceForSymbol(
    symbolName: string
  ): Promise<SymbolReference[]> {
    const results: SymbolReference[] = [];

    try {
      const symbols = await vscode.commands.executeCommand<
        vscode.SymbolInformation[]
      >("vscode.executeWorkspaceSymbolProvider", symbolName);

      if (symbols) {
        for (const symbol of symbols.slice(0, 10)) {
          // Limit results
          results.push({
            file: symbol.location.uri.fsPath,
            range: symbol.location.range,
            kind: "definition",
            symbol: symbol.name,
          });
        }
      }
    } catch (error) {
      console.error(`Error searching workspace for ${symbolName}:`, error);
    }

    return results;
  }

  // Clear caches
  clearCache() {
    this.symbolCache.clear();
    this.dependencyGraph.clear();
    this.symbolDefinitionCache.clear();
    this.symbolReferenceCache.clear();
  }
}
