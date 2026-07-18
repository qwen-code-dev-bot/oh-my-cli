// A minimal in-process OpenAI-compatible HTTP server for provider-invocation
// tests. It implements just enough of POST /chat/completions (non-streaming) to
// exercise the governed invocation path against a real network client without
// reaching any external API. Behavior is selected by the request's `model`
// field so a single server serves every case:
//
//   (default)  — 200, echoes the last user message as content (or "pong")
//   "empty"    — 200, empty content
//   "auth"     — 401 invalid authentication
//   "nomodel"  — 404 model not available
//   "ratelimit"— 429 rate limited
//   "hang"     — never responds (the client's hard timeout aborts)
//   "flood"    — 200, content larger than the output cap
//   "secret"   — 200, content carrying a secret to prove redaction
//
// startMockServer() resolves to { baseUrl, close }; baseUrl ends in `/v1` so the
// SDK targets `${baseUrl}/chat/completions`.

import http from "node:http";

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(body));
  });
}

function parseRequest(body) {
  try {
    const parsed = JSON.parse(body || "{}");
    const model = typeof parsed.model === "string" ? parsed.model : "";
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const last = messages[messages.length - 1];
    const prompt = last && typeof last.content === "string" ? last.content : "";
    return { model, prompt };
  } catch {
    return { model: "", prompt: "" };
  }
}

function send(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function completion(model, content) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: model || "mock",
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  };
}

function handle(model, prompt, res) {
  switch (model) {
    case "empty":
      return send(res, 200, completion(model, ""));
    case "auth":
      return send(res, 401, { error: { message: "invalid authentication", type: "invalid_request_error" } });
    case "nomodel":
      return send(res, 404, { error: { message: "The model `x` does not exist", type: "invalid_request_error" } });
    case "ratelimit":
      return send(res, 429, { error: { message: "rate limited", type: "rate_limit_error" } });
    case "hang":
      return; // never respond; the client's hard timeout aborts the request
    case "flood":
      return send(res, 200, completion(model, "x".repeat(200_000)));
    case "secret":
      return send(res, 200, completion(model, "leak ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 here"));
    default:
      return send(res, 200, completion(model, prompt || "pong"));
  }
}

export function startMockServer() {
  const server = http.createServer((req, res) => {
    readBody(req).then((body) => {
      const { model, prompt } = parseRequest(body);
      handle(model, prompt, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}
