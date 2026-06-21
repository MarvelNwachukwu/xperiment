import type { Panel, ConsoleCtx } from "../console";
import { buildSteps, type ListForm } from "../steps";

interface Candidate { handle: string; name: string; location: string | null; followers: number | null; matchedKeywords: string[]; }

export const buildPanel: Panel = {
  id: "build",
  label: "Build List",
  render(host: HTMLElement, ctx: ConsoleCtx) {
    host.innerHTML = `
      <h2>Build List</h2>
      <div class="sub">Crawl seed accounts, enrich profiles, filter to matches, export CSV.</div>
      <label class="field"><span>Seed accounts <small>(one @handle per line)</small></span>
        <textarea id="seeds" rows="3" placeholder="@NigerianBar"></textarea></label>
      <label class="field"><span>Crawl side</span>
        <select id="side"><option value="following">following</option><option value="followers">followers</option></select></label>
      <label class="field"><span>Looking for <small>(keywords)</small></span>
        <input id="who" placeholder="lawyer, attorney, barrister, SAN" /></label>
      <label class="field"><span>Location <small>(optional)</small></span>
        <input id="where" placeholder="nigeria, lagos, abuja" /></label>
      <button id="run" class="primary">Build list</button>
      <button id="export" class="ghost" hidden>Export CSV</button>
      <div id="results"></div>`;
    const $ = (id: string) => host.querySelector<HTMLElement>("#" + id)!;
    $("run").addEventListener("click", async () => {
      ctx.clearLog();
      const form: ListForm = {
        seeds: ($("seeds") as HTMLTextAreaElement).value.split("\n"),
        side: ($("side") as HTMLSelectElement).value as "following" | "followers",
        who: ($("who") as HTMLInputElement).value,
        where: ($("where") as HTMLInputElement).value,
      };
      for (const step of buildSteps(form)) { ctx.log(`\n[ ${step.label} ]`); await ctx.run(step.args).done; }
      const cands = (await ctx.readJson<Candidate[]>("output/candidates.json")) ?? [];
      $("results").innerHTML = cands.length
        ? `<p>${cands.length} matches.</p><table><thead><tr><th>Handle</th><th>Name</th><th>Location</th><th>Followers</th><th>Matched</th></tr></thead><tbody>${cands.map((c) => `<tr><td>@${c.handle}</td><td>${c.name ?? ""}</td><td>${c.location ?? ""}</td><td>${c.followers ?? ""}</td><td>${(c.matchedKeywords ?? []).join(", ")}</td></tr>`).join("")}</tbody></table>`
        : `<p class="sub">No matches.</p>`;
      ($("export") as HTMLButtonElement).hidden = cands.length === 0;
    });
    $("export").addEventListener("click", async () => { ctx.log("\n[ Export CSV ]"); await ctx.run(["tsx", "prospect.ts", "export-csv"]).done; });
  },
};
