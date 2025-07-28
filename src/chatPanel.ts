// src/chatPanel.ts
import * as vscode from "vscode";
import { DirectiveIndexer } from "./directiveIndexer";
import { LlmProvider } from "./providers/base";
import { ModelManager, Model, Provider } from "./modelManager";
import { ProviderFactory } from "./providerFactory";
import * as path from "path";

export interface ContextItem {
  file: string;
  range: vscode.Range;
  content: string;
  importance: number; // 0-1 scoring
  type: "current" | "import" | "export" | "related" | "test";
  symbols?: vscode.DocumentSymbol[]; // Change from DocumentSymbol[] to make it optional
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

  constructor(directiveIndexer: DirectiveIndexer, maxTokens = 8000) {
    this.directiveIndexer = directiveIndexer;
    this.maxTokens = maxTokens;
  }

  async collectEnhancedContext(
    intent: string,
    targetFile?: string
  ): Promise<ProjectContext> {
    const context: ProjectContext = {
      items: [],
      totalTokens: 0,
      conversationHistory: this.conversationHistory.slice(-3), // Last 3 turns
      workspaceInfo: await this.getWorkspaceInfo(),
    };

    // 1. Get current file context
    const currentContext = await this.getCurrentFileContext();
    if (currentContext) {
      context.items.push(currentContext);
    }

    // 2. Analyze dependencies and related files
    const relatedFiles = await this.findRelatedFiles(
      currentContext?.file || "",
      intent
    );

    // 3. Add related context with importance scoring
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
    let range: vscode.Range = selection; // Fix: explicitly type as Range
    if (selection.isEmpty) {
      range =
        (await this.getSmartRange(doc, selection.start)) ||
        new vscode.Range(0, 0, doc.lineCount, 0);
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
      symbols: symbols?.filter((s) => s.range.intersection(range)) || undefined, // Fix: handle null case
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
    // Change return type
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

      return undefined; // Return undefined instead of null
    } catch (error) {
      console.error(`Error getting symbols for ${doc.fileName}:`, error);
      return undefined;
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
        symbols,
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

  clearCache() {
    this.symbolCache.clear();
    this.dependencyGraph.clear();
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aiAssistant.chatView";
  private _view?: vscode.WebviewView;
  private currentProvider: LlmProvider;
  private modelManager: ModelManager;
  private contextManager: EnhancedContextManager; // Add context manager

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly indexer: DirectiveIndexer,
    initialProvider: LlmProvider
  ) {
    this.currentProvider = initialProvider;
    this.modelManager = ModelManager.getInstance();
    this.contextManager = new EnhancedContextManager(this.indexer); // Initialize context manager
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Load initial data
    this.loadModelsAndProviders();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "userPrompt":
          await this.handleUserPrompt(data.text, data.model, data.provider);
          break;
        case "applyEdit":
          await this.applyEdit(data.code, data.range);
          break;
        case "rejectEdit":
          this.addMessage("Edit rejected.", "system");
          break;
        case "refreshModels":
          await this.refreshModels();
          break;
        case "providerChanged":
          await this.handleProviderChange(data.provider);
          break;
      }
    });
  }

  private async loadModelsAndProviders() {
    const providers = this.modelManager.getAvailableProviders();
    const models = await this.modelManager.getAvailableModels();

    this._view?.webview.postMessage({
      type: "loadSelectors",
      providers: providers,
      models: models,
      currentProvider: "ollama",
      currentModel: models[0]?.name || "mistral",
    });
  }

  private async refreshModels() {
    this.modelManager.clearCache();
    const models = await this.modelManager.getAvailableModels();

    this._view?.webview.postMessage({
      type: "updateModels",
      models: models,
    });

    this.addMessage("📡 Models refreshed!", "system");
  }

  private async handleProviderChange(providerName: string) {
    try {
      this.currentProvider = ProviderFactory.createProvider(providerName);
      this.addMessage(`🔄 Switched to ${providerName}`, "system");

      // Refresh models for the new provider
      if (providerName === "ollama") {
        await this.refreshModels();
      } else if (providerName === "openai") {
        // OpenAI models are predefined
        const openaiModels = [
          { name: "gpt-4" },
          { name: "gpt-4-turbo-preview" },
          { name: "gpt-3.5-turbo" },
        ];
        this._view?.webview.postMessage({
          type: "updateModels",
          models: openaiModels,
        });
      }
    } catch (error) {
      this.addMessage(`❌ Failed to switch provider: ${error}`, "system");
    }
  }

  private async handleUserPrompt(
    userText: string,
    selectedModel: string,
    selectedProvider: string
  ) {
    try {
      // Switch provider if needed
      if (selectedProvider !== this.getCurrentProviderName()) {
        await this.handleProviderChange(selectedProvider);
      }

      this.addMessage(userText, "user");
      this.addMessage("Thinking...", "system");

      const context = await this.collectContext(userText);

      if (context.items.length === 0) {
        this.addMessage("No context found. Please open a file.", "system");
        return;
      }

      // Build enhanced context prompt
      const contextPrompt = this.buildContextPrompt(userText, context);

      const reply = await this.currentProvider.complete({
        prompt:
          "You are an expert coding assistant. Analyze the provided context and respond appropriately.",
        context: contextPrompt,
        model: selectedModel,
        temperature: 0.2,
      });

      // Track the conversation
      this.contextManager.addConversationTurn(
        userText,
        reply,
        [context.items[0]?.file || ""] // Track modified files
      );

      const { extractedCode } = this.extractCodeFromResponse(reply);

      this.addMessage(reply, "assistant");

      if (extractedCode) {
        const currentFile = context.items.find(
          (item) => item.type === "current"
        );
        if (currentFile) {
          this._view?.webview.postMessage({
            type: "showActions",
            code: extractedCode,
            range: {
              start: currentFile.range.start.line,
              end: currentFile.range.end.line,
            },
            filePath: currentFile.file,
          });
        }
      } else {
        this.addMessage(
          "⚠️ No code found in response. The AI might have provided only explanations.",
          "system"
        );
      }
    } catch (error) {
      this.addMessage(`Error: ${error}`, "system");
    }
  }

  private getCurrentProviderName(): string {
    // Simple way to track current provider - you might want to make this more robust
    return this.currentProvider.constructor.name
      .toLowerCase()
      .replace("provider", "");
  }

  private getCurrentFile(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor?.document.fileName;
  }

  private extractCodeFromResponse(response: string): {
    extractedCode: string | null;
    explanation: string;
  } {
    // Try to extract code blocks first (```...```)
    const codeBlockRegex = /```(?:\w+)?\s*\n?([\s\S]*?)\n?```/g;
    const codeBlocks = [];
    let match;

    while ((match = codeBlockRegex.exec(response)) !== null) {
      // Clean up the extracted code
      let cleanCode = match[1].trim();

      // Remove any remaining markdown artifacts
      cleanCode = this.cleanMarkdownArtifacts(cleanCode);

      if (cleanCode.length > 0) {
        codeBlocks.push(cleanCode);
      }
    }

    if (codeBlocks.length > 0) {
      const extractedCode = codeBlocks.reduce((longest, current) =>
        current.length > longest.length ? current : longest
      );
      return { extractedCode, explanation: response };
    }

    // If no code blocks, try to detect if the entire response looks like code
    let cleanedResponse = this.cleanMarkdownArtifacts(response.trim());

    const lines = cleanedResponse.split("\n");
    const codeIndicators = [
      /^\s*(?:function|const|let|var|class|interface|type|import|export)/,
      /^\s*(?:def|class|import|from|if|for|while|try|except)/,
      /^\s*(?:public|private|protected|static|async|await)/,
      /^\s*[{}()[\];,]/,
      /^\s*\/\/|^\s*\/\*|^\s*#/,
    ];

    const codeLineCount = lines.filter(
      (line) =>
        codeIndicators.some((regex) => regex.test(line)) ||
        line.trim() === "" ||
        /^\s+/.test(line)
    ).length;

    if (codeLineCount / lines.length > 0.7) {
      return { extractedCode: cleanedResponse, explanation: "" };
    }

    // Otherwise, try to find the largest indented block (likely code)
    const indentedBlocks = [];
    let currentBlock = [];
    let inIndentedBlock = false;

    for (const line of lines) {
      if (/^\s{2,}/.test(line) || line.trim() === "") {
        // Line is indented or empty
        if (!inIndentedBlock) {
          inIndentedBlock = true;
          currentBlock = [];
        }
        currentBlock.push(line);
      } else {
        // Line is not indented
        if (inIndentedBlock && currentBlock.length > 2) {
          indentedBlocks.push(currentBlock.join("\n").trim());
        }
        inIndentedBlock = false;
        currentBlock = [];
      }
    }

    if (inIndentedBlock && currentBlock.length > 2) {
      indentedBlocks.push(currentBlock.join("\n").trim());
    }

    if (indentedBlocks.length > 0) {
      const extractedCode = indentedBlocks.reduce((longest, current) =>
        current.length > longest.length ? current : longest
      );
      return {
        extractedCode: this.cleanMarkdownArtifacts(extractedCode),
        explanation: response,
      };
    }

    // Last resort: if response looks short and code-like, use it all
    if (cleanedResponse.length < 1000 && /[{}()[\];]/.test(cleanedResponse)) {
      return { extractedCode: cleanedResponse, explanation: "" };
    }

    return { extractedCode: null, explanation: response };
  }

  /**
   * Clean up markdown artifacts and formatting from code
   */
  private cleanMarkdownArtifacts(code: string): string {
    // Remove markdown code block markers that might have been missed
    code = code.replace(/^```\w*\n?/gm, "");
    code = code.replace(/\n?```$/gm, "");

    // Remove any standalone ``` lines
    code = code.replace(/^```$/gm, "");

    // Remove language specifiers that might appear at the start
    code = code.replace(
      /^(python|javascript|typescript|js|ts|java|c\+\+|cpp|c|go|rust|php|ruby|html|css|sql|bash|shell|sh)\s*\n/i,
      ""
    );

    // Remove any markdown formatting that might be in the code
    code = code.replace(/^\*\*(.*?)\*\*$/gm, "$1"); // Remove bold
    code = code.replace(/^\*(.*?)\*$/gm, "$1"); // Remove italic
    code = code.replace(/^`(.*?)`$/gm, "$1"); // Remove inline code markers

    // Clean up any extra whitespace
    code = code.trim();

    return code;
  }

  // Replace the simple collectContext with enhanced version
  private async collectContext(userText: string): Promise<ProjectContext> {
    return await this.contextManager.collectEnhancedContext(
      userText,
      this.getCurrentFile()
    );
  }

  private async applyEdit(code: string, range: { start: number; end: number }) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.addMessage("No active editor to apply changes.", "system");
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    const editRange = new vscode.Range(range.start, 0, range.end, 0);
    edit.replace(editor.document.uri, editRange, code);

    const success = await vscode.workspace.applyEdit(edit);
    if (success) {
      this.addMessage("✅ Changes applied successfully!", "system");
    } else {
      this.addMessage("❌ Failed to apply changes.", "system");
    }
  }

  private addMessage(text: string, sender: "user" | "assistant" | "system") {
    this._view?.webview.postMessage({
      type: "addMessage",
      text: text,
      sender: sender,
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>AI Assistant</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 12px;
            height: 100vh;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        
        .selectors {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 8px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
        }
        
        .selector-row {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .selector-row label {
            min-width: 60px;
            font-size: 12px;
            font-weight: bold;
        }
        
        select {
            flex: 1;
            padding: 4px 8px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 3px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-size: 12px;
        }
        
        .refresh-btn {
            padding: 4px 8px;
            font-size: 12px;
            min-width: auto;
        }
        
        #messages {
            flex: 1;
            overflow-y: auto;
            padding: 8px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
        }
        
        .message {
            margin-bottom: 12px;
            padding: 8px;
            border-radius: 4px;
        }
        
        .message.user {
            background-color: var(--vscode-inputOption-activeBackground);
        }
        
        .message.assistant {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        
        .message.system {
            background-color: var(--vscode-notifications-background);
            font-style: italic;
            opacity: 0.8;
        }
        
        .message-sender {
            font-weight: bold;
            margin-bottom: 4px;
            font-size: 12px;
        }
        
        .message-content {
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
        }
        
        .input-area {
            display: flex;
            gap: 8px;
        }
        
        #messageInput {
            flex: 1;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }
        
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            cursor: pointer;
            font-size: 12px;
        }
        
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        
        .action-buttons {
            display: none;
            gap: 8px;
            margin-top: 8px;
            padding: 8px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }
        
        .action-buttons.show {
            display: flex;
        }
        
        .action-buttons-header {
            font-weight: bold;
            margin-bottom: 8px;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        
        .apply-btn {
            background-color: var(--vscode-testing-iconPassed);
        }
        
        .reject-btn {
            background-color: var(--vscode-testing-iconFailed);
        }
    </style>
</head>
<body>
    <div class="selectors">
        <div class="selector-row">
            <label>Provider:</label>
            <select id="providerSelect">
                <option value="ollama">🦙 Ollama (Local)</option>
                <option value="openai">🤖 OpenAI</option>
            </select>
        </div>
        <div class="selector-row">
            <label>Model:</label>
            <select id="modelSelect">
                <option value="mistral">Loading...</option>
            </select>
            <button class="refresh-btn" id="refreshBtn">🔄</button>
        </div>
    </div>

    <div id="messages"></div>
    
    <div class="action-buttons" id="actionButtons">
        <div class="action-buttons-header">📝 Apply code changes to your file?</div>
        <button class="apply-btn" id="applyBtn">✅ Apply Code Only</button>
        <button class="reject-btn" id="rejectBtn">❌ Reject</button>
    </div>
    
    <div class="input-area">
        <input type="text" id="messageInput" placeholder="Ask AI to modify your code..." />
        <button id="sendBtn">Send</button>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const messagesContainer = document.getElementById('messages');
        const messageInput = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        const actionButtons = document.getElementById('actionButtons');
        const applyBtn = document.getElementById('applyBtn');
        const rejectBtn = document.getElementById('rejectBtn');
        const providerSelect = document.getElementById('providerSelect');
        const modelSelect = document.getElementById('modelSelect');
        const refreshBtn = document.getElementById('refreshBtn');
        
        let pendingEdit = null;

        function addMessage(text, sender) {
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${sender}\`;
            
            const senderDiv = document.createElement('div');
            senderDiv.className = 'message-sender';
            senderDiv.textContent = sender === 'user' ? '👤 You' : 
                                   sender === 'assistant' ? '🤖 AI' : '💡 System';
            
            const contentDiv = document.createElement('div');
            contentDiv.className = 'message-content';
            contentDiv.textContent = text;
            
            messageDiv.appendChild(senderDiv);
            messageDiv.appendChild(contentDiv);
            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        function sendMessage() {
            const text = messageInput.value.trim();
            if (text) {
                vscode.postMessage({
                    type: 'userPrompt',
                    text: text,
                    model: modelSelect.value,
                    provider: providerSelect.value
                });
                messageInput.value = '';
                actionButtons.classList.remove('show');
            }
        }

        sendBtn.addEventListener('click', sendMessage);
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });

        refreshBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'refreshModels' });
        });

        providerSelect.addEventListener('change', () => {
            vscode.postMessage({ 
                type: 'providerChanged', 
                provider: providerSelect.value 
            });
        });

        applyBtn.addEventListener('click', () => {
            if (pendingEdit) {
                vscode.postMessage({
                    type: 'applyEdit',
                    code: pendingEdit.code,
                    range: pendingEdit.range
                });
                actionButtons.classList.remove('show');
                pendingEdit = null;
            }
        });

        rejectBtn.addEventListener('click', () => {
            vscode.postMessage({
                type: 'rejectEdit'
            });
            actionButtons.classList.remove('show');
            pendingEdit = null;
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'addMessage':
                    addMessage(message.text, message.sender);
                    break;
                case 'showActions':
                    pendingEdit = {
                        code: message.code,
                        range: message.range
                    };
                    actionButtons.classList.add('show');
                    break;
                case 'loadSelectors':
                    // Load providers
                    providerSelect.innerHTML = '';
                    message.providers.forEach(provider => {
                        const option = document.createElement('option');
                        option.value = provider.name;
                        option.textContent = \`\${provider.icon} \${provider.displayName}\`;
                        providerSelect.appendChild(option);
                    });
                    providerSelect.value = message.currentProvider;
                    
                    // Load models
                    modelSelect.innerHTML = '';
                    message.models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.name;
                        option.textContent = model.size ? 
                            \`\${model.name} (\${model.size})\` : model.name;
                        modelSelect.appendChild(option);
                    });
                    modelSelect.value = message.currentModel;
                    break;
                case 'updateModels':
                    modelSelect.innerHTML = '';
                    message.models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.name;
                        option.textContent = model.size ? 
                            \`\${model.name} (\${model.size})\` : model.name;
                        modelSelect.appendChild(option);
                    });
                    break;
            }
        });

        // Initial welcome message
        addMessage('Hi! I\\'m your AI coding assistant.\\n\\nSelect a provider and model above, then ask me to modify your code!', 'system');
    </script>
</body>
</html>`;
  }

  private buildContextPrompt(
    userText: string,
    context: ProjectContext
  ): string {
    let prompt = `User Request: ${userText}\n\n`;

    // Add workspace info
    if (context.workspaceInfo.packageJson) {
      prompt += `Project: ${context.workspaceInfo.packageJson.name}\n`;
    }

    // Add conversation history
    if (context.conversationHistory.length > 0) {
      prompt += `\nRecent Conversation:\n`;
      context.conversationHistory.forEach((turn, i) => {
        prompt += `[${i + 1}] User: ${turn.request.substring(0, 100)}...\n`;
        prompt += `[${i + 1}] Assistant: ${turn.response.substring(
          0,
          100
        )}...\n`;
      });
    }

    // Add context items by importance
    prompt += `\nRelevant Code Context:\n`;
    context.items.forEach((item, i) => {
      const filename = path.basename(item.file);
      prompt += `\n--- ${filename} (${
        item.type
      }, importance: ${item.importance.toFixed(2)}) ---\n`;
      prompt += item.content;
      prompt += "\n";
    });

    // Add directives
    const allDirectives = context.items.flatMap((item) =>
      this.indexer.getForFile(item.file)
    );

    if (allDirectives.length > 0) {
      prompt += `\nProject Directives:\n`;
      allDirectives.forEach((directive) => {
        prompt += `• ${directive}\n`;
      });
    }

    return prompt;
  }
}

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
