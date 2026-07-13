import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("Configuration", () => {
  it("loads valid config from env", () => {
    const config = loadConfig({
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "http://localhost:3000/v1",
      OPENAI_MODEL: "gpt-4",
    });
    expect(config.apiKey).toBe("test-key");
    expect(config.baseUrl).toBe("http://localhost:3000/v1");
    expect(config.model).toBe("gpt-4");
  });

  it("throws on missing API key", () => {
    expect(() =>
      loadConfig({ OPENAI_API_KEY: "", OPENAI_BASE_URL: "http://localhost:3000/v1", OPENAI_MODEL: "gpt-4" }),
    ).toThrow("Configuration error");
  });

  it("throws on missing model", () => {
    expect(() =>
      loadConfig({ OPENAI_API_KEY: "key", OPENAI_BASE_URL: "http://localhost:3000/v1", OPENAI_MODEL: "" }),
    ).toThrow("Configuration error");
  });

  it("throws on invalid base URL", () => {
    expect(() =>
      loadConfig({ OPENAI_API_KEY: "key", OPENAI_BASE_URL: "not-a-url", OPENAI_MODEL: "model" }),
    ).toThrow("Configuration error");
  });

  it("uses default base URL when not set", () => {
    const config = loadConfig({ OPENAI_API_KEY: "key", OPENAI_MODEL: "model" });
    expect(config.baseUrl).toBe("https://api.openai.com/v1");
  });
});
