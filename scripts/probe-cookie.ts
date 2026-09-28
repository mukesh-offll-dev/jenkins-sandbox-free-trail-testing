import { chromium } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
import { qaBypassCookie, urls } from '../src/utils/env';

(async () => {
  const { registration } = urls();
  const bypass = qaBypassCookie();
  if (!bypass) { console.log('NO BYPASS CONFIGURED'); process.exit(0); }
  const browser = await chromium.launch({
    headless: false, channel: process.env.BROWSER_CHANNEL || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1536, height: 864 } });
  await ctx.addCookies([{ name: bypass.name, value: bypass.value, url: registration }]);

  const stored = await ctx.cookies(registration);
  const mine = stored.find(c => c.name === bypass.name);
  console.log('STORED COOKIE ATTRS:', JSON.stringify({
    found: !!mine, domain: mine?.domain, path: mine?.path, secure: mine?.secure,
    httpOnly: mine?.httpOnly, sameSite: mine?.sameSite, expires: mine?.expires,
  }));
  for (const host of ['https://sandbox.hellothinkster.com','https://elevate-sandbox.hellothinkster.com','https://core-api-4.0-sandbox.hellothinkster.com']) {
    const c = await ctx.cookies(host);
    console.log('VISIBLE TO', host, ':', c.some(x => x.name === bypass.name));
  }

  const page = await ctx.newPage();
  const seen: any[] = [];
  page.on('request', async (r) => {
    const u = r.url();
    if (!/hellothinkster\.com/.test(u)) return;
    try {
      const all = await r.allHeaders();
      const ck = all['cookie'] || '';
      const names = ck.split(';').map(s => s.split('=')[0].trim()).filter(Boolean);
      if (seen.length < 14) seen.push({ m: r.method(), u: u.replace(/^https?:\/\//,'').slice(0,70), bypassSent: names.includes(bypass.name), names });
    } catch {}
  });
  await page.goto(registration + '/start/sign-up', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  console.log('EMAIL FIELD COUNT:', await page.locator('#twEmailFld').count());
  console.log('REQUESTS (allHeaders):');
  for (const s of seen) console.log('  ', JSON.stringify(s));
  await browser.close();
})();
