// src/chatPanel.ts
import * as vscode from "vscode";
import { DirectiveIndexer } from "./directiveIndexer";
import { LlmProvider } from "./providers/base";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aiAssistant.chatView";
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly indexer: DirectiveIndexer,
    private readonly provider: LlmProvider
  ) {}

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

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case "userPrompt":
          await this.handleUserPrompt(data.text);
          break;
        case "applyEdit":
          await this.applyEdit(data.code, data.range);
          break;
        case "rejectEdit":
          this.addMessage("Edit rejected.", "system");
          break;
      }
    });
  }

  private async handleUserPrompt(userText: string) {
    try {
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

      // Create context with directives
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

      const reply = await this.provider.complete({
        prompt:
          "You are a helpful coding assistant. Respond with ONLY the complete updated code that addresses the user's request. Do not include explanations, comments about changes, or markdown formatting - just return the raw code.",
        context: fullContext,
        model:
          vscode.workspace
            .getConfiguration("aiAssistant")
            .get<string>("model") || "mistral",
        temperature: 0.2,
      });

      // Extract code from the response and separate from explanations
      const { extractedCode, explanation } =
        this.extractCodeFromResponse(reply);

      // Show the full response in chat
      this.addMessage(reply, "assistant");

      if (extractedCode) {
        // Show apply/reject buttons with just the code
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

  private extractCodeFromResponse(response: string): {
    extractedCode: string | null;
    explanation: string;
  } {
    // Try to extract code blocks first (```...```)
    const codeBlockRegex = /```(?:\w+)?\s*\n([\s\S]*?)\n```/g;
    const codeBlocks = [];
    let match;

    while ((match = codeBlockRegex.exec(response)) !== null) {
      codeBlocks.push(match[1].trim());
    }

    if (codeBlocks.length > 0) {
      // If we found code blocks, use the largest one (likely the main code)
      const extractedCode = codeBlocks.reduce((longest, current) =>
        current.length > longest.length ? current : longest
      );
      return { extractedCode, explanation: response };
    }

    // If no code blocks, try to detect if the entire response looks like code
    const lines = response.trim().split("\n");
    const codeIndicators = [
      /^\s*(?:function|const|let|var|class|interface|type|import|export)/,
      /^\s*(?:def|class|import|from|if|for|while|try|except)/,
      /^\s*(?:public|private|protected|static|async|await)/,
      /^\s*[{}()[\];,]/,
      /^\s*\/\/|^\s*\/\*|^\s*#/, // comments
    ];

    const codeLineCount = lines.filter(
      (line) =>
        codeIndicators.some((regex) => regex.test(line)) ||
        line.trim() === "" || // empty lines
        /^\s+/.test(line) // indented lines
    ).length;

    // If more than 70% of lines look like code, treat the whole response as code
    if (codeLineCount / lines.length > 0.7) {
      return { extractedCode: response.trim(), explanation: "" };
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
      return { extractedCode, explanation: response };
    }

    // Last resort: if response looks short and code-like, use it all
    if (response.length < 1000 && /[{}()[\];]/.test(response)) {
      return { extractedCode: response.trim(), explanation: "" };
    }

    return { extractedCode: null, explanation: response };
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

    // Use selection if exists, otherwise entire file
    const range = selection.isEmpty
      ? new vscode.Range(0, 0, doc.lineCount, 0)
      : selection;

    const code = doc.getText(range);

    // Get directives near the selected/current code
    const directives = this.indexer.getAllForRange(doc.fileName, range);

    return {
      code,
      range,
      directives,
      filePath: doc.fileName,
    };
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
            padding: 16px;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        
        #messages {
            flex: 1;
            overflow-y: auto;
            margin-bottom: 16px;
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
        }
        
        .message-content {
            white-space: pre-wrap;
            word-wrap: break-word;
            font-family: var(--vscode-editor-font-family);
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
                    text: text
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
            }
        });

        // Initial welcome message
        addMessage('Hi! I\\'m your AI coding assistant. Select some code and ask me to modify it!\\n\\nI\\'ll show you the full response here, but only apply the extracted code to your file.', 'system');
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
