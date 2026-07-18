#!/usr/bin/env node
// Minimal stdio MCP server fixture for tests. Reads newline-delimited JSON-RPC
// 2.0 from stdin and responds on stdout — just enough of the protocol
// (initialize, tools/list, tools/call) to exercise the governed MCP invocation
// path. Behavior is selected by the MCP_MODE env var or a `--mode <name>`
// argument so a single file serves every scenario:
//
//   echo         one "echo" tool that returns its arguments as JSON text
//   multi        two tools ("alpha", "beta") for selection / ambiguity
//   notools      a server that exposes zero tools
//   toolerror    the echo tool reports a tool-level isError
//   badhandshake initialize returns a JSON-RPC error (no result)
//   hang         never responds (drives the client hard timeout)
//   flood        writes far more than the output cap on tools/call (no newline)

import { createInterface } from "node:readline";

let mode = process.env.MCP_MODE || "echo";
const mi = process.argv.indexOf("--mode");
if (mi >= 0 && process.argv[mi + 1]) mode = process.argv[mi + 1];

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function initializeResult() {
  return {
    protocolVersion: "2024-11-05",
    capabilities: {},
    serverInfo: { name: "fixture", version: "0.0.0" },
  };
}

if (mode === "hang") {
  // Consume stdin but never respond, so the client hits its hard timeout.
  process.stdin.on("data", () => {});
  setInterval(() => {}, 1 << 30);
} else {
  const tools =
    mode === "multi"
      ? [
          { name: "alpha", inputSchema: { type: "object" } },
          { name: "beta", inputSchema: { type: "object" } },
        ]
      : mode === "notools"
        ? []
        : [{ name: "echo", inputSchema: { type: "object" } }];

  // Readline gives us clean line framing over the newline-delimited stream.
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method === "initialize") {
      if (mode === "badhandshake") {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "handshake refused" } });
        return;
      }
      send({ jsonrpc: "2.0", id: msg.id, result: initializeResult() });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    } else if (msg.method === "tools/call") {
      if (mode === "flood") {
        // Far more than the client's output cap, with no newline so it never
        // forms a complete response line.
        process.stdout.write("x".repeat(200000));
        return;
      }
      const args = (msg.params && msg.params.arguments) || {};
      if (mode === "toolerror") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: "boom" }], isError: true },
        });
        return;
      }
      // echo: reflect the arguments so callers can assert on them and so secret
      // redaction can be exercised.
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(args) }], isError: false },
      });
    }
    // notifications/initialized and anything else are intentionally ignored.
  });
}
