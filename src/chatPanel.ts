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

Please provide the updated code that addresses the user's request while following any directives.`;

      const reply = await this.provider.complete({
        prompt:
          "You are a helpful coding assistant. Respond with the complete updated code that addresses the user's request.",
        context: fullContext,
        model:
          vscode.workspace
            .getConfiguration("aiAssistant")
            .get<string>("model") || "mistral",
        temperature: 0.2,
      });

      this.addMessage(reply, "assistant");

      // Show apply/reject buttons
      this._view?.webview.postMessage({
        type: "showActions",
        code: reply,
        range: { start: range.start.line, end: range.end.line },
        filePath: filePath,
      });
    } catch (error) {
      this.addMessage(`Error: ${error}`, "system");
    }
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
        }
        
        .action-buttons.show {
            display: flex;
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
        <button class="apply-btn" id="applyBtn">✅ Apply Changes</button>
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
        addMessage('Hi! I\\'m your AI coding assistant. Select some code and ask me to modify it!', 'system');
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
