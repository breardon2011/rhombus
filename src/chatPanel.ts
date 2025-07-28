// src/chatPanel.ts
import * as vscode from "vscode";
import { DirectiveIndexer } from "./directiveIndexer";
import { LlmProvider } from "./providers/base";
import { ModelManager, Model, Provider } from "./modelManager";
import { ProviderFactory } from "./providerFactory";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aiAssistant.chatView";
  private _view?: vscode.WebviewView;
  private currentProvider: LlmProvider;
  private modelManager: ModelManager;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly indexer: DirectiveIndexer,
    initialProvider: LlmProvider
  ) {
    this.currentProvider = initialProvider;
    this.modelManager = ModelManager.getInstance();
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

      const { code, range, directives, filePath } = await this.collectContext();

      if (!code) {
        this.addMessage(
          "No active editor found. Please open a file.",
          "system"
        );
        return;
      }

      const directiveContext =
        directives.length > 0
          ? `\n\nProject Directives:\n${directives
              .map((d) => `• ${d}`)
              .join("\n")}`
          : "";

      const fullContext = `User Request: ${userText}

Current Code:
\`\`\`
${code}
\`\`\`${directiveContext}

Please provide the updated code that addresses the user's request while following any directives. Return only the code without explanations.`;

      const reply = await this.currentProvider.complete({
        prompt:
          "You are a helpful coding assistant. Respond with ONLY the complete updated code that addresses the user's request. Do not include explanations, comments about changes, or markdown formatting - just return the raw code.",
        context: fullContext,
        model: selectedModel,
        temperature: 0.2,
      });

      const { extractedCode } = this.extractCodeFromResponse(reply);

      this.addMessage(reply, "assistant");

      if (extractedCode) {
        this._view?.webview.postMessage({
          type: "showActions",
          code: extractedCode,
          range: { start: range.start.line, end: range.end.line },
          filePath: filePath,
        });
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

  private async collectContext(): Promise<{
    code: string;
    range: vscode.Range;
    directives: string[];
    filePath: string;
  }> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return {
        code: "",
        range: new vscode.Range(0, 0, 0, 0),
        directives: [],
        filePath: "",
      };
    }

    const doc = editor.document;
    const selection = editor.selection;

    const range = selection.isEmpty
      ? new vscode.Range(0, 0, doc.lineCount, 0)
      : selection;

    const code = doc.getText(range);
    const directives = this.indexer.getAllForRange(doc.fileName, range);

    return { code, range, directives, filePath: doc.fileName };
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
