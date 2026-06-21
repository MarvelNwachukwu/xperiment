import type { Panel, ConsoleCtx } from "../console";
import { followLockHeld } from "../console";
import { chainArgs } from "../steps";

export const chainPanel: Panel = {
  id: "chain",
  label: "Chain",
  render(host: HTMLElement, ctx: ConsoleCtx) {
    host.innerHTML = `
      <h2>Chain</h2>
      <div class="sub">Long-running: hops the social graph, following accounts that match your keywords. Safe-paced; daily cap 350. Use Stop to end it.</div>
      <div class="banner" id="lock" hidden>A follow-type tool is already running — Stop it first.</div>
      <label class="field"><span>Seed account</span><input id="seed" placeholder="@vitalik" /></label>
      <label class="field"><span>Target keywords <small>comma-separated — leave blank for tech/crypto</small></span><input id="keywords" placeholder="law, attorney, barrister, counsel" /></label>
      <button id="run" class="primary">Start chain</button>
      <button id="resume" class="ghost">Resume last</button>`;
    const $ = (id: string) => host.querySelector<HTMLElement>("#" + id)!;
    const run = $("run") as HTMLButtonElement;
    const resume = $("resume") as HTMLButtonElement;
    followLockHeld().then((held) => { ($("lock") as HTMLElement).hidden = !held; run.disabled = held; resume.disabled = held; });
    run.addEventListener("click", async () => {
      const seed = ($("seed") as HTMLInputElement).value.trim();
      const keywords = ($("keywords") as HTMLInputElement).value;
      if (!seed) { ctx.log("Enter a seed account."); return; }
      ctx.clearLog(); run.disabled = true;
      await ctx.run(chainArgs(seed, { resume: false, keywords })).done; run.disabled = false;
    });
    resume.addEventListener("click", async () => {
      const keywords = ($("keywords") as HTMLInputElement).value;
      ctx.clearLog(); resume.disabled = true;
      await ctx.run(chainArgs("", { resume: true, keywords })).done; resume.disabled = false;
    });
  },
};
