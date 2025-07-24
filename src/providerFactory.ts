// src/providerFactory.ts
import * as vscode from "vscode";
import { LlmProvider } from "./providers/base";
import { OllamaProvider } from "./providers/ollama";
import { OpenAIProvider } from "./providers/openai";

export class ProviderFactory {
  static createProvider(providerName: string): LlmProvider {
    const config = vscode.workspace.getConfiguration("aiAssistant");

    switch (providerName.toLowerCase()) {
      case "ollama":
        const ollamaUrl =
          config.get<string>("ollamaUrl") || "http://localhost:11434";
        return new OllamaProvider(ollamaUrl);

      case "openai":
        const apiKey = config.get<string>("openaiApiKey");
        const openaiUrl =
          config.get<string>("openaiBaseUrl") || "https://api.openai.com";

        if (!apiKey) {
          throw new Error(
            "OpenAI API key not configured. Please set aiAssistant.openaiApiKey in settings."
          );
        }

        return new OpenAIProvider(apiKey, openaiUrl);

      default:
        throw new Error(`Unknown provider: ${providerName}`);
    }
  }
}
