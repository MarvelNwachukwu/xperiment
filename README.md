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

The script opens Chrome, goes to that account's followers page, and starts clicking Follow on each person. It waits 15-45 seconds between each one (random) to avoid getting rate-limited. It stops after 150 follows or when it runs out of followers to process.

A few things it handles:

- It skips anyone you already follow
- It skips anyone it followed in a previous session (tracked in `follow-log.json`)
- If a follow fails for whatever reason, it moves on to the next person
- If X shows a popup or dialog, it tries to dismiss it and keep going
- It scrolls down automatically to load more followers as it goes

The 150 cap is there because X will rate-limit you beyond that. I learned this the hard way. 15-45 seconds between follows is the sweet spot I landed on after getting rate-limited at 10-second intervals.

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

The numbers are defined at the top of each script file. To change them, open the `.ts` file and edit the constants:

In `follow-bot.ts`:
- `MAX_FOLLOWS` -- how many people to follow before stopping (default: 150)
- `MIN_DELAY_SEC` / `MAX_DELAY_SEC` -- delay range between follows (default: 15-45 seconds)

In `unfollow-bot.ts`:
- `MIN_DELAY_SEC` / `MAX_DELAY_SEC` -- delay range between unfollows (default: 15-45 seconds)
- `TECH_KEYWORDS` -- the list of keywords used to classify bios

## Files the scripts create

These are all gitignored:

- `.chrome-profile/` -- the persistent Chrome profile with your login session
- `follow-log.json` -- record of every account you've followed
- `unfollow-candidates.json` -- the scan results (your review list)
- `unfollow-log.json` -- record of every account you've unfollowed

## If something goes wrong

**"Not logged in" error** -- run `npm run login` again. Your session probably expired.

**Account gets locked** -- X sometimes locks accounts for "unusual activity." Go to x.com in your normal browser, pass the challenge (usually a captcha), and you're fine. This happened to me when I was still using headless mode. Haven't had the issue since switching to a visible Chrome window.

**Rate limited** -- the script will just fail to follow/unfollow that person and move on. If you're hitting rate limits often, increase the delay values.

**Script stops mid-session** -- just run it again. It tracks what it's already done and picks up where it left off.

## License

MIT
