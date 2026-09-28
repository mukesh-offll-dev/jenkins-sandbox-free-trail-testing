// Verifies HomePage.open() fails fast with a clear ENVIRONMENT FAILURE message
// when the edge blocks the document. Non-destructive: never submits anything.
import { chromium } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
import { HomePage } from '../src/pages/HomePage';
import { urls } from '../src/utils/env';

(async () => {
  const { registration } = urls();
  const browser = await chromium.launch({
    headless: true, channel: process.env.BROWSER_CHANNEL || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1536, height: 864 } });
  const page = await ctx.newPage();
  const home = new HomePage(page);
  const started = Date.now();
  try {
    await home.open(registration);
    console.log('RESULT: page loaded (no block) - edge rule may have been lifted');
  } catch (e) {
    const ms = Date.now() - started;
    console.log(`RESULT: failed fast in ${ms}ms`);
    console.log(String(e).split('\n').slice(0, 6).join('\n'));
  }
  await browser.close();
})();
