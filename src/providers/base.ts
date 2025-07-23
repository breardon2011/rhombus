// src/providers/base.ts
export interface CompletionArgs {
  prompt: string;
  context: string;
  model: string;
  temperature: number;
}

export interface LlmProvider {
  complete(opts: CompletionArgs): Promise<string>;
}
