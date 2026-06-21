import { writeTextFile } from "@tauri-apps/plugin-fs";
import type { Panel, ConsoleCtx } from "../console";
import { followLockHeld } from "../console";
import { unfollowScanArgs, unfollowArgs } from "../steps";
import { REPO_DIR } from "../config";

interface ScanRow { username: string; displayName: string; bio: string; isTech: boolean; matchedKeywords: string[]; markedForUnfollow: boolean; }

export const unfollowPanel: Panel = {
  id: "unfollow",
  label: "Unfollow",
  render(host: HTMLElement, ctx: ConsoleCtx) {
    host.innerHTML = `
      <h2>Unfollow</h2>
      <div class="sub">Scan who you follow, review the non-tech list, then unfollow the ones you keep checked.</div>
      <div class="banner" id="lock" hidden>A follow-type tool is already running — Stop it first.</div>
      <button id="scan" class="primary">Scan following</button>
      <div id="review"></div>`;
    const $ = (id: string) => host.querySelector<HTMLElement>("#" + id)!;
    const scan = $("scan") as HTMLButtonElement;
    followLockHeld().then((held) => { ($("lock") as HTMLElement).hidden = !held; scan.disabled = held; });

    scan.addEventListener("click", async () => {
      ctx.clearLog(); scan.disabled = true;
      await ctx.run(unfollowScanArgs()).done; scan.disabled = false;
      const rows = (await ctx.readJson<ScanRow[]>("output/unfollow-candidates.json")) ?? [];
      const flagged = rows.filter((r) => r.markedForUnfollow);
      $("review").innerHTML = `<p class="sub">${flagged.length} marked for unfollow. Uncheck anyone to keep, then Unfollow.</p>
        <table><tbody>${flagged.map((r, i) => `<tr><td><input type="checkbox" data-i="${i}" checked></td><td>@${r.username}</td><td>${(r.bio || "").slice(0, 70)}</td></tr>`).join("")}</tbody></table>
        <button id="go" class="primary" style="margin-top:12px">Unfollow checked</button>`;
      $("review").querySelector<HTMLButtonElement>("#go")!.addEventListener("click", async () => {
        // Persist edits: only checked rows stay markedForUnfollow=true.
        const checks = [...$("review").querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
        const keepIdx = new Set(checks.filter((c) => c.checked).map((c) => Number(c.dataset.i)));
        flagged.forEach((r, i) => { r.markedForUnfollow = keepIdx.has(i); });
        const byName = new Map(flagged.map((r) => [r.username, r]));
        const merged = rows.map((r) => byName.get(r.username) ?? r);
        await writeTextFile(`${REPO_DIR}/output/unfollow-candidates.json`, JSON.stringify(merged, null, 2));
        ctx.clearLog();
        await ctx.run(unfollowArgs()).done;
      });
    });
  },
};
