# Rhombus 🔷

An intelligent VS Code extension that enhances your coding experience by integrating AI directives directly into your code and providing a persistent chat interface powered by Ollama.

## ✨ Features

- 🤖 **Static AI Chat Window** - Persistent chat interface like Cursor, always available in your panel
- 📝 **Smart Directive Detection** - Automatically finds and uses `@ai:` directives near your code as context
- 🎯 **Context-Aware Responses** - AI considers your project directives when suggesting code changes
- 📁 **Directive Tree View** - Browse all AI directives in your project from the Explorer sidebar
- ✅ **Apply/Reject Changes** - Review and selectively apply AI suggestions with one click
- 🔗 **Ollama Integration** - Works with your local Ollama installation

## 🚀 Quick Start

### Prerequisites

1. **Install Ollama**: Download from [ollama.ai](https://ollama.ai)
2. **Pull a model**: Run `ollama pull mistral` (or your preferred model)
3. **Start Ollama**: Run `ollama serve` to start the local server

### Installation

1. Clone this repository
2. Run `npm install` in the extension directory
3. Press `F5` to launch the extension development host
4. Or package with `vsce package` and install the `.vsix` file

## 📖 How to Use

### 1. Add AI Directives to Your Code

Add directives using comments in your code to guide the AI:

```javascript
// @ai: Make this function more efficient and add error handling
function processData(data) {
  return data.map((item) => item * 2);
}

// @ai: Add JSDoc comments and type safety
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

```python
# @ai: Convert this to use async/await pattern
def fetch_user_data(user_id):
    response = requests.get(f"/api/users/{user_id}")
    return response.json()

# @ai: Add comprehensive error handling and logging
def process_payment(amount, card_token):
    # payment processing logic
    pass
```
