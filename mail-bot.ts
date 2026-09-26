import { randomUUID } from "crypto";
import { ImapFlow } from "imapflow";
import { acquireWriteLock } from "./write-lock";
import { loadDmLog, saveDmLog, loadMessages, validateMessage, textHash, type DmRecord } from "./dm-store";
import { MAIL_MESSAGES_FILE, MAIL_LOG_FILE, GMAIL_IMAP_HOST } from "./config";

// Email never sends from here. `draft` saves each message as a Gmail draft so
// the User reads it (and fixes anything) before clicking Send; `sync` looks in
// Sent Mail afterwards and logs the ones that went out.

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function mailProblem(to: string, subject: string, text: string): string {
  if (!EMAIL_RE.test(to)) return "not an email address";
  if (!subject.trim()) return "missing subject";
  if (/[\r\n]/.test(subject)) return "subject has a line break";
  return validateMessage(text, Infinity).reason;
}

// RFC 2047 encoded-word for non-ASCII header text; ASCII passes through.
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf-8").toString("base64")}?=`;
}

// Plain-text RFC 5322 message. The body is base64 so any character and line
// length survives; line endings are normalized to CRLF before encoding.
function buildRfc822(m: { from: string; to: string; subject: string; text: string; date: Date }): string {
  const body = Buffer.from(m.text.replace(/\r?\n/g, "\r\n"), "utf-8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  const domain = m.from.split("@")[1];
  return [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${m.date.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

function credentials(): { user: string; pass: string } {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass || !EMAIL_RE.test(user)) {
    console.error(
      "Set GMAIL_USER (your full address) and GMAIL_APP_PASSWORD (an app password from\n" +
        "myaccount.google.com/apppasswords; needs 2-Step Verification) in the environment."
    );
    process.exit(1);
  }
  return { user, pass: pass.replace(/\s+/g, "") };
}

async function connect(): Promise<{ client: ImapFlow; user: string }> {
  const { user, pass } = credentials();
  const client = new ImapFlow({ host: GMAIL_IMAP_HOST, port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  return { client, user };
}

// Gmail localizes folder names ("[Gmail]/Brouillons"), so find them by their
// IMAP special-use flag instead of by path.
async function specialFolder(client: ImapFlow, flag: "\\Drafts" | "\\Sent"): Promise<string> {
  const folder = (await client.list()).find((f) => f.specialUse === flag);
  if (!folder) throw new Error(`No ${flag} folder on this account. Is IMAP enabled in Gmail settings?`);
  return folder.path;
}

async function draft(): Promise<void> {
  const args = process.argv.slice(3);
  const live = args.includes("--live");
  const releaseLock = live ? acquireWriteLock("mail", "mail-bot", args.includes("--force")) : () => {};

  const messages = loadMessages(MAIL_MESSAGES_FILE);
  const addresses = Object.keys(messages);
  if (addresses.length === 0) {
    console.error(`No ${MAIL_MESSAGES_FILE} found (or empty). Expected { "<email>": { "subject": "...", "text": "..." } }.`);
    process.exit(1);
  }
  const log = loadDmLog(MAIL_LOG_FILE);
  const record = (handle: string, status: DmRecord["status"], reason: string, text: string) => {
    log.push({ handle, status, reason, timestamp: new Date().toISOString(), textHash: textHash(text) });
    saveDmLog(log, MAIL_LOG_FILE);
  };

  console.log(live ? "LIVE: drafts WILL be saved to Gmail (nothing is sent)." : "DRY-RUN: nothing saved (pass --live to save drafts).");

  const conn = live ? await connect() : null;
  try {
    const draftsPath = conn ? await specialFolder(conn.client, "\\Drafts") : "";
    let saved = 0;
    for (const key of addresses) {
      const to = key.trim().toLowerCase();
      const { subject = "", text = "" } = messages[key];
      const hash = textHash(text);

      if (log.some((r) => r.handle === to && r.textHash === hash && (r.status === "drafted" || r.status === "sent"))) {
        console.log(`  ↪ ${to}: this text is already drafted or sent, skipping.`);
        continue;
      }
      const problem = mailProblem(to, subject, text);
      if (problem) {
        console.warn(`  ⚠ ${to}: ${problem} — skipping.`);
        record(to, "failed", problem, text);
        continue;
      }

      if (!conn) {
        console.log(`  [dry-run] would draft to ${to}: "${subject}" / ${text.split("\n")[0].slice(0, 60)}...`);
        record(to, "dry_run", "dry-run", text);
        continue;
      }

      const raw = buildRfc822({ from: conn.user, to, subject, text, date: new Date() });
      const ok = await conn.client.append(draftsPath, raw, ["\\Draft", "\\Seen"]).catch((err) => {
        console.warn(`  ⚠ ${to}: IMAP append failed: ${err}`);
        return false;
      });
      if (ok) {
        record(to, "drafted", `saved to ${draftsPath}`, text);
        saved++;
        console.log(`  ✎ Drafted to ${to}: "${subject}"`);
      } else {
        record(to, "failed", "IMAP append failed", text);
      }
    }
    if (conn) console.log(`\nDone. ${saved} new drafts in ${draftsPath}. Review and send them from Gmail, then run: mail-bot.ts sync`);
  } finally {
    await conn?.client.logout();
    releaseLock();
  }
}

// For every drafted message not yet logged as sent, look in Sent Mail for a
// message to that address on or after the draft day. IMAP SINCE is day-grained.
async function sync(): Promise<void> {
  const log = loadDmLog(MAIL_LOG_FILE);
  const pending = new Map<string, DmRecord>(); // address -> latest drafted record not yet sent
  for (const r of log) {
    if (r.status === "drafted") pending.set(r.handle, r);
    if (r.status === "sent" && pending.get(r.handle)?.textHash === r.textHash) pending.delete(r.handle);
  }
  if (pending.size === 0) {
    console.log("No drafted emails waiting to be confirmed as sent.");
    return;
  }

  const { client } = await connect();
  let found = 0;
  try {
    const lock = await client.getMailboxLock(await specialFolder(client, "\\Sent"));
    try {
      for (const [to, d] of pending) {
        // SINCE is day-grained in the server's time zone, so search from the day
        // before and keep only messages dated after the draft was saved.
        const draftedAt = new Date(d.timestamp);
        const since = new Date(draftedAt.getTime() - 24 * 60 * 60 * 1000);
        const uids = (await client.search({ to, since }, { uid: true })) || [];
        const msgs = uids.length ? await client.fetchAll(uids.join(","), { envelope: true }, { uid: true }) : [];
        const sentAt = msgs
          .map((m) => (m.envelope?.date ? new Date(m.envelope.date) : null))
          .filter((t): t is Date => !!t && t >= draftedAt)
          .sort((a, b) => b.getTime() - a.getTime())[0];
        if (!sentAt) {
          console.log(`  … ${to}: still a draft`);
          continue;
        }
        log.push({ handle: to, status: "sent", reason: "found in Sent Mail", timestamp: sentAt.toISOString(), textHash: d.textHash });
        found++;
        console.log(`  ✓ ${to}: sent ${sentAt.toISOString()}`);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  saveDmLog(log, MAIL_LOG_FILE);
  console.log(`\n${found} newly confirmed as sent. See ${MAIL_LOG_FILE}.`);
}

if (require.main === module) {
  const command = process.argv[2];
  const run = command === "draft" ? draft : command === "sync" ? sync : null;
  if (!run) {
    console.error("Usage: tsx mail-bot.ts draft [--live] | tsx mail-bot.ts sync");
    process.exit(1);
  }
  run().catch((err) => {
    console.error("mail-bot failed:", err);
    process.exit(1);
  });
}
