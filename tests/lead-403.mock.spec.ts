/**
 * Proof that a reCAPTCHA 403 on the lead endpoint aborts IMMEDIATELY after ONE
 * attempt instead of retrying. Regression guard for Jenkins build #64 (5x 403).
 *
 * Loads the REAL sandbox signup page (real widget, real styling - so a failure
 * screenshot shows the actual design), but intercepts POST /api/register/lead and
 * answers it with a 403, so no lead is ever created. Needs a headed browser
 * (the sandbox edge rejects headless browsers).
 */
import { test, expect } from './fixtures';
import { HomePage } from '../src/pages/HomePage';
import { assertSandboxOnly, urls } from '../src/utils/env';
import { generateParentEmail } from '../src/utils/email';

test('a reCAPTCHA 403 aborts after a single attempt', async ({ page }) => {
  assertSandboxOnly();
  const { registration } = urls();
  const siteOrigin = new URL(registration).origin;
  let leadCalls = 0;

  // The lead endpoint is on the core-API origin, so the faked reply must carry
  // CORS headers (and answer the preflight) for the widget to read the 403.
  const cors = {
    'access-control-allow-origin': siteOrigin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, x-api-key',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
  await page.route('**/api/register/lead', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    leadCalls += 1;
    await route.fulfill({
      status: 403,
      headers: cors,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'reCAPTCHA verification failed. Please try again.' }),
    });
  });

  const home = new HomePage(page);
  await home.open(registration);
  await home.expectLoaded();
  // Generated but not reserved: the request is intercepted and never reaches Thinkster.
  await home.enterParentEmail(generateParentEmail({ reserve: false }).email);

  await expect(home.submitEmail()).rejects.toThrow(/NON-RETRYABLE/i);

  // The whole point of the fix: exactly ONE request, not five.
  expect(leadCalls, 'a 403 must not be retried').toBe(1);
});
