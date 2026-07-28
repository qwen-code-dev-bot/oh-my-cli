import { afterEach, describe, expect, it } from "vitest";
import {
  DELIVERY_ISSUE_NUMBER,
  DELIVERY_WEB_HOST,
  parseDeliveryWebPort,
  renderDeliveryWebPage,
  renderDeliveryWebScript,
  renderDeliveryWebStyles,
  startDeliveryWebServer,
  type DeliveryWebServer,
} from "../../src/delivery-web.js";

let activeServer: DeliveryWebServer | undefined;

afterEach(async () => {
  await activeServer?.close();
  activeServer = undefined;
});

describe("delivery Web renderer", () => {
  it("renders browser-native Remote Control and Dynamic Workflow demos", () => {
    const html = renderDeliveryWebPage();

    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="remote-panel"');
    expect(html).toContain('id="workflow-panel"');
    expect(html).toContain("Remote Control");
    expect(html).toContain("Dynamic Workflow");
    expect(html).toContain(
      `https://github.com/qwen-code-dev-bot/oh-my-cli/issues/${DELIVERY_ISSUE_NUMBER}`,
    );
    expect(html).toContain("Delivery evidence");
    expect(html).not.toContain("Computer Use");
    expect(html).not.toContain("macOS");
    expect(html).not.toContain("Dock");
  });

  it("includes keyboard, narrow-layout, and reduced-motion affordances", () => {
    const styles = renderDeliveryWebStyles();
    const script = renderDeliveryWebScript();

    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain(":focus-visible");
    expect(script).toContain('"ArrowLeft"');
    expect(script).toContain('"ArrowRight"');
    expect(script).toContain('data-action="toggle-session"');
    expect(script).toContain('data-action="run-workflow"');
  });

  it("validates an explicit CLI port", () => {
    expect(parseDeliveryWebPort(undefined)).toBe(4317);
    expect(parseDeliveryWebPort("8080")).toBe(8080);
    expect(() => parseDeliveryWebPort("0")).toThrow(/between 1 and 65535/);
    expect(() => parseDeliveryWebPort("70000")).toThrow(/between 1 and 65535/);
    expect(() => parseDeliveryWebPort("not-a-port")).toThrow(
      /between 1 and 65535/,
    );
  });
});

describe("delivery Web server", () => {
  it("serves only the bounded local assets with restrictive headers", async () => {
    activeServer = await startDeliveryWebServer({ port: 0 });

    expect(activeServer.url).toMatch(
      new RegExp(`^http://${DELIVERY_WEB_HOST}:\\d+$`),
    );

    const page = await fetch(activeServer.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain(
      "connect-src 'none'",
    );
    expect(await page.text()).toContain("See the feature.");

    const script = await fetch(`${activeServer.url}/delivery-web.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");

    const health = await fetch(`${activeServer.url}/health`);
    expect(await health.json()).toEqual({ ok: true });

    const missing = await fetch(`${activeServer.url}/not-found`);
    expect(missing.status).toBe(404);

    const rejected = await fetch(activeServer.url, { method: "POST" });
    expect(rejected.status).toBe(405);
  });
});
