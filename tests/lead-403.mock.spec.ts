/**
 * OFFLINE proof that a reCAPTCHA 403 on the lead endpoint aborts IMMEDIATELY
 * after ONE attempt instead of retrying five times.
 *
 * Everything is mocked via page.route, so no live registration request is made.
 * Regression guard for Jenkins build #64, which produced 5x HTTP 403.
 */
import { test, expect } from '@playwright/test';
import { HomePage } from '../src/pages/HomePage';
import { generateParentEmail } from '../src/utils/email';

const ORIGIN = 'https://sandbox.mock.test';

const WIDGET = `<!doctype html><html><head><title>Thinkster mock</title></head><body><main id="main-content">
  <section id="trial" role="region" aria-label="Trial signup">
    <p>GET STARTED &middot; 1 OF 8</p>
    <iframe src="https://www.google.com/recaptcha/api2/anchor?mock=1" style="display:none"></iframe>
    <input id="twEmailFld" type="email" placeholder="Parent email address" />
    <div class="tw-inline-msg" style="display:none"></div>
    <button id="twCtaLanding" type="button">Try Thinkster Risk-Free &rarr;</button>
  </section>
  <script>
    document.getElementById('twCtaLanding').addEventListener('click', async () => {
      const res = await fetch('/api/register/lead', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('twEmailFld').value }),
      });
      if (!res.ok) {
        const el = document.querySelector('.tw-inline-msg');
        el.textContent = 'Something went wrong. Please check your email and try again.';
        el.style.display = 'block';
      }
    });
  </script>
</main></body></html>`;

test('a reCAPTCHA 403 aborts after a single attempt', async ({ page }) => {
  let leadCalls = 0;

  await page.route(`${ORIGIN}/`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: WIDGET }),
  );
  await page.route('**/recaptcha/api2/anchor*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' }),
  );
  await page.route('**/api/register/lead', async (route) => {
    leadCalls += 1;
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'reCAPTCHA verification failed. Please try again.' }),
    });
  });

  const home = new HomePage(page);
  await home.open(ORIGIN);
  // Fully mocked (no live request), so the address is generated but not reserved.
  await home.enterParentEmail(generateParentEmail({ reserve: false }).email);

  await expect(home.submitEmail()).rejects.toThrow(/NON-RETRYABLE/i);

  // The whole point of the fix: exactly ONE request, not five.
  expect(leadCalls, 'a 403 must not be retried').toBe(1);
});

