# Rhombus 🔷

An intelligent VS Code extension that enhances your coding experience by integrating AI directives directly into your code and providing a persistent chat interface powered by Ollama.

Note: This is very early version and doesn't work right, use at your own risk for now - 7/22/25

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
// @ai: This must use iterators and be designed for processing 1 million + records
function processData(data) {
  return data.map((item) => item * 2);
}

// @ai: Must not be a float
function calculateTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
```

```python
# @ai: Make sure always return Json
def fetch_user_data(user_id):
    response = requests.get(f"/api/users/{user_id}")
    return response.json()

# @ai: We must maintain this to Stripe API version 2.34
def process_payment(amount, card_token):
    # payment processing logic
    pass
```
