# X Follow Bot — Design Spec

## Overview

A Playwright-based automation script that logs into X (Twitter) using saved cookies, navigates to a target account's followers page, and follows users one by one with random delays. Caps at 150 follows per session. Logs each follow to a JSON file. Skips already-followed users.

## Project Structure

```
follow-bot.ts        # Main script (login + follow commands)
package.json         # Dependencies and npm scripts
cookies.json         # Saved auth cookies (gitignored)
follow-log.json      # Follow history with timestamps (gitignored)
.gitignore           # Excludes cookies.json and follow-log.json
```

### Dependencies

- `playwright` (with Chromium browser)
- `tsx` (run TypeScript directly)

### npm Scripts

- `npm run login` — launches visible browser for manual login, saves cookies
- `npm run follow -- @targethandle` — runs the follow bot against a target's followers page

## Login Flow

1. Launch Chromium in **visible** (headed) mode
2. Navigate to `https://x.com/login`
3. Print to terminal: `"Log in manually (including 2FA if needed). Press Enter in the terminal when done."`
4. Wait for user to press Enter via stdin
5. Extract all cookies from the browser context via `context.cookies()`
6. Write cookies to `cookies.json`
7. Close browser and exit

The user handles all authentication steps manually (username, password, 2FA). The script only captures the resulting session cookies.

## Follow Loop

### Startup

1. Parse the target username from CLI args (strip leading `@` if present)
2. Launch Chromium in **headless** mode
3. Create a new browser context and load cookies from `cookies.json`
4. Navigate to `https://x.com/{target}/followers`
5. Verify the page loaded correctly (not redirected to login). If redirected to login, print an error asking the user to re-run `npm run login` and exit.
6. Load existing `follow-log.json` into a `Set<string>` of already-followed usernames

### Processing Followers

For each follower card visible on the page:

1. **Extract username** from the card's user link (the `/@username` href pattern)
2. **Skip check 1 (log-based):** If username exists in the follow-log Set, skip silently
3. **Skip check 2 (UI-based):** If the associated button text reads "Following" or "Pending", skip silently
4. **Click** the "Follow" button
5. **Wait** for confirmation — button text changes to "Following" (timeout: 5 seconds)
6. **Log** to `follow-log.json`: append `{ "username": "<username>", "target": "<target>", "timestamp": "<ISO 8601>" }`
7. **Increment** the follow counter
8. **Check cap:** If counter >= 150, stop the session
9. **Delay:** Wait a random duration between 30-90 seconds (uniform distribution) before processing the next user

### Scrolling for More Followers

When all visible follower cards have been processed:

1. Scroll down to the bottom of the page to trigger X's infinite scroll
2. Wait up to 5 seconds for new follower cards to appear
3. If new cards loaded, continue processing from the first new card
4. If no new cards appear after scrolling, the follower list is exhausted — stop the session

### Session Termination

The session ends when any of these occur:
- Follow counter reaches 150
- No new followers load after scrolling
- A fatal page error occurs (page crash, network failure)

On termination, print a summary: `"Session complete. Followed {count} users."`

## Error Handling

| Scenario | Action |
|---|---|
| Follow button click fails (not found, timeout) | Log warning with username, skip, continue |
| Confirmation timeout (button doesn't change) | Log warning, skip, continue |
| Unexpected popup/modal appears | Attempt to dismiss, log warning, continue |
| Page fails to load entirely | Exit with error message |
| Cookies expired (redirect to login) | Print "Cookies expired. Run `npm run login` again." and exit |

Errors are logged to stderr. The script never retries a failed follow — it skips and moves on.

## Logging

### File: `follow-log.json`

A JSON array of follow records:

```json
[
  {
    "username": "someuser",
    "target": "targetaccount",
    "timestamp": "2026-03-28T12:34:56.000Z"
  }
]
```

### Write Strategy

- Read the full array at startup
- After each successful follow, read the current file, append the new record, and write the full array back
- This ensures the file is always valid JSON even if the script is killed mid-session

## Configuration Constants

Defined at the top of `follow-bot.ts`:

| Constant | Value | Description |
|---|---|---|
| `MAX_FOLLOWS` | 150 | Maximum follows per session |
| `MIN_DELAY_SEC` | 30 | Minimum random delay between follows |
| `MAX_DELAY_SEC` | 90 | Maximum random delay between follows |
| `COOKIES_FILE` | `cookies.json` | Path to saved cookies |
| `LOG_FILE` | `follow-log.json` | Path to follow log |
| `FOLLOW_TIMEOUT_MS` | 5000 | Timeout waiting for follow confirmation |
| `SCROLL_WAIT_MS` | 5000 | Timeout waiting for new cards after scroll |
