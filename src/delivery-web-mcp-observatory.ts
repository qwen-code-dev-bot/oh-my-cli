export function renderMcpObservatoryPage(): string {
  return `<main class="mcp-page">
    <section class="mcp-shell" aria-label="MCP Observatory">
      <div class="mcp-toolbar">
        <div><span class="mcp-mark">M</span><span><strong>Model Context Protocol · live trace</strong><small><i></i> 3 servers · stdio + streamable HTTP</small></span></div>
        <div class="mcp-health"><span><small>P95</small><b data-mcp-p95>184 ms</b></span><span><small>CALLS</small><b data-mcp-calls>1,284</b></span><span><small>ERROR RATE</small><b data-mcp-errors>0.08%</b></span></div>
        <button type="button" data-action="send-mcp-probe"><span>⌁</span><b>Send protocol probe</b></button>
      </div>
      <div class="mcp-body">
        <section class="protocol-map">
          <div class="protocol-map-head"><span>PROTOCOL TOPOLOGY</span><small><i></i>request</small><small><i></i>response</small><b data-mcp-status>stream healthy</b></div>
          <div class="protocol-canvas" data-mcp-phase="idle">
            <svg viewBox="0 0 900 390" preserveAspectRatio="none" aria-hidden="true">
              <path class="protocol-path request-path" d="M135 195 C250 195 265 92 390 92 S565 92 670 92"></path>
              <path class="protocol-path request-path" d="M135 195 C265 195 300 195 430 195 S590 195 700 195"></path>
              <path class="protocol-path request-path" d="M135 195 C250 195 265 298 390 298 S565 298 670 298"></path>
              <path class="protocol-path response-path" d="M670 112 C540 132 310 220 135 215"></path>
              <circle class="protocol-pulse pulse-a" r="5"></circle><circle class="protocol-pulse pulse-b" r="5"></circle><circle class="protocol-pulse pulse-c" r="5"></circle>
            </svg>
            <article class="mcp-client"><span>Q</span><small>MCP CLIENT</small><strong>oh-my-cli</strong><b><i></i>connected</b></article>
            <article class="mcp-server server-fs"><span>FS</span><div><small>STDIO · LOCAL</small><strong>filesystem</strong><b>12 tools · 31 ms</b></div><i></i></article>
            <article class="mcp-server server-gh"><span>GH</span><div><small>HTTP · REMOTE</small><strong>github</strong><b>28 tools · 184 ms</b></div><i></i></article>
            <article class="mcp-server server-db"><span>DB</span><div><small>STDIO · LOCAL</small><strong>sqlite</strong><b>8 tools · 46 ms</b></div><i></i></article>
            <div class="protocol-envelope" data-mcp-envelope><span>→</span><b>tools/call</b><small>id: req_07f2</small></div>
          </div>
        </section>
        <aside class="trace-inspector">
          <div class="trace-tabs"><span class="is-active">Inspector</span><span>Headers</span><b>REDACTED</b></div>
          <div class="trace-summary"><span><small>SELECTED SPAN</small><strong data-mcp-selected>tools/call · github</strong></span><b data-mcp-duration>184 ms</b></div>
          <pre class="json-view" data-mcp-json><span>{</span>
  <b>"jsonrpc"</b>: <em>"2.0"</em>,
  <b>"id"</b>: <i>"req_07f2"</i>,
  <b>"method"</b>: <em>"tools/call"</em>,
  <b>"params"</b>: {
    <b>"name"</b>: <em>"get_issue"</em>,
    <b>"arguments"</b>: {
      <b>"owner"</b>: <em>"qwen-code-dev-bot"</em>,
      <b>"token"</b>: <mark>"[REDACTED]"</mark>
    }
  }
<span>}</span></pre>
          <div class="schema-check"><span><i>✓</i><b>Schema valid</b></span><span><i>✓</i><b>Secrets redacted</b></span><span><i>✓</i><b>Response correlated</b></span></div>
        </aside>
      </div>
      <div class="waterfall-panel">
        <div class="waterfall-head"><span>TRACE WATERFALL</span><small data-mcp-trace>trace mcp_8e21 · 412 ms total</small><b>NOW − 500 MS</b></div>
        <div class="waterfall-scale"><span>0</span><span>100</span><span>200</span><span>300</span><span>400 ms</span></div>
        <div class="waterfall-row"><span><i></i>initialize</span><div><b class="bar-init"></b></div><time>48 ms</time></div>
        <div class="waterfall-row"><span><i></i>tools/list</span><div><b class="bar-list"></b></div><time>71 ms</time></div>
        <div class="waterfall-row is-selected"><span><i></i>tools/call</span><div><b class="bar-call" data-mcp-bar></b><em>github.get_issue</em></div><time data-mcp-row-time>184 ms</time></div>
        <div class="waterfall-row"><span><i></i>result decode</span><div><b class="bar-result"></b></div><time>36 ms</time></div>
      </div>
    </section>
  </main>`;
}

export function renderMcpObservatoryStyles(): string {
  return `
.mcp-thumbnail{position:relative;display:grid;grid-template-columns:55px 1fr;gap:24px;align-items:center;margin:28px 0;padding:40px;border:1px solid #d4dbea;border-right:0;border-radius:14px 0 0 14px;background:#0c1529}.mcp-thumbnail>i{width:50px;height:50px;border:1px solid #6177ff;border-radius:50%;box-shadow:0 0 0 10px #6177ff12}.mcp-thumbnail div{display:grid;gap:18px}.mcp-thumbnail span{position:relative;height:6px;border-radius:8px;background:linear-gradient(90deg,#5f75ff,#8b5cf6)}.mcp-thumbnail span::after{position:absolute;right:0;width:9px;height:9px;border-radius:50%;background:#7af0cc;box-shadow:0 0 14px #7af0cc;content:"";transform:translateY(-2px)}
.mcp-page{min-height:100vh;background:#edf1f8}.mcp-shell{display:grid;grid-template-rows:68px minmax(0,1fr) 235px;min-height:100vh;color:#111a31;background:linear-gradient(90deg,#e0e6f0 1px,transparent 1px),linear-gradient(#e0e6f0 1px,transparent 1px),#f6f8fb;background-size:24px 24px}.mcp-toolbar{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:28px;padding:0 22px;border-bottom:1px solid #dce2ec;background:#fff}.mcp-toolbar>div:first-child{display:flex;align-items:center;gap:11px}.mcp-toolbar strong,.mcp-toolbar small{display:block}.mcp-toolbar strong{font-size:11px}.mcp-toolbar small{margin-top:4px;color:#808a9e;font:6px "SFMono-Regular",Consolas,monospace}.mcp-toolbar small i{display:inline-block;width:5px;height:5px;margin-right:5px;border-radius:50%;background:#18a876;box-shadow:0 0 0 4px #18a87614}.mcp-mark{display:grid;width:34px;height:34px;place-items:center;border-radius:10px;color:#fff;background:linear-gradient(135deg,#3157ff,#8758df);font-size:13px;font-weight:900}.mcp-health{display:flex;gap:24px}.mcp-health span{min-width:62px}.mcp-health small{color:#9aa2b3;font-size:5px;letter-spacing:.1em}.mcp-health b{display:block;margin-top:4px;font:800 8px "SFMono-Regular",Consolas,monospace}.mcp-toolbar button{display:flex;align-items:center;gap:8px;padding:9px 13px;border:0;border-radius:9px;color:#fff;background:#111b31;cursor:pointer;box-shadow:0 9px 20px #111b3123}.mcp-toolbar button span{color:#a798ff}.mcp-toolbar button b{font-size:8px}.mcp-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;min-height:0;margin:16px 16px 0;overflow:hidden;border:1px solid #d8dfea;border-radius:16px 16px 0 0;background:#fff;box-shadow:0 20px 48px #1e315314}.protocol-map{display:grid;grid-template-rows:40px minmax(0,1fr);min-width:0;border-right:1px solid #dce2ec}.protocol-map-head{display:flex;align-items:center;gap:18px;padding:0 16px;border-bottom:1px solid #26354e;color:#8290a8;background:#101a2e;font:6px "SFMono-Regular",Consolas,monospace}.protocol-map-head>span{color:#dce6f8;font-weight:800;letter-spacing:.1em}.protocol-map-head small i{display:inline-block;width:13px;height:2px;margin-right:5px;background:#697eff}.protocol-map-head small:nth-child(3) i{background:#56d8ac}.protocol-map-head b{margin-left:auto;color:#6fe2ba}.protocol-canvas{position:relative;min-height:410px;overflow:hidden;background:radial-gradient(circle at 45% 48%,#172743,#0c1629 68%)}.protocol-canvas::before{position:absolute;inset:0;background:linear-gradient(90deg,#8395bd0a 1px,transparent 1px),linear-gradient(#8395bd0a 1px,transparent 1px);background-size:34px 34px;content:""}.protocol-canvas svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}.protocol-path{fill:none;stroke-width:1.5;stroke-linecap:round;stroke-dasharray:5 6}.request-path{stroke:#6178dd}.response-path{stroke:#45bc95;opacity:.75}.protocol-pulse{fill:#8aa0ff;filter:drop-shadow(0 0 7px #7890ff);opacity:0}.protocol-canvas[data-mcp-phase="probing"] .pulse-a{opacity:1;offset-path:path("M135 195 C250 195 265 92 390 92 S565 92 670 92");animation:protocol-travel 1.4s linear forwards}.protocol-canvas[data-mcp-phase="probing"] .pulse-b{opacity:1;offset-path:path("M135 195 C265 195 300 195 430 195 S590 195 700 195");animation:protocol-travel 1.6s .16s linear forwards}.protocol-canvas[data-mcp-phase="probing"] .pulse-c{opacity:1;offset-path:path("M135 195 C250 195 265 298 390 298 S565 298 670 298");animation:protocol-travel 1.8s .3s linear forwards}.mcp-client{position:absolute;z-index:3;top:50%;left:5%;display:grid;width:112px;height:112px;place-items:center;padding:15px;border:1px solid #7186f2;border-radius:18px;color:#e5ebff;background:#172541;box-shadow:0 0 0 9px #6178e810,0 18px 35px #02071280;transform:translateY(-50%)}.mcp-client>span{display:grid;width:31px;height:31px;place-items:center;border-radius:9px;color:#fff;background:#6178ef;font-weight:900}.mcp-client small{color:#7f90b2;font:5px "SFMono-Regular",Consolas,monospace}.mcp-client strong{font-size:9px}.mcp-client b{display:flex;align-items:center;gap:5px;color:#6ee2b9;font:6px "SFMono-Regular",Consolas,monospace}.mcp-client b i{width:5px;height:5px;border-radius:50%;background:#60ddb2}.mcp-server{position:absolute;z-index:3;right:6%;display:grid;grid-template-columns:34px 1fr 7px;align-items:center;gap:10px;min-width:205px;padding:12px;border:1px solid #3d5072;border-radius:11px;color:#e0e9fa;background:#122139e8;box-shadow:0 12px 26px #0207137a}.mcp-server>span{display:grid;width:33px;height:33px;place-items:center;border-radius:9px;color:#c9d5ff;background:#263a67;font-size:8px;font-weight:900}.mcp-server small,.mcp-server strong,.mcp-server b{display:block}.mcp-server small{color:#788ba8;font:5px "SFMono-Regular",Consolas,monospace}.mcp-server strong{margin-top:3px;font-size:8px}.mcp-server b{margin-top:4px;color:#70dfb8;font:6px "SFMono-Regular",Consolas,monospace}.mcp-server>i{width:7px;height:7px;border-radius:50%;background:#51d5a8;box-shadow:0 0 0 5px #51d5a813}.server-fs{top:8%}.server-gh{top:50%;border-color:#6d7ee5;transform:translateY(-50%)}.server-gh>span{background:#5c6fdf}.server-db{bottom:8%}.protocol-envelope{position:absolute;z-index:5;top:42%;left:43%;display:grid;grid-template-columns:22px 1fr;gap:3px 8px;padding:9px 12px;border:1px solid #7184e8;border-radius:9px;color:#dce5ff;background:#18284ae8;box-shadow:0 12px 25px #02071266}.protocol-envelope>span{grid-row:1/3;display:grid;width:21px;height:21px;place-items:center;border-radius:6px;color:#9cafff;background:#2b4072}.protocol-envelope b{font-size:7px}.protocol-envelope small{color:#8190ad;font:5px "SFMono-Regular",Consolas,monospace}.protocol-canvas[data-mcp-phase="probing"] .protocol-envelope{animation:envelope-pulse .7s ease-in-out infinite alternate}.trace-inspector{padding:0;background:#fff}.trace-tabs{display:flex;align-items:center;gap:17px;height:40px;padding:0 15px;border-bottom:1px solid #e1e5ed;color:#8992a4;font-size:7px;font-weight:700}.trace-tabs span{height:40px;padding-top:15px}.trace-tabs .is-active{color:#3157ff;border-bottom:2px solid #3157ff}.trace-tabs b{margin-left:auto;padding:3px 5px;border-radius:5px;color:#8c6c22;background:#fff4dc;font:6px "SFMono-Regular",Consolas,monospace}.trace-summary{display:flex;align-items:center;justify-content:space-between;padding:14px 16px}.trace-summary small,.trace-summary strong{display:block}.trace-summary small{color:#969eaf;font:5px "SFMono-Regular",Consolas,monospace;letter-spacing:.08em}.trace-summary strong{margin-top:4px;font-size:8px}.trace-summary>b{color:#3157ff;font:800 8px "SFMono-Regular",Consolas,monospace}.json-view{margin:0 14px;padding:16px;overflow:auto;border-radius:11px;color:#aab8ce;background:#10192b;font:6.5px/1.8 "SFMono-Regular",Consolas,monospace}.json-view b{color:#8ca1ff}.json-view em{color:#7be0ba;font-style:normal}.json-view i{color:#e1b56f;font-style:normal}.json-view mark{padding:2px 4px;border-radius:4px;color:#ffcf7f;background:#4a3a22}.schema-check{display:grid;gap:8px;margin:14px;padding:12px;border-radius:10px;background:#f5f7fb}.schema-check span{display:flex;align-items:center;gap:8px;color:#566279;font-size:7px}.schema-check i{display:grid;width:17px;height:17px;place-items:center;border-radius:5px;color:#0f7652;background:#e1f5ec;font-style:normal;font-size:7px}.waterfall-panel{margin:0 16px 16px;padding:13px 17px;border:1px solid #d8dfea;border-top-color:#e4e8f0;border-radius:0 0 16px 16px;background:#fff;box-shadow:0 20px 48px #1e315314}.waterfall-head{display:flex;gap:15px;align-items:center}.waterfall-head span{font:800 6px "SFMono-Regular",Consolas,monospace;letter-spacing:.1em}.waterfall-head small{color:#8d96a8;font:6px "SFMono-Regular",Consolas,monospace}.waterfall-head b{margin-left:auto;color:#8f98aa;font:5px "SFMono-Regular",Consolas,monospace}.waterfall-scale{display:grid;grid-template-columns:repeat(5,1fr);margin:13px 58px 5px 144px;color:#a0a7b6;font:5px "SFMono-Regular",Consolas,monospace}.waterfall-scale span:last-child{text-align:right}.waterfall-row{display:grid;grid-template-columns:135px 1fr 52px;align-items:center;gap:9px;min-height:31px;border-top:1px solid #e8ebf1}.waterfall-row>span{display:flex;align-items:center;gap:7px;color:#566279;font-size:7px}.waterfall-row>span i{width:6px;height:6px;border-radius:50%;background:#7587aa}.waterfall-row>div{position:relative;height:14px;background-image:linear-gradient(90deg,#eef1f6 1px,transparent 1px);background-size:25% 100%}.waterfall-row>div b{position:absolute;height:8px;top:3px;border-radius:4px;background:#7d8fdc}.bar-init{left:2%;width:12%}.bar-list{left:17%;width:18%;background:#7657d8!important}.bar-call{left:37%;width:46%;background:linear-gradient(90deg,#3157ff,#7657d8)!important;box-shadow:0 0 12px #536bdb33}.bar-result{left:84%;width:10%;background:#29ad7f!important}.waterfall-row em{position:absolute;top:3px;left:50%;color:#fff;font:5px "SFMono-Regular",Consolas,monospace}.waterfall-row time{color:#7f899d;font:6px "SFMono-Regular",Consolas,monospace;text-align:right}.waterfall-row.is-selected>span{color:#3157ff;font-weight:800}.waterfall-row.is-selected>span i{background:#3157ff}.protocol-canvas[data-mcp-phase="complete"] .mcp-server{border-color:#55cda7}.protocol-canvas[data-mcp-phase="complete"] .protocol-envelope{border-color:#57d2aa}@keyframes protocol-travel{from{offset-distance:0}to{offset-distance:100%}}@keyframes envelope-pulse{to{filter:brightness(1.35);box-shadow:0 0 25px #7184e84d}}
@media(max-width:950px){.mcp-body{grid-template-columns:1fr}.trace-inspector{display:none}.mcp-health{display:none}}@media(max-width:650px){.mcp-shell{grid-template-rows:62px minmax(0,1fr) 225px}.mcp-toolbar{grid-template-columns:1fr auto;padding:0 11px}.mcp-toolbar strong{font-size:8px}.mcp-toolbar button b{display:none}.mcp-body{margin:10px 10px 0}.protocol-canvas{min-height:470px}.mcp-server{right:2%;min-width:160px}.mcp-client{left:2%;width:90px;height:100px}.protocol-envelope{display:none}.waterfall-panel{margin:0 10px 10px;padding-inline:10px}.waterfall-row{grid-template-columns:92px 1fr 42px}.waterfall-scale{margin-left:101px}}`;
}

export function renderMcpObservatoryScript(): string {
  return `(() => {
  const button = document.querySelector('[data-action="send-mcp-probe"]');
  const canvas = document.querySelector(".protocol-canvas");
  if (!button || !canvas) return;
  let probing = false;
  const phases = [
    ["initialize · filesystem","48 ms","initialize",{jsonrpc:"2.0",method:"initialize",params:{client:"oh-my-cli"}}],
    ["tools/list · sqlite","71 ms","tools/list",{jsonrpc:"2.0",method:"tools/list",params:{}}],
    ["tools/call · github","156 ms","tools/call",{jsonrpc:"2.0",method:"tools/call",params:{name:"get_issue",token:"[REDACTED]"}}],
    ["result · correlated","36 ms","result",{jsonrpc:"2.0",id:"req_07f2",result:{content:"[BOUNDED]"},meta:{authorization:"[REDACTED]"}}]
  ];
  button.addEventListener("click", () => {
    if (probing) return;
    probing = true;
    canvas.dataset.mcpPhase = "probing";
    button.querySelector("b").textContent = "Probing";
    document.querySelector("[data-mcp-status]").textContent = "probe in flight";
    let index = 0;
    const advance = () => {
      const phase = phases[index];
      document.querySelector("[data-mcp-selected]").textContent = phase[0];
      document.querySelector("[data-mcp-duration]").textContent = phase[1];
      document.querySelector("[data-mcp-envelope] b").textContent = phase[2];
      document.querySelector("[data-mcp-json]").textContent = JSON.stringify(phase[3], null, 2);
      index += 1;
      if (index === phases.length) {
        window.setTimeout(() => {
          canvas.dataset.mcpPhase = "complete";
          document.querySelector("[data-mcp-status]").textContent = "probe correlated";
          document.querySelector("[data-mcp-p95]").textContent = "156 ms";
          document.querySelector("[data-mcp-calls]").textContent = "1,285";
          document.querySelector("[data-mcp-row-time]").textContent = "156 ms";
          document.querySelector("[data-mcp-trace]").textContent = "trace mcp_91a4 · 311 ms total";
          button.querySelector("b").textContent = "Probe complete";
          probing = false;
        }, 480);
        return;
      }
      window.setTimeout(advance, 470);
    };
    advance();
  });
})();`;
}
