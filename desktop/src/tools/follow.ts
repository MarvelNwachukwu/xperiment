import type { Panel, ConsoleCtx } from "../console";
import { followLockHeld } from "../console";
import { followArgs } from "../steps";

export const followPanel: Panel = {
  id: "follow",
  label: "Follow",
  render(host: HTMLElement, ctx: ConsoleCtx) {
    host.innerHTML = `
      <h2>Follow</h2>
      <div class="sub">Follow people from an account's followers or following. Safe-paced; daily cap 350.</div>
      <div class="banner" id="lock" hidden>A follow-type tool is already running — Stop it first.</div>
      <label class="field"><span>Target account</span><input id="target" placeholder="@somedev" /></label>
      <label class="field"><span>Target keywords <small>comma-separated bio filter — overrides the toggle; blank uses it</small></span><input id="keywords" placeholder="law, attorney, barrister, counsel" /></label>
      <label class="check"><input type="checkbox" id="following" /> Pull from their <b>&nbsp;following</b> (default: followers)</label>
      <label class="check"><input type="checkbox" id="tech" checked /> Tech accounts only <small>&nbsp;(used when no keywords above)</small></label>
      <button id="run" class="primary">Start</button>`;
    const $ = (id: string) => host.querySelector<HTMLElement>("#" + id)!;
    const run = $("run") as HTMLButtonElement;
    followLockHeld().then((held) => { ($("lock") as HTMLElement).hidden = !held; run.disabled = held; });
    run.addEventListener("click", async () => {
      const target = ($("target") as HTMLInputElement).value.trim();
      if (!target) { ctx.log("Enter a target account."); return; }
      ctx.clearLog();
      run.disabled = true;
      const args = followArgs(target, {
        following: ($("following") as HTMLInputElement).checked,
        techOnly: ($("tech") as HTMLInputElement).checked,
        keywords: ($("keywords") as HTMLInputElement).value,
      });
      await ctx.run(args).done;
      run.disabled = false;
    });
  },
};
