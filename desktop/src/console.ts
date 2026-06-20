import { readTextFile } from "@tauri-apps/plugin-fs";
import { runEngine, killAllEngine, type EngineRun } from "./engine";
import { REPO_DIR } from "./config";

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
    ctx.log("\n— Cleanup —");
    runEngine(["tsx", "cleanup.ts"], ctx.log);
  };
  window.addEventListener("beforeunload", () => { void killAllEngine(); });

  // Connect (wired fully in the Connect task; basic spawn here)
  app.querySelector<HTMLButtonElement>("#btn-connect")!.onclick = () => connectX(ctx, app);
}

// eslint-disable-next-line prefer-const
export let loginRun: EngineRun | null = null;
function connectX(ctx: ConsoleCtx, app: HTMLElement): void {
  const dot = app.querySelector<HTMLElement>("#conn-dot")!;
  const text = app.querySelector<HTMLElement>("#conn-text")!;
  text.textContent = "Opening login…";
  const setConnected = () => { dot.classList.add("on"); text.textContent = "Connected"; };
  const r = runEngine(["tsx", "follow-bot.ts", "login"], (line) => {
    ctx.log(line);
    if (line.includes("XPERIMENT_LOGGED_IN")) setConnected();
  });
  loginRun = r;
  r.done.then(() => { setConnected(); loginRun = null; });
}
