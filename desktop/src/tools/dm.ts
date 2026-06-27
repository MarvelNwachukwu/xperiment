import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { Panel, ConsoleCtx } from "../console";
import { dmArgs } from "../steps";
import { dataPath } from "../config";

interface Candidate { handle: string; name: string; location: string | null; }

// Fill {name}/{location}/{handle} per candidate into the messages.json dm-bot reads.
function fillTemplate(tpl: string, c: Candidate): string {
  return tpl
    .split("{name}").join(c.name || c.handle)
    .split("{location}").join(c.location || "")
    .split("{handle}").join(c.handle);
}

export const dmPanel: Panel = {
  id: "dm",
  label: "DM",
  render(host: HTMLElement, ctx: ConsoleCtx) {
    host.innerHTML = `
      <h2>DM</h2>
      <div class="sub">Write one template; it personalizes per candidate. Dry-run first, sending is a separate confirm. Daily cap 30.</div>
      <label class="field" style="max-width:640px"><span>Message template <small>(use {name}, {location})</small></span>
        <textarea id="tpl" rows="4" placeholder="Hi {name}, I'm reaching out to legal professionals in {location} about…"></textarea></label>
      <button id="prep" class="primary">Preview (dry-run)</button>
      <div id="out"></div>`;
    const $ = (id: string) => host.querySelector<HTMLElement>("#" + id)!;

    async function writeMessages(): Promise<number> {
      const cands = (await ctx.readJson<Candidate[]>("output/candidates.json")) ?? [];
      const tpl = ($("tpl") as HTMLTextAreaElement).value.trim();
      if (!tpl) { ctx.log("Write a template first."); return 0; }
      if (cands.length === 0) { ctx.log("No candidates.json. Build a list first."); return 0; }
      const messages: Record<string, { tone: string; text: string }> = {};
      for (const c of cands) messages[c.handle] = { tone: "warm", text: fillTemplate(tpl, c) };
      await writeTextFile(await dataPath("output/messages.json"), JSON.stringify(messages, null, 2));
      return cands.length;
    }

    $("prep").addEventListener("click", async () => {
      ctx.clearLog();
      const n = await writeMessages();
      if (n === 0) return;
      await ctx.run(dmArgs({ live: false })).done; // dry-run
      $("out").innerHTML = `<div class="confirm"><div class="warn">⚠ Dry-run above shows who WOULD be messaged.</div>
        Send real DMs to up to ${n} people (closed-DM ones auto-skip, max 30/day)?
        <div style="margin-top:10px"><button id="send" class="primary">Send for real</button></div></div>`;
      $("out").querySelector<HTMLButtonElement>("#send")!.addEventListener("click", async () => {
        $("out").innerHTML = "";
        ctx.clearLog();
        await ctx.run(dmArgs({ live: true })).done; // live
      });
    });
  },
};
