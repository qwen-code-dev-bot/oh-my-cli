import { describe, it, expect } from "vitest";
import {
  OFFLINE_ENV,
  isOfflineRequested,
  isLoopbackBaseUrl,
  offlineDispatchDecision,
  offlineRefusalMessage,
  OfflineRefusalError,
} from "../../src/offline-guard.js";

describe("offline mode guard (Issue #576)", () => {
  describe("isOfflineRequested", () => {
    it("activates only on the documented value", () => {
      expect(isOfflineRequested({ [OFFLINE_ENV]: "1" })).toBe(true);
      expect(isOfflineRequested({ [OFFLINE_ENV]: "0" })).toBe(false);
      expect(isOfflineRequested({ [OFFLINE_ENV]: "true" })).toBe(false);
      expect(isOfflineRequested({})).toBe(false);
    });
  });

  describe("isLoopbackBaseUrl (lexical, no DNS)", () => {
    it("recognizes the documented loopback forms, case-insensitively", () => {
      expect(isLoopbackBaseUrl("http://127.0.0.1:49999/v1")).toBe(true);
      expect(isLoopbackBaseUrl("http://localhost:8080/v1")).toBe(true);
      expect(isLoopbackBaseUrl("http://LOCALHOST:8080/v1")).toBe(true);
      expect(isLoopbackBaseUrl("http://[::1]:8080/v1")).toBe(true);
      // Bare IPv6 without brackets is not a parseable URL host (URL spec
      // requires brackets), so it fails closed — documented as unparseable.
      expect(isLoopbackBaseUrl("http://::1/v1")).toBe(false);
      expect(isLoopbackBaseUrl("http://[0:0:0:0:0:0:0:1]:8080/v1")).toBe(true);
    });

    it("refuses non-loopback hosts and fails closed on the unparseable", () => {
      expect(isLoopbackBaseUrl("https://api.openai.com/v1")).toBe(false);
      expect(isLoopbackBaseUrl("http://10.0.0.1:8080/v1")).toBe(false);
      expect(isLoopbackBaseUrl("http://192.168.1.5:8080/v1")).toBe(false);
      expect(isLoopbackBaseUrl("http://my-local-box:8080/v1")).toBe(false); // hostname alias is not loopback
      expect(isLoopbackBaseUrl("not a url")).toBe(false);
      expect(isLoopbackBaseUrl("")).toBe(false);
      expect(isLoopbackBaseUrl(null)).toBe(false);
      expect(isLoopbackBaseUrl(undefined)).toBe(false);
    });
  });

  describe("offlineDispatchDecision", () => {
    it("allows everything when offline mode is off", () => {
      expect(offlineDispatchDecision({ offline: false, baseUrl: "https://api.openai.com/v1" })).toEqual({
        allowed: true,
      });
    });

    it("allows loopback routes in offline mode", () => {
      expect(offlineDispatchDecision({ offline: true, baseUrl: "http://127.0.0.1:49999/v1" })).toEqual({
        allowed: true,
      });
      expect(offlineDispatchDecision({ offline: true, baseUrl: "http://localhost:8080/v1" })).toEqual({
        allowed: true,
      });
    });

    it("refuses non-loopback routes with a redacted host", () => {
      const d = offlineDispatchDecision({ offline: true, baseUrl: "https://api.openai.com/v1" });
      expect(d.allowed).toBe(false);
      if (!d.allowed) {
        expect(d.redactedHost).toBe("api.openai.com");
        expect(d.redactedHost).not.toContain("/v1");
      }
    });

    it("fails closed on an unparseable endpoint", () => {
      const d = offlineDispatchDecision({ offline: true, baseUrl: "not a url" });
      expect(d.allowed).toBe(false);
    });
  });

  describe("offlineRefusalMessage / OfflineRefusalError", () => {
    it("names offline mode, the blocked host, and how to proceed", () => {
      const msg = offlineRefusalMessage("api.openai.com");
      expect(msg).toContain("Offline mode is active");
      expect(msg).toContain("api.openai.com");
      expect(msg).toContain("OPENAI_BASE_URL");
      expect(msg).toContain(OFFLINE_ENV);
      expect(msg).toContain("before any network I/O");
    });

    it("is a distinct, non-retryable error type", () => {
      const err = new OfflineRefusalError("blocked");
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("OfflineRefusalError");
      expect(err.message).toBe("blocked");
    });
  });
});
