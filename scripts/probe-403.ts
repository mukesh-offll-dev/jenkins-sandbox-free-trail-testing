import { chromium } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
import { qaBypassCookie, urls } from '../src/utils/env';
import { redact } from '../src/utils/mask';

async function attempt(label: string, opts: { headless: boolean; channel?: string; useBypass: boolean }) {
  const { registration } = urls();
  const browser = await chromium.launch({
    headless: opts.headless,
    channel: opts.channel,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1536, height: 864 } });
  const bypass = qaBypassCookie();
  let cookieApplied = false;
  if (opts.useBypass && bypass) {
    await ctx.addCookies([{ name: bypass.name, value: bypass.value, url: registration }]);
    cookieApplied = true;
  }
  const page = await ctx.newPage();
  let status: number | undefined;
  let serverHdr = '';
  let bodySnippet = '';
  let sentCookieNames: string[] = [];
  page.on('request', (r) => {
    if (r.url().replace(/\/$/, '') === registration.replace(/\/$/, '')) {
      const ck = r.headers()['cookie'] || '';
      sentCookieNames = ck.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
    }
  });
  try {
    const resp = await page.goto(registration, { waitUntil: 'domcontentloaded', timeout: 60000 });
    status = resp?.status();
    const h = resp?.headers() || {};
    serverHdr = [h['server'], h['cf-ray'] ? 'cf-ray:present' : '', h['x-cache'] || '', h['content-type'] || ''].filter(Boolean).join(' | ');
    bodySnippet = (await page.content()).replace(/\s+/g, ' ').slice(0, 260);
  } catch (e) {
    bodySnippet = 'NAV ERROR: ' + String(e).slice(0, 160);
  }
  const hasField = await page.locator('#twEmailFld').count().catch(() => -1);
  console.log(redact(JSON.stringify({
    label, status, respHeaders: serverHdr, cookieApplied,
    cookieNamesSentOnDocumentRequest: sentCookieNames,
    twEmailFldCount: hasField, bodySnippet,
  })));
  await browser.close();
}

(async () => {
  await attempt('A headless + bypass',    { headless: true,  channel: process.env.BROWSER_CHANNEL, useBypass: true });
  await attempt('B headless NO bypass',   { headless: true,  channel: process.env.BROWSER_CHANNEL, useBypass: false });
  await attempt('C headed   + bypass',    { headless: false, channel: process.env.BROWSER_CHANNEL, useBypass: true });
})();
