// src/modelManager.ts
import * as vscode from "vscode";

export interface Model {
  name: string;
  size?: string;
  modified?: string;
  digest?: string;
}

export interface Provider {
  name: string;
  displayName: string;
  icon: string;
}

export class ModelManager {
  private static instance: ModelManager;
  private cachedModels: Model[] = [];
  private lastFetch: number = 0;
  private readonly CACHE_DURATION = 30000; // 30 seconds

  static getInstance(): ModelManager {
    if (!ModelManager.instance) {
      ModelManager.instance = new ModelManager();
    }
    return ModelManager.instance;
  }

  async getAvailableModels(
    baseUrl: string = "http://localhost:11434"
  ): Promise<Model[]> {
    const now = Date.now();

    // Return cached models if recent
    if (
      this.cachedModels.length > 0 &&
      now - this.lastFetch < this.CACHE_DURATION
    ) {
      return this.cachedModels;
    }

    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      this.cachedModels =
        data.models?.map((model: any) => ({
          name: model.name,
          size: this.formatSize(model.size),
          modified: model.modified_at
            ? new Date(model.modified_at).toLocaleDateString()
            : undefined,
          digest: model.digest,
        })) || [];

      this.lastFetch = now;
      return this.cachedModels;
    } catch (error) {
      console.error("Failed to fetch Ollama models:", error);
      // Return some common models as fallback
      return [
        { name: "llama3" },
        { name: "mistral" },
        { name: "codellama" },
        { name: "deepseek-coder" },
      ];
    }
  }

  getAvailableProviders(): Provider[] {
    return [
      { name: "ollama", displayName: "Ollama (Local)", icon: "🦙" },
      { name: "openai", displayName: "OpenAI", icon: "🤖" },
      // Add more providers as needed
    ];
  }

  private formatSize(bytes: number): string {
    if (!bytes) return "";
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(1)}GB`;
  }

  // Clear cache to force refresh
  clearCache(): void {
    this.cachedModels = [];
    this.lastFetch = 0;
  }
}
