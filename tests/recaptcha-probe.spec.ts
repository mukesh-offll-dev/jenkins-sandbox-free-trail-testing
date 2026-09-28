import { test, expect } from './fixtures';
import { HomePage } from '../src/pages/HomePage';
import { buildRegistrationTestData } from '../src/utils/testData';
import { urls } from '../src/utils/env';

/**
 * Lightweight reCAPTCHA health probe.
 *
 * Exercises ONLY the reCAPTCHA-guarded lead-capture step so we can tell whether
 * the environment currently lets automated sessions through, without creating a
 * full registration (no parent, no student, no held calendar slot, no payment).
 *
 * Run with:  npx playwright test tests/recaptcha-probe.spec.ts
 */
test('reCAPTCHA health probe - can this session capture a lead?', async ({ page }) => {
  test.setTimeout(3 * 60 * 1000);

  const statuses: string[] = [];
  page.on('response', async (r) => {
    if (!/\/api\/register\/lead$/.test(r.url())) return;
    let body = '';
    try {
      body = (await r.text()).slice(0, 120);
    } catch {
      body = '<unreadable>';
    }
    statuses.push(`HTTP ${r.status()} ${body}`);
  });

  const data = buildRegistrationTestData();
  const home = new HomePage(page);

  await home.open(urls().registration);
  await home.expectLoaded();
  await home.enterParentEmail(data.generatedEmail.email);

  let verdict = 'PASS';
  try {
    const result = await home.submitEmail();
    console.log(`\n>>> reCAPTCHA PROBE: PASSED on attempt ${result.attempts}`);
    if (result.transientErrors.length) {
      console.log('>>> transient errors along the way:');
      result.transientErrors.forEach((e) => console.log(`      ${e}`));
    }
  } catch (error) {
    verdict = 'BLOCKED';
    console.log(`\n>>> reCAPTCHA PROBE: BLOCKED`);
    console.log(`>>> ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  }

  console.log('>>> observed /api/register/lead responses:');
  statuses.forEach((s, i) => console.log(`      ${i + 1}. ${s}`));
  console.log(`>>> VERDICT: ${verdict}\n`);

  expect(verdict, 'reCAPTCHA is currently rejecting this automated session').toBe('PASS');
});
