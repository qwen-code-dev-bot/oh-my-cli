import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const DEFAULT_DELIVERY_WEB_PORT = 4317;
export const DELIVERY_WEB_HOST = "127.0.0.1";
export const DELIVERY_ISSUE_NUMBER = 271;
export const DELIVERY_PULL_REQUEST_NUMBER: number | null = 272;

const REPOSITORY_URL = "https://github.com/qwen-code-dev-bot/oh-my-cli";

export interface DeliveryWebServer {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

export interface DeliveryWebServerOptions {
  port?: number;
}

export function parseDeliveryWebPort(value: unknown): number {
  const port = Number(value ?? DEFAULT_DELIVERY_WEB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Web delivery port must be an integer between 1 and 65535");
  }
  return port;
}

function pullRequestCard(): string {
  if (DELIVERY_PULL_REQUEST_NUMBER === null) {
    return `<article class="evidence-card is-pending">
      <div class="evidence-icon" aria-hidden="true">↗</div>
      <div>
        <span class="evidence-kind">Pull request</span>
        <strong>Opening from this branch</strong>
        <p>Implementation and visual evidence will be linked after publish.</p>
      </div>
      <span class="evidence-state">Pending</span>
    </article>`;
  }
  return `<a class="evidence-card" href="${REPOSITORY_URL}/pull/${DELIVERY_PULL_REQUEST_NUMBER}" target="_blank" rel="noreferrer">
    <div class="evidence-icon" aria-hidden="true">↗</div>
    <div>
      <span class="evidence-kind">Pull request</span>
      <strong>#${DELIVERY_PULL_REQUEST_NUMBER} · Web delivery board</strong>
      <p>Implementation, tests, and browser evidence.</p>
    </div>
    <span class="evidence-state is-open">Open</span>
  </a>`;
}

export function renderDeliveryWebPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="light">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="description" content="Browser-native delivery demos for Oh My CLI Remote Control and Dynamic Workflow.">
    <title>Oh My CLI · Delivery Board</title>
    <link rel="stylesheet" href="/delivery-web.css">
    <script src="/delivery-web.js" defer></script>
  </head>
  <body>
    <div class="page-shell">
      <header class="site-header">
        <a class="brand" href="/" aria-label="Oh My CLI delivery board">
          <span class="brand-mark" aria-hidden="true"><i></i><i></i></span>
          <span><strong>oh-my-cli</strong><small>Delivery board</small></span>
        </a>
        <div class="bot-identity">
          <span class="bot-avatar" aria-hidden="true">Q</span>
          <span><strong>Qwen3.8-Max</strong><small>dev-bot</small></span>
          <span class="online-pill"><i></i>Live evidence</span>
        </div>
      </header>

      <main>
        <section class="hero" aria-labelledby="page-title">
          <div>
            <p class="eyebrow">Post-Desktop delivery · Issue #${DELIVERY_ISSUE_NUMBER}</p>
            <h1 id="page-title">See the feature.<br><span>Trace the delivery.</span></h1>
          </div>
          <p class="hero-copy">Two browser-native control surfaces, tied directly to the GitHub work that delivers them. No desktop chrome. No staged screenshots.</p>
        </section>

        <div class="feature-switcher" role="tablist" aria-label="Delivery demos">
          <button class="feature-tab" type="button" role="tab" aria-selected="true" aria-controls="remote-panel" data-feature-tab="remote">
            <span>01</span>
            <span><strong>Remote Control</strong><small>Connected session</small></span>
          </button>
          <button class="feature-tab" type="button" role="tab" aria-selected="false" aria-controls="workflow-panel" data-feature-tab="workflow">
            <span>02</span>
            <span><strong>Dynamic Workflow</strong><small>Adaptive execution</small></span>
          </button>
        </div>

        <section class="delivery-layout">
          <div class="demo-column">
            <section class="feature-panel" id="remote-panel" role="tabpanel" data-feature-panel="remote">
              <div class="panel-heading">
                <div>
                  <p class="eyebrow">Remote Control · Web session</p>
                  <h2>Operate the active workspace from one control surface.</h2>
                </div>
                <button class="primary-action" type="button" data-action="toggle-session" aria-pressed="true"><i></i><span>End session</span></button>
              </div>

              <div class="remote-console" data-session-state="live">
                <aside class="session-list" aria-label="Remote sessions">
                  <div class="mini-brand">Sessions <span>2</span></div>
                  <button class="session-row is-active" type="button">
                    <span class="device-glyph" aria-hidden="true">◫</span>
                    <span><strong>Design system</strong><small>web · active now</small></span>
                    <i></i>
                  </button>
                  <button class="session-row" type="button">
                    <span class="device-glyph" aria-hidden="true">⌁</span>
                    <span><strong>Release runner</strong><small>cli · 14m ago</small></span>
                  </button>
                  <div class="session-security"><span aria-hidden="true">⌾</span><span><strong>Encrypted</strong><small>End-to-end channel</small></span></div>
                </aside>

                <div class="live-viewport">
                  <div class="viewport-bar">
                    <div><span class="live-dot"></span><strong>design.ohmy.dev</strong><small>Controlled by Qwen3.8-Max</small></div>
                    <div class="latency"><span>Latency</span><strong data-latency>24 ms</strong><i></i><i></i><i></i><i></i></div>
                  </div>
                  <div class="controlled-page">
                    <div class="controlled-nav">
                      <span class="controlled-logo">OM</span>
                      <span>Overview</span><span>Runs</span><span>Evidence</span>
                      <button type="button">Publish</button>
                    </div>
                    <div class="controlled-content">
                      <div class="controlled-copy">
                        <span class="control-tag">Release candidate</span>
                        <h3>One review surface for every agent run.</h3>
                        <p>Follow decisions, changes, and verification without losing the execution thread.</p>
                        <button type="button">Review delivery <span>→</span></button>
                      </div>
                      <div class="controlled-preview">
                        <div class="preview-head"><span>Execution health</span><strong>All systems nominal</strong></div>
                        <div class="metric-grid"><div><small>Checks</small><strong>18/18</strong></div><div><small>Coverage</small><strong>94%</strong></div></div>
                        <div class="signal"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
                      </div>
                    </div>
                    <div class="remote-cursor" aria-hidden="true"><span></span></div>
                  </div>
                  <div class="activity-strip" aria-live="polite">
                    <span>Live activity</span>
                    <ol data-remote-events>
                      <li><time>00:08</time><strong>Publish button focused</strong><small>pointer</small></li>
                      <li><time>00:05</time><strong>Viewport synchronized</strong><small>remote</small></li>
                    </ol>
                  </div>
                </div>
              </div>
            </section>

            <section class="feature-panel" id="workflow-panel" role="tabpanel" data-feature-panel="workflow" hidden>
              <div class="panel-heading">
                <div>
                  <p class="eyebrow">Dynamic Workflow · Adaptive run</p>
                  <h2>Watch the plan change while delivery stays accountable.</h2>
                </div>
                <button class="primary-action" type="button" data-action="run-workflow"><i></i><span>Run workflow</span></button>
              </div>

              <div class="workflow-console">
                <div class="workflow-toolbar">
                  <div><span class="workflow-mark">DW</span><span><strong>adaptive-release</strong><small>4 steps · branch devbot/issue-${DELIVERY_ISSUE_NUMBER}</small></span></div>
                  <div class="run-state" data-workflow-status><i></i>Ready</div>
                </div>
                <div class="workflow-canvas">
                  <div class="execution-thread" aria-hidden="true"></div>
                  <article class="workflow-node" data-workflow-step="0">
                    <span class="node-index">01</span><div><small>Context</small><strong>Inspect request</strong><p>Scope, constraints, repository state</p></div><span class="node-state">Ready</span>
                  </article>
                  <article class="workflow-node" data-workflow-step="1">
                    <span class="node-index">02</span><div><small>Plan</small><strong>Route the work</strong><p>Web surface · tests · evidence</p></div><span class="node-state">Ready</span>
                  </article>
                  <article class="workflow-node" data-workflow-step="2">
                    <span class="node-index">03</span><div><small>Execute</small><strong>Build and verify</strong><p>Renderer, server, browser checks</p></div><span class="node-state">Ready</span>
                  </article>
                  <article class="workflow-node" data-workflow-step="3">
                    <span class="node-index">04</span><div><small>Deliver</small><strong>Open linked PR</strong><p>Commit, checks, review handoff</p></div><span class="node-state">Ready</span>
                  </article>
                </div>
                <aside class="event-ledger" aria-label="Workflow event ledger">
                  <div><span>Event ledger</span><strong>append-only</strong></div>
                  <ol data-workflow-events>
                    <li><time>00:00.000</time><span>Workflow ready for an explicit run.</span></li>
                  </ol>
                </aside>
              </div>
            </section>
          </div>

          <aside class="evidence-column" aria-label="GitHub delivery evidence">
            <div class="evidence-heading">
              <p class="eyebrow">Delivery evidence</p>
              <span class="verified-pill">Verified links</span>
            </div>
            <div class="evidence-trace" aria-hidden="true"><span></span></div>
            <a class="evidence-card" href="${REPOSITORY_URL}/issues/${DELIVERY_ISSUE_NUMBER}" target="_blank" rel="noreferrer">
              <div class="evidence-icon" aria-hidden="true">#</div>
              <div>
                <span class="evidence-kind">Feature issue</span>
                <strong>#${DELIVERY_ISSUE_NUMBER} · Browser delivery demos</strong>
                <p>Remote Control and Dynamic Workflow in one focused Web surface.</p>
              </div>
              <span class="evidence-state is-open">Open</span>
            </a>
            <a class="evidence-card" href="${REPOSITORY_URL}/issues/109" target="_blank" rel="noreferrer">
              <div class="evidence-icon" aria-hidden="true">◇</div>
              <div>
                <span class="evidence-kind">Related issue</span>
                <strong>#109 · Workflow checkpoints</strong>
                <p>Approval and Dynamic Workflow delivery state.</p>
              </div>
              <span class="evidence-state">Related</span>
            </a>
            ${pullRequestCard()}
            <div class="checks-card">
              <div><span class="check-orb">✓</span><span><strong>Delivery contract</strong><small>Loopback-only · no secrets</small></span></div>
              <ul>
                <li><span>Renderer tests</span><strong>Required</strong></li>
                <li><span>Server isolation</span><strong>Required</strong></li>
                <li><span>Browser evidence</span><strong>Required</strong></li>
              </ul>
            </div>
          </aside>
        </section>
      </main>

      <footer class="site-footer">
        <span>qwen-code-dev-bot / oh-my-cli</span>
        <span>Issue #${DELIVERY_ISSUE_NUMBER} · local Web surface</span>
      </footer>
    </div>
  </body>
</html>`;
}

export function renderDeliveryWebStyles(): string {
  return `:root {
  color-scheme: light;
  font-family: Inter, "Avenir Next", "Segoe UI", sans-serif;
  color: #10182b;
  background: #f5f7fb;
  font-synthesis: none;
  --ink: #10182b;
  --muted: #687189;
  --paper: #ffffff;
  --line: #dce2ee;
  --blue: #3157ff;
  --blue-soft: #e9eeff;
  --green: #14885f;
  --green-soft: #e9f7f1;
  --violet: #7657d8;
  --amber: #b97918;
}

* { box-sizing: border-box; }
html { min-width: 320px; background: #f5f7fb; }
body { margin: 0; min-height: 100vh; background: radial-gradient(circle at 84% 6%, #e5eaff 0, transparent 28rem), #f5f7fb; }
button, a { font: inherit; }
button { color: inherit; }
button:focus-visible, a:focus-visible { outline: 3px solid #3157ff55; outline-offset: 3px; }
a { color: inherit; text-decoration: none; }
[hidden] { display: none !important; }

.page-shell { width: min(1480px, 100%); min-height: 100vh; margin: 0 auto; padding: 0 42px; }
.site-header { display: flex; align-items: center; justify-content: space-between; height: 88px; border-bottom: 1px solid #dce2ee; }
.brand, .bot-identity { display: flex; align-items: center; gap: 12px; }
.brand-mark { position: relative; display: grid; width: 38px; height: 38px; place-items: center; overflow: hidden; border-radius: 11px; background: #10182b; }
.brand-mark i { position: absolute; width: 20px; height: 6px; border-radius: 5px; background: #ffffff; transform: rotate(-38deg); }
.brand-mark i:last-child { width: 9px; background: #6f8aff; transform: translate(9px, 7px) rotate(-38deg); }
.brand strong, .brand small, .bot-identity strong, .bot-identity small { display: block; }
.brand strong { font-size: 14px; letter-spacing: -.02em; }
.brand small, .bot-identity small { margin-top: 2px; color: #798198; font-family: "SFMono-Regular", Consolas, monospace; font-size: 10px; }
.bot-avatar { display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid #cdd7ff; border-radius: 50%; color: #2445c8; background: #edf1ff; font-weight: 800; }
.bot-identity strong { font-size: 12px; }
.online-pill, .verified-pill { display: inline-flex; align-items: center; gap: 7px; margin-left: 8px; padding: 7px 10px; border: 1px solid #b8dfcf; border-radius: 999px; color: #0e704d; background: #edf9f4; font-size: 10px; font-weight: 700; }
.online-pill i { width: 7px; height: 7px; border-radius: 50%; background: #18a06f; box-shadow: 0 0 0 4px #18a06f1c; }

main { padding-bottom: 38px; }
.hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(300px, .72fr); gap: 80px; align-items: end; padding: 64px 0 42px; }
.eyebrow { margin: 0 0 12px; color: #6f7890; font-family: "SFMono-Regular", Consolas, monospace; font-size: 10px; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }
.hero h1 { margin: 0; font-family: ui-rounded, "Avenir Next", "Segoe UI", sans-serif; font-size: clamp(43px, 5vw, 72px); font-weight: 750; letter-spacing: -.065em; line-height: .98; }
.hero h1 span { color: #3157ff; }
.hero-copy { margin: 0 0 4px; max-width: 520px; color: #626c83; font-size: 15px; line-height: 1.7; }

.feature-switcher { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin-bottom: 16px; border: 1px solid #dce2ee; border-radius: 16px; background: #ffffff; box-shadow: 0 9px 30px #1d315c0a; }
.feature-tab { display: grid; grid-template-columns: 42px 1fr; gap: 12px; align-items: center; padding: 17px 20px; border: 0; border-radius: 15px; background: transparent; text-align: left; cursor: pointer; }
.feature-tab + .feature-tab { border-left: 1px solid #dce2ee; }
.feature-tab > span:first-child { color: #9aa2b5; font-family: "SFMono-Regular", Consolas, monospace; font-size: 11px; }
.feature-tab strong, .feature-tab small { display: block; }
.feature-tab strong { font-size: 13px; }
.feature-tab small { margin-top: 4px; color: #81899c; font-size: 10px; }
.feature-tab[aria-selected="true"] { color: #2445c8; background: linear-gradient(95deg, #eef2ff, #ffffff); box-shadow: inset 3px 0 #3157ff; }
.feature-tab[aria-selected="true"] > span:first-child { color: #3157ff; }

.delivery-layout { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; }
.demo-column, .evidence-column { min-width: 0; }
.feature-panel { min-height: 660px; padding: 28px; border: 1px solid #dce2ee; border-radius: 20px; background: #ffffff; box-shadow: 0 18px 45px #1d315c0d; }
.panel-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; margin-bottom: 25px; }
.panel-heading h2 { max-width: 660px; margin: 0; font-size: clamp(22px, 2.3vw, 34px); font-weight: 680; letter-spacing: -.045em; line-height: 1.12; }
.primary-action { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 9px; padding: 11px 15px; border: 1px solid #2445c8; border-radius: 10px; color: #ffffff; background: #3157ff; box-shadow: 0 7px 18px #3157ff32; cursor: pointer; font-size: 11px; font-weight: 700; }
.primary-action i { width: 7px; height: 7px; border-radius: 50%; background: #9affd5; }
.primary-action:hover { background: #2449e8; }

.remote-console { display: grid; grid-template-columns: 190px minmax(0, 1fr); min-height: 530px; overflow: hidden; border: 1px solid #ccd4e3; border-radius: 15px; background: #f9faff; }
.session-list { padding: 17px 11px; border-right: 1px solid #dce2ee; background: #f3f5fa; }
.mini-brand { display: flex; align-items: center; justify-content: space-between; padding: 0 7px 14px; color: #6f7890; font-size: 10px; font-weight: 700; text-transform: uppercase; }
.mini-brand span { display: grid; width: 20px; height: 20px; place-items: center; border-radius: 6px; color: #3157ff; background: #e4eaff; font-size: 9px; }
.session-row { display: grid; grid-template-columns: 28px 1fr 7px; gap: 8px; align-items: center; width: 100%; padding: 11px 8px; border: 0; border-radius: 10px; background: transparent; text-align: left; cursor: pointer; }
.session-row.is-active { background: #ffffff; box-shadow: 0 5px 16px #2435590e; }
.device-glyph { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid #d4dbea; border-radius: 8px; color: #3157ff; background: #f8faff; }
.session-row strong, .session-row small { display: block; }
.session-row strong { font-size: 10px; }
.session-row small { margin-top: 4px; color: #858da0; font-size: 8px; }
.session-row i { width: 7px; height: 7px; border-radius: 50%; background: #1aa270; box-shadow: 0 0 0 3px #1aa27018; }
.session-security { display: flex; gap: 9px; align-items: center; margin: 24px 6px 0; padding-top: 18px; border-top: 1px solid #dce2ee; color: #627087; }
.session-security > span:first-child { color: #14885f; }
.session-security strong, .session-security small { display: block; }
.session-security strong { font-size: 9px; }
.session-security small { margin-top: 3px; font-size: 8px; }
.live-viewport { display: grid; grid-template-rows: 58px minmax(0, 1fr) 112px; min-width: 0; background: #ffffff; }
.viewport-bar { display: flex; align-items: center; justify-content: space-between; padding: 0 17px; border-bottom: 1px solid #e0e5ef; }
.viewport-bar > div:first-child { display: grid; grid-template-columns: 8px 1fr; column-gap: 8px; align-items: center; }
.viewport-bar strong, .viewport-bar small { display: block; }
.viewport-bar strong { font-size: 10px; }
.viewport-bar small { grid-column: 2; margin-top: 3px; color: #8991a4; font-size: 8px; }
.live-dot { grid-row: 1 / 3; width: 7px; height: 7px; border-radius: 50%; background: #19a773; box-shadow: 0 0 0 4px #19a77318; }
.latency { display: flex; align-items: end; gap: 4px; height: 28px; color: #7f879a; font-family: "SFMono-Regular", Consolas, monospace; font-size: 7px; }
.latency strong { margin: 0 6px 0 2px; color: #14885f; font-size: 9px; }
.latency i { width: 3px; border-radius: 3px; background: #56b994; }
.latency i:nth-last-child(4) { height: 7px; }.latency i:nth-last-child(3) { height: 13px; }.latency i:nth-last-child(2) { height: 18px; }.latency i:last-child { height: 11px; }
.controlled-page { position: relative; overflow: hidden; margin: 13px; border: 1px solid #d8deea; border-radius: 12px; background: #f8f9fc; }
.controlled-nav { display: flex; align-items: center; gap: 18px; height: 48px; padding: 0 16px; border-bottom: 1px solid #e0e5ef; color: #778096; font-size: 8px; }
.controlled-logo { display: grid; width: 24px; height: 24px; margin-right: 3px; place-items: center; border-radius: 7px; color: #ffffff; background: #111a2e; font-size: 7px; font-weight: 800; }
.controlled-nav button { margin-left: auto; padding: 7px 11px; border: 0; border-radius: 7px; color: #ffffff; background: #3157ff; font-size: 8px; }
.controlled-content { display: grid; grid-template-columns: 1.1fr .9fr; gap: 18px; padding: 28px 24px; }
.control-tag { display: inline-block; padding: 5px 8px; border-radius: 999px; color: #3157ff; background: #e9eeff; font-size: 7px; font-weight: 700; text-transform: uppercase; }
.controlled-copy h3 { margin: 12px 0 8px; max-width: 300px; font-size: 22px; letter-spacing: -.05em; line-height: 1.06; }
.controlled-copy p { margin: 0; max-width: 320px; color: #768095; font-size: 8px; line-height: 1.6; }
.controlled-copy button { margin-top: 17px; padding: 8px 10px; border: 1px solid #d3daea; border-radius: 7px; background: #ffffff; font-size: 8px; }
.controlled-copy button span { color: #3157ff; }
.controlled-preview { align-self: center; padding: 15px; border: 1px solid #dce2ee; border-radius: 10px; background: #ffffff; box-shadow: 0 13px 28px #23345a12; }
.preview-head { display: flex; justify-content: space-between; color: #7f879a; font-size: 7px; }
.preview-head strong { color: #14885f; }
.metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin: 13px 0; }
.metric-grid div { padding: 10px; border-radius: 7px; background: #f3f5f9; }
.metric-grid small, .metric-grid strong { display: block; }.metric-grid small { color: #8a92a4; font-size: 7px; }.metric-grid strong { margin-top: 4px; font-size: 14px; }
.signal { display: flex; align-items: end; gap: 5px; height: 50px; padding-top: 7px; border-top: 1px solid #edf0f5; }
.signal span { flex: 1; border-radius: 3px 3px 1px 1px; background: #8fa4ff; }.signal span:nth-child(1) { height: 25%; }.signal span:nth-child(2) { height: 45%; }.signal span:nth-child(3) { height: 38%; }.signal span:nth-child(4) { height: 72%; }.signal span:nth-child(5) { height: 58%; }.signal span:nth-child(6) { height: 88%; }.signal span:nth-child(7) { height: 70%; background: #3157ff; }
.remote-cursor { position: absolute; right: 27%; bottom: 25%; display: grid; width: 38px; height: 38px; place-items: center; border: 1px solid #3157ff99; border-radius: 50%; background: #3157ff15; box-shadow: 0 0 0 8px #3157ff0a; }
.remote-cursor span { display: block; width: 9px; height: 13px; clip-path: polygon(0 0, 100% 72%, 58% 76%, 72% 100%, 55% 100%, 43% 80%, 0 100%); background: #173dd6; }
.activity-strip { padding: 12px 17px; border-top: 1px solid #e0e5ef; overflow: hidden; }
.activity-strip > span { color: #7f879a; font-size: 8px; font-weight: 700; text-transform: uppercase; }
.activity-strip ol, .event-ledger ol { margin: 8px 0 0; padding: 0; list-style: none; }
.activity-strip li { display: grid; grid-template-columns: 38px 1fr auto; gap: 8px; padding: 6px 0; border-top: 1px solid #edf0f5; font-size: 8px; }
.activity-strip time, .activity-strip small { color: #9098aa; font-family: "SFMono-Regular", Consolas, monospace; }
.remote-console[data-session-state="idle"] .live-dot, .remote-console[data-session-state="idle"] .session-row i { background: #a4aab7; box-shadow: none; }
.remote-console[data-session-state="idle"] .controlled-page { filter: saturate(.4); opacity: .74; }

.workflow-console { overflow: hidden; border: 1px solid #ccd4e3; border-radius: 15px; background: #f8f9fd; }
.workflow-toolbar { display: flex; align-items: center; justify-content: space-between; height: 64px; padding: 0 18px; border-bottom: 1px solid #dce2ee; background: #ffffff; }
.workflow-toolbar > div:first-child { display: flex; align-items: center; gap: 10px; }
.workflow-mark { display: grid; width: 31px; height: 31px; place-items: center; border-radius: 9px; color: #ffffff; background: #10182b; font-size: 8px; font-weight: 800; }
.workflow-toolbar strong, .workflow-toolbar small { display: block; }
.workflow-toolbar strong { font-size: 10px; }.workflow-toolbar small { margin-top: 3px; color: #8a92a4; font-family: "SFMono-Regular", Consolas, monospace; font-size: 7px; }
.run-state { display: flex; align-items: center; gap: 7px; padding: 7px 9px; border: 1px solid #dce2ee; border-radius: 999px; color: #758096; background: #f8f9fc; font-size: 8px; font-weight: 700; }
.run-state i { width: 6px; height: 6px; border-radius: 50%; background: #9aa2b4; }
.run-state.is-running { color: #2445c8; border-color: #bfcaff; background: #eef2ff; }.run-state.is-running i { background: #3157ff; box-shadow: 0 0 0 4px #3157ff15; }
.run-state.is-complete { color: #0e704d; border-color: #b8dfcf; background: #edf9f4; }.run-state.is-complete i { background: #18a06f; }
.workflow-canvas { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 17px; min-height: 300px; padding: 70px 30px 62px; background-image: radial-gradient(#cdd5e5 1px, transparent 1px); background-size: 19px 19px; }
.execution-thread { position: absolute; top: 156px; right: 11%; left: 11%; height: 2px; background: linear-gradient(90deg, #3157ff, #7b62dd, #18a06f); opacity: .25; }
.workflow-node { position: relative; z-index: 1; min-height: 160px; padding: 15px; border: 1px solid #d5dcea; border-radius: 13px; background: #ffffff; box-shadow: 0 10px 28px #23345a0c; }
.workflow-node::before { position: absolute; top: 73px; right: -22px; width: 22px; height: 2px; background: #bcc8ff; content: ""; }
.workflow-node:last-child::before { display: none; }
.node-index { display: grid; width: 28px; height: 28px; margin-bottom: 23px; place-items: center; border: 1px solid #d8dfec; border-radius: 8px; color: #7c8599; background: #f8f9fc; font-family: "SFMono-Regular", Consolas, monospace; font-size: 8px; }
.workflow-node small, .workflow-node strong, .workflow-node p { display: block; }
.workflow-node small { color: #8b93a5; font-size: 7px; text-transform: uppercase; }.workflow-node strong { margin-top: 5px; font-size: 10px; }.workflow-node p { margin: 6px 0 0; color: #8991a3; font-size: 7px; line-height: 1.45; }
.node-state { position: absolute; right: 12px; bottom: 12px; color: #9299aa; font-family: "SFMono-Regular", Consolas, monospace; font-size: 7px; }
.workflow-node[data-state="active"] { border-color: #8299ff; box-shadow: 0 0 0 4px #3157ff0d, 0 15px 35px #3157ff18; }.workflow-node[data-state="active"] .node-index { color: #ffffff; border-color: #3157ff; background: #3157ff; }.workflow-node[data-state="active"] .node-state { color: #3157ff; }
.workflow-node[data-state="complete"] { border-color: #b7decf; background: #fbfffd; }.workflow-node[data-state="complete"] .node-index { color: #0f7652; border-color: #acd7c5; background: #eaf8f2; }.workflow-node[data-state="complete"] .node-state { color: #14885f; }
.event-ledger { display: grid; grid-template-columns: 150px 1fr; min-height: 140px; padding: 18px; border-top: 1px solid #dce2ee; background: #ffffff; }
.event-ledger > div span, .event-ledger > div strong { display: block; }.event-ledger > div span { font-size: 9px; font-weight: 700; }.event-ledger > div strong { margin-top: 5px; color: #8b93a5; font-family: "SFMono-Regular", Consolas, monospace; font-size: 7px; }
.event-ledger ol { margin: 0; }.event-ledger li { display: grid; grid-template-columns: 70px 1fr; padding: 7px 0; border-bottom: 1px solid #edf0f5; font-size: 8px; }.event-ledger time { color: #8d95a7; font-family: "SFMono-Regular", Consolas, monospace; }

.evidence-column { position: relative; padding: 23px; border: 1px solid #dce2ee; border-radius: 20px; background: #f0f3f9; }
.evidence-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
.evidence-heading .eyebrow { margin: 0; }
.verified-pill { margin: 0; padding: 6px 8px; font-size: 8px; }
.evidence-trace { position: absolute; top: 84px; bottom: 232px; left: 39px; width: 1px; background: #bcc7e0; }.evidence-trace span { position: absolute; top: 0; left: -2px; width: 5px; height: 52%; border-radius: 4px; background: #3157ff; }
.evidence-card { position: relative; display: grid; grid-template-columns: 38px 1fr auto; gap: 10px; align-items: start; margin-bottom: 11px; padding: 15px 13px; border: 1px solid #d8deea; border-radius: 13px; background: #ffffff; box-shadow: 0 8px 20px #2234580a; transition: transform 150ms ease, border-color 150ms ease; }
a.evidence-card:hover { border-color: #aebeff; transform: translateY(-2px); }
.evidence-icon { position: relative; z-index: 1; display: grid; width: 34px; height: 34px; place-items: center; border: 1px solid #ccd6ff; border-radius: 10px; color: #3157ff; background: #eef2ff; font-family: "SFMono-Regular", Consolas, monospace; font-weight: 800; }
.evidence-kind { color: #8991a3; font-family: "SFMono-Regular", Consolas, monospace; font-size: 7px; text-transform: uppercase; }
.evidence-card strong { display: block; margin-top: 4px; font-size: 10px; line-height: 1.35; }
.evidence-card p { margin: 6px 0 0; color: #7d8598; font-size: 8px; line-height: 1.5; }
.evidence-state { padding: 4px 6px; border-radius: 999px; color: #787f91; background: #eef0f4; font-family: "SFMono-Regular", Consolas, monospace; font-size: 6px; font-weight: 700; text-transform: uppercase; }
.evidence-state.is-open { color: #0e704d; background: #e9f7f1; }
.evidence-card.is-pending { opacity: .7; }
.checks-card { margin-top: 18px; padding: 16px; border-radius: 13px; color: #dce5ff; background: #10182b; }
.checks-card > div { display: flex; gap: 10px; align-items: center; }
.check-orb { display: grid; width: 31px; height: 31px; place-items: center; border-radius: 9px; color: #95ffd6; background: #1c2d46; }
.checks-card strong, .checks-card small { display: block; }.checks-card strong { font-size: 9px; }.checks-card small { margin-top: 4px; color: #8e9ab3; font-size: 7px; }
.checks-card ul { margin: 15px 0 0; padding: 12px 0 0; border-top: 1px solid #2b3a53; list-style: none; }.checks-card li { display: flex; justify-content: space-between; margin: 9px 0; color: #9aa6bd; font-size: 8px; }.checks-card li strong { color: #dbe4f7; font-family: "SFMono-Regular", Consolas, monospace; font-size: 7px; }
.site-footer { display: flex; justify-content: space-between; padding: 24px 0 32px; border-top: 1px solid #dce2ee; color: #858da0; font-family: "SFMono-Regular", Consolas, monospace; font-size: 9px; }

@media (max-width: 1060px) {
  .page-shell { padding-inline: 24px; }
  .delivery-layout { grid-template-columns: 1fr; }
  .evidence-column { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; }
  .evidence-heading, .checks-card { grid-column: 1 / -1; }
  .evidence-card { margin: 0; }
  .evidence-trace { display: none; }
}

@media (max-width: 760px) {
  .page-shell { padding-inline: 15px; }
  .site-header { height: 72px; }
  .online-pill { display: none; }
  .hero { grid-template-columns: 1fr; gap: 22px; padding: 44px 0 30px; }
  .hero h1 { font-size: 45px; }
  .feature-switcher { grid-template-columns: 1fr; }
  .feature-tab + .feature-tab { border-top: 1px solid #dce2ee; border-left: 0; }
  .feature-panel { min-height: 0; padding: 18px; }
  .panel-heading { display: block; }.primary-action { margin-top: 18px; }
  .remote-console { grid-template-columns: 1fr; }.session-list { display: none; }
  .workflow-canvas { grid-template-columns: 1fr; padding: 25px; }.execution-thread, .workflow-node::before { display: none; }
  .event-ledger { grid-template-columns: 1fr; gap: 12px; }
  .evidence-column { grid-template-columns: 1fr; }
  .evidence-heading, .checks-card { grid-column: auto; }
  .site-footer { display: grid; gap: 8px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}`;
}

export function renderDeliveryWebScript(): string {
  return `(() => {
  const tabs = [...document.querySelectorAll("[data-feature-tab]")];
  const panels = [...document.querySelectorAll("[data-feature-panel]")];
  const allowed = new Set(["remote", "workflow"]);

  function showFeature(feature) {
    if (!allowed.has(feature)) return;
    tabs.forEach((tab) => {
      const selected = tab.dataset.featureTab === feature;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.featurePanel !== feature;
    });
    history.replaceState(null, "", "#" + feature);
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => showFeature(tab.dataset.featureTab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + direction + tabs.length) % tabs.length];
      showFeature(next.dataset.featureTab);
      next.focus();
    });
  });

  const sessionButton = document.querySelector('[data-action="toggle-session"]');
  const remoteConsole = document.querySelector(".remote-console");
  const remoteEvents = document.querySelector("[data-remote-events]");
  const latency = document.querySelector("[data-latency]");
  sessionButton?.addEventListener("click", () => {
    const live = remoteConsole.dataset.sessionState === "live";
    remoteConsole.dataset.sessionState = live ? "idle" : "live";
    sessionButton.setAttribute("aria-pressed", String(!live));
    sessionButton.querySelector("span").textContent = live ? "Start session" : "End session";
    latency.textContent = live ? "Offline" : "22 ms";
    const event = document.createElement("li");
    event.innerHTML = '<time>now</time><strong>' + (live ? "Remote session ended" : "Secure session established") + '</strong><small>control</small>';
    remoteEvents.prepend(event);
  });

  const workflowButton = document.querySelector('[data-action="run-workflow"]');
  const workflowStatus = document.querySelector("[data-workflow-status]");
  const workflowEvents = document.querySelector("[data-workflow-events]");
  const steps = [...document.querySelectorAll("[data-workflow-step]")];
  let workflowTimer = null;

  workflowButton?.addEventListener("click", () => {
    if (workflowTimer) return;
    steps.forEach((step) => {
      step.dataset.state = "";
      step.querySelector(".node-state").textContent = "Ready";
    });
    workflowStatus.className = "run-state is-running";
    workflowStatus.innerHTML = "<i></i>Running";
    workflowEvents.innerHTML = "";
    workflowButton.disabled = true;
    workflowButton.querySelector("span").textContent = "Running";
    let index = 0;

    const advance = () => {
      if (index > 0) {
        const previous = steps[index - 1];
        previous.dataset.state = "complete";
        previous.querySelector(".node-state").textContent = "Passed";
      }
      if (index === steps.length) {
        workflowStatus.className = "run-state is-complete";
        workflowStatus.innerHTML = "<i></i>Complete";
        workflowButton.disabled = false;
        workflowButton.querySelector("span").textContent = "Run again";
        workflowTimer = null;
        return;
      }
      const step = steps[index];
      step.dataset.state = "active";
      step.querySelector(".node-state").textContent = "Running";
      const item = document.createElement("li");
      item.innerHTML = "<time>00:0" + index + "." + String(index * 173).padStart(3, "0") + "</time><span>" + step.querySelector("strong").textContent + "</span>";
      workflowEvents.prepend(item);
      index += 1;
      workflowTimer = window.setTimeout(advance, 650);
    };
    advance();
  });

  const initial = location.hash.slice(1);
  showFeature(allowed.has(initial) ? initial : "remote");
})();`;
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headOnly: boolean,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  response.end(headOnly ? undefined : body);
}

export async function startDeliveryWebServer(
  options: DeliveryWebServerOptions = {},
): Promise<DeliveryWebServer> {
  const port = options.port ?? DEFAULT_DELIVERY_WEB_PORT;
  const server = createServer((request, response) => {
    const method = request.method ?? "GET";
    const headOnly = method === "HEAD";
    if (method !== "GET" && !headOnly) {
      send(response, 405, "text/plain; charset=utf-8", "Method not allowed", headOnly);
      return;
    }
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/" || pathname === "/index.html") {
      send(response, 200, "text/html; charset=utf-8", renderDeliveryWebPage(), headOnly);
    } else if (pathname === "/delivery-web.css") {
      send(response, 200, "text/css; charset=utf-8", renderDeliveryWebStyles(), headOnly);
    } else if (pathname === "/delivery-web.js") {
      send(
        response,
        200,
        "text/javascript; charset=utf-8",
        renderDeliveryWebScript(),
        headOnly,
      );
    } else if (pathname === "/health") {
      send(response, 200, "application/json; charset=utf-8", '{"ok":true}', headOnly);
    } else {
      send(response, 404, "text/plain; charset=utf-8", "Not found", headOnly);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, DELIVERY_WEB_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://${DELIVERY_WEB_HOST}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
