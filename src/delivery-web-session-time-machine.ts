export function renderSessionTimeMachinePage(): string {
  return `<main class="time-machine-page">
    <section class="time-machine-shell" aria-label="Session Time Machine">
      <div class="time-toolbar">
        <div class="time-session">
          <span class="time-mark">TM</span>
          <span><strong>checkout-recovery · session 04</strong><small><i></i> durable replay ready · 06:42 elapsed</small></span>
        </div>
        <div class="time-position"><span data-replay-time>03:18.420</span><small>checkpoint 04 / 06</small></div>
        <button class="time-play" type="button" data-action="play-replay"><span>▶</span><b>Play replay</b></button>
      </div>
      <div class="time-workspace">
        <section class="replay-stage">
          <div class="replay-tabs"><span class="is-active">Transcript</span><span>Patch</span><span>Tool stream</span><small data-replay-mode>paused at durable checkpoint</small></div>
          <div class="replay-content">
            <aside class="replay-rail" aria-hidden="true"><span>01</span><span>02</span><span>03</span><span class="is-active">04</span><span>05</span><span>06</span></aside>
            <div class="replay-conversation">
              <article class="replay-message user-message"><span>YOU</span><p data-replay-prompt>Restore the checkout after the interrupted refactor and keep the unrelated changes intact.</p></article>
              <article class="replay-message agent-message"><span>AGENT · 03:18</span><p data-replay-response>I found a durable checkpoint before the interrupted write. Replaying the verified patch against the current worktree.</p><div class="replay-tool"><i>✓</i><span><small>checkpoint.restore</small><strong data-replay-tool>Restored 7 files from cp_04b7</strong></span><time>184 ms</time></div></article>
              <div class="replay-diff">
                <header><span>src/runtime/session.ts</span><small data-replay-diff-meta>+18 −4 · recovered</small></header>
                <pre data-replay-diff><span>  const owner = await resolveSession(workspace);</span>
<b>+ if (!owner) return checkpoint.resume();</b>
<b>+ await journal.append({ phase: "restored" });</b>
<em>- return primaryRuntime;</em>
<span>  return owner.runtime;</span></pre>
              </div>
            </div>
          </div>
        </section>
        <aside class="checkpoint-inspector">
          <div class="inspector-heading"><span>Checkpoint inspector</span><b data-replay-health>durable</b></div>
          <div class="checkpoint-orbit"><i></i><i></i><i></i><strong data-replay-index>04</strong><span>cp_04b7</span></div>
          <dl>
            <div><dt>State</dt><dd data-replay-state>Patch restored</dd></div>
            <div><dt>Git head</dt><dd data-replay-head>8f4c2d1</dd></div>
            <div><dt>Files</dt><dd data-replay-files>7 changed</dd></div>
            <div><dt>Tool result</dt><dd data-replay-result>exit 0</dd></div>
          </dl>
          <div class="durability-stack"><span><i></i>Transcript sealed</span><span><i></i>Tool output captured</span><span><i></i>Patch checksum verified</span></div>
        </aside>
      </div>
      <div class="timeline-deck">
        <div class="timeline-meta"><span>SESSION TIMELINE</span><small>transient events</small><small><i></i>durable checkpoints</small><b data-replay-percent>58%</b></div>
        <div class="timeline-track">
          <div class="timeline-progress" data-replay-progress></div>
          <button type="button" data-checkpoint="0"><i></i><span>00:00</span><b>Prompt</b></button>
          <button type="button" data-checkpoint="1"><i></i><span>00:42</span><b>Inspect</b></button>
          <button type="button" data-checkpoint="2"><i></i><span>01:56</span><b>Patch</b></button>
          <button class="is-selected" type="button" data-checkpoint="3"><i></i><span>03:18</span><b>Restore</b></button>
          <button type="button" data-checkpoint="4"><i></i><span>04:51</span><b>Verify</b></button>
          <button type="button" data-checkpoint="5"><i></i><span>06:42</span><b>Complete</b></button>
          <input aria-label="Scrub session timeline" data-replay-scrubber max="5" min="0" step="1" type="range" value="3">
        </div>
      </div>
    </section>
  </main>`;
}

export function renderSessionTimeMachineStyles(): string {
  return `
.time-thumbnail{position:relative;display:grid;align-content:center;margin:28px 0;padding:35px;border:1px solid #d4dbea;border-right:0;border-radius:14px 0 0 14px;background:#111a2e}.time-thumbnail::before{height:2px;background:linear-gradient(90deg,#3157ff,#8c6cff);content:""}.time-thumbnail span{position:absolute;top:50%;width:11px;height:11px;border:2px solid #111a2e;background:#6f83df;transform:translateY(-50%) rotate(45deg)}.time-thumbnail span:first-child{left:20%}.time-thumbnail span:nth-child(2){left:48%;background:#8c6cff;box-shadow:0 0 14px #8c6cff}.time-thumbnail span:last-child{right:18%;background:#18a371}
.time-machine-page{min-height:100vh;padding:0;background:#f4f6fb}.time-machine-shell{display:grid;grid-template-rows:68px minmax(0,1fr) 150px;min-height:100vh;color:#111a31;background:radial-gradient(circle at 58% 38%,#eef1ff 0,transparent 32%),linear-gradient(90deg,#e9edf5 1px,transparent 1px),linear-gradient(#e9edf5 1px,transparent 1px),#f8f9fc;background-size:auto,24px 24px,24px 24px}.time-toolbar{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:24px;padding:0 24px;border-bottom:1px solid #dce2ec;background:#ffffffeb;backdrop-filter:blur(18px)}.time-session{display:flex;align-items:center;gap:11px}.time-session strong,.time-session small{display:block}.time-session strong{font-size:12px}.time-session small{margin-top:4px;color:#7d8699;font:7px "SFMono-Regular",Consolas,monospace}.time-session small i{display:inline-block;width:5px;height:5px;margin-right:5px;border-radius:50%;background:#19a371;box-shadow:0 0 0 4px #19a37114}.time-mark{display:grid;width:34px;height:34px;place-items:center;border-radius:10px;color:#fff;background:linear-gradient(135deg,#3157ff,#8b5cf6);font-size:10px;font-weight:900;box-shadow:0 10px 22px #5364db2d}.time-position{text-align:right}.time-position span,.time-position small{display:block}.time-position span{font:700 11px "SFMono-Regular",Consolas,monospace}.time-position small{margin-top:3px;color:#939bad;font:6px "SFMono-Regular",Consolas,monospace}.time-play{display:flex;align-items:center;gap:8px;padding:9px 13px;border:0;border-radius:9px;color:#fff;background:#111b31;cursor:pointer;box-shadow:0 8px 18px #10182b21}.time-play span{color:#aab8ff;font-size:8px}.time-play b{font-size:8px}.time-workspace{display:grid;grid-template-columns:minmax(0,1fr) 280px;min-height:0;margin:18px 18px 0;overflow:hidden;border:1px solid #d9dfeb;border-radius:16px 16px 0 0;background:#fff;box-shadow:0 22px 50px #1d2e5210}.replay-stage{display:grid;grid-template-rows:42px minmax(0,1fr);min-width:0;border-right:1px solid #dde2ec}.replay-tabs{display:flex;align-items:center;gap:20px;padding:0 17px;border-bottom:1px solid #e1e5ee;color:#8a92a5;font-size:8px;font-weight:700}.replay-tabs span{height:42px;padding-top:16px}.replay-tabs .is-active{color:#3157ff;border-bottom:2px solid #3157ff}.replay-tabs small{margin-left:auto;color:#7f899e;font:6px "SFMono-Regular",Consolas,monospace}.replay-tabs small::before{display:inline-block;width:5px;height:5px;margin-right:6px;border-radius:50%;background:#7657d8;content:""}.replay-content{display:grid;grid-template-columns:44px minmax(0,1fr);min-height:0;background:linear-gradient(180deg,#fbfcff,#f7f9fc)}.replay-rail{display:flex;flex-direction:column;align-items:center;gap:13px;padding-top:23px;border-right:1px solid #e4e8f0;color:#a2a9b8;font:6px "SFMono-Regular",Consolas,monospace}.replay-rail span{display:grid;width:20px;height:20px;place-items:center;border-radius:6px}.replay-rail .is-active{color:#fff;background:#3157ff;box-shadow:0 0 0 4px #3157ff12}.replay-conversation{overflow:auto;padding:20px 24px}.replay-message{max-width:760px;margin-bottom:13px;padding:15px 17px;border:1px solid #e0e5ee;border-radius:11px;background:#fff;box-shadow:0 8px 20px #24355a0a}.replay-message>span{color:#8a93a7;font:700 6px "SFMono-Regular",Consolas,monospace;letter-spacing:.08em}.replay-message p{margin:8px 0 0;color:#39455d;font-size:9px;line-height:1.6}.agent-message{margin-left:30px;border-color:#cfd8ff;background:linear-gradient(135deg,#fff,#f5f7ff)}.agent-message>span{color:#3157ff}.replay-tool{display:grid;grid-template-columns:24px 1fr auto;align-items:center;gap:9px;margin-top:12px;padding:9px;border:1px solid #d8dfeb;border-radius:8px;background:#fff}.replay-tool>i{display:grid;width:23px;height:23px;place-items:center;border-radius:7px;color:#0f7652;background:#e8f8f1;font-style:normal;font-size:8px}.replay-tool small,.replay-tool strong{display:block}.replay-tool small{color:#8790a4;font:6px "SFMono-Regular",Consolas,monospace}.replay-tool strong{margin-top:3px;font-size:7px}.replay-tool time{color:#8d95a7;font:6px "SFMono-Regular",Consolas,monospace}.replay-diff{max-width:790px;margin:18px 0 0 48px;overflow:hidden;border:1px solid #d7deea;border-radius:11px;background:#10182b;box-shadow:0 18px 34px #17244020}.replay-diff header{display:flex;justify-content:space-between;padding:10px 13px;border-bottom:1px solid #28344c;color:#d8e1f5;font:7px "SFMono-Regular",Consolas,monospace}.replay-diff header small{color:#8c9ab2}.replay-diff pre{display:grid;margin:0;padding:12px 14px;color:#aeb9ce;font:7px/1.8 "SFMono-Regular",Consolas,monospace;white-space:pre-wrap}.replay-diff b{color:#8ae0b7;background:#173b34}.replay-diff em{color:#ff9ba8;background:#49232e;font-style:normal}.checkpoint-inspector{padding:19px;background:#fff}.inspector-heading{display:flex;justify-content:space-between;align-items:center;font-size:9px;font-weight:800}.inspector-heading b{padding:4px 7px;border-radius:999px;color:#0f7652;background:#e8f8f1;font:700 6px "SFMono-Regular",Consolas,monospace}.checkpoint-orbit{position:relative;display:grid;width:116px;height:116px;margin:22px auto;place-items:center;border:1px solid #d7def2;border-radius:50%;background:radial-gradient(circle,#fff 28%,#eef1ff 29%,#f8f9ff 57%,transparent 58%)}.checkpoint-orbit::before,.checkpoint-orbit::after{position:absolute;border:1px dashed #aebbf2;border-radius:50%;content:""}.checkpoint-orbit::before{inset:12px;animation:checkpoint-spin 8s linear infinite}.checkpoint-orbit::after{inset:-7px;border-color:#e0e5f3}.checkpoint-orbit strong{z-index:1;font:800 23px "SFMono-Regular",Consolas,monospace}.checkpoint-orbit span{position:absolute;bottom:26px;color:#7657d8;font:6px "SFMono-Regular",Consolas,monospace}.checkpoint-orbit i{position:absolute;z-index:2;width:7px;height:7px;border-radius:50%;background:#3157ff;box-shadow:0 0 0 4px #3157ff17}.checkpoint-orbit i:first-child{top:7px;left:54px}.checkpoint-orbit i:nth-child(2){right:13px;bottom:23px;background:#7657d8}.checkpoint-orbit i:nth-child(3){bottom:22px;left:13px;background:#18a371}.checkpoint-inspector dl{margin:0}.checkpoint-inspector dl div{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #e8ebf1}.checkpoint-inspector dt{color:#8992a5;font-size:7px}.checkpoint-inspector dd{margin:0;color:#26344e;font:700 7px "SFMono-Regular",Consolas,monospace}.durability-stack{display:grid;gap:8px;margin-top:17px;padding:12px;border-radius:10px;background:#f5f7fb}.durability-stack span{display:flex;align-items:center;gap:7px;color:#606b81;font-size:7px}.durability-stack i{width:6px;height:6px;border-radius:2px;background:#18a371;box-shadow:0 0 0 3px #18a37110}.timeline-deck{margin:0 18px 18px;padding:15px 20px 18px;border:1px solid #d9dfeb;border-top-color:#e6e9f0;border-radius:0 0 16px 16px;background:#111a2e;color:#d8e1f4;box-shadow:0 22px 50px #1d2e5210}.timeline-meta{display:flex;align-items:center;gap:18px;color:#8d9ab0;font:6px "SFMono-Regular",Consolas,monospace}.timeline-meta>span{color:#dce5f7;font-weight:800;letter-spacing:.11em}.timeline-meta small i{display:inline-block;width:6px;height:6px;margin-right:5px;background:#8c6cff;transform:rotate(45deg)}.timeline-meta b{margin-left:auto;color:#9fb1ff}.timeline-track{position:relative;display:grid;grid-template-columns:repeat(6,1fr);margin-top:22px}.timeline-track::before,.timeline-progress{position:absolute;top:6px;right:8%;left:8%;height:2px;content:""}.timeline-track::before{background:#334058}.timeline-progress{right:auto;width:50%;background:linear-gradient(90deg,#3157ff,#8c6cff);box-shadow:0 0 12px #7657d8}.timeline-track button{position:relative;z-index:2;display:grid;justify-items:center;gap:5px;border:0;color:#8996ad;background:transparent;cursor:pointer}.timeline-track button i{width:10px;height:10px;border:2px solid #111a2e;background:#65738d;transform:rotate(45deg)}.timeline-track button.is-selected{color:#fff}.timeline-track button.is-selected i{background:#8c6cff;box-shadow:0 0 0 6px #8c6cff20,0 0 18px #8c6cff}.timeline-track button span{font:6px "SFMono-Regular",Consolas,monospace}.timeline-track button b{font-size:7px}.timeline-track input{position:absolute;inset:-8px 7% auto;width:86%;height:26px;opacity:0;cursor:ew-resize}.time-machine-shell[data-replaying="true"] .checkpoint-orbit{filter:saturate(1.25);box-shadow:0 0 30px #6c79ff25}.time-machine-shell[data-replaying="true"] .timeline-progress{animation:timeline-glow .9s ease-in-out infinite alternate}@keyframes checkpoint-spin{to{transform:rotate(360deg)}}@keyframes timeline-glow{to{filter:brightness(1.5);box-shadow:0 0 22px #8c6cff}}
@media(max-width:900px){.time-workspace{grid-template-columns:1fr}.checkpoint-inspector{display:none}.timeline-deck{overflow-x:auto}.timeline-track{min-width:650px}.time-toolbar{grid-template-columns:1fr auto}.time-position{display:none}}@media(max-width:620px){.time-machine-shell{grid-template-rows:62px minmax(0,1fr) 140px}.time-toolbar{padding:0 12px}.time-session strong{font-size:9px}.time-session small{max-width:190px}.time-play b{display:none}.time-workspace{margin:10px 10px 0}.replay-conversation{padding:14px 10px}.agent-message,.replay-diff{margin-left:0}.replay-rail{display:none}.replay-content{grid-template-columns:1fr}.timeline-deck{margin:0 10px 10px;padding-inline:12px}}`;
}

export function renderSessionTimeMachineScript(): string {
  return `(() => {
  const shell = document.querySelector(".time-machine-shell");
  const scrubber = document.querySelector("[data-replay-scrubber]");
  const playButton = document.querySelector('[data-action="play-replay"]');
  if (!shell || !scrubber || !playButton) return;
  const checkpoints = [
    ["00:00.000","01","Prompt captured","a11d909","1 opened","pending","Waiting for agent","Session initialized"],
    ["00:42.185","02","Repository inspected","b23fe10","214 indexed","exit 0","Workspace mapped","Inspected repository boundaries"],
    ["01:56.730","03","Patch prepared","c642ca8","7 changed","exit 0","Patch staged","Prepared recovery-safe patch"],
    ["03:18.420","04","Patch restored","8f4c2d1","7 changed","exit 0","Patch restored","Restored 7 files from cp_04b7"],
    ["04:51.204","05","Verification passed","8f4c2d1","1783 passed","exit 0","Tests green","Validated recovered workspace"],
    ["06:42.016","06","Session completed","a90e34f","7 committed","exit 0","Delivery sealed","Created durable completion checkpoint"]
  ];
  let timer = null;
  const render = (value) => {
    const index = Number(value);
    const item = checkpoints[index];
    scrubber.value = String(index);
    document.querySelectorAll("[data-checkpoint]").forEach((node, nodeIndex) => node.classList.toggle("is-selected", nodeIndex === index));
    document.querySelector("[data-replay-time]").textContent = item[0];
    document.querySelector(".time-position small").textContent = "checkpoint " + item[1] + " / 06";
    document.querySelector("[data-replay-index]").textContent = item[1];
    document.querySelector("[data-replay-state]").textContent = item[2];
    document.querySelector("[data-replay-head]").textContent = item[3];
    document.querySelector("[data-replay-files]").textContent = item[4];
    document.querySelector("[data-replay-result]").textContent = item[5];
    document.querySelector("[data-replay-response]").textContent = item[6] + ". The replay keeps every captured tool result and workspace mutation in order.";
    document.querySelector("[data-replay-tool]").textContent = item[7];
    document.querySelector("[data-replay-percent]").textContent = Math.round(index / 5 * 100) + "%";
    document.querySelector("[data-replay-progress]").style.width = 8 + index * 16.8 + "%";
    document.querySelector(".replay-rail .is-active")?.classList.remove("is-active");
    document.querySelectorAll(".replay-rail span")[index]?.classList.add("is-active");
  };
  scrubber.addEventListener("input", () => render(scrubber.value));
  document.querySelectorAll("[data-checkpoint]").forEach((button) => button.addEventListener("click", () => render(button.dataset.checkpoint)));
  playButton.addEventListener("click", () => {
    if (timer) return;
    shell.dataset.replaying = "true";
    playButton.querySelector("b").textContent = "Replaying";
    let next = Number(scrubber.value) >= 5 ? 0 : Number(scrubber.value) + 1;
    const advance = () => {
      render(next);
      next += 1;
      if (next > 5) {
        window.clearInterval(timer);
        timer = null;
        shell.dataset.replaying = "false";
        playButton.querySelector("b").textContent = "Replay again";
      }
    };
    advance();
    timer = window.setInterval(advance, 700);
  });
})();`;
}
