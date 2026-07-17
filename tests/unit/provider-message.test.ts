import { describe, it, expect } from "vitest";
import { toOpenAIMessage } from "../../src/provider.js";
import type { SessionMessage } from "../../src/session.js";

describe("toOpenAIMessage multimodal mapping", () => {
  it("maps a user message with image data URLs to content parts (text + image_url)", () => {
    const msg: SessionMessage = {
      role: "user",
      content: "describe this",
      images: [{ name: "a.png", mediaType: "image/png", bytes: 10, dataUrl: "data:image/png;base64,AAAA" }],
    };
    expect(toOpenAIMessage(msg)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("supports multiple images and omits the text part when the prompt is empty", () => {
    const msg: SessionMessage = {
      role: "user",
      content: "",
      images: [
        { name: "a.png", mediaType: "image/png", bytes: 1, dataUrl: "data:image/png;base64,AA" },
        { name: "b.jpg", mediaType: "image/jpeg", bytes: 1, dataUrl: "data:image/jpeg;base64,BB" },
      ],
    };
    expect(toOpenAIMessage(msg)).toEqual({
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BB" } },
      ],
    });
  });

  it("falls back to plain text for a historical image with no data URL (resume safety)", () => {
    const msg: SessionMessage = {
      role: "user",
      content: "earlier prompt",
      images: [{ name: "a.png", mediaType: "image/png", bytes: 10 }],
    };
    expect(toOpenAIMessage(msg)).toEqual({ role: "user", content: "earlier prompt" });
  });

  it("leaves a plain user message unchanged", () => {
    expect(toOpenAIMessage({ role: "user", content: "hi" })).toEqual({ role: "user", content: "hi" });
  });

  it("leaves tool and assistant-with-tool-calls messages unchanged", () => {
    expect(
      toOpenAIMessage({ role: "tool", content: "ok", tool_call_id: "c1" }),
    ).toEqual({ role: "tool", content: "ok", tool_call_id: "c1" });

    const assistant = toOpenAIMessage({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
    });
    expect(assistant).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
    });
  });
});
