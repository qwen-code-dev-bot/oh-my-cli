import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_CHANNELS,
  createDesktopBridge,
} from "../../src/desktop/contracts.js";

describe("desktop preload contract", () => {
  it("exposes one immutable bootstrap channel", () => {
    expect(DESKTOP_CHANNELS).toEqual({
      getBootstrapState: "desktop:get-bootstrap-state",
    });
    expect(Object.isFrozen(DESKTOP_CHANNELS)).toBe(true);
  });

  it("invokes only the allowlisted bootstrap channel", async () => {
    const invoke = vi.fn().mockResolvedValue({
      platform: "darwin",
      version: "0.1.0",
    });
    const bridge = createDesktopBridge(invoke);

    await expect(bridge.getBootstrapState()).resolves.toEqual({
      platform: "darwin",
      version: "0.1.0",
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      DESKTOP_CHANNELS.getBootstrapState,
    );
    expect(Object.keys(bridge)).toEqual(["getBootstrapState"]);
  });
});
