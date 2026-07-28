import { afterEach, describe, expect, it } from "vitest";
import {
  DELIVERY_ISSUE_NUMBER,
  DELIVERY_PULL_REQUEST_NUMBER,
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
  it("renders a compact directory linking to separate feature pages", () => {
    const directory = renderDeliveryWebPage();

    expect(directory).toContain('href="/remote-control"');
    expect(directory).toContain('href="/dynamic-workflow"');
    expect(directory).toContain("Feature demos");
    expect(directory).not.toContain("See the feature.");
    expect(directory).not.toContain('data-action="toggle-session"');
    expect(directory).not.toContain('data-action="run-workflow"');
  });

  it("renders Remote Control as a focused feature page", () => {
    const remote = renderDeliveryWebPage("remote-control");

    expect(remote).toContain("<h1>Remote Control</h1>");
    expect(remote).toContain('data-action="toggle-session"');
    expect(remote).toContain("Control stays visible");
    expect(remote).toContain("Every action leaves a trace");
    expect(remote).not.toContain('data-action="run-workflow"');
    expect(remote).toContain(
      `https://github.com/qwen-code-dev-bot/oh-my-cli/issues/${DELIVERY_ISSUE_NUMBER}`,
    );
    expect(remote).toContain(
      `https://github.com/qwen-code-dev-bot/oh-my-cli/pull/${DELIVERY_PULL_REQUEST_NUMBER}`,
    );
  });

  it("renders Dynamic Workflow as a focused feature page", () => {
    const workflow = renderDeliveryWebPage("dynamic-workflow");

    expect(workflow).toContain("<h1>Dynamic Workflow</h1>");
    expect(workflow).toContain('data-action="run-workflow"');
    expect(workflow).toContain("The plan is inspectable");
    expect(workflow).toContain("History is append-only");
    expect(workflow).not.toContain('data-action="toggle-session"');
  });

  it("keeps every page browser-native", () => {
    for (const page of [
      renderDeliveryWebPage(),
      renderDeliveryWebPage("remote-control"),
      renderDeliveryWebPage("dynamic-workflow"),
    ]) {
      expect(page).not.toContain("Computer Use");
      expect(page).not.toContain("macOS");
      expect(page).not.toContain("Dock");
    }
  });

  it("includes narrow-layout and reduced-motion affordances", () => {
    const styles = renderDeliveryWebStyles();
    const script = renderDeliveryWebScript();

    expect(styles).toContain("@media(max-width:720px)");
    expect(styles).toContain("@media(prefers-reduced-motion:reduce)");
    expect(styles).toContain(":focus-visible");
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
    expect(await page.text()).toContain("Feature demos");

    const remote = await fetch(`${activeServer.url}/remote-control`);
    expect(remote.status).toBe(200);
    expect(await remote.text()).toContain("<h1>Remote Control</h1>");

    const workflow = await fetch(`${activeServer.url}/dynamic-workflow`);
    expect(workflow.status).toBe(200);
    expect(await workflow.text()).toContain("<h1>Dynamic Workflow</h1>");

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
