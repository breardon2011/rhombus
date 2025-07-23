// src/providers/ollama.ts
import type { CompletionArgs, LlmProvider } from "./base";

interface ChatCompletionResponse {
  choices: { message: { content: string } }[];
}

export class OllamaProvider implements LlmProvider {
  constructor(private baseUrl = "http://localhost:11434") {}

  async complete({
    prompt,
    context,
    model,
    temperature,
  }: CompletionArgs): Promise<string> {
    const body = {
      model,
      stream: false,
      options: { temperature },
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: context },
      ],
    };

    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      return data.choices?.[0]?.message?.content ?? "";
    } catch (error) {
      console.error("Ollama API error:", error);
      throw new Error(`Failed to communicate with Ollama: ${error}`);
    }
  }
}
