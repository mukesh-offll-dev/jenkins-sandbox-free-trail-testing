/**
 * OFFLINE validation of the A/B activation-arm detection.
 *
 * Uses static DOM reproduced verbatim from Jenkins build #64 artifacts, so the
 * branching logic is proven without making ANY live registration request, OTP
 * request or payment. Safe to run repeatedly.
 */
import { test, expect } from '@playwright/test';
import { SandboxPaymentPage } from '../src/pages/SandboxPaymentPage';

/** No-card arm, reproduced from build #64 retry1 error-context.md. */
const NO_CARD_ARM = `
<main id="main-content">
  <section id="trial" role="region" aria-label="Trial signup">
    <p>YOUR TRIAL &mdash; ACTIVATED 3-DAY TRIAL ACTIVATED</p>
    <h2>Welcome to Thinkster &mdash; thank you!</h2>
    <p>Test's 3-day trial is live. The personalized plan, full curriculum and 24/7 AI Coach are ready and waiting.</p>
    <p>Live 1:1 session &mdash; Fri, Oct 2 &mdash; 7:30 PM</p>
    <button type="button">Open the Elevate App &rarr;</button>
  </section>
</main>`;

/** Card-required arm: ACTIVATE TRIAL 1 OF 3, the gift offer. */
const CARD_ARM = `
<main id="main-content">
  <section id="trial" role="region" aria-label="Trial signup">
    <p>ACTIVATE TRIAL &middot; 1 OF 3</p>
    <h2>A gift to get started</h2>
    <button type="button" id="twCtaGift">See my plan &rarr;</button>
  </section>
</main>`;

/** Neither arm - e.g. the widget errored or rendered something unknown. */
const UNKNOWN = `
<main id="main-content">
  <section id="trial" role="region" aria-label="Trial signup">
    <p>Something went wrong. Please try again.</p>
  </section>
</main>`;

test.describe('activation arm detection (offline, mocked DOM)', () => {
  test('detects the no-card arm from build #64 DOM', async ({ page }) => {
    await page.setContent(NO_CARD_ARM);
    const payment = new SandboxPaymentPage(page);

    expect(await payment.detectActivationFlow(5_000)).toBe('activated-without-card');

    // The safeguard must confirm a real activation and the absence of a checkout.
    const summary = await payment.expectActivatedWithoutCard();
    expect(summary).toContain('TRIAL ACTIVATED');
  });

  test('detects the card-required arm', async ({ page }) => {
    await page.setContent(CARD_ARM);
    const payment = new SandboxPaymentPage(page);

    expect(await payment.detectActivationFlow(5_000)).toBe('card-required');
  });

  test('refuses a card-free activation when a checkout iframe IS present', async ({ page }) => {
    // Guard against the branch ever being used to skip a real payment screen.
    await page.setContent(`
      <main id="main-content">
        <section id="trial" role="region" aria-label="Trial signup">
          <p>TRIAL ACTIVATED</p>
          <h2>Welcome to Thinkster &mdash; thank you!</h2>
          <button type="button">Open the Elevate App &rarr;</button>
          <iframe id="twHostedCheckoutFrame" src="https://cde.openpaystaging.com/pay/x"></iframe>
        </section>
      </main>`);
    const payment = new SandboxPaymentPage(page);

    await expect(payment.expectActivatedWithoutCard()).rejects.toThrow(/Refusing to report a card-free activation/i);
  });

  test('fails with the widget text when neither arm appears', async ({ page }) => {
    await page.setContent(UNKNOWN);
    const payment = new SandboxPaymentPage(page);

    await expect(payment.detectActivationFlow(2_000)).rejects.toThrow(/neither known terminal state/i);
  });
});
