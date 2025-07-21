export interface LlmProvider {
  complete(opts: {
    prompt: string;
    context: string;
    model: string;
    temperature: number;
  }): Promise<string>;
}
