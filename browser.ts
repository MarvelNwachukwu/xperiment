import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import { PROFILE_DIR, CDP_PORT } from "./config";

const CDP_ENDPOINT = `http://localhost:${CDP_PORT}`;

export interface AcquiredBrowser {
  context: BrowserContext;
  release: () => Promise<void>;
}

// Connect to an already-running shared browser, or launch one if none exists.
// First tool = OWNER (launches Chrome on CDP_PORT; release() closes it).
// Later tools = CONNECTOR (attach over CDP; release() only disconnects, never
// kills the shared browser). Both reuse the one logged-in persistent context.
export async function acquireBrowser(): Promise<AcquiredBrowser> {
  let browser = null;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  } catch {
    browser = null; // nothing listening — we'll launch as owner
  }

  if (browser) {
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      await browser.close();
      throw new Error(
        `Connected to the shared browser on :${CDP_PORT} but it has no context ` +
          `(logged-out?). Close stray Chrome windows using this profile and retry.`
      );
    }
    console.log(`Attached to shared browser on :${CDP_PORT} (connector).`);
    const connected = browser;
    return { context: contexts[0], release: async () => { await connected.close(); } };
  }

  try {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      channel: "chrome",
      viewport: { width: 1280, height: 800 },
      args: [
        `--remote-debugging-port=${CDP_PORT}`,
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    console.log(`Launched shared browser on :${CDP_PORT} (owner).`);
    return { context, release: async () => { await context.close(); } };
  } catch (err) {
    throw new Error(
      `Could not start the browser. A browser may be half-running — close stray ` +
        `Chrome windows using this profile, or check port ${CDP_PORT}. Original: ${err}`
    );
  }
}
