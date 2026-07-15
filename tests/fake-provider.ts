import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeResponse {
  type: "text" | "tool_calls";
  content?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface FakeServer {
  url: string;
  port: number;
  close: () => Promise<void>;
  setResponse: (r: FakeResponse) => void;
  setResponses: (r: FakeResponse[]) => void;
  requests: Array<{ body: unknown }>;
}

export async function createFakeServer(): Promise<FakeServer> {
  const requests: Array<{ body: unknown }> = [];
  let responseQueue: FakeResponse[] = [];

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && (req.url === "/chat/completions" || req.url === "/v1/chat/completions")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          requests.push({ body: parsed });

          const response = responseQueue.length > 0
            ? responseQueue.shift()!
            : { type: "text" as const, content: "Hello from fake provider" };

          if (parsed.stream) {
            sendStreamedResponse(res, response, Boolean(parsed.stream_options?.include_usage));
          } else {
            sendNonStreamedResponse(res, response);
          }
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "bad request" }));
        }
      });
    } else if (req.method === "GET" && req.url === "/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    port: addr.port,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
    setResponse: (r: FakeResponse) => { responseQueue = [r]; },
    setResponses: (r: FakeResponse[]) => { responseQueue = [...r]; },
  };
}

function sendStreamedResponse(res: http.ServerResponse, response: FakeResponse, includeUsage: boolean) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const id = `chatcmpl-fake-${Date.now()}`;

  if (response.type === "text") {
    const content = response.content ?? "Hello from fake provider";
    const chunks = content.split("");
    for (const char of chunks) {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: { content: char },
          finish_reason: null,
        }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    const finalChunk = {
      id,
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "stop",
      }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  } else if (response.type === "tool_calls") {
    // First send role
    const roleChunk = {
      id,
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null,
      }],
    };
    res.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

    // Stream each tool call
    for (let i = 0; i < (response.toolCalls?.length ?? 0); i++) {
      const tc = response.toolCalls![i];
      // First chunk: id + name
      const tcChunk1 = {
        id,
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: i,
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      };
      res.write(`data: ${JSON.stringify(tcChunk1)}\n\n`);

      // Stream arguments in chunks
      const args = tc.arguments;
      const chunkSize = 20;
      for (let j = 0; j < args.length; j += chunkSize) {
        const argChunk = {
          id,
          object: "chat.completion.chunk",
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: i,
                function: { arguments: args.slice(j, j + chunkSize) },
              }],
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(argChunk)}\n\n`);
      }
    }

    // Final chunk with finish_reason
    const finalChunk = {
      id,
      object: "chat.completion.chunk",
      choices: [{
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
      }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  }

  if (includeUsage) {
    // A trailing usage chunk (empty choices) mirrors OpenAI's include_usage
    // behaviour. Values are fixed so multi-round token totals are deterministic.
    const usageChunk = {
      id,
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };
    res.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

function sendNonStreamedResponse(res: http.ServerResponse, response: FakeResponse) {
  const id = `chatcmpl-fake-${Date.now()}`;
  const message: Record<string, unknown> = { role: "assistant" };

  if (response.type === "text") {
    message.content = response.content ?? "Hello from fake provider";
  } else {
    message.content = null;
    message.tool_calls = response.toolCalls?.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    id,
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: response.type === "tool_calls" ? "tool_calls" : "stop" }],
  }));
}
