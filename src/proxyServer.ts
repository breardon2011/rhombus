// src/proxyServer.ts
import http from "http";
import { Readable } from "stream";
import type { DirectiveIndexer } from "./directiveIndexer";

interface Touch {
  path: string;
  start: number;
  end: number;
}

/** Start a local OpenAI-compatible proxy that injects directives. */
export function startProxy(
  indexer: DirectiveIndexer,
  realUrl: string,
  port: number
) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/v1/chat/completions")) {
      res.writeHead(404).end();
      return;
    }

    // 1. read incoming body
    const rawBody = await readBody(req);
    const payload: any = JSON.parse(rawBody.toString());

    // 2. extract file ranges mentioned in messages
    const touched = extractRanges(payload.messages);

    // 3. gather directives
    const dirSet = new Set<string>();
    for (const t of touched) {
      const range = new (require("vscode").Range)(t.start, 0, t.end, 0); // lazy import
      indexer.getAllForRange(t.path, range).forEach((d) => dirSet.add(d));
    }

    if (dirSet.size) {
      payload.messages.unshift({
        role: "system",
        content:
          "Project directives (obey strictly):\n" +
          [...dirSet].map((d) => "• " + d).join("\n"),
      });
    }

    // 4. forward to upstream
    const upstream = await fetch(realUrl + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // 5. stream response back
    const headers: Record<string, string> = {};
    upstream.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(upstream.status, headers);

    if (upstream.body) {
      Readable.fromWeb(upstream.body as any).pipe(res);
    } else {
      res.end();
    }
  });

  server.listen(port, () =>
    console.log(`[ai-proxy] listening on http://localhost:${port}`)
  );
}

// ───────────────────────── helpers ──────────────────────────────

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** Very naive extractor: ```FILE:/abs/path:12-34``` fences inside messages. */
function extractRanges(messages: any[]): Touch[] {
  const out: Touch[] = [];
  const RE = /```FILE:(.+?):(\d+)-(\d+)/g;
  for (const m of messages ?? []) {
    if (typeof m.content !== "string") continue;
    let hit: RegExpExecArray | null;
    while ((hit = RE.exec(m.content))) {
      out.push({ path: hit[1], start: Number(hit[2]), end: Number(hit[3]) });
    }
  }
  return out;
}
