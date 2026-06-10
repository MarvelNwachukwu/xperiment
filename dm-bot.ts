import type { Page } from "playwright";
import * as readline from "readline";
import { launchBrowser } from "./follow-bot";
import { BurstScheduler, applyDelay } from "./pacing";
import {
  loadDmLog,
  saveDmLog,
  loadMessages,
  loadCandidateHandles,
  alreadySent,
  validateMessage,
  dmsToday,
  parseDmFlags,
  textHash,
  type DmRecord,
} from "./dm-store";
import {
  DM_MAX_PER_DAY,
  DM_MAX_LENGTH,
  DM_CLUSTER_MIN,
  DM_CLUSTER_MAX,
  DM_INTRA_DELAY_MIN_SEC,
  DM_INTRA_DELAY_MAX_SEC,
  DM_REST_DELAY_MIN_SEC,
  DM_REST_DELAY_MAX_SEC,
} from "./config";

function confirmPrompt(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}\n  Send? [y/N] `, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "y");
    });
  });
}

// Navigate to the profile and try to open the DM composer. Returns true if a
// composer input is reachable (i.e. we can DM this person). Opening the
// composer does NOT send anything — X only creates the conversation on send.
async function openDmComposer(page: Page, handle: string): Promise<boolean> {
  await page.goto(`https://x.com/${handle}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const msgBtn = await page.$('[data-testid="sendDMFromProfile"], button[aria-label^="Message"]');
  if (!msgBtn) return false;
  await msgBtn.click();
  const input = await page
    .waitForSelector('[data-testid="dmComposerTextInput"]', { timeout: 8000 })
    .catch(() => null);
  return !!input;
}

// Types text into the already-open composer and clicks send. Returns true if
// the composer cleared (best-effort confirmation that the message went out).
async function sendDm(page: Page, text: string): Promise<boolean> {
  const input = await page.$('[data-testid="dmComposerTextInput"]');
  if (!input) return false;
  await input.click();
  await page.keyboard.type(text);
  await page.waitForTimeout(500);
  const sendBtn = await page.$('[data-testid="dmComposerSendButton"]');
  if (!sendBtn) return false;
  await sendBtn.click();
  await page.waitForTimeout(2000);
  const remaining = (await input.innerText().catch(() => "")) ?? "";
  return remaining.trim().length === 0;
}

async function send(): Promise<void> {
  const args = process.argv.slice(3);
  const { live, approve } = parseDmFlags(args);

  const messages = loadMessages();
  const handles = Object.keys(messages);
  if (handles.length === 0) {
    console.error('No messages.json found (or empty). Expected { "<handle>": { "tone": "...", "text": "..." } }.');
    process.exit(1);
  }
  const candidates = loadCandidateHandles();
  const log = loadDmLog();

  console.log(
    live
      ? "⚠ LIVE mode: messages WILL be sent."
      : "DRY-RUN: nothing will be sent (pass --live to actually send)."
  );
  if (approve) console.log("Approve mode: you'll confirm each message before it sends.");

  let dailyCount = dmsToday(log, new Date().toISOString());
  if (live && dailyCount >= DM_MAX_PER_DAY) {
    console.log(`Daily DM cap already reached (${dailyCount}/${DM_MAX_PER_DAY}). Stopping until UTC midnight.`);
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
    saveDmLog(log);
  };

  const context = await launchBrowser();
  const page = await context.newPage();
  try {
    for (const handle of handles) {
      const msg = messages[handle];
      const text = msg?.text ?? "";

      // Idempotency: never re-send the exact same text to the same person.
      if (alreadySent(log, handle, text)) {
        console.log(`  ↪ @${handle}: already sent this message, skipping.`);
        continue;
      }

      // Validate before any navigation (no browser cost on bad input).
      const v = validateMessage(text, DM_MAX_LENGTH);
      if (!v.ok) {
        console.warn(`  ⚠ @${handle}: ${v.reason} — skipping.`);
        record(handle, "failed", v.reason, text);
        continue;
      }
      if (candidates.size > 0 && !candidates.has(handle)) {
        console.warn(`  ⚠ @${handle}: not in candidates.json — skipping.`);
        record(handle, "failed", "not a candidate", text);
        continue;
      }

      // From here we navigate the browser; pace every navigated iteration.
      const canDm = await openDmComposer(page, handle).catch(() => false);
      if (!canDm) {
        console.log(`  🔒 @${handle}: DMs closed / no Message button — skipping.`);
        record(handle, "skipped_no_open_dm", "no DM affordance", text);
        await applyDelay(scheduler.next());
        continue;
      }

      if (!live) {
        console.log(`  [dry-run] would DM @${handle} (${msg.tone}): ${text.slice(0, 60)}...`);
        record(handle, "dry_run", "dry-run", text);
        await applyDelay(scheduler.next());
        continue;
      }

      if (approve) {
        const ok = await confirmPrompt(`@${handle} (${msg.tone}):\n  "${text}"`);
        if (!ok) {
          console.log(`  ⏭ @${handle}: skipped by you.`);
          await applyDelay(scheduler.next());
          continue;
        }
      }

      const sent = await sendDm(page, text).catch(() => false);
      if (sent) {
        record(handle, "sent", "ok", text);
        dailyCount++;
        console.log(`  ✓ Sent to @${handle} (${dailyCount}/${DM_MAX_PER_DAY} today)`);
        if (dailyCount >= DM_MAX_PER_DAY) {
          console.log(`\n  Daily DM cap reached (${dailyCount}/${DM_MAX_PER_DAY}). Stopping until UTC midnight.`);
          break;
        }
      } else {
        record(handle, "failed", "send failed (composer/send button missing)", text);
        console.warn(`  ⚠ @${handle}: send failed.`);
      }
      await applyDelay(scheduler.next());
    }
  } finally {
    await context.close();
  }

  const totalSent = log.filter((r) => r.status === "sent").length;
  console.log(`\nDone. ${totalSent} total sent across all runs. See dm-log.json.`);
}

if (require.main === module) {
  const command = process.argv[2];
  if (command === "send") {
    send().catch((err) => {
      console.error("dm-bot failed:", err);
      process.exit(1);
    });
  } else {
    console.error("Usage: tsx dm-bot.ts send [--live] [--approve]");
    process.exit(1);
  }
}
