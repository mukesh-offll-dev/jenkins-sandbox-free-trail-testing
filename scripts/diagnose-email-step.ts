/**
 * NON-DESTRUCTIVE diagnostic for the "email + Next" registration step.
 *
 * Deliberately performs EXACTLY ONE submit attempt and never retries, so it
 * cannot contribute to rate limiting. It never requests an OTP, never creates a
 * parent account and never submits payment.
 *
 * Run:  npx tsx scripts/diagnose-email-step.ts
 */
import { chromium, BrowserContext, Page } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import { urls, qaBypassCookie, qaBypassTargets, assertSandboxOnly } from '../src/utils/env';
import { redact, redactedJson } from '../src/utils/mask';
import { buildRegistrationTestData } from '../src/utils/testData';

const BYPASS_NAME = qaBypassCookie()?.name;

interface ApiCall {
  method: string;
  url: string;
  status?: number;
  body?: string;
  bypassCookieSent?: boolean;
  cookieNamesSent?: string[];
  failure?: string;
}

async function main() {
  assertSandboxOnly();
  const { registration } = urls();
  const data = buildRegistrationTestData();
  const email = data.generatedEmail.email;

  const outDir = path.resolve(process.cwd(), 'artifacts', 'diagnostics');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    headless: process.env.HEADLESS === '1',
    channel: process.env.BROWSER_CHANNEL || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const context: BrowserContext = await browser.newContext({
    locale: 'en-US',
    timezoneId: process.env.APPOINTMENT_TIMEZONE || 'America/New_York',
    viewport: { width: 1536, height: 864 },
    ignoreHTTPSErrors: true,
  });

  // --- QA bypass cookie, applied exactly as the suite does -------------------
  const bypass = qaBypassCookie();
  const cookieReport: Record<string, unknown> = { configured: !!bypass, name: bypass?.name ?? null };
  if (bypass) {
    for (const target of qaBypassTargets()) {
      await context.addCookies([{ name: bypass.name, value: bypass.value, url: target }]);
    }
    cookieReport.appliedTo = qaBypassTargets().map((t) => new URL(t).host);
    const stored = (await context.cookies(registration)).find((c) => c.name === bypass.name);
    cookieReport.storedForRegistrationHost = !!stored;
    if (stored) {
      cookieReport.attributes = {
        domain: stored.domain, path: stored.path, secure: stored.secure,
        httpOnly: stored.httpOnly, sameSite: stored.sameSite, expires: stored.expires,
      };
    }
    const elevate = (await context.cookies('https://elevate-sandbox.hellothinkster.com')).some((c) => c.name === bypass.name);
    const coreApi = (await context.cookies('https://core-api-4.0-sandbox.hellothinkster.com')).some((c) => c.name === bypass.name);
    cookieReport.visibleToElevateSandbox = elevate;
    cookieReport.visibleToCoreApiSandbox = coreApi;
  }

  const page: Page = await context.newPage();
  const apiCalls: ApiCall[] = [];
  const consoleErrors: string[] = [];
  const failures: string[] = [];

  // --- Listeners registered BEFORE any navigation or click ------------------
  const isInteresting = (u: string) => /\/api\//.test(u);

  page.on('request', async (req) => {
    if (!isInteresting(req.url())) return;
    const all = await req.allHeaders().catch(() => ({} as Record<string,string>));
    const cookieHeader = all['cookie'] || '';
    const names = cookieHeader.split(';').map((c) => c.split('=')[0].trim()).filter(Boolean);
    apiCalls.push({
      method: req.method(),
      url: req.url(),
      bypassCookieSent: BYPASS_NAME ? names.includes(BYPASS_NAME) : undefined,
      cookieNamesSent: names,
    });
  });

  page.on('response', async (res) => {
    if (!isInteresting(res.url())) return;
    let body = '';
    try { body = (await res.text()).slice(0, 300); } catch { body = '<unreadable>'; }
    const rec = [...apiCalls].reverse().find((c) => c.url === res.url() && c.status === undefined);
    if (rec) { rec.status = res.status(); rec.body = body; }
    else apiCalls.push({ method: '?', url: res.url(), status: res.status(), body });
  });

  page.on('requestfailed', (req) => {
    failures.push(`${req.method()} ${req.url()} -> ${req.failure()?.errorText ?? 'unknown'}`);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
  });

  const result: Record<string, unknown> = { email, startedAtUtc: new Date().toISOString() };

  const navResp = await page.goto(registration, { waitUntil: 'domcontentloaded' });
  result.documentStatus = navResp?.status();
  result.documentServer = (navResp?.headers() || {})['server'];

  const emailField = page.locator('#twEmailFld');
  const cta = page.locator('#twCtaLanding');
  const congrats = page.locator('#twCtaCongrats');

  // The homepage mounts the widget below the fold after hydration; the dedicated
  // /start/sign-up route renders it immediately. Prefer whichever appears.
  let navStatusNote = `document ${result.documentStatus ?? '?'}`;
  const appeared = await emailField.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
  if (!appeared) {
    await page.goto(registration.replace(/\/$/, '') + '/start/sign-up', { waitUntil: 'domcontentloaded' });
    await emailField.waitFor({ state: 'visible', timeout: 45_000 });
    navStatusNote += ' | fell back to /start/sign-up';
  }
  result.fieldSource = navStatusNote;
  result.ctaDisabledBeforeEmail = await cta.isDisabled().catch(() => null);

  await emailField.fill(email);
  result.ctaEnabledAfterEmail = await cta.isEnabled().catch(() => null);

  // Wait for lazily-loaded reCAPTCHA, exactly as HomePage does.
  const recaptchaAttached = await page.locator('iframe[src*="api2/anchor"]').first()
    .waitFor({ state: 'attached', timeout: 45_000 }).then(() => true).catch(() => false);
  result.recaptchaAnchorAttached = recaptchaAttached;
  await page.waitForTimeout(4_000);

  // ---- EXACTLY ONE submit --------------------------------------------------
  await cta.click();
  result.submittedAtUtc = new Date().toISOString();

  const outcome = await Promise.race([
    congrats.waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'advanced').catch(() => 'pending'),
    page.waitForFunction(
      () => Array.from(document.querySelectorAll('#trial .tw-inline-msg, #trial .err'))
        .some((el) => (el as HTMLElement).offsetHeight > 0 && (el as HTMLElement).innerText.trim().length > 0),
      undefined, { timeout: 30_000 },
    ).then(() => 'error').catch(() => 'pending'),
  ]);
  result.outcome = outcome;

  const banners = await page.locator('#trial .tw-inline-msg, #trial .err').all();
  const visibleBanners: string[] = [];
  for (const b of banners) {
    if (await b.isVisible().catch(() => false)) {
      const t = (await b.innerText().catch(() => '')).trim();
      if (t) visibleBanners.push(t);
    }
  }
  result.visibleBanners = visibleBanners;
  result.stepIndicator = await page.locator('#trial').innerText()
    .then((t) => (t.match(/\d+\s*OF\s*\d+/i) || ['?'])[0]).catch(() => '?');
  result.finalUrl = page.url();

  const leadCalls = apiCalls.filter((c) => /\/api\/register\/lead$/.test(c.url));
  result.leadCallCount = leadCalls.length;
  result.leadCalls = leadCalls;
  result.allApiCalls = apiCalls;
  result.requestFailures = failures;
  result.consoleErrors = consoleErrors;
  result.qaBypassCookie = cookieReport;

  const shot = path.join(outDir, `email-step-${data.runId}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
  result.screenshot = shot;

  const jsonPath = path.join(outDir, `email-step-${data.runId}.json`);
  fs.writeFileSync(jsonPath, redactedJson(result), 'utf8');

  console.log(redact(JSON.stringify({
    outcome: result.outcome,
    stepIndicator: result.stepIndicator,
    visibleBanners: result.visibleBanners,
    ctaDisabledBeforeEmail: result.ctaDisabledBeforeEmail,
    recaptchaAnchorAttached: result.recaptchaAnchorAttached,
    leadCalls: leadCalls.map((c) => ({ status: c.status, body: c.body, bypassCookieSent: c.bypassCookieSent })),
    otherApi: apiCalls.filter((c) => !/\/api\/register\/lead$/.test(c.url)).map((c) => ({ m: c.method, u: c.url.replace(/^https?:\/\/[^/]+/, ''), s: c.status })),
    requestFailures: failures,
    consoleErrors: consoleErrors.slice(0, 5),
    qaBypassCookie: cookieReport,
    savedTo: jsonPath,
  }, null, 2)));

  await context.close();
  await browser.close();
}

main().catch((err) => { console.error(redact(String(err?.stack || err))); process.exit(1); });



