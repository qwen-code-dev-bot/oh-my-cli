import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  renderSessionTimeMachinePage,
  renderSessionTimeMachineScript,
  renderSessionTimeMachineStyles,
} from "./delivery-web-session-time-machine.js";

export const DEFAULT_DELIVERY_WEB_PORT = 4317;
export const DELIVERY_WEB_HOST = "127.0.0.1";
export const DELIVERY_PULL_REQUEST_NUMBER = 272;

export type DeliveryWebPage =
  | "index"
  | "remote-control"
  | "dynamic-workflow"
  | "session-time-machine";

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

function directoryPage(): string {
  return `<main class="directory-page" aria-label="Feature demos">
    <section class="feature-directory" aria-label="Available feature demos">
      <a class="directory-card remote-card" href="/remote-control">
        <div class="card-copy">
          <span class="card-kicker"><i></i>Connected session</span>
          <h2>Remote Control</h2>
          <p>Operate a live Web workspace through a secure, observable session.</p>
          <ul><li>Live viewport state</li><li>Session activity trail</li><li>Loopback boundary</li></ul>
          <span class="open-page">Open feature page <b>→</b></span>
        </div>
        <div class="remote-thumbnail" aria-hidden="true">
          <aside><i></i><span></span><span></span></aside>
          <div><header><i></i><span></span></header><main><span></span><strong></strong><small></small></main><footer><i></i><i></i></footer></div>
        </div>
      </a>
      <a class="directory-card workflow-card" href="/dynamic-workflow">
        <div class="card-copy">
          <span class="card-kicker"><i></i>Adaptive execution</span>
          <h2>Dynamic Workflow</h2>
          <p>Watch an execution plan advance while every transition stays traceable.</p>
          <ul><li>Live execution graph</li><li>Step-level state</li><li>Append-only ledger</li></ul>
          <span class="open-page">Open feature page <b>→</b></span>
        </div>
        <div class="workflow-thumbnail" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
          <i></i>
        </div>
      </a>
      <a class="directory-card time-card" href="/session-time-machine">
        <div class="card-copy">
          <span class="card-kicker"><i></i>Durable replay</span>
          <h2>Session Time Machine</h2>
          <p>Scrub an agent session across prompts, tools, patches, and recovery checkpoints.</p>
          <ul><li>Durable checkpoints</li><li>Tool-result replay</li><li>Recovery-safe timeline</li></ul>
          <span class="open-page">Open feature page <b>→</b></span>
        </div>
        <div class="time-thumbnail" aria-hidden="true"><span></span><span></span><span></span></div>
      </a>
    </section>
  </main>`;
}

function remoteControlPage(): string {
  return `<main class="feature-page">
    <section class="feature-layout">
      <div class="demo-surface">
        <div class="surface-toolbar">
          <div><span class="surface-mark">RC</span><span><strong>iPhone 16 Pro → design-system</strong><small data-phone-copy>encrypted Web session · connected now</small></span></div>
          <div class="latency"><span>Latency</span><strong data-latency>24 ms</strong><i></i><i></i><i></i><i></i></div>
          <button class="primary-action" type="button" data-action="toggle-session" aria-pressed="true"><i></i><span>End session</span></button>
        </div>
        <div class="remote-console" data-session-state="live">
          <aside class="phone-link-panel" aria-label="Connected phone">
            <div class="phone-device">
              <div class="phone-speaker"></div>
              <div class="phone-screen">
                <div class="phone-top"><span>9:41</span><span>⌁ 5G ▰</span></div>
                <div class="phone-app">
                  <span class="phone-app-mark">OM</span>
                  <small>Remote Control</small>
                  <strong data-phone-status>Connected</strong>
                  <div class="phone-pulse"><i></i><i></i><i></i></div>
                  <div class="phone-target"><span>◫</span><span><small>Controlling</small><b>design.ohmy.dev</b></span></div>
                </div>
                <div class="phone-home"></div>
              </div>
            </div>
            <div class="connection-handshake">
              <span><i></i>Device verified</span>
              <span><i></i>Encrypted channel</span>
              <span><i></i>Viewport synchronized</span>
            </div>
            <div class="connection-beam" aria-hidden="true"><i></i><i></i><i></i><span>live control</span></div>
          </aside>
          <div class="live-viewport">
            <div class="viewport-bar"><span><i></i>design.ohmy.dev</span><small>Controlled from iPhone 16 Pro</small></div>
            <div class="controlled-page">
              <div class="controlled-nav"><b>OM</b><span>Overview</span><span>Runs</span><span>Evidence</span><button>Publish</button></div>
              <div class="controlled-content">
                <div><small>Release candidate</small><h2>Review every agent run in one place.</h2><p>Follow decisions, changes, and verification without losing the execution thread.</p><button>Review delivery →</button></div>
                <aside><header><span>Execution health</span><strong>Nominal</strong></header><div><span><small>Checks</small><b>18/18</b></span><span><small>Coverage</small><b>94%</b></span></div><footer><i></i><i></i><i></i><i></i><i></i><i></i><i></i></footer></aside>
              </div>
              <span class="remote-cursor" aria-hidden="true"></span>
            </div>
            <div class="activity-strip"><span>Live activity</span><ol data-remote-events><li><time>00:08</time><strong>Publish button focused</strong><small>pointer</small></li><li><time>00:05</time><strong>Viewport synchronized</strong><small>remote</small></li></ol></div>
          </div>
        </div>
      </div>
      <aside class="feature-notes">
        <p class="section-label">Live session</p>
        <article><span>01</span><div><strong>Phone identity is explicit</strong><p>The connected device, network, and controlled Web target stay visible.</p></div></article>
        <article><span>02</span><div><strong>Handshake before control</strong><p>Device verification, encryption, and viewport sync form the session boundary.</p></div></article>
        <article><span>03</span><div><strong>Actions remain observable</strong><p>Phone input appears in the Web activity stream as it happens.</p></div></article>
        <div class="try-note"><strong>Try the connection</strong><p>End the session and start it again. The phone, handshake, latency, and Web viewport change together.</p></div>
      </aside>
    </section>
  </main>`;
}

function dynamicWorkflowPage(): string {
  return `<main class="feature-page">
    <section class="feature-layout">
      <div class="demo-surface">
        <div class="surface-toolbar">
          <div><span class="surface-mark workflow-mark">DW</span><span><strong>adaptive-release.workflow</strong><small>7 nodes · 2 parallel lanes · 1 approval gate</small></span></div>
          <div class="run-state" data-workflow-status><i></i>Ready</div>
          <button class="primary-action" type="button" data-action="run-workflow"><i></i><span>Run workflow</span></button>
        </div>
        <div class="workflow-console">
          <div class="workflow-canvas">
            <div class="canvas-toolbar"><span>adaptive-release</span><span><i></i>Auto layout</span><span>100%</span></div>
            <div class="workflow-board">
              <svg class="workflow-links" viewBox="0 0 1020 460" preserveAspectRatio="none" aria-hidden="true">
                <path d="M120 230 H175"></path>
                <path d="M295 230 H350"></path>
                <path d="M470 230 C495 230 500 116 525 116"></path>
                <path d="M470 230 C495 230 500 344 525 344"></path>
                <path d="M645 116 H665 C690 116 675 230 700 230"></path>
                <path d="M645 344 H665 C690 344 675 230 700 230"></path>
                <path d="M820 230 H875"></path>
              </svg>
              <article class="workflow-node trigger-node" data-workflow-step="0"><i class="node-port in"></i><span class="node-icon">▶</span><div><small>Trigger</small><strong>Issue labeled</strong><p>agent-active</p></div><span class="node-state">Ready</span><i class="node-port out"></i></article>
              <article class="workflow-node context-node" data-workflow-step="1"><i class="node-port in"></i><span class="node-icon">⌁</span><div><small>Context</small><strong>Inspect request</strong><p>Repo + constraints</p></div><span class="node-state">Ready</span><i class="node-port out"></i></article>
              <article class="workflow-node router-node" data-workflow-step="2"><i class="node-port in"></i><span class="node-icon">◇</span><div><small>Router</small><strong>Parallelize</strong><p>Build + verify</p></div><span class="node-state">Ready</span><i class="node-port out"></i></article>
              <article class="workflow-node build-node" data-workflow-step="3"><i class="node-port in"></i><span class="node-icon">⌘</span><div><small>Build lane</small><strong>Render Web UI</strong><p>TypeScript + CSS</p></div><span class="node-state">Ready</span><i class="node-port out"></i></article>
              <article class="workflow-node verify-node" data-workflow-step="4"><i class="node-port in"></i><span class="node-icon">✓</span><div><small>Verify lane</small><strong>Run browser tests</strong><p>Desktop + mobile</p></div><span class="node-state">Ready</span><i class="node-port out"></i></article>
              <article class="workflow-node approval-node" data-workflow-step="5"><i class="node-port in"></i><span class="node-icon">⏸</span><div><small>Approval gate</small><strong>Review evidence</strong><p>Wait for checks</p></div><span class="node-state">Ready</span><i class="node-port out"></i></article>
              <article class="workflow-node delivery-node" data-workflow-step="6"><i class="node-port in"></i><span class="node-icon">↗</span><div><small>Delivery</small><strong>Update PR #${DELIVERY_PULL_REQUEST_NUMBER}</strong><p>Attach evidence</p></div><span class="node-state">Ready</span><i class="node-port out"></i></article>
            </div>
          </div>
          <aside class="event-ledger"><div><span>Event ledger</span><strong>append-only</strong></div><ol data-workflow-events><li><time>00:00.000</time><span>Workflow ready for an explicit run.</span></li></ol></aside>
        </div>
      </div>
      <aside class="feature-notes">
        <p class="section-label">Orchestration</p>
        <article><span>01</span><div><strong>Branch by responsibility</strong><p>The router separates build and browser verification into parallel lanes.</p></div></article>
        <article><span>02</span><div><strong>Join at an approval gate</strong><p>Both lanes converge before evidence can move into delivery.</p></div></article>
        <article><span>03</span><div><strong>Keep the run traceable</strong><p>Ports, connectors, node state, and the ledger expose the full path.</p></div></article>
        <div class="try-note"><strong>Run the graph</strong><p>Watch the trigger cross the branch, parallel lanes, approval gate, and final PR delivery.</p></div>
      </aside>
    </section>
  </main>`;
}

export function renderDeliveryWebPage(
  page: DeliveryWebPage = "index",
): string {
  const pages = {
    index: ["Feature demos", directoryPage()],
    "remote-control": ["Remote Control", remoteControlPage()],
    "dynamic-workflow": ["Dynamic Workflow", dynamicWorkflowPage()],
    "session-time-machine": [
      "Session Time Machine",
      renderSessionTimeMachinePage(),
    ],
  } satisfies Record<DeliveryWebPage, [string, string]>;
  const [title, content] = pages[page];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="light">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="description" content="${title} · Oh My CLI browser-native feature demo.">
    <title>${title} · Oh My CLI</title>
    <link rel="stylesheet" href="/delivery-web.css">
    <script src="/delivery-web.js" defer></script>
  </head>
  <body>
    <div class="page-shell">
      ${content}
    </div>
  </body>
</html>`;
}

export function renderDeliveryWebStyles(): string {
  return `:root{color-scheme:light;font-family:Inter,"Avenir Next","Segoe UI",sans-serif;color:#10182b;background:#f4f6fa;font-synthesis:none;--ink:#10182b;--muted:#70798e;--paper:#fff;--line:#dce2ec;--blue:#3157ff;--green:#13845d;--violet:#7657d8}
*{box-sizing:border-box}html{min-width:320px;background:#f4f6fa}body{margin:0;min-height:100vh;background:linear-gradient(90deg,#eef1f7 1px,transparent 1px),linear-gradient(#eef1f7 1px,transparent 1px),#f7f8fb;background-size:24px 24px}button,a{font:inherit}button{color:inherit}a{color:inherit;text-decoration:none}button:focus-visible,a:focus-visible{outline:3px solid #3157ff4d;outline-offset:3px}
.page-shell{width:min(1460px,100%);min-height:100vh;margin:auto;padding:0 36px}.product-header{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;height:76px;border-bottom:1px solid var(--line);background:#f7f8fbdd;backdrop-filter:blur(16px)}.brand,.bot-identity{display:flex;align-items:center;gap:11px}.brand-mark{position:relative;width:34px;height:34px;overflow:hidden;border-radius:10px;background:var(--ink)}.brand-mark i{position:absolute;top:14px;left:7px;width:20px;height:5px;border-radius:4px;background:#fff;transform:rotate(-38deg)}.brand-mark i:last-child{top:21px;left:19px;width:8px;background:#7890ff}.brand strong,.brand small,.bot-identity strong,.bot-identity small{display:block}.brand strong{font-size:13px}.brand small,.bot-identity small{margin-top:2px;color:#828a9b;font:9px "SFMono-Regular",Consolas,monospace}.product-nav{display:flex;align-items:center;gap:5px;padding:4px;border:1px solid var(--line);border-radius:10px;background:#fff}.product-nav a{padding:8px 11px;border-radius:7px;color:#747d90;font-size:10px;font-weight:700}.product-nav a[aria-current="page"]{color:#2445cf;background:#eaf0ff}.bot-identity{justify-self:end}.bot-avatar{display:grid;width:31px;height:31px;place-items:center;border:1px solid #cbd5ff;border-radius:50%;color:#2445cf;background:#edf1ff;font-size:11px;font-weight:800}
.directory-page,.feature-page{padding:38px 0}.directory-heading{display:grid;grid-template-columns:1fr minmax(300px,500px);gap:50px;align-items:end;padding:14px 0 30px}.section-label{margin:0 0 8px;color:#7a8397;font:700 9px "SFMono-Regular",Consolas,monospace;letter-spacing:.12em;text-transform:uppercase}.directory-heading h1,.feature-heading h1{margin:0;letter-spacing:-.045em}.directory-heading h1{font-size:34px}.directory-heading>p{margin:0;color:#687287;font-size:13px;line-height:1.65}.feature-directory{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.directory-card{display:grid;grid-template-columns:.78fr 1.22fr;min-height:390px;overflow:hidden;border:1px solid var(--line);border-radius:18px;background:#fff;box-shadow:0 18px 46px #2637590d;transition:transform 160ms ease,border-color 160ms ease}.directory-card:hover{border-color:#aebcff;transform:translateY(-3px)}.card-copy{display:flex;flex-direction:column;padding:30px}.card-kicker{display:flex;align-items:center;gap:7px;color:#647086;font:700 9px "SFMono-Regular",Consolas,monospace}.card-kicker i{width:7px;height:7px;border-radius:50%;background:#18a371;box-shadow:0 0 0 4px #18a37117}.card-copy h2{margin:28px 0 10px;font-size:25px;letter-spacing:-.04em}.card-copy p{margin:0;color:#737c90;font-size:11px;line-height:1.6}.card-copy ul{display:grid;gap:8px;margin:22px 0 28px;padding:0;list-style:none;color:#4f5a70;font-size:10px}.card-copy li::before{margin-right:8px;color:#3157ff;content:"•"}.open-page{margin-top:auto;color:#2445cf;font-size:10px;font-weight:800}.open-page b{margin-left:6px}.remote-thumbnail{display:grid;grid-template-columns:70px 1fr;margin:28px 0 28px 0;overflow:hidden;border:1px solid #d2d9e7;border-right:0;border-radius:14px 0 0 14px;background:#fff;box-shadow:0 15px 28px #20325916}.remote-thumbnail>aside{display:grid;align-content:start;gap:13px;padding:17px 12px;background:#f0f3f8}.remote-thumbnail>aside i{width:25px;height:25px;border-radius:8px;background:#3157ff}.remote-thumbnail>aside span{height:28px;border-radius:7px;background:#fff}.remote-thumbnail>div{display:grid;grid-template-rows:42px 1fr 70px}.remote-thumbnail header{display:flex;align-items:center;gap:9px;padding:0 14px;border-bottom:1px solid #e1e5ed}.remote-thumbnail header i{width:7px;height:7px;border-radius:50%;background:#19a371}.remote-thumbnail header span{width:72px;height:5px;border-radius:4px;background:#d7ddea}.remote-thumbnail main{display:flex;flex-direction:column;justify-content:center;margin:12px;padding:22px;border:1px solid #e0e4ed;border-radius:10px;background:#f8f9fc}.remote-thumbnail main span{width:50px;height:9px;border-radius:9px;background:#dce4ff}.remote-thumbnail main strong{width:72%;height:30px;margin:12px 0 9px;border-radius:5px;background:#172036}.remote-thumbnail main small{width:55%;height:7px;border-radius:5px;background:#d6dce7}.remote-thumbnail footer{display:flex;gap:9px;padding:14px;border-top:1px solid #e1e5ed}.remote-thumbnail footer i{width:40%;height:7px;border-radius:4px;background:#dce2ec}.workflow-thumbnail{position:relative;display:grid;grid-template-columns:repeat(2,1fr);gap:25px;align-content:center;margin:28px 0;padding:40px;border:1px solid #d4dbea;border-right:0;border-radius:14px 0 0 14px;background-image:radial-gradient(#cad2e1 1px,transparent 1px);background-size:17px 17px}.workflow-thumbnail span{position:relative;z-index:1;height:88px;border:1px solid #cbd4e7;border-radius:12px;background:#fff;box-shadow:0 10px 22px #20325912}.workflow-thumbnail span:nth-child(1),.workflow-thumbnail span:nth-child(4){border-color:#91a3f5}.workflow-thumbnail i{position:absolute;top:50%;right:20%;left:20%;height:2px;background:linear-gradient(90deg,#3157ff,#7657d8,#18a371)}.evidence-strip{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr;gap:1px;margin-top:16px;overflow:hidden;border:1px solid var(--line);border-radius:14px;background:var(--line)}.evidence-strip>div,.evidence-strip>a{display:flex;align-items:center;gap:10px;min-height:74px;padding:14px 17px;background:#fff}.evidence-strip>a:hover{background:#f8faff}.evidence-label .status-dot{width:8px;height:8px;border-radius:50%;background:#18a371;box-shadow:0 0 0 5px #18a37117}.evidence-strip small,.evidence-strip strong{display:block}.evidence-strip small{color:#8790a2;font:8px "SFMono-Regular",Consolas,monospace}.evidence-strip strong{margin-top:4px;font-size:10px}.evidence-symbol{display:grid;width:30px;height:30px;place-items:center;border-radius:9px;color:#3157ff;background:#eaf0ff;font-weight:800}.evidence-strip b{margin-left:auto;padding:4px 6px;border-radius:999px;color:#0f7853;background:#eaf8f2;font:700 7px "SFMono-Regular",Consolas,monospace;text-transform:uppercase}.evidence-check>span:first-child{display:grid;width:30px;height:30px;place-items:center;border-radius:9px;color:#7dffd0;background:#17243a}
.feature-heading{display:flex;align-items:end;justify-content:space-between;gap:30px;padding:5px 0 24px}.feature-heading>div>p{display:flex;gap:7px;margin:0 0 10px;color:#7d8699;font:9px "SFMono-Regular",Consolas,monospace}.feature-heading>div>p a:hover{color:#3157ff}.feature-heading>div>p span{color:#b2b8c4}.feature-heading h1{font-size:31px}.heading-meta{display:flex;align-items:center;gap:12px;margin-top:10px;color:#6f788b;font-size:11px}.live-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 8px;border-radius:999px;color:#0f7853;background:#eaf8f2;font:700 8px "SFMono-Regular",Consolas,monospace}.live-badge i{width:6px;height:6px;border-radius:50%;background:#18a371}.github-link{padding:9px 11px;border:1px solid var(--line);border-radius:9px;background:#fff;font-size:9px;font-weight:700}.github-link span{margin-left:6px;color:#3157ff}.feature-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px}.demo-surface,.feature-notes{border:1px solid var(--line);border-radius:17px;background:#fff;box-shadow:0 16px 40px #2637590d}.demo-surface{overflow:hidden}.surface-toolbar{display:grid;grid-template-columns:1fr auto auto;gap:18px;align-items:center;min-height:68px;padding:12px 17px;border-bottom:1px solid var(--line)}.surface-toolbar>div:first-child{display:flex;align-items:center;gap:10px}.surface-mark{display:grid;width:34px;height:34px;place-items:center;border-radius:10px;color:#fff;background:#3157ff;font-size:9px;font-weight:800}.surface-toolbar strong,.surface-toolbar small{display:block}.surface-toolbar strong{font-size:11px}.surface-toolbar small{margin-top:3px;color:#858ea1;font:8px "SFMono-Regular",Consolas,monospace}.primary-action{display:inline-flex;align-items:center;gap:8px;padding:10px 13px;border:1px solid #2445cc;border-radius:9px;color:#fff;background:#3157ff;box-shadow:0 7px 18px #3157ff2b;cursor:pointer;font-size:9px;font-weight:800}.primary-action i{width:6px;height:6px;border-radius:50%;background:#9affd5}.primary-action:disabled{cursor:wait;opacity:.6}.latency{display:flex;align-items:end;gap:3px;color:#7f8799;font:7px "SFMono-Regular",Consolas,monospace}.latency strong{margin:0 5px;color:#13845d;font-size:8px}.latency i{width:3px;border-radius:3px;background:#58ba96}.latency i:nth-last-child(4){height:7px}.latency i:nth-last-child(3){height:13px}.latency i:nth-last-child(2){height:17px}.latency i:last-child{height:10px}.remote-console{display:grid;grid-template-columns:175px minmax(0,1fr);min-height:570px;background:#f8f9fc}.session-list{padding:16px 10px;border-right:1px solid var(--line);background:#f1f3f8}.mini-label{display:flex;justify-content:space-between;padding:0 7px 13px;color:#727b8e;font-size:9px;font-weight:800;text-transform:uppercase}.mini-label span{display:grid;width:18px;height:18px;place-items:center;border-radius:5px;color:#3157ff;background:#e3e9ff}.session-row{display:grid;grid-template-columns:27px 1fr 6px;gap:8px;align-items:center;width:100%;padding:10px 7px;border:0;border-radius:9px;background:transparent;text-align:left}.session-row.is-active{background:#fff;box-shadow:0 6px 15px #2335570d}.device-glyph{display:grid;width:27px;height:27px;place-items:center;border:1px solid #d4dbea;border-radius:8px;color:#3157ff}.session-row strong,.session-row small,.security-note strong,.security-note small{display:block}.session-row strong{font-size:9px}.session-row small,.security-note small{margin-top:3px;color:#858da0;font-size:7px}.session-row i{width:6px;height:6px;border-radius:50%;background:#19a371}.security-note{display:flex;align-items:center;gap:8px;margin:25px 6px 0;padding-top:18px;border-top:1px solid var(--line);color:#637086}.security-note>span:first-child{color:#13845d}.security-note strong{font-size:8px}.live-viewport{display:grid;grid-template-rows:50px minmax(0,1fr) 105px;min-width:0;background:#fff}.viewport-bar{display:flex;align-items:center;justify-content:space-between;padding:0 15px;border-bottom:1px solid #e2e6ee}.viewport-bar span{display:flex;align-items:center;gap:7px;font-size:9px;font-weight:700}.viewport-bar span i{width:7px;height:7px;border-radius:50%;background:#19a371}.viewport-bar small{color:#8991a3;font-size:7px}.controlled-page{position:relative;overflow:hidden;margin:12px;border:1px solid #d9dfea;border-radius:11px;background:#f8f9fc}.controlled-nav{display:flex;align-items:center;gap:17px;height:43px;padding:0 14px;border-bottom:1px solid #e0e5ed;color:#778095;font-size:7px}.controlled-nav b{display:grid;width:23px;height:23px;margin-right:2px;place-items:center;border-radius:7px;color:#fff;background:#111a2e;font-size:7px}.controlled-nav button{margin-left:auto;padding:6px 9px;border:0;border-radius:6px;color:#fff;background:#3157ff;font-size:7px}.controlled-content{display:grid;grid-template-columns:1.08fr .92fr;gap:17px;padding:25px 21px}.controlled-content>div>small{display:inline-block;padding:5px 7px;border-radius:999px;color:#3157ff;background:#e7edff;font-size:6px;font-weight:800;text-transform:uppercase}.controlled-content h2{max-width:310px;margin:11px 0 7px;font-size:20px;letter-spacing:-.045em;line-height:1.08}.controlled-content p{max-width:300px;margin:0;color:#768095;font-size:7px;line-height:1.6}.controlled-content>div>button{margin-top:15px;padding:7px 9px;border:1px solid #d3d9e6;border-radius:7px;background:#fff;font-size:7px}.controlled-content aside{align-self:center;padding:13px;border:1px solid #dce2ec;border-radius:10px;background:#fff;box-shadow:0 12px 26px #23345a12}.controlled-content aside header{display:flex;justify-content:space-between;color:#7d8699;font-size:6px}.controlled-content aside header strong{color:#13845d}.controlled-content aside>div{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:12px 0}.controlled-content aside>div span{padding:9px;border-radius:7px;background:#f2f4f8}.controlled-content aside small,.controlled-content aside b{display:block}.controlled-content aside small{color:#8a92a4;font-size:6px}.controlled-content aside b{margin-top:3px;font-size:12px}.controlled-content aside footer{display:flex;align-items:end;gap:4px;height:45px;border-top:1px solid #edf0f5}.controlled-content aside footer i{flex:1;border-radius:3px 3px 1px 1px;background:#8fa4ff}.controlled-content aside footer i:nth-child(1){height:25%}.controlled-content aside footer i:nth-child(2){height:45%}.controlled-content aside footer i:nth-child(3){height:38%}.controlled-content aside footer i:nth-child(4){height:72%}.controlled-content aside footer i:nth-child(5){height:58%}.controlled-content aside footer i:nth-child(6){height:88%}.controlled-content aside footer i:nth-child(7){height:70%;background:#3157ff}.remote-cursor{position:absolute;right:27%;bottom:25%;width:34px;height:34px;border:1px solid #3157ff8c;border-radius:50%;background:#3157ff13;box-shadow:0 0 0 7px #3157ff09}.activity-strip{padding:11px 15px;border-top:1px solid #e1e5ed}.activity-strip>span{color:#7f8799;font-size:7px;font-weight:800;text-transform:uppercase}.activity-strip ol,.event-ledger ol{margin:7px 0 0;padding:0;list-style:none}.activity-strip li{display:grid;grid-template-columns:36px 1fr auto;gap:7px;padding:5px 0;border-top:1px solid #edf0f5;font-size:7px}.activity-strip time,.activity-strip small{color:#9098aa;font-family:"SFMono-Regular",Consolas,monospace}.remote-console[data-session-state="idle"]{filter:saturate(.4)}.remote-console[data-session-state="idle"] .viewport-bar span i,.remote-console[data-session-state="idle"] .session-row i{background:#a4aab7}
.feature-notes{padding:23px}.feature-notes article{display:grid;grid-template-columns:28px 1fr;gap:10px;padding:18px 0;border-bottom:1px solid #e6e9f0}.feature-notes article>span{display:grid;width:26px;height:26px;place-items:center;border-radius:8px;color:#3157ff;background:#eaf0ff;font:8px "SFMono-Regular",Consolas,monospace}.feature-notes article strong{font-size:10px}.feature-notes article p{margin:6px 0 0;color:#7b8497;font-size:9px;line-height:1.55}.try-note{margin-top:20px;padding:15px;border-radius:11px;color:#dce5fb;background:#111b2f}.try-note strong{font-size:9px}.try-note p{margin:6px 0 0;color:#9ca8bf;font-size:8px;line-height:1.55}.workflow-mark{background:#7657d8}.run-state{display:flex;align-items:center;gap:7px;padding:7px 9px;border:1px solid #dce2ec;border-radius:999px;color:#758095;background:#f8f9fc;font-size:8px;font-weight:800}.run-state i{width:6px;height:6px;border-radius:50%;background:#9aa2b4}.run-state.is-running{color:#2445cf;border-color:#bdc8ff;background:#edf1ff}.run-state.is-running i{background:#3157ff}.run-state.is-complete{color:#0e704d;border-color:#b8dfcf;background:#edf9f4}.run-state.is-complete i{background:#18a06f}.workflow-console{min-height:570px;background:#f8f9fc}.workflow-canvas{position:relative;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:15px;min-height:380px;padding:95px 25px 70px;background-image:radial-gradient(#cbd3e2 1px,transparent 1px);background-size:18px 18px}.execution-thread{position:absolute;top:172px;right:10%;left:10%;height:2px;background:linear-gradient(90deg,#3157ff,#7657d8,#18a06f);opacity:.3}.workflow-node{position:relative;z-index:1;min-height:165px;padding:14px;border:1px solid #d4dbea;border-radius:12px;background:#fff;box-shadow:0 10px 26px #23345a0d}.workflow-node::before{position:absolute;top:76px;right:-19px;width:19px;height:2px;background:#bdc8fa;content:""}.workflow-node:last-child::before{display:none}.node-index{display:grid;width:28px;height:28px;margin-bottom:25px;place-items:center;border:1px solid #d8deea;border-radius:8px;color:#7b8497;background:#f8f9fc;font:8px "SFMono-Regular",Consolas,monospace}.workflow-node small,.workflow-node strong,.workflow-node p{display:block}.workflow-node small{color:#8a93a5;font-size:6px;text-transform:uppercase}.workflow-node strong{margin-top:5px;font-size:9px}.workflow-node p{margin:6px 0 0;color:#8991a3;font-size:7px;line-height:1.45}.node-state{position:absolute;right:11px;bottom:11px;color:#9299aa;font:7px "SFMono-Regular",Consolas,monospace}.workflow-node[data-state="active"]{border-color:#8198ff;box-shadow:0 0 0 4px #3157ff0c,0 15px 34px #3157ff17}.workflow-node[data-state="active"] .node-index{color:#fff;border-color:#3157ff;background:#3157ff}.workflow-node[data-state="active"] .node-state{color:#3157ff}.workflow-node[data-state="complete"]{border-color:#b6ddce;background:#fbfffd}.workflow-node[data-state="complete"] .node-index{color:#0f7652;border-color:#acd7c5;background:#eaf8f2}.workflow-node[data-state="complete"] .node-state{color:#13845d}.event-ledger{display:grid;grid-template-columns:140px 1fr;min-height:190px;padding:18px;border-top:1px solid var(--line);background:#fff}.event-ledger>div span,.event-ledger>div strong{display:block}.event-ledger>div span{font-size:9px;font-weight:800}.event-ledger>div strong{margin-top:4px;color:#8b93a5;font:7px "SFMono-Regular",Consolas,monospace}.event-ledger ol{margin:0}.event-ledger li{display:grid;grid-template-columns:65px 1fr;padding:6px 0;border-bottom:1px solid #edf0f5;font-size:7px}.event-ledger time{color:#8d95a7;font-family:"SFMono-Regular",Consolas,monospace}
.feature-page{padding-top:18px}.directory-page{padding-top:22px}.remote-console{grid-template-columns:245px minmax(0,1fr)}.phone-link-panel{position:relative;display:flex;flex-direction:column;align-items:center;padding:24px 20px;border-right:1px solid var(--line);background:linear-gradient(180deg,#edf1f8,#f7f8fb)}.phone-device{position:relative;width:126px;height:260px;padding:6px;border:1px solid #1d2a42;border-radius:27px;background:#10182b;box-shadow:0 18px 35px #1b2e5326}.phone-speaker{position:absolute;z-index:2;top:10px;left:50%;width:38px;height:8px;border-radius:8px;background:#10182b;transform:translateX(-50%)}.phone-screen{position:relative;height:100%;overflow:hidden;border-radius:21px;background:linear-gradient(160deg,#f7f9ff,#e8eeff)}.phone-top{display:flex;justify-content:space-between;padding:11px 10px 0;color:#26344f;font:6px "SFMono-Regular",Consolas,monospace}.phone-app{display:flex;flex-direction:column;align-items:center;padding:31px 12px 0}.phone-app-mark{display:grid;width:34px;height:34px;place-items:center;border-radius:10px;color:#fff;background:#3157ff;font-size:8px;font-weight:900;box-shadow:0 8px 18px #3157ff35}.phone-app>small{margin-top:11px;color:#7c869a;font-size:6px}.phone-app>strong{margin-top:4px;color:#0f7652;font-size:11px}.phone-pulse{position:relative;display:grid;width:54px;height:54px;margin:13px 0;place-items:center}.phone-pulse i{position:absolute;width:18px;height:18px;border:1px solid #35a77e;border-radius:50%;animation:phone-wave 2.1s ease-out infinite}.phone-pulse i:nth-child(2){animation-delay:.7s}.phone-pulse i:nth-child(3){animation-delay:1.4s}.phone-target{display:flex;align-items:center;gap:6px;width:100%;padding:8px;border:1px solid #d2daea;border-radius:9px;background:#fff;box-shadow:0 8px 18px #283b5a0d}.phone-target>span:first-child{display:grid;width:23px;height:23px;place-items:center;border-radius:7px;color:#3157ff;background:#e9eeff}.phone-target small,.phone-target b{display:block}.phone-target small{color:#8b94a6;font-size:5px}.phone-target b{margin-top:2px;font-size:6px}.phone-home{position:absolute;bottom:6px;left:50%;width:38px;height:3px;border-radius:3px;background:#9da8bd;transform:translateX(-50%)}.connection-handshake{display:grid;gap:7px;width:100%;margin-top:18px}.connection-handshake span{display:flex;align-items:center;gap:7px;color:#667187;font:7px "SFMono-Regular",Consolas,monospace}.connection-handshake i{width:6px;height:6px;border-radius:50%;background:#19a371;box-shadow:0 0 0 3px #19a37115}.connection-beam{position:absolute;z-index:3;top:240px;right:-45px;width:90px;height:36px}.connection-beam::before{position:absolute;top:17px;right:0;left:0;height:1px;background:linear-gradient(90deg,#19a371,#3157ff);content:""}.connection-beam i{position:absolute;top:14px;width:7px;height:7px;border-radius:50%;background:#3157ff;box-shadow:0 0 0 4px #3157ff14;animation:beam-travel 1.8s linear infinite}.connection-beam i:nth-child(2){animation-delay:.6s}.connection-beam i:nth-child(3){animation-delay:1.2s}.connection-beam span{position:absolute;top:25px;left:20px;padding:3px 5px;border-radius:5px;color:#3157ff;background:#f7f9ff;font:6px "SFMono-Regular",Consolas,monospace;white-space:nowrap}.remote-console[data-session-state="idle"] .phone-pulse i,.remote-console[data-session-state="idle"] .connection-beam i{animation:none;border-color:#a4aab7;background:#a4aab7}.remote-console[data-session-state="idle"] .connection-handshake i{background:#a4aab7;box-shadow:none}@keyframes phone-wave{0%{opacity:1;transform:scale(.4)}100%{opacity:0;transform:scale(2.8)}}@keyframes beam-travel{0%{left:0;opacity:0}15%{opacity:1}85%{opacity:1}100%{left:84px;opacity:0}}
.workflow-canvas{display:block;min-height:520px;padding:0;overflow-x:auto;background-size:18px 18px}.canvas-toolbar{position:sticky;z-index:4;left:0;display:flex;align-items:center;gap:16px;height:40px;padding:0 14px;border-bottom:1px solid #dce2ec;color:#7d8699;background:#fff;font:7px "SFMono-Regular",Consolas,monospace}.canvas-toolbar span:first-child{color:#26344f;font-weight:800}.canvas-toolbar span:last-child{margin-left:auto}.canvas-toolbar i{display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:#18a371}.workflow-board{position:relative;width:1020px;height:460px}.workflow-links{position:absolute;inset:0;width:1020px;height:460px;fill:none;stroke:#8da0ef;stroke-width:2;stroke-linecap:round;stroke-dasharray:5 5}.workflow-node{position:absolute;width:120px;min-height:100px;padding:13px 13px 25px}.workflow-node::before{display:none}.trigger-node{top:180px;left:15px;width:105px}.context-node{top:180px;left:175px}.router-node{top:180px;left:350px}.build-node{top:66px;left:525px}.verify-node{top:294px;left:525px}.approval-node{top:180px;left:700px}.delivery-node{top:180px;left:875px;width:130px}.node-icon{display:grid;width:25px;height:25px;margin-bottom:12px;place-items:center;border-radius:7px;color:#3157ff;background:#eaf0ff;font-size:8px;font-weight:900}.router-node .node-icon{color:#7657d8;background:#f0ecff}.approval-node .node-icon{color:#a26a10;background:#fff3df}.delivery-node .node-icon{color:#0f7652;background:#eaf8f2}.node-port{position:absolute;z-index:2;top:48px;width:8px;height:8px;border:2px solid #fff;border-radius:50%;background:#7189e8;box-shadow:0 0 0 1px #7189e8}.node-port.in{left:-5px}.node-port.out{right:-5px}.workflow-node[data-state="active"] .node-icon{color:#fff;background:#3157ff}.workflow-node[data-state="complete"] .node-icon{color:#0f7652;background:#eaf8f2}
.page-shell{width:100%;min-height:100vh;padding:0}.feature-page{min-height:100vh;padding:0}.feature-layout{grid-template-columns:minmax(0,1fr) 300px;gap:0;min-height:100vh}.demo-surface,.feature-notes{border-radius:0;box-shadow:none}.demo-surface{border-width:0 1px 0 0}.feature-notes{border-width:0}.remote-console{min-height:calc(100vh - 68px)}.workflow-console{min-height:calc(100vh - 68px)}.workflow-canvas{min-height:calc(100vh - 258px)}.directory-page{padding:16px}
@media(max-width:1040px){.feature-layout{grid-template-columns:1fr}.feature-notes{display:grid;grid-template-columns:repeat(3,1fr);gap:13px}.feature-notes>.section-label,.feature-notes>.try-note{grid-column:1/-1}.feature-notes article{border:0}.directory-card{grid-template-columns:1fr}.remote-thumbnail,.workflow-thumbnail{min-height:250px;margin:0 0 24px 30px}.evidence-strip{grid-template-columns:repeat(2,1fr)}}
@media(max-width:720px){.page-shell{padding:0 14px}.product-header{grid-template-columns:1fr auto;height:auto;min-height:68px}.product-nav{grid-column:1/-1;grid-row:2;width:100%;margin-bottom:12px}.product-nav a{flex:1;text-align:center}.bot-identity span:last-child{display:none}.directory-page,.feature-page{padding:26px 0}.directory-heading{grid-template-columns:1fr;gap:12px}.directory-heading h1{font-size:28px}.feature-directory{grid-template-columns:1fr}.directory-card{min-height:0}.card-copy{padding:24px}.remote-thumbnail,.workflow-thumbnail{min-height:220px;margin:0 0 18px 24px}.feature-heading{display:block}.feature-heading h1{font-size:27px}.github-link{display:inline-block;margin-top:18px}.heading-meta{align-items:start;flex-direction:column}.surface-toolbar{grid-template-columns:1fr auto}.surface-toolbar .latency,.surface-toolbar .run-state{display:none}.remote-console{grid-template-columns:1fr}.session-list{display:none}.live-viewport{min-height:520px}.controlled-content{grid-template-columns:1fr}.controlled-content aside{display:none}.workflow-canvas{grid-template-columns:1fr;padding:25px}.execution-thread,.workflow-node::before{display:none}.event-ledger{grid-template-columns:1fr;gap:12px}.feature-notes{grid-template-columns:1fr}.feature-notes>.section-label,.feature-notes>.try-note{grid-column:auto}.evidence-strip{grid-template-columns:1fr}}
@media(max-width:720px){.page-shell,.feature-page{padding:0}.directory-page{padding:10px}.phone-link-panel{min-height:470px;border-right:0;border-bottom:1px solid var(--line)}.connection-beam{top:auto;right:50%;bottom:-20px;width:40px;transform:translateX(50%) rotate(90deg)}.connection-beam span{display:none}.workflow-canvas{display:block;padding:0}.workflow-board{transform-origin:top left}.surface-toolbar>div:first-child small{max-width:170px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition-duration:.01ms!important;animation-duration:.01ms!important;animation-iteration-count:1!important}}${renderSessionTimeMachineStyles()}`;
}

export function renderDeliveryWebScript(): string {
  return `(() => {
  const sessionButton = document.querySelector('[data-action="toggle-session"]');
  const remoteConsole = document.querySelector(".remote-console");
  const remoteEvents = document.querySelector("[data-remote-events]");
  const latency = document.querySelector("[data-latency]");
  const phoneStatus = document.querySelector("[data-phone-status]");
  const phoneCopy = document.querySelector("[data-phone-copy]");
  sessionButton?.addEventListener("click", () => {
    const live = remoteConsole.dataset.sessionState === "live";
    remoteConsole.dataset.sessionState = live ? "idle" : "live";
    sessionButton.setAttribute("aria-pressed", String(!live));
    sessionButton.querySelector("span").textContent = live ? "Start session" : "End session";
    latency.textContent = live ? "Offline" : "22 ms";
    phoneStatus.textContent = live ? "Disconnected" : "Connected";
    phoneCopy.textContent = live
      ? "phone waiting for a secure session"
      : "encrypted Web session · connected now";
    const item = document.createElement("li");
    item.innerHTML = '<time>now</time><strong>' + (live ? "Remote session ended" : "Secure session established") + '</strong><small>control</small>';
    remoteEvents.prepend(item);
  });

  const workflowButton = document.querySelector('[data-action="run-workflow"]');
  const workflowStatus = document.querySelector("[data-workflow-status]");
  const workflowEvents = document.querySelector("[data-workflow-events]");
  const steps = [...document.querySelectorAll("[data-workflow-step]")];
  const phases = [[0], [1], [2], [3, 4], [5], [6]];
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
    let phaseIndex = 0;
    const advance = () => {
      if (phaseIndex > 0) {
        phases[phaseIndex - 1].forEach((stepIndex) => {
          const previous = steps[stepIndex];
          previous.dataset.state = "complete";
          previous.querySelector(".node-state").textContent = "Passed";
        });
      }
      if (phaseIndex === phases.length) {
        workflowStatus.className = "run-state is-complete";
        workflowStatus.innerHTML = "<i></i>Complete";
        workflowButton.disabled = false;
        workflowButton.querySelector("span").textContent = "Run again";
        workflowTimer = null;
        return;
      }
      phases[phaseIndex].forEach((stepIndex) => {
        const step = steps[stepIndex];
        step.dataset.state = "active";
        step.querySelector(".node-state").textContent =
          phases[phaseIndex].length > 1 ? "Parallel" : "Running";
        const item = document.createElement("li");
        item.innerHTML = "<time>00:0" + phaseIndex + "." + String(stepIndex * 173).padStart(3, "0") + "</time><span>" + step.querySelector("strong").textContent + "</span>";
        workflowEvents.prepend(item);
      });
      phaseIndex += 1;
      workflowTimer = window.setTimeout(advance, 650);
    };
    advance();
  });
})();
${renderSessionTimeMachineScript()}`;
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

function pageForPath(pathname: string): DeliveryWebPage | undefined {
  if (pathname === "/" || pathname === "/index.html") return "index";
  if (pathname === "/remote-control" || pathname === "/remote-control/") {
    return "remote-control";
  }
  if (
    pathname === "/dynamic-workflow" ||
    pathname === "/dynamic-workflow/"
  ) {
    return "dynamic-workflow";
  }
  if (
    pathname === "/session-time-machine" ||
    pathname === "/session-time-machine/"
  ) {
    return "session-time-machine";
  }
  return undefined;
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
    const page = pageForPath(pathname);
    if (page) {
      send(response, 200, "text/html; charset=utf-8", renderDeliveryWebPage(page), headOnly);
    } else if (pathname === "/delivery-web.css") {
      send(response, 200, "text/css; charset=utf-8", renderDeliveryWebStyles(), headOnly);
    } else if (pathname === "/delivery-web.js") {
      send(response, 200, "text/javascript; charset=utf-8", renderDeliveryWebScript(), headOnly);
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
