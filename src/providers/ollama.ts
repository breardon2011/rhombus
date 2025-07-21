// src/providers/ollama.ts
import { LlmProvider } from "./base";

/** Parameters we expect when we call provider.complete(...) */
export interface CompletionArgs {
  prompt: string;
  context: string;
  model: string;
  temperature: number;
}

/** Minimal subset of the response we care about */
interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export class OllamaProvider implements LlmProvider {
  constructor(private baseUrl = "http://localhost:11434") {}

  /** Call the Ollama server and return only the assistant’s text. */
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

    const res: Response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data: ChatCompletionResponse =
      (await res.json()) as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content ?? "";
  }
}
