import type { Page } from "playwright";
import { acquireBrowser } from "./browser";
import { acquireWriteLock } from "./write-lock";
import { BurstScheduler, applyDelay } from "./pacing";
import {
  loadDmLog,
  saveDmLog,
  loadMessages,
  alreadySent,
  validateMessage,
  dmsToday,
  parseDmFlags,
  textHash,
  confirmPrompt,
  type DmRecord,
} from "./dm-store";
import {
  TG_MESSAGES_FILE,
  TG_LOG_FILE,
  TG_MAX_PER_DAY,
  TG_MAX_LENGTH,
  DM_CLUSTER_MIN,
  DM_CLUSTER_MAX,
  DM_INTRA_DELAY_MIN_SEC,
  DM_INTRA_DELAY_MAX_SEC,
  DM_REST_DELAY_MIN_SEC,
  DM_REST_DELAY_MAX_SEC,
} from "./config";

// Sends Telegram messages through Telegram Web (the "K" client) in the shared
// Chrome profile, logged in once with `tg-bot.ts login`. Same safety model as
// dm-bot: dry-run by default, --live to send, --approve to confirm each one.

const WEBK = "https://web.telegram.org/k/";

type TmeKind = "user" | "bot" | "channel" | "group" | "missing";

// "@alice", "alice", "t.me/alice", "https://t.me/alice/" -> "alice"
function normalizeTgHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?t(elegram)?\.me\//i, "")
    .replace(/^@/, "")
    .replace(/[/?#].*$/, "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

// Classifies the public t.me/<username> preview page. A username that doesn't
// exist still gets a page, just without a title. Channels and groups show a
// subscriber/member count where a person shows "@username"; bots get a
// "Start Bot" button.
function parseTmePage(html: string): { kind: TmeKind; name: string } {
  if (!html.includes('class="tgme_page_title"')) return { kind: "missing", name: "" };
  const name = (html.match(/<meta property="og:title" content="([^"]*)"/)?.[1] ?? "")
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e])
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
  const extra = html.match(/class="tgme_page_extra"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  if (/subscriber/.test(extra)) return { kind: "channel", name };
  if (/member/.test(extra)) return { kind: "group", name };
  if (/tgme_action_button_new[^>]*>\s*Start Bot/.test(html)) return { kind: "bot", name };
  return { kind: "user", name };
}

// Letters and digits only: Telegram Web draws emoji and badges next to names
// as icons, so raw text comparisons would fail on them.
const nameKey = (s: string) => s.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

// Opens the chat with a full page load. Changing only the URL hash does not
// reliably switch chats in Telegram Web, and a full load also means the
// previous chat can't still be on screen. We then wait until the header shows
// this person's name (from t.me) and the composer belongs to the same peer.
// Returns "" when a message can be typed, else the reason it can't.
async function openChat(page: Page, username: string, name: string): Promise<string> {
  await page.goto("about:blank");
  await page.goto(`${WEBK}#?tgaddr=${encodeURIComponent(`tg://resolve?domain=${username}`)}`, {
    waitUntil: "domcontentloaded",
  });
  const header = await page
    .waitForFunction(
      (key) => {
        const t = document.querySelector(".chat-info .peer-title");
        const k = (t?.textContent ?? "").normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
        return k === key ? t!.getAttribute("data-peer-id") : null;
      },
      nameKey(name),
      { timeout: 25000 }
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  if (!header) return `chat for "${name}" did not open`;
  await page.waitForTimeout(1500);
  // A person who only accepts messages from contacts or Premium users, or who
  // blocked us, gets a button (e.g. "UNBLOCK") where the composer should be.
  return page.evaluate((peerId) => {
    const input = document.querySelector(`.input-message-input[data-peer-id="${peerId}"]`);
    if (!input || !input.checkVisibility()) return "no message box";
    const blockers = [...document.querySelectorAll(".chat-input button")]
      .filter((b) => b.checkVisibility())
      .map((b) => (b as HTMLElement).innerText.replace(/[\uE000-\uF8FF]/g, "").trim())
      .filter(Boolean);
    return blockers.length ? blockers.join(" / ") : "";
  }, header);
}

// fill() on the contenteditable composer keeps line breaks as line breaks
// (Enter would send). Success = composer cleared and the last outgoing bubble
// starts with our text and is no longer in the "sending" state.
async function sendTg(page: Page, text: string): Promise<boolean> {
  const input = page.locator(".input-message-input[data-peer-id]");
  await input.fill(text);
  await page.waitForTimeout(500);
  await page.locator(".btn-send.send").click();
  return page
    .waitForFunction(
      (t) => {
        const input = document.querySelector(".input-message-input[data-peer-id]");
        const bubble = [...document.querySelectorAll(".bubble.is-out")].pop();
        return (
          input?.textContent === "" &&
          !!bubble &&
          !bubble.classList.contains("is-sending") &&
          !bubble.classList.contains("is-error") &&
          (bubble.querySelector(".message")?.textContent ?? "").startsWith(t)
        );
      },
      text.trim(),
      { timeout: 20000 }
    )
    .then(() => true)
    .catch(() => false);
}

async function login(): Promise<void> {
  const { context, release } = await acquireBrowser();
  const page = await context.newPage();
  try {
    await page.goto(WEBK);
    console.log("Log in to Telegram Web in the Chrome window (scan the QR code with your phone). Waiting up to 5 minutes...");
    await page.waitForSelector(".chatlist", { timeout: 5 * 60 * 1000 });
    console.log("✓ Logged in. The session is saved in the shared Chrome profile.");
  } finally {
    await release();
  }
}

async function send(): Promise<void> {
  const args = process.argv.slice(3);
  const { live, approve } = parseDmFlags(args);
  const releaseLock = live ? acquireWriteLock("tg", "tg-bot", args.includes("--force")) : () => {};

  const messages = loadMessages(TG_MESSAGES_FILE);
  const keys = Object.keys(messages);
  if (keys.length === 0) {
    console.error(`No ${TG_MESSAGES_FILE} found (or empty). Expected { "<username>": { "tone": "...", "text": "..." } }.`);
    process.exit(1);
  }
  const log = loadDmLog(TG_LOG_FILE);

  console.log(live ? "⚠ LIVE mode: messages WILL be sent." : "DRY-RUN: nothing will be sent (pass --live to actually send).");
  if (approve) console.log("Approve mode: you'll confirm each message before it sends.");

  let dailyCount = dmsToday(log, new Date().toISOString());
  if (live && dailyCount >= TG_MAX_PER_DAY) {
    console.log(`Daily Telegram cap already reached (${dailyCount}/${TG_MAX_PER_DAY}). Stopping until UTC midnight.`);
    releaseLock();
    return;
  }

  const scheduler = new BurstScheduler({
    clusterMin: DM_CLUSTER_MIN,
    clusterMax: DM_CLUSTER_MAX,
    intraDelayMinSec: DM_INTRA_DELAY_MIN_SEC,
    intraDelayMaxSec: DM_INTRA_DELAY_MAX_SEC,
    restDelayMinSec: DM_REST_DELAY_MIN_SEC,
    restDelayMaxSec: DM_REST_DELAY_MAX_SEC,
  });

  const record = (handle: string, status: DmRecord["status"], reason: string, text: string) => {
    log.push({ handle, status, reason, timestamp: new Date().toISOString(), textHash: textHash(text) });
    saveDmLog(log, TG_LOG_FILE);
  };

  const { context, release } = await acquireBrowser();
  const page = await context.newPage();
  try {
    await page.goto(WEBK);
    if (!(await page.waitForSelector(".chatlist", { timeout: 30000 }).catch(() => null))) {
      console.error("Not logged in to Telegram Web. Run: npx tsx tg-bot.ts login");
      process.exitCode = 1;
      return;
    }

    for (const key of keys) {
      const msg = messages[key];
      const text = msg?.text ?? "";
      // Log keys are lowercase usernames; Telegram usernames are case-insensitive.
      const handle = normalizeTgHandle(key).toLowerCase();

      if (alreadySent(log, handle, text)) {
        console.log(`  ↪ @${handle}: already sent this message, skipping.`);
        continue;
      }
      const v = validateMessage(text, TG_MAX_LENGTH);
      if (!v.ok) {
        console.warn(`  ⚠ @${handle}: ${v.reason} — skipping.`);
        record(handle, "failed", v.reason, text);
        continue;
      }

      // Read-only check on the public t.me page before touching the browser.
      const peer = await fetch(`https://t.me/${handle}`)
        .then((r) => r.text())
        .then(parseTmePage)
        .catch(() => null);
      if (!peer) {
        console.warn(`  ⚠ @${handle}: could not load t.me/${handle} — skipping.`);
        record(handle, "failed", "t.me lookup failed", text);
        continue;
      }
      if (peer.kind !== "user") {
        const why = peer.kind === "missing" ? "no such username" : `is a ${peer.kind} ("${peer.name}"), not a person`;
        console.log(`  ✗ @${handle}: ${why} — skipping.`);
        record(handle, "skipped_bad_handle", why, text);
        continue;
      }

      // From here we navigate the browser; pace every navigated iteration.
      const blocked = await openChat(page, handle, peer.name).catch((err) => `error: ${err}`);
      if (blocked) {
        console.log(`  🔒 @${handle} (${peer.name}): can't message — ${blocked}.`);
        record(handle, "skipped_no_open_dm", blocked, text);
        await applyDelay(scheduler.next());
        continue;
      }

      if (!live) {
        console.log(`  [dry-run] would message @${handle} (${peer.name}): ${text.slice(0, 60)}...`);
        record(handle, "dry_run", "dry-run", text);
        await applyDelay(scheduler.next());
        continue;
      }

      if (approve && !(await confirmPrompt(`@${handle} (${peer.name}):\n  "${text}"`))) {
        console.log(`  ⏭ @${handle}: skipped by you.`);
        await applyDelay(scheduler.next());
        continue;
      }

      if (await sendTg(page, text).catch(() => false)) {
        record(handle, "sent", "ok", text);
        dailyCount++;
        console.log(`  ✓ Sent to @${handle} (${dailyCount}/${TG_MAX_PER_DAY} today)`);
        if (dailyCount >= TG_MAX_PER_DAY) {
          console.log(`\n  Daily Telegram cap reached (${dailyCount}/${TG_MAX_PER_DAY}). Stopping until UTC midnight.`);
          break;
        }
      } else {
        record(handle, "failed", "send not confirmed (composer did not clear or bubble missing)", text);
        console.warn(`  ⚠ @${handle}: send not confirmed. Check the chat before retrying.`);
      }
      await applyDelay(scheduler.next());
    }
  } finally {
    await release();
    releaseLock();
  }

  const totalSent = log.filter((r) => r.status === "sent").length;
  console.log(`\nDone. ${totalSent} total sent across all runs. See ${TG_LOG_FILE}.`);
}

if (require.main === module) {
  const command = process.argv[2];
  const run = command === "send" ? send : command === "login" ? login : null;
  if (!run) {
    console.error("Usage: tsx tg-bot.ts login | tsx tg-bot.ts send [--live] [--approve]");
    process.exit(1);
  }
  run().catch((err) => {
    console.error("tg-bot failed:", err);
    process.exit(1);
  });
}
