/**
 * reCAPTCHA reputation persistence.
 *
 * WHY THIS EXISTS (verified against the live sandbox)
 * --------------------------------------------------
 * `POST /api/register/lead` and `POST /api/register/parent` are guarded by
 * invisible reCAPTCHA v3. A brand-new, cookie-less browser context is scored as
 * a bot and the API answers:
 *     403 {"error":"reCAPTCHA verification failed. Please try again."}
 *
 * Proven experimentally: from the SAME machine and IP, using the SAME interaction
 * sequence, a long-lived browser profile received `201 Lead captured successfully`
 * while a fresh ephemeral context received `403`. The differentiator is session
 * reputation (principally the `_GRECAPTCHA` cookie on google.com), not the IP.
 *
 * So we persist ONLY the Google/reCAPTCHA cookies between runs and deliberately
 * drop every Thinkster cookie, which gives us:
 *   - accumulated reCAPTCHA reputation  (fewer 403s)
 *   - a completely fresh application session every run (no resumed widget state,
 *     no stale Elevate login), which the registration journey requires.
 *
 * Using `storageState` (rather than a persistent profile via
 * launchPersistentContext) keeps Playwright's built-in trace, video and
 * screenshot handling fully intact.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { BrowserContext } from '@playwright/test';

const STATE_DIR = path.resolve(process.cwd(), '.auth');
export const RECAPTCHA_STATE_FILE = path.join(STATE_DIR, 'recaptcha-state.json');

/** On-disk Chromium profile reused across runs to retain reCAPTCHA reputation. */
export const PROFILE_DIR = path.join(STATE_DIR, 'chrome-profile');

/** Domains whose cookies we keep: Google's reCAPTCHA reputation carriers. */
const KEEP_DOMAIN = /(^|\.)(google\.com|gstatic\.com|recaptcha\.net)$/;

/** Path to a previously saved state, or undefined on the very first run. */
export function existingRecaptchaState(): string | undefined {
  return fs.existsSync(RECAPTCHA_STATE_FILE) ? RECAPTCHA_STATE_FILE : undefined;
}

/**
 * Save the Google-only cookie jar for the next run.
 *
 * Safe to call after either a pass or a fail - reputation accrues either way.
 * Never throws: this is an optimisation, not a test requirement.
 */
export async function saveRecaptchaState(context: BrowserContext): Promise<string | null> {
  try {
    const state = await context.storageState();

    const cookies = state.cookies.filter((cookie) => KEEP_DOMAIN.test(cookie.domain.replace(/^\./, '')));

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(
      RECAPTCHA_STATE_FILE,
      // origins are intentionally dropped: no app localStorage is carried over.
      JSON.stringify({ cookies, origins: [] }, null, 2),
      'utf8',
    );
    return RECAPTCHA_STATE_FILE;
  } catch {
    return null;
  }
}
