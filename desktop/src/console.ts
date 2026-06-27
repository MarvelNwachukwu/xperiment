import { readTextFile, exists } from "@tauri-apps/plugin-fs";
import { runEngine, killAllEngine, type EngineRun } from "./engine";
import { REPO_DIR } from "./config";
import { countToday, capLabel } from "./status";

export interface ConsoleCtx {
  log: (line: string) => void;
  clearLog: () => void;
  setBusy: (busy: boolean) => void;
  readJson: <T>(relPath: string) => Promise<T | null>;
  run: (args: string[]) => EngineRun;
}

export interface Panel {
  id: string;
  label: string;
  render: (host: HTMLElement, ctx: ConsoleCtx) => void;
}

export function mountConsole(panels: Panel[]): void {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="statusbar">
      <span class="brand"><span class="mk">◆</span> Xperiment</span>
      <span class="dot" id="conn-dot"></span><span id="conn-text">Not connected</span>
      <button id="btn-connect" class="ghost" style="padding:4px 10px">Connect X</button>
      <span class="grow"></span>
      <span class="meter" id="meters"></span>
      <button id="btn-theme" class="icon-btn" title="Theme"></button>
      <button id="btn-stop" disabled>Stop</button>
      <button id="btn-cleanup" class="danger">Cleanup</button>
    </div>
    <div class="main">
      <div class="sidebar" id="nav"></div>
      <div class="panel" id="host"></div>
    </div>
    <pre class="log" id="log"></pre>`;

  const logEl = app.querySelector<HTMLPreElement>("#log")!;
  const host = app.querySelector<HTMLElement>("#host")!;
  const nav = app.querySelector<HTMLElement>("#nav")!;
  const stopBtn = app.querySelector<HTMLButtonElement>("#btn-stop")!;

  // theme: cycle system → light → dark; persist; default follows OS
  const themeBtn = app.querySelector<HTMLButtonElement>("#btn-theme")!;
  const THEMES = ["system", "light", "dark"] as const;
  const ICON = { system: "◐", light: "☀", dark: "☾" } as const;
  const applyTheme = (t: (typeof THEMES)[number]) => {
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    themeBtn.textContent = ICON[t];
    themeBtn.title = `Theme: ${t}`;
  };
  let theme = (localStorage.getItem("theme") as (typeof THEMES)[number]) || "system";
  applyTheme(theme);
  themeBtn.onclick = () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    localStorage.setItem("theme", theme);
    applyTheme(theme);
  };

  let current: EngineRun | null = null;
  const ctx: ConsoleCtx = {
    log: (line) => { logEl.textContent += line + "\n"; logEl.scrollTop = logEl.scrollHeight; },
    clearLog: () => { logEl.textContent = ""; },
    setBusy: (busy) => { stopBtn.disabled = !busy; },
    readJson: async <T>(rel: string) => {
      try { return JSON.parse(await readTextFile(`${REPO_DIR}/${rel}`)) as T; } catch { return null; }
    },
    run: (args) => { const r = runEngine(args, ctx.log); current = r; ctx.setBusy(true);
      r.done.then(() => { ctx.setBusy(false); current = null; }); return r; },
  };

  // ---- cap meters (refresh every 4s) ----
  const meters = app.querySelector<HTMLElement>("#meters")!;
  const refreshMeters = async () => {
    const now = new Date().toISOString();
    const follows = (await ctx.readJson<{ timestamp: string }[]>("output/follow-log.json")) ?? [];
    const dms = (await ctx.readJson<{ status: string; timestamp: string }[]>("output/dm-log.json")) ?? [];
    const f = countToday(follows.map((r) => r.timestamp), now);
    const d = countToday(dms.filter((r) => r.status === "sent").map((r) => r.timestamp), now);
    meters.textContent = `follow ${capLabel(f, 350)}   ·   dm ${capLabel(d, 30)}`;
  };
  void refreshMeters();
  setInterval(refreshMeters, 4000);

  // nav + panels
  const navButtons: HTMLButtonElement[] = [];
  const select = (p: Panel, btn: HTMLButtonElement) => {
    navButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    host.innerHTML = "";
    p.render(host, ctx);
  };
  panels.forEach((p, i) => {
    const btn = document.createElement("button");
    btn.className = "nav"; btn.textContent = p.label;
    btn.onclick = () => select(p, btn);
    nav.appendChild(btn); navButtons.push(btn);
    if (i === 0) select(p, btn);
  });

  // Stop / Cleanup / window-close
  stopBtn.onclick = async () => { if (current) await current.kill(); await killAllEngine(); ctx.setBusy(false); };
  app.querySelector<HTMLButtonElement>("#btn-cleanup")!.onclick = () => {
    ctx.log("\n[ Cleanup ]");
    runEngine(["tsx", "cleanup.ts"], ctx.log);
  };
  window.addEventListener("beforeunload", () => { void killAllEngine(); });

  // Connect (wired fully in the Connect task; basic spawn here)
  app.querySelector<HTMLButtonElement>("#btn-connect")!.onclick = () => connectX(ctx, app);
}

// True if a follow-category write tool is currently running (lock file present).
export async function followLockHeld(): Promise<boolean> {
  try { return await exists(`${REPO_DIR}/output/.write-follow.lock`); } catch { return false; }
}

// eslint-disable-next-line prefer-const
export let loginRun: EngineRun | null = null;
function connectX(ctx: ConsoleCtx, app: HTMLElement): void {
  const dot = app.querySelector<HTMLElement>("#conn-dot")!;
  const text = app.querySelector<HTMLElement>("#conn-text")!;
  text.textContent = "Opening login…";
  const setConnected = () => {
    dot.classList.add("on"); text.textContent = "Connected";
    app.querySelector<HTMLButtonElement>("#btn-connect")!.style.display = "none";
  };
  const r = runEngine(["tsx", "follow-bot.ts", "login"], (line) => {
    ctx.log(line);
    if (line.includes("XPERIMENT_LOGGED_IN")) setConnected();
  });
  loginRun = r;
  r.done.then(() => { setConnected(); loginRun = null; });
}
