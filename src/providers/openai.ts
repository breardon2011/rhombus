// src/providers/openai.ts
import type { CompletionArgs, LlmProvider } from "./base";

interface OpenAIResponse {
  choices: { message: { content: string } }[];
}

export class OpenAIProvider implements LlmProvider {
  constructor(
    private apiKey: string,
    private baseUrl: string = "https://api.openai.com"
  ) {}

  async complete({
    prompt,
    context,
    model,
    temperature,
  }: CompletionArgs): Promise<string> {
    const body = {
      model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: context },
      ],
      temperature,
      max_tokens: 4000,
    };

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = (await response.json()) as OpenAIResponse;
      return data.choices?.[0]?.message?.content ?? "";
    } catch (error) {
      console.error("OpenAI API error:", error);
      throw new Error(`Failed to communicate with OpenAI: ${error}`);
    }
  }
}
