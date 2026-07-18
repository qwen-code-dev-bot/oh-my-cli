export type DesktopWorkbenchState =
  | "empty"
  | "loading"
  | "ready"
  | "error";

export interface DesktopViewModel {
  state: DesktopWorkbenchState;
  heading: string;
  detail: string;
}

const STATE_COPY: Record<
  DesktopWorkbenchState,
  Pick<DesktopViewModel, "heading" | "detail">
> = {
  empty: {
    heading: "Choose a project to begin",
    detail: "Open a local workspace to start a focused agent session.",
  },
  loading: {
    heading: "Opening project",
    detail: "Preparing workspace context and session history.",
  },
  ready: {
    heading: "Workspace ready",
    detail: "Ask for a change, inspect the plan, and follow every step.",
  },
  error: {
    heading: "Project unavailable",
    detail: "Review the workspace location and try opening it again.",
  },
};

export function createDesktopViewModel(
  state: DesktopWorkbenchState,
): DesktopViewModel {
  return { state, ...STATE_COPY[state] };
}

export function renderDesktopShell(model: DesktopViewModel): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="color-scheme" content="dark">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Oh My CLI Desktop</title>
    <style>
      :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; background: #08090b; color: #f5f5f7; }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 920px; min-height: 620px; overflow: hidden; background: #08090b; }
      button, textarea { font: inherit; }
      .app { display: grid; grid-template-columns: 232px minmax(420px, 1fr) 280px; height: 100vh; }
      .rail, .inspector { background: #0d0f12; border-color: #22252a; border-style: solid; }
      .rail { border-width: 0 1px 0 0; padding: 18px 14px; }
      .inspector { border-width: 0 0 0 1px; padding: 22px 18px; }
      .brand { display: flex; align-items: center; gap: 9px; margin: 2px 6px 24px; font-size: 13px; font-weight: 650; letter-spacing: .01em; }
      .mark { width: 22px; height: 22px; display: grid; place-items: center; border-radius: 7px; background: #f5f5f7; color: #08090b; font-size: 11px; }
      .section-label { margin: 18px 7px 8px; color: #70747d; font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
      .rail-item { width: 100%; padding: 9px 10px; border: 0; border-radius: 8px; text-align: left; color: #a8abb2; background: transparent; }
      .rail-item.active { color: #fff; background: #1a1d22; }
      .workbench { position: relative; display: grid; grid-template-rows: 52px 1fr auto; min-width: 0; background: radial-gradient(circle at 50% -20%, #171a20 0, #0a0b0e 48%); }
      .toolbar { display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid #1f2227; color: #9ca0a8; font-size: 12px; }
      .toolbar strong { color: #e8e9eb; font-weight: 600; }
      .status-dot { display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: #6ddd9a; box-shadow: 0 0 12px #6ddd9a66; }
      .stage { display: grid; place-items: center; padding: 32px; text-align: center; }
      .state-card { max-width: 470px; }
      .eyebrow { color: #777b84; font-size: 11px; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 11px 0 10px; font-size: 25px; font-weight: 620; letter-spacing: -.025em; }
      .state-card p { margin: 0; color: #8f939c; font-size: 14px; line-height: 1.6; }
      .composer-wrap { padding: 0 24px 22px; }
      .composer { display: grid; grid-template-columns: 1fr auto; gap: 12px; min-height: 74px; padding: 14px 14px 12px 16px; border: 1px solid #292d34; border-radius: 14px; background: #121419; box-shadow: 0 18px 50px #0008; }
      textarea { resize: none; border: 0; outline: 0; color: #f0f1f2; background: transparent; line-height: 1.45; }
      textarea::placeholder { color: #62666f; }
      .send { align-self: end; width: 32px; height: 32px; border: 0; border-radius: 9px; color: #0a0b0e; background: #f5f5f7; font-weight: 700; }
      .inspector h2 { margin: 2px 0 22px; font-size: 12px; font-weight: 650; }
      .fact { padding: 13px 0; border-top: 1px solid #202329; }
      .fact span { display: block; color: #666b74; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; }
      .fact strong { display: block; margin-top: 6px; color: #c9cbd0; font-size: 12px; font-weight: 500; }
    </style>
  </head>
  <body>
    <div class="app" data-workbench-state="${model.state}">
      <nav class="rail" aria-label="Projects and sessions" tabindex="0">
        <div class="brand"><span class="mark">OM</span>Oh My CLI</div>
        <div class="section-label">Projects</div>
        <button class="rail-item active" type="button">Desktop workspace</button>
        <div class="section-label">Sessions</div>
        <button class="rail-item" type="button">New session</button>
      </nav>
      <main class="workbench" aria-label="Agent workbench" tabindex="0">
        <header class="toolbar"><strong>Desktop workspace</strong><span><i class="status-dot"></i>Local</span></header>
        <section class="stage" aria-live="polite">
          <div class="state-card"><div class="eyebrow">Agent workbench</div><h1>${model.heading}</h1><p>${model.detail}</p></div>
        </section>
        <div class="composer-wrap" data-fixed-composer="true">
          <form class="composer" aria-label="Message composer"><textarea rows="2" aria-label="Message" placeholder="Ask Oh My CLI to build, inspect, or explain…"></textarea><button class="send" type="button" aria-label="Send message">↑</button></form>
        </div>
      </main>
      <aside class="inspector" aria-label="Context inspector" tabindex="0">
        <h2>Context</h2>
        <div class="fact"><span>Workspace</span><strong>Desktop workspace</strong></div>
        <div class="fact"><span>State</span><strong>${model.state}</strong></div>
        <div class="fact"><span>Execution</span><strong>Local · approval required</strong></div>
      </aside>
    </div>
  </body>
</html>`;
}
