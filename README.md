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

The script opens Chrome, goes to that account's followers page, and starts clicking Follow on each person. It waits 15-45 seconds between each one (random) to avoid getting rate-limited. It stops when it runs out of followers to process.

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

When it finishes, it writes `unfollow-candidates.json`. Each entry looks like this:

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

Open `unfollow-candidates.json` in any text editor. Look through it. If there's someone marked for unfollow that you actually want to keep, change their `"markedForUnfollow"` from `true` to `false`. The scan isn't perfect -- someone might have a non-techy bio but still be someone you want to follow. This review step is your safety net.

### Step 3: Unfollow

```
npm run unfollow
```

This reads the candidates file and unfollows everyone still marked `true`. Same deal as the follow bot: random delays between each one, picks up where it left off if you stop it, logs everything to `unfollow-log.json`.

## Chain Mode (Long-Running)

Chain mode follows tech accounts indefinitely by automatically hopping to new targets from the social graph.

### Usage

```bash
# Start a new chain from a seed account
npm run chain -- @vitalik

# Resume after crash or restart
npm run chain -- --resume
```

### How It Works

1. Starts following tech accounts from the seed account's following list
2. When the list is exhausted or 20 consecutive non-tech users are found (dry streak), picks a random previously-followed tech account as the next target
3. Continues chaining through the social graph indefinitely
4. Persists state to `chain-state.json` — survives crashes and restarts

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
| `MIN_DELAY_SEC` | 15 | Min seconds between follows |
| `MAX_DELAY_SEC` | 45 | Max seconds between follows |
| `RATE_LIMIT_THRESHOLD` | 3 | Consecutive failures before rate-limit cooldown |
| `RATE_LIMIT_COOLDOWN_MIN` | 15 | Minutes to wait when rate-limited |
| `MAX_RATE_LIMIT_WAITS` | 5 | Max cooldowns before exiting (cron restarts) |

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

- `MIN_DELAY_SEC` / `MAX_DELAY_SEC` -- delay range between follows/unfollows (default: 15-45 seconds)
- `RATE_LIMIT_THRESHOLD` -- how many consecutive failures before assuming rate limit (default: 3)
- `RATE_LIMIT_COOLDOWN_MIN` -- how long to wait when rate-limited, in minutes (default: 15)
- `MAX_RATE_LIMIT_WAITS` -- how many cooldowns before giving up for the session (default: 5)
- `DRY_STREAK_THRESHOLD` -- non-tech skips before chaining to the next target in chain mode (default: 20)
- `HEARTBEAT_INTERVAL_MS` -- how often the chain runner writes a heartbeat (default: 2 minutes)

`TECH_KEYWORDS` is defined separately in both `follow-bot.ts` and `unfollow-bot.ts` -- they are not shared. If you edit the keyword list in one file, update the other one too.

## Files the scripts create

These are all gitignored:

- `.chrome-profile/` -- the persistent Chrome profile with your login session
- `follow-log.json` -- record of every account you've followed
- `unfollow-candidates.json` -- the scan results (your review list)
- `unfollow-log.json` -- record of every account you've unfollowed
- `chain-state.json` -- chain mode state (current target, followed list, heartbeat)
- `chain-log.txt` -- append-only log of chain mode activity

## If something goes wrong

**"Not logged in" error** -- run `npm run login` again. Your session probably expired.

**Account gets locked** -- X sometimes locks accounts for "unusual activity." Go to x.com in your normal browser, pass the challenge (usually a captcha), and you're fine. This happened to me when I was still using headless mode. Haven't had the issue since switching to a visible Chrome window.

**Rate limited** -- the script will just fail to follow/unfollow that person and move on. If you're hitting rate limits often, increase the delay values.

**Script stops mid-session** -- just run it again. It tracks what it's already done and picks up where it left off.

## License

MIT
