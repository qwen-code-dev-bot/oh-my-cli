export function renderParallelWorkspaceRadarPage(): string {
  return `<main class="fleet-page">
    <section class="fleet-shell" aria-label="Parallel Workspace Radar">
      <div class="fleet-toolbar">
        <div><span class="fleet-mark">PR</span><span><strong>release-0.9 · parallel workspace radar</strong><small><i></i> coordinator online · 5 isolated worktrees</small></span></div>
        <div class="fleet-metrics"><span><small>ACTIVE</small><b data-fleet-active>3 agents</b></span><span><small>CAPACITY</small><b>5 / 8</b></span><span><small>CONFLICT</small><b data-fleet-conflict>low</b></span></div>
        <button type="button" data-action="dispatch-fleet"><span>↗</span><b>Dispatch next wave</b></button>
      </div>
      <div class="fleet-grid">
        <section class="radar-deck">
          <div class="radar-controls"><span>LIVE TOPOLOGY</span><small>branch distance</small><small>workspace lease</small><b data-fleet-phase>observing</b></div>
          <div class="radar-field" data-fleet-state="idle">
            <div class="radar-rings" aria-hidden="true"><i></i><i></i><i></i><i></i><span></span></div>
            <svg class="fleet-links" viewBox="0 0 820 560" preserveAspectRatio="none" aria-hidden="true">
              <path d="M410 280 C330 220 280 150 205 112"></path>
              <path d="M410 280 C500 210 560 140 630 102"></path>
              <path d="M410 280 C305 310 235 365 157 405"></path>
              <path d="M410 280 C510 320 595 385 668 424"></path>
              <path d="M410 280 C420 365 424 420 414 482"></path>
            </svg>
            <article class="coordinator-node"><span>Q</span><small>COORDINATOR</small><strong>dev-bot</strong><b><i></i>dispatching</b></article>
            <article class="agent-blip agent-a is-running" data-fleet-agent="0"><i></i><span><small>AGENT 01 · BUILD</small><strong>web/session-replay</strong><b data-agent-state>running · 72%</b></span></article>
            <article class="agent-blip agent-b is-running" data-fleet-agent="1"><i></i><span><small>AGENT 02 · TEST</small><strong>web/radar-e2e</strong><b data-agent-state>running · 48%</b></span></article>
            <article class="agent-blip agent-c" data-fleet-agent="2"><i></i><span><small>AGENT 03 · REVIEW</small><strong>core/trust-boundary</strong><b data-agent-state>leased · waiting</b></span></article>
            <article class="agent-blip agent-d is-running" data-fleet-agent="3"><i></i><span><small>AGENT 04 · DOCS</small><strong>docs/feature-map</strong><b data-agent-state>running · 88%</b></span></article>
            <article class="agent-blip agent-e" data-fleet-agent="4"><i></i><span><small>AGENT 05 · VERIFY</small><strong>ci/preflight</strong><b data-agent-state>queued · 02</b></span></article>
          </div>
        </section>
        <aside class="fleet-inspector">
          <div class="fleet-inspector-head"><span>Worktree leases</span><b>LIVE</b></div>
          <ol class="lease-list">
            <li class="is-selected"><span class="agent-avatar">01</span><div><strong>session-replay</strong><small>devbot/issue-273</small></div><b>72%</b></li>
            <li><span class="agent-avatar violet">02</span><div><strong>radar-e2e</strong><small>devbot/issue-274</small></div><b>48%</b></li>
            <li><span class="agent-avatar amber">03</span><div><strong>trust-boundary</strong><small>review/route-scope</small></div><b>WAIT</b></li>
            <li><span class="agent-avatar green">04</span><div><strong>feature-map</strong><small>docs/web-surfaces</small></div><b>88%</b></li>
            <li><span class="agent-avatar slate">05</span><div><strong>preflight</strong><small>verify/release-0.9</small></div><b>QUEUE</b></li>
          </ol>
          <div class="risk-panel"><header><span>Merge-path forecast</span><b data-risk-label>CLEAN</b></header><div class="risk-lanes"><i></i><i></i><i></i><i></i><span></span></div><p data-risk-copy>Five worktrees resolve to isolated paths. No overlapping production files detected.</p></div>
        </aside>
      </div>
      <div class="fleet-ledger">
        <div><span>COORDINATION STREAM</span><small>ordered handoffs across isolated worktrees</small></div>
        <ol data-fleet-events><li><time>00:18.240</time><i></i><strong>Agent 04</strong><span>attached documentation receipt</span><b>docs/feature-map</b></li><li><time>00:12.904</time><i></i><strong>Agent 01</strong><span>sealed checkpoint cp_04b7</span><b>web/session-replay</b></li><li><time>00:04.118</time><i></i><strong>Coordinator</strong><span>verified 5 workspace leases</span><b>release-0.9</b></li></ol>
      </div>
    </section>
  </main>`;
}

export function renderParallelWorkspaceRadarStyles(): string {
  return `
.radar-thumbnail{position:relative;display:grid;place-items:center;margin:28px 0;padding:38px;border:1px solid #d4dbea;border-right:0;border-radius:14px 0 0 14px;background:#0e1930}.radar-thumbnail::before,.radar-thumbnail::after{position:absolute;border:1px solid #3c547f;border-radius:50%;content:""}.radar-thumbnail::before{width:150px;height:150px}.radar-thumbnail::after{width:80px;height:80px}.radar-thumbnail i{z-index:1;width:12px;height:12px;border-radius:50%;background:#61e8b7;box-shadow:0 0 0 8px #61e8b71a,0 0 24px #61e8b7}.radar-thumbnail span{position:absolute;width:7px;height:7px;border-radius:50%;background:#6f8cff}.radar-thumbnail span:nth-child(2){top:26%;left:30%}.radar-thumbnail span:nth-child(3){right:25%;bottom:27%}
.fleet-page{min-height:100vh;background:#eef2f8}.fleet-shell{display:grid;grid-template-rows:68px minmax(0,1fr) 176px;min-height:100vh;color:#10182b;background:linear-gradient(90deg,#e2e7f0 1px,transparent 1px),linear-gradient(#e2e7f0 1px,transparent 1px),#f6f8fb;background-size:24px 24px}.fleet-toolbar{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:28px;padding:0 22px;border-bottom:1px solid #dce2ec;background:#fff}.fleet-toolbar>div:first-child{display:flex;align-items:center;gap:11px}.fleet-toolbar strong,.fleet-toolbar small{display:block}.fleet-toolbar strong{font-size:11px}.fleet-toolbar small{margin-top:4px;color:#7f899d;font:6px "SFMono-Regular",Consolas,monospace}.fleet-toolbar small i{display:inline-block;width:5px;height:5px;margin-right:5px;border-radius:50%;background:#1aad78;box-shadow:0 0 0 4px #1aad7813}.fleet-mark{display:grid;width:34px;height:34px;place-items:center;border-radius:10px;color:#0e1930;background:#9af2d4;font-size:10px;font-weight:900}.fleet-metrics{display:flex;gap:24px}.fleet-metrics span{min-width:58px}.fleet-metrics small{color:#9aa2b2;font-size:5px;letter-spacing:.1em}.fleet-metrics b{display:block;margin-top:4px;font:800 8px "SFMono-Regular",Consolas,monospace}.fleet-toolbar button{display:flex;align-items:center;gap:8px;padding:9px 13px;border:0;border-radius:9px;color:#e8fff7;background:#10223a;cursor:pointer;box-shadow:0 9px 20px #142a4824}.fleet-toolbar button span{color:#77e7bf}.fleet-toolbar button b{font-size:8px}.fleet-grid{display:grid;grid-template-columns:minmax(0,1fr) 292px;min-height:0;margin:16px 16px 0;overflow:hidden;border:1px solid #d8dfea;border-radius:16px 16px 0 0;background:#fff;box-shadow:0 20px 48px #1e315314}.radar-deck{display:grid;grid-template-rows:40px minmax(0,1fr);min-width:0;border-right:1px solid #dce2ec}.radar-controls{display:flex;align-items:center;gap:18px;padding:0 16px;border-bottom:1px solid #263750;color:#8290a8;background:#101b30;font:6px "SFMono-Regular",Consolas,monospace}.radar-controls>span{color:#deebff;font-weight:800;letter-spacing:.1em}.radar-controls small::before{display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:#5470a1;content:""}.radar-controls small:nth-child(3)::before{background:#64e4b5}.radar-controls b{margin-left:auto;color:#72e7be}.radar-field{position:relative;min-height:510px;overflow:hidden;background:radial-gradient(circle at center,#182b47 0,#101c32 56%,#0b1426 100%)}.radar-field::before{position:absolute;inset:0;background:linear-gradient(90deg,#7992bb0a 1px,transparent 1px),linear-gradient(#7992bb0a 1px,transparent 1px);background-size:36px 36px;content:""}.radar-rings{position:absolute;top:50%;left:50%;width:530px;height:530px;transform:translate(-50%,-50%)}.radar-rings i{position:absolute;top:50%;left:50%;border:1px solid #385174;border-radius:50%;transform:translate(-50%,-50%)}.radar-rings i:first-child{width:125px;height:125px}.radar-rings i:nth-child(2){width:245px;height:245px}.radar-rings i:nth-child(3){width:365px;height:365px}.radar-rings i:nth-child(4){width:505px;height:505px}.radar-rings::before,.radar-rings::after{position:absolute;top:50%;left:0;width:100%;height:1px;background:#385174;content:""}.radar-rings::after{transform:rotate(90deg)}.radar-rings span{position:absolute;top:50%;left:50%;width:250px;height:250px;border-right:1px solid #65e1b5;background:conic-gradient(from 0deg,transparent 0 72%,#65e1b512 87%,#65e1b54a);transform-origin:0 0;animation:radar-sweep 5s linear infinite}.fleet-links{position:absolute;inset:0;width:100%;height:100%;fill:none;stroke:#5a7299;stroke-width:1;stroke-dasharray:4 6}.coordinator-node{position:absolute;z-index:3;top:50%;left:50%;display:grid;width:108px;height:108px;place-items:center;padding:16px;border:1px solid #7ce6c0;border-radius:50%;color:#dffcf2;background:#132c40;box-shadow:0 0 0 12px #5ee2b414,0 0 42px #5ee2b421;transform:translate(-50%,-50%)}.coordinator-node>span{display:grid;width:30px;height:30px;place-items:center;border-radius:9px;color:#10243a;background:#8df0ce;font-size:12px;font-weight:900}.coordinator-node small{color:#7ca092;font:5px "SFMono-Regular",Consolas,monospace}.coordinator-node strong{font-size:9px}.coordinator-node b{display:flex;align-items:center;gap:5px;color:#7de7bf;font:6px "SFMono-Regular",Consolas,monospace}.coordinator-node b i{width:5px;height:5px;border-radius:50%;background:#68e5b7}.agent-blip{position:absolute;z-index:4;display:flex;align-items:center;gap:9px;min-width:150px;padding:10px;border:1px solid #405576;border-radius:10px;color:#dce8fb;background:#122038e8;box-shadow:0 10px 28px #030a1690}.agent-blip>i{width:10px;height:10px;border:2px solid #9aaac2;border-radius:50%;background:#33445d}.agent-blip.is-running>i{border-color:#88efcb;background:#34bc8c;box-shadow:0 0 0 5px #55dda918,0 0 18px #55dda9}.agent-blip small,.agent-blip strong,.agent-blip b{display:block}.agent-blip small{color:#788ba8;font:5px "SFMono-Regular",Consolas,monospace}.agent-blip strong{margin-top:4px;font-size:7px}.agent-blip b{margin-top:4px;color:#81e7c1;font:6px "SFMono-Regular",Consolas,monospace}.agent-a{top:9%;left:9%}.agent-b{top:8%;right:7%}.agent-c{bottom:16%;left:5%}.agent-d{right:5%;bottom:13%}.agent-e{bottom:2%;left:50%;transform:translateX(-50%)}.radar-field[data-fleet-state="dispatching"] .agent-blip{border-color:#66dcb3}.radar-field[data-fleet-state="dispatching"] .agent-blip>i{animation:agent-pulse .8s ease-in-out infinite alternate}.fleet-inspector{padding:18px;background:#fff}.fleet-inspector-head{display:flex;justify-content:space-between;align-items:center;font-size:9px;font-weight:800}.fleet-inspector-head b{padding:4px 6px;border-radius:999px;color:#0d7651;background:#e8f8f1;font:700 6px "SFMono-Regular",Consolas,monospace}.lease-list{display:grid;gap:4px;margin:16px 0;padding:0;list-style:none}.lease-list li{display:grid;grid-template-columns:30px 1fr auto;align-items:center;gap:9px;padding:9px;border:1px solid transparent;border-radius:9px}.lease-list li.is-selected{border-color:#ccd5e4;background:#f7f9fc}.agent-avatar{display:grid;width:28px;height:28px;place-items:center;border-radius:8px;color:#fff;background:#3157ff;font:700 7px "SFMono-Regular",Consolas,monospace}.agent-avatar.violet{background:#7657d8}.agent-avatar.amber{background:#b47c23}.agent-avatar.green{background:#168861}.agent-avatar.slate{background:#718097}.lease-list strong,.lease-list small{display:block}.lease-list strong{font-size:7px}.lease-list small{margin-top:3px;color:#929aac;font:5px "SFMono-Regular",Consolas,monospace}.lease-list li>b{color:#647189;font:700 6px "SFMono-Regular",Consolas,monospace}.risk-panel{margin-top:13px;padding:13px;border-radius:11px;color:#dce8fa;background:#111c31}.risk-panel header{display:flex;justify-content:space-between;font-size:7px}.risk-panel header b{color:#76e3bb;font:700 6px "SFMono-Regular",Consolas,monospace}.risk-lanes{position:relative;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:15px 0}.risk-lanes i{height:4px;border-radius:4px;background:#34435b}.risk-lanes i:first-child,.risk-lanes i:nth-child(2),.risk-lanes i:nth-child(3){background:#4dc49a}.risk-lanes span{position:absolute;right:15%;bottom:-4px;width:8px;height:8px;border:2px solid #111c31;border-radius:50%;background:#7be4bc}.risk-panel p{margin:0;color:#8493aa;font-size:6px;line-height:1.6}.fleet-ledger{margin:0 16px 16px;padding:13px 17px;border:1px solid #d8dfea;border-top-color:#e5e9f0;border-radius:0 0 16px 16px;background:#fff;box-shadow:0 20px 48px #1e315314}.fleet-ledger>div{display:flex;align-items:center;gap:15px}.fleet-ledger>div span{font:800 6px "SFMono-Regular",Consolas,monospace;letter-spacing:.1em}.fleet-ledger>div small{color:#929bad;font-size:6px}.fleet-ledger ol{display:grid;gap:2px;margin:10px 0 0;padding:0;list-style:none}.fleet-ledger li{display:grid;grid-template-columns:72px 8px 72px 1fr auto;align-items:center;gap:9px;padding:6px 0;border-top:1px solid #e7ebf1;color:#667289;font-size:7px}.fleet-ledger time,.fleet-ledger b{font:6px "SFMono-Regular",Consolas,monospace}.fleet-ledger time{color:#9aa2b2}.fleet-ledger li i{width:6px;height:6px;border-radius:50%;background:#26b984}.fleet-ledger strong{color:#26344e}.fleet-ledger b{color:#3157ff}@keyframes radar-sweep{to{transform:rotate(360deg)}}@keyframes agent-pulse{to{transform:scale(1.35);filter:brightness(1.4)}}
@media(max-width:940px){.fleet-grid{grid-template-columns:1fr}.fleet-inspector{display:none}.fleet-metrics{display:none}}@media(max-width:650px){.fleet-shell{grid-template-rows:62px minmax(0,1fr) 164px}.fleet-toolbar{grid-template-columns:1fr auto;padding:0 11px}.fleet-toolbar strong{font-size:8px}.fleet-toolbar button b{display:none}.fleet-grid{margin:10px 10px 0}.radar-field{min-height:520px}.agent-blip{min-width:125px;padding:8px}.agent-a{left:2%}.agent-b{right:2%}.agent-c{left:1%}.agent-d{right:1%}.fleet-ledger{margin:0 10px 10px;padding-inline:10px}.fleet-ledger li{grid-template-columns:58px 6px 62px 1fr}.fleet-ledger li b{display:none}}.fleet-shell{display:block}.fleet-toolbar,.fleet-inspector,.radar-controls,.fleet-ledger{display:none}.fleet-grid{display:block;min-height:100vh;margin:0;border:0;border-radius:0;box-shadow:none}.radar-deck{display:block;border:0}.radar-field{min-height:100vh}`;
}

export function renderParallelWorkspaceRadarScript(): string {
  return `(() => {
  const button = document.querySelector('[data-action="dispatch-fleet"]');
  const radar = document.querySelector(".radar-field");
  const eventList = document.querySelector("[data-fleet-events]");
  if (!button || !radar || !eventList) return;
  const agents = [...document.querySelectorAll("[data-fleet-agent]")];
  let running = false;
  button.addEventListener("click", () => {
    if (running) return;
    running = true;
    radar.dataset.fleetState = "dispatching";
    button.querySelector("b").textContent = "Dispatching";
    document.querySelector("[data-fleet-phase]").textContent = "routing wave 06";
    document.querySelector("[data-fleet-conflict]").textContent = "scanning";
    agents.forEach((agent, index) => {
      window.setTimeout(() => {
        agent.classList.add("is-running");
        agent.querySelector("[data-agent-state]").textContent = index === 4 ? "running · 12%" : "handoff verified";
        const item = document.createElement("li");
        item.innerHTML = "<time>now +" + index + "s</time><i></i><strong>Agent 0" + (index + 1) + "</strong><span>" + (index === 4 ? "accepted preflight lease" : "confirmed isolated handoff") + "</span><b>" + agent.querySelector("strong").textContent + "</b>";
        eventList.prepend(item);
        if (index === agents.length - 1) {
          document.querySelector("[data-fleet-active]").textContent = "5 agents";
          document.querySelector("[data-fleet-conflict]").textContent = "none";
          document.querySelector("[data-fleet-phase]").textContent = "wave 06 active";
          document.querySelector("[data-risk-label]").textContent = "ISOLATED";
          document.querySelector("[data-risk-copy]").textContent = "Wave 06 accepted. All five branches retain isolated mutation boundaries.";
          button.querySelector("b").textContent = "Wave dispatched";
          radar.dataset.fleetState = "active";
          running = false;
        }
      }, 380 * index);
    });
  });
})();`;
}
