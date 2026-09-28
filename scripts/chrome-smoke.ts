/**
 * Chrome launch smoke test.
 *
 * Proves the Jenkins service account can actually launch the browser the
 * registration suite will use, BEFORE the 15-minute registration test starts.
 * A launch/permission problem then surfaces here in seconds with a clear
 * message instead of as an opaque timeout deep inside the journey.
 *
 * Deliberately offline: it opens about:blank only. It never contacts Thinkster,
 * creates an account, or touches payment data, so it is safe to run anywhere.
 *
 * Launch options mirror playwright.config.ts on purpose - the check is only
 * meaningful if it fails under the same conditions the real run would.
 */

import { chromium } from '@playwright/test';

const LAUNCH_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  // Empty/unset means "use Playwright's bundled Chromium"; any value selects an
  // installed system browser channel (chrome, msedge, ...).
  const channel = process.env.BROWSER_CHANNEL?.trim() || undefined;

  console.log(`[chrome-smoke] channel: ${channel ?? '(bundled Chromium)'}`);

  const browser = await chromium.launch({
    channel,
    timeout: LAUNCH_TIMEOUT_MS,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    console.log(`[chrome-smoke] launched, browser version: ${browser.version()}`);

    const page = await browser.newPage();
    await page.goto('about:blank');

    const url = page.url();
    if (url !== 'about:blank') {
      throw new Error(`Expected about:blank, got "${url}".`);
    }

    // Confirms the renderer process is alive, not just the browser process.
    const ready = await page.evaluate(() => document.readyState);
    console.log(`[chrome-smoke] about:blank open, document.readyState=${ready}`);
  } finally {
    await browser.close();
  }

  console.log('[chrome-smoke] PASSED - browser launched and closed cleanly.');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[chrome-smoke] FAILED - could not launch the browser.\n${message}`);
  console.error(
    '\nIf BROWSER_CHANNEL=chrome, check that:\n' +
      '  1. Google Chrome is installed at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n' +
      '  2. The Jenkins service account has read+execute permission on that path\n' +
      '  3. Chrome is registered for the machine (per-machine install, not per-user)',
  );
  process.exit(1);
});
