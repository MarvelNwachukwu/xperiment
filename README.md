# x-follow-bot

Two scripts for managing who you follow on X (Twitter). One follows people. The other cleans up your following list.

Both open a real Chrome window on your machine and click through the interface the same way you would, just without you having to sit there doing it. There's no API key, no developer account, nothing to apply for.

## Why this exists

I was trying to grow a tech-focused X account. The two things I kept putting off: following people from accounts in my niche, and cleaning out the hundreds of non-tech accounts I'd accumulated over the years. I tried doing it by hand a few times. Got about 20 in before I wanted to throw my laptop. So I wrote scripts instead.

## What you need

- [Node.js](https://nodejs.org/) (v18 or newer)
- Google Chrome installed on your machine
- An X account

That's it.

## Setup

Clone the repo and install dependencies:

```
git clone https://github.com/MarvelNwachukwu/xperiment.git
cd xperiment
npm install
npx playwright install chromium
```

## Logging in

Before either script can do anything, you need to log in once. This opens a Chrome window to the X login page. You log in yourself -- type your password, do 2FA, whatever you normally do. The script just watches and saves the session.

```
npm run login
```

A Chrome window opens. Log in like normal. When you're done and you see your timeline, go back to the terminal and press Enter. That's it. Your session is saved and both scripts can use it from now on.

You only need to do this once. The session sticks around until X invalidates it (usually weeks). If either script tells you you're not logged in, just run this again.

## Following people

Pick a target account whose followers you want to follow. Say you want to follow the people who follow @somedev:

```
npm run follow -- @somedev
```

The script opens Chrome, goes to that account's followers page, and starts clicking Follow on each person. It follows in human-like bursts — a few accounts a few seconds apart, then a several-minute rest — to avoid getting rate-limited, and stops for the day once it hits the daily cap (or runs out of followers). See [Chain Mode](#chain-mode-long-running) for the pacing details.

A few things it handles:

- It skips anyone you already follow
- It skips anyone it followed in a previous session (tracked in `follow-log.json`)
- If X shows a popup or dialog, it tries to dismiss it and keep going
- It scrolls down automatically to load more followers as it goes

### Flags

**`--following`** -- By default the script pulls from the target's *followers* list. Add this flag to pull from their *following* list instead. Useful when the account you're targeting follows a lot of relevant people but doesn't have many followers itself.

**`--tech-only`** -- Only follow accounts whose bio contains at least one tech-related keyword. Uses the same ~70-keyword list as the unfollow scanner (job titles, domains, technologies, etc.). The match is case-insensitive. Anyone without a recognizable tech bio gets skipped entirely.

Both flags can be combined. Here are all four variations:

```
npm run follow -- @handle                          # Follow from followers page (default)
npm run follow -- @handle --following              # Follow from following page
npm run follow -- @handle --tech-only              # Only tech accounts from followers
npm run follow -- @handle --following --tech-only  # Only tech accounts from following
```

### Rate limiting

X will rate-limit you after roughly 15-20 follows in a row. There's no way around this. What the script does is detect it and deal with it automatically.

When a follow fails (the button doesn't change to "Following"), the script keeps count. If 3 fail in a row, it assumes you've been rate-limited and pauses for 15 minutes. After the cooldown, it reloads the page and picks up where it left off. No users get skipped or lost.

In practice a session looks something like: follow 15 people, rate-limited, wait 15 min, follow another 15, rate-limited, wait 15 min, and so on. It'll do this up to 5 times before calling it quits for the session. So a full session takes a few hours with the waiting, but it gets there without you having to babysit it.

15-45 seconds between follows is the delay sweet spot I landed on. I tried 10-second intervals early on and got rate-limited almost immediately.

Every successful follow gets logged to `follow-log.json` with the username, the target account you pulled them from, and a timestamp:

```json
[
  {
    "username": "someuser",
    "target": "somedev",
    "timestamp": "2026-03-28T14:30:00.000Z"
  }
]
```

## Cleaning up your following list

This is a two-step process. First you scan, then you unfollow.

### Step 1: Scan

```
npm run scan
```

This scrolls through everyone you follow and reads their bio. If the bio contains any tech-related keywords (developer, engineer, crypto, web3, AI, startup, python, react, etc. -- there are about 70 of them), it marks that account as "keep." Everything else gets marked as an unfollow candidate.

When it finishes, it writes `output/unfollow-candidates.json`. Each entry looks like this:

```json
{
  "username": "someaccount",
  "displayName": "Some Person",
  "bio": "Lifestyle blogger and foodie",
  "isTech": false,
  "matchedKeywords": [],
  "markedForUnfollow": true
}
```

The terminal also prints a live summary as it goes, so you can watch the classification happen in real time.

### Step 2: Review

Open `output/unfollow-candidates.json` in any text editor. Look through it. If there's someone marked for unfollow that you actually want to keep, change their `"markedForUnfollow"` from `true` to `false`. The scan isn't perfect -- someone might have a non-techy bio but still be someone you want to follow. This review step is your safety net.

### Step 3: Unfollow

```
npm run unfollow
```

This reads the candidates file and unfollows everyone still marked `true`. Same deal as the follow bot: random delays between each one, picks up where it left off if you stop it, logs everything to `unfollow-log.json`.

## Chain Mode (Long-Running)

Chain mode follows tech accounts indefinitely by automatically hopping to new targets from the social graph.

### Usage

```bash
# Start a new chain from a seed account (safe paced: 300/day, 90–300s)
npm run chain -- @vitalik

# Override the daily cap
npm run chain -- @vitalik --max-per-day 150

# Burst mode: no daily cap, fast 15–45s delays. Higher ban risk —
# for short, deliberate, attended runs only.
npm run chain -- @vitalik --burst

# Resume after crash or restart (always resumes in safe mode)
npm run chain -- --resume
```

### How It Works

1. Starts following tech accounts from the seed account's following list
2. When the list is exhausted or 20 consecutive non-tech users are found (dry streak), picks a random previously-followed tech account as the next target
3. Continues chaining through the social graph indefinitely
4. Persists state to `chain-state.json` — survives crashes and restarts

By default it self-paces with a human-like **burst pattern**: it follows a
small cluster of accounts close together (2–5, a few seconds apart), then rests
3–8 minutes before the next burst — like a person scrolling and following a few
accounts, then stepping away. This is far less bot-like than a fixed metronome,
and the rests let X's rate-limit window reset between bursts.

It also self-limits: it stops once it has followed `MAX_FOLLOWS_PER_DAY`
accounts in the current UTC day (counted from the follow log, so it survives
restarts) and exits. At ~33 follows/hour, a full 350/day budget drains in
~10 hours, then the bot idles until the cap resets at UTC midnight — the cron
watchdog's retries are near-free in the meantime. This keeps you under X's
~400/day soft limit. `--resume` always uses safe pacing regardless of how the
chain was first launched, so unattended cron runs never burst-mode.

### Cron Watchdog

For 12+ hour unattended runs, set up the watchdog via cron:

```bash
# Edit crontab
crontab -e

# Add this line (checks every 5 minutes):
*/5 * * * * /path/to/project/watchdog.sh
```

The watchdog:
- Checks if the heartbeat in `chain-state.json` is stale (>10 minutes)
- Kills any hung processes
- Restarts with `--resume`

### Configuration

All constants are centralized in `config.ts`:

| Setting | Default | Description |
|---|---|---|
| `DRY_STREAK_THRESHOLD` | 20 | Non-tech skips before chaining to next target |
| `HEARTBEAT_INTERVAL_MS` | 120000 | How often heartbeat is written (2 min) |
| `MAX_FOLLOWS_PER_DAY` | 350 | Daily follow cap (per UTC day); `--burst` disables it |
| `CLUSTER_MIN` / `CLUSTER_MAX` | 2 / 5 | Follows per burst (safe mode) |
| `INTRA_DELAY_MIN_SEC` / `INTRA_DELAY_MAX_SEC` | 5 / 20 | Seconds between follows within a burst |
| `REST_DELAY_MIN_SEC` / `REST_DELAY_MAX_SEC` | 180 / 480 | Rest between bursts (3–8 min) |
| `BURST_*` | 3–5 / 3–10s / 30–90s | Cluster, intra, and rest ranges for `--burst` |
| `RATE_LIMIT_THRESHOLD` | 3 | Consecutive failures before rate-limit cooldown |
| `RATE_LIMIT_COOLDOWN_MIN` | 15 | Minutes to wait when rate-limited |
| `MAX_RATE_LIMIT_WAITS` | 5 | Max cooldowns before exiting (cron restarts) |

## Outreach Profiles (prospect.ts)

`prospect.ts` builds a current picture of who you follow, enriches those accounts into deep profiles, and filters down to a decision-maker shortlist that a separate DM-writing AI can work from.

### Pipeline

```
npm run prospect:sync    → output/following.json   (who you follow right now)
npm run prospect:enrich  → output/profiles.json    (deep data per account)
npm run prospect:filter  → output/candidates.json  (decision-maker shortlist)
                           [writer AI]
                        → output/messages.json     (DM drafts, external step)
                           [future dm-bot.ts]       (sends the messages)
```

`prepare` chains all three steps in order: sync → enrich → filter.

### Usage

```bash
# Sync your following list
npm run prospect:sync -- @yourhandle

# Enrich all accounts in following.json
npm run prospect:enrich

# Enrich only specific handles
npm run prospect:enrich -- --handles @a,@b

# Filter profiles.json down to candidates
npm run prospect:filter

# Run the full pipeline in one command
npm run prospect:prepare -- @yourhandle
```

### following.json

`following.json` is the canonical synced set of who you follow -- it is separate from `follow-log.json`, which is the bot's action log of every follow it has made. On each sync, accounts are merged: `firstSeen` is preserved from the first time an account was synced, `lastSynced` is refreshed to now. Accounts that were in a previous sync but are missing from the current scrape are kept in the file with a `stale` flag rather than deleted, so you don't silently lose history.

### Enrichment

Enrichment pulls deep profile data for each account: bio, follower and following counts, location, website, join date, verified status, parsed role and company (inferred from bio), pinned tweet, and roughly 5 recent tweets.

It is resumable -- accounts that already have a `profiles.json` entry are skipped. It runs with the same burst pacing as the follow bot and respects a daily cap (`ENRICH_MAX_PER_DAY`, default 300) to stay well under X's rate limits.

### Filtering

Filtering is two-stage. Accounts with strong title signals (founder, CTO, CEO, head of, VP, etc.) land in the `strong` bucket. Accounts with ambiguous signals (lead, director, principal, etc.) land in a `review` bucket for human triage. Each candidate record includes `matchedKeywords` so the DM-writing AI can see exactly why that person was kept.

### Building a niche list (any topic)

Use `crawl` to seed the pipeline from any public account's follower/following graph, then `filter` with Target Criteria to keep only the profiles that match your niche.

```bash
# 1. Log in once
npm run login

# 2. Crawl seed accounts — repeat for each relevant account
npx tsx prospect.ts crawl @BarAssociation --side followers
npx tsx prospect.ts crawl @BigLawFirm --side followers
# Fills output/following.json. --side is "following" or "followers" (default "following").

# 3. Enrich crawled accounts into deep profiles
npm run prospect:enrich
# Writes output/profiles.json

# 4. Filter to niche using Target Criteria
npx tsx prospect.ts filter --who "lawyer,attorney,barrister,SAN" --where "nigeria,lagos,abuja"
# Writes output/candidates.json

# 5. Export to CSV
npx tsx prospect.ts export-csv
# Writes output/candidates.csv
```

`--who` is required to activate Target Criteria mode; omit it and `filter` falls back to the built-in decision-maker role filter. `--where` is optional — omit it to match any location.

### Generated files

All these files live under `output/`, which is gitignored.

## Sending DMs (dm-bot.ts)

`dm-bot.ts` sends the AI-drafted DMs in `output/messages.json` to the decision-maker shortlist built by `prospect.ts`.

### messages.json shape

`output/messages.json` is produced by the external writer AI — it is not generated by any script in this repo. The shape is an object keyed by handle:

```json
{
  "@somefounder": { "tone": "cold", "text": "Hey, saw you're building..." },
  "@anotherdev":  { "tone": "warm", "text": "Really enjoyed your thread on..." }
}
```

- Keys are handles, with or without a leading `@` (both are accepted).
- `tone` is `"cold"` or `"warm"`; `text` is the message sent verbatim (≤ 10,000 chars).
- The real file is gitignored under `output/`. A committed reference lives at [`messages.example.json`](messages.example.json) — point your writer agent at it.

**Writer-agent workflow:** the agent reads `output/candidates.json` (each entry has `handle`, `name`, `bio`, `roleConfidence`, `matchedKeywords` (the matched titles, e.g. `["ceo","founder"]`), `company`, `followers`, `location`, `pinnedTweet`, and `recentTweets[]`) and writes one personalized entry per handle to `output/messages.json`. Only handles present in `candidates.json` are sent; anything else is logged `failed` ("not a candidate").

### Safety: dry-run by default

`npm run dm` does the full open-DM check and logs `dry_run` entries but sends nothing. You must pass `--live` to actually send. `--approve` prompts `y/n` before each individual send.

```bash
npm run dm                        # dry-run preview (safe default)
npm run dm -- --approve --live    # send, confirming each message
npm run dm -- --live              # send all, unattended
```

### What it handles

- **Skips closed DMs** — if a profile has no Message button the message is logged `skipped_no_open_dm` and the bot moves on.
- **Idempotent** — it never double-sends the exact same text to the same person. The check is based on a `textHash` of the message body, so a revised draft will re-send.
- **Validates length** — messages over `DM_MAX_LENGTH` (10,000 characters) are rejected and logged `failed` before any browser navigation.
- **Daily cap** — stops once it has sent `DM_MAX_PER_DAY` messages in the current UTC day (default 30). The cap is intentionally much lower than the follow cap: unsolicited DMs get flagged fast.
- **Paced in bursts** — same burst-and-rest rhythm as the other tools to avoid triggering X's automation detection.

### Logging

Every attempt is appended to `output/dm-log.json` with a status of `sent`, `skipped_no_open_dm`, `failed`, or `dry_run`.

Always dry-run first (`npm run dm`) and confirm the DM selectors work in your browser before going `--live`.

## Running multiple tools at once

All tools share **one** Chrome over CDP (`CDP_PORT`, default 9222). The first tool you start launches the browser; any tool you start afterward attaches to that same instance. One login serves all of them, so you can run, say, `prospect:enrich` in one terminal and `follow` in another without hitting Chrome's `SingletonLock` error.

**Start the longer-running tool first.** Whichever tool launched the browser owns it. If that tool exits while another is attached, the shared browser closes and the attached tool stops with a "shared browser closed" message.

### Write guard

To prevent two tools from clobbering each other's state:

- **Follow-category tools** (`follow`, `chain`, `unfollow`) are mutually exclusive. Starting a second one while the first is running refuses with a message that names the holder (pid + start time).
- **`dm --live`** is its own separate category, so it *can* run alongside a follow-category tool — but not alongside another `dm --live`.
- **Read-only commands** (`prospect sync`/`enrich`/`filter`, `dm` dry-run, `login`) are never blocked.
- **`--force`** overrides the refusal. It logs a warning and proceeds without clobbering the holder's lock file, so the holder is not affected.

Lock files live at `output/.write-follow.lock` and `output/.write-dm.lock`. If a run crashes without cleaning up, the stale lock is automatically reclaimed the next time a tool starts — it checks whether the recorded pid is still alive.

### Example

```bash
# terminal 1 — read-only, never blocked
npm run prospect:enrich

# terminal 2 — follow-category write tool
npm run follow -- @somedev --tech-only

# terminal 3 — different category, runs alongside the follow tool
npm run dm -- --live
```

## The keyword list

The scan classifies accounts by checking their bio against a list of ~70 keywords. These cover:

- Job titles: developer, engineer, founder, CTO, designer
- Domains: web3, crypto, blockchain, AI, machine learning, cybersecurity, devops
- Technologies: javascript, python, rust, react, docker, kubernetes
- Community: startup, indie hacker, building in public, hackathon, open source
- Platforms: github, AWS, GCP, solidity

If none of these appear in someone's bio, they get flagged as a candidate. The list is defined at the top of `unfollow-bot.ts` and you can edit it to match whatever niche you care about.

## How it avoids getting detected

X doesn't like automation, and they're not subtle about it. My first version used a headless browser and got my account locked after one follow. Literally one.

What works now: the scripts open your actual installed Chrome (not a testing binary that X can fingerprint), use a persistent browser profile that looks like a real person coming back to the same browser, and strip out the automation flags that tools like Playwright normally leave behind. The random delays between actions help too. X can tell if something is clicking at machine speed.

If you crank the delays too low or follow too many people in one sitting, you'll still get rate-limited. The defaults are what worked for me without problems.

## Configuration

Most constants are centralized in `config.ts`. To change them, open that file and edit the values:

- `CLUSTER_MIN` / `CLUSTER_MAX` -- follows per burst (default: 2-5; `--burst` uses 3-5)
- `INTRA_DELAY_MIN_SEC` / `INTRA_DELAY_MAX_SEC` -- delay between follows within a burst (default: 5-20s)
- `REST_DELAY_MIN_SEC` / `REST_DELAY_MAX_SEC` -- rest between bursts (default: 180-480s)
- `MAX_FOLLOWS_PER_DAY` -- daily follow cap per UTC day (default: 350; `--burst` disables it)
- `RATE_LIMIT_THRESHOLD` -- how many consecutive failures before assuming rate limit (default: 3)
- `RATE_LIMIT_COOLDOWN_MIN` -- how long to wait when rate-limited, in minutes (default: 15)
- `MAX_RATE_LIMIT_WAITS` -- how many cooldowns before giving up for the session (default: 5)
- `DRY_STREAK_THRESHOLD` -- non-tech skips before chaining to the next target in chain mode (default: 20)
- `HEARTBEAT_INTERVAL_MS` -- how often the chain runner writes a heartbeat (default: 2 minutes)

`TECH_KEYWORDS` is defined separately in both `follow-bot.ts` and `unfollow-bot.ts` -- they are not shared. If you edit the keyword list in one file, update the other one too.

## Files the scripts create

All generated state and logs live under `output/` (gitignored). The only generated thing outside it is the Chrome profile, which stays at the repo root because moving it would force a re-login.

- `.chrome-profile/` -- the persistent Chrome profile with your login session (repo root)
- `output/follow-log.json` -- record of every account you've followed
- `output/following.json` -- canonical set of who you follow (synced)
- `output/profiles.json` -- deep enriched profiles
- `output/candidates.json` -- decision-maker shortlist
- `output/messages.json` -- DM drafts (produced by the writer AI)
- `output/dm-log.json` -- record of DM sends
- `output/unfollow-candidates.json` -- the scan results (your review list)
- `output/unfollow-log.json` -- record of every account you've unfollowed
- `output/chain-state.json` -- chain mode state (current target, followed list, heartbeat)
- `output/chain-log.txt` -- append-only log of chain mode activity

## If something goes wrong

**"Not logged in" error** -- run `npm run login` again. Your session probably expired.

**Account gets locked** -- X sometimes locks accounts for "unusual activity." Go to x.com in your normal browser, pass the challenge (usually a captcha), and you're fine. This happened to me when I was still using headless mode. Haven't had the issue since switching to a visible Chrome window.

**Rate limited** -- the script will just fail to follow/unfollow that person and move on. If you're hitting rate limits often, increase the delay values.

**Script stops mid-session** -- just run it again. It tracks what it's already done and picks up where it left off.

## License

MIT
