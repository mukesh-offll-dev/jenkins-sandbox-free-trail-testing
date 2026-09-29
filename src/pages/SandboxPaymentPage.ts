import { expect, FrameLocator, Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { BillingData } from '../utils/testData';
import { Secrets } from '../utils/env';
import { maskCard } from '../utils/mask';

/**
 * Sandbox payment / trial activation - "ACTIVATE TRIAL" screens 1..3 of 3.
 *
 * Verified widget locators:
 *   gift offer   #twCtaGift        "See my plan →"        (ACTIVATE TRIAL · 1 OF 3)
 *   plan         #twCtaAActivate   "Continue →"           (ACTIVATE TRIAL · 2 OF 3)
 *                #twFootOpts       "See & adjust plan options" (default plan is accepted)
 *   checkout     #twHostedCheckoutFrame  iframe, title "Secure Checkout"
 *   success      #twCtaAThanks     "Start your child's math journey →"
 *
 * Verified checkout structure (NESTED iframes - OpenPay hosted fields):
 *   #twHostedCheckoutFrame                -> https://cde.openpaystaging.com/pay/<id>
 *     iframe[name="card-number-element"]  -> input[name="cardNumber"]
 *     iframe[name="card-expiry-element"]  -> input[name="cardExpiry"]
 *     iframe[name="card-cvc-element"]     -> input[name="cardCvc"]
 *   plus, directly in the checkout document:
 *     input[autocomplete="email"]         (pre-filled from registration, disabled)
 *     input[autocomplete="given-name"] / [family-name]
 *     input[autocomplete="postal-code"]
 *     select[name="rcrs-country"]
 *     button "Add payment method"
 *   The "I have read and agree to Terms of Service" label is static text - there
 *   is no consent checkbox to tick inside the checkout.
 */
export type ActivationFlow = 'card-required' | 'activated-without-card';

export class SandboxPaymentPage extends BasePage {
  private readonly giftContinue = this.page.locator('#twCtaGift');
  private readonly planContinue = this.page.locator('#twCtaAActivate');
  private readonly checkoutFrameElement = this.page.locator('#twHostedCheckoutFrame');
  private readonly successCta = this.page.locator('#twCtaAThanks');

  /**
   * The no-card variant's hand-off CTA, verified in Jenkins build #64 retry1:
   *   button "Open the Elevate App →"
   */
  private readonly elevateAppCta = this.page.getByRole('button', { name: /Open the Elevate App/i });

  constructor(page: Page) {
    super(page);
  }

  private get checkout(): FrameLocator {
    return this.page.frameLocator('#twHostedCheckoutFrame');
  }

  /**
   * Decide which activation flow the application actually served.
   *
   * WHY THIS EXISTS (evidence, Jenkins build #64 retry1)
   * ---------------------------------------------------
   * The suite previously assumed every run gets ACTIVATE TRIAL 1..3 OF 3
   * (gift -> plan -> hosted checkout). That is only one arm of a live A/B test.
   * In build #64 the appointment booked successfully and then, with no gift and
   * no checkout, the widget rendered:
   *   "YOUR TRIAL - ACTIVATED   3-DAY TRIAL ACTIVATED"
   *   heading "Welcome to Thinkster - thank you!"
   *   "Live 1:1 session - Fri, Oct 2 - 7:30 PM"
   *   button "Open the Elevate App ->"
   * The trace network log confirms it: the app called
   *   POST /api/ab/assign
   *   POST /api/admin/parent/<id>/free-trial      <- direct activation
   * and NEVER contacted a payment host - there is no `openpay`, `hosted` or
   * `checkout` request anywhere in the log. So `#twCtaGift` genuinely does not
   * exist in that arm, and waiting 120s for it can only ever time out.
   *
   * This method does NOT skip a required payment. It waits for whichever of the
   * two real terminal states appears and reports which one, so the test can
   * assert the correct contract for that arm. If neither appears, it fails with
   * the widget's actual text instead of a bare locator timeout.
   */
  async detectActivationFlow(timeout = 120_000): Promise<ActivationFlow> {
    const decided = await Promise.race([
      this.giftContinue
        .waitFor({ state: 'visible', timeout })
        .then(() => 'card-required' as const)
        .catch(() => null),
      this.elevateAppCta
        .waitFor({ state: 'visible', timeout })
        .then(() => 'activated-without-card' as const)
        .catch(() => null),
    ]);

    if (decided === 'card-required') {
      // The widget renders the gift CTA as its default/loading state while
      // POST /api/ab/assign is still in-flight. On slower machines (Jenkins)
      // the race above can fire on that transient render before the A/B
      // assignment settles and switches the widget to the no-card arm.
      // Wait for pending network activity to finish, then re-confirm.
      await this.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      const stillThere = await this.giftContinue.isVisible().catch(() => false);
      if (!stillThere) {
        // Arm switched to no-card during the A/B assignment window.
        await this.elevateAppCta.waitFor({ state: 'visible', timeout: 30_000 });
        return 'activated-without-card';
      }
      return 'card-required';
    }

    if (decided) return decided;

    const widgetText = (await this.widget.innerText().catch(() => '<widget not readable>'))
      .replace(/\s+/g, ' ')
      .trim();
    throw new Error(
      `The activation step reached neither known terminal state within ${timeout}ms.\n` +
        `  Expected either the gift offer (#twCtaGift, card-required arm) or the ` +
        `"Open the Elevate App" CTA (no-card arm).\n` +
        `  Widget actually showed: "${widgetText.slice(0, 400)}"\n` +
        `  URL: ${this.page.url()}`,
    );
  }

  /**
   * Assert the no-card arm really did activate a trial before the run is allowed
   * to treat it as a success. This is the safeguard that stops the variant branch
   * from becoming a silent "skip payment" path.
   */
  async expectActivatedWithoutCard(): Promise<string> {
    await expect(this.widget).toContainText(/TRIAL ACTIVATED/i);
    await expect(this.page.getByRole('heading', { name: /Welcome to Thinkster/i })).toBeVisible();
    await expect(this.elevateAppCta).toBeEnabled();

    const text = (await this.widget.innerText()).replace(/\s+/g, ' ').trim();
    // Prove no checkout was rendered - i.e. the app did not ask for a card and
    // we did not bypass one that was there.
    if (await this.checkoutFrameElement.count()) {
      throw new Error(
        'Refusing to report a card-free activation: a hosted checkout iframe IS present, ' +
          'so this run does require payment and must not be short-circuited.',
      );
    }
    return text.slice(0, 400);
  }

  /** ACTIVATE TRIAL · 1 OF 3 - the $25 gift-card offer. */
  async continuePastGiftOffer(): Promise<void> {
    // detectActivationFlow already confirmed this element is present and
    // network-settled; 15s is sufficient and surfaces arm-switch regressions
    // quickly rather than hanging for 2 minutes.
    await this.expectVisible(this.giftContinue, 15_000);
    await expect(this.widget).toContainText(/ACTIVATE TRIAL · 1 OF 3/i);
    await this.giftContinue.click();
    await this.expectVisible(this.planContinue, 90_000);
  }

  /** ACTIVATE TRIAL · 2 OF 3 - accept the pre-selected (most popular) plan. */
  async acceptDefaultPlan(): Promise<string> {
    await expect(this.widget).toContainText(/ACTIVATE TRIAL · 2 OF 3/i);
    await expect(this.page.getByRole('heading', { name: /Activate your trial/i })).toBeVisible();
    await expect(this.widget).toContainText(/\$0 due today/i);

    const planText = (await this.widget.innerText()).replace(/\s+/g, ' ').trim();
    await this.planContinue.click();
    return planText.slice(0, 400);
  }

  /**
   * ACTIVATE TRIAL · 3 OF 3 - wait for the hosted checkout and prove it is the
   * authorized sandbox payment environment before any card data is typed.
   */
  async expectSandboxCheckoutLoaded(expectedHost: string): Promise<string> {
    await expect(this.widget).toContainText(/ACTIVATE TRIAL · 3 OF 3/i);
    await this.expectVisible(this.checkoutFrameElement, 120_000);

    const src = await this.checkoutFrameElement.getAttribute('src');
    if (!src) throw new Error('Hosted checkout iframe rendered without a src attribute.');

    const host = new URL(src).host;
    if (host !== expectedHost) {
      throw new Error(
        `Refusing to submit card data: hosted checkout host "${host}" does not match the ` +
          `expected sandbox payment host "${expectedHost}".`,
      );
    }

    // Wait for the card fields (nested iframes) to be interactive.
    await expect(this.checkout.locator('input[autocomplete="given-name"]')).toBeVisible({ timeout: 90_000 });
    await expect(
      this.checkout.frameLocator('iframe[name="card-number-element"]').locator('input[name="cardNumber"]'),
    ).toBeVisible({ timeout: 90_000 });

    return host;
  }

  /** Fill billing details + card data across the nested secure iframes. */
  async fillPaymentDetails(billing: BillingData, secrets: Secrets): Promise<void> {
    await this.checkout.locator('input[autocomplete="given-name"]').fill(billing.firstName);
    await this.checkout.locator('input[autocomplete="family-name"]').fill(billing.lastName);

    const cardNumber = this.checkout
      .frameLocator('iframe[name="card-number-element"]')
      .locator('input[name="cardNumber"]');
    await cardNumber.click();
    await cardNumber.pressSequentially(secrets.cardNumber.replace(/\s/g, ''), { delay: 35 });

    const expiry = this.checkout
      .frameLocator('iframe[name="card-expiry-element"]')
      .locator('input[name="cardExpiry"]');
    await expiry.click();
    await expiry.pressSequentially(secrets.cardExpiry.replace(/\D/g, ''), { delay: 55 });

    const cvc = this.checkout.frameLocator('iframe[name="card-cvc-element"]').locator('input[name="cardCvc"]');
    await cvc.click();
    await cvc.pressSequentially(secrets.cardCvc, { delay: 55 });

    await this.checkout.locator('input[autocomplete="postal-code"]').fill(billing.postalCode);
    await this.checkout.locator('select[name="rcrs-country"]').selectOption({ label: billing.country });
  }

  /** The checkout pre-fills the email from registration - prove it is our parent. */
  async expectCheckoutEmail(email: string): Promise<void> {
    await expect(this.checkout.locator('input[autocomplete="email"]')).toHaveValue(email);
  }

  /**
   * Submit the sandbox payment and wait for the REAL outcome.
   *
   * A click is not treated as success: the run only proceeds once the widget
   * renders the "TRIAL ACTIVATED" screen with its hand-off CTA. If the checkout
   * instead surfaces an error, that error text is raised verbatim.
   */
  async submitPayment(): Promise<string> {
    await this.checkout.getByRole('button', { name: /Add payment method/i }).click();

    const success = this.successCta;
    const checkoutError = this.checkout.locator('[role="alert"], .text-red-500, .text-error, [class*="error"]');

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      if (await success.isVisible().catch(() => false)) {
        await expect(this.widget).toContainText(/TRIAL ACTIVATED/i);
        await expect(this.widget).toContainText(/\$0 charged today/i);
        return 'TRIAL ACTIVATED';
      }

      const errText = (await checkoutError.first().innerText().catch(() => '')).trim();
      if (errText && !/^\s*$/.test(errText)) {
        throw new Error(`Sandbox payment was rejected by the checkout: "${errText.slice(0, 300)}"`);
      }

      await expect(this.page.locator('body')).toBeVisible(); // cheap poll tick
      await this.page.waitForTimeout(2_000);
    }

    throw new Error(
      'Sandbox payment did not produce a result within 5 minutes: the "TRIAL ACTIVATED" ' +
        'confirmation never appeared and no checkout error was surfaced.',
    );
  }

  get maskedCard(): string {
    return maskCard(process.env.SANDBOX_CARD_NUMBER ?? '4111111111111111');
  }

  /**
   * Final hand-off for the card-required arm.
   *
   * Handles both observed behaviours defensively: on some environments
   * (verified local) the CTA opens a new tab; on others (verified Jenkins)
   * it navigates the current tab. Using Promise.all hard-requires a popup
   * event and hangs for 120s when same-tab navigation occurs instead.
   * Pattern mirrors openElevateApp() which already handles this correctly.
   */
  async startMathJourney(): Promise<Page> {
    await expect(this.successCta).toBeEnabled();

    const popupPromise = this.page
      .context()
      .waitForEvent('page', { timeout: 30_000 })
      .catch(() => null);

    await this.successCta.click();
    const popup = await popupPromise;

    if (popup) {
      await popup.waitForLoadState('domcontentloaded');
      return popup;
    }

    // Same-tab navigation: the hand-off happened in place.
    await this.page.waitForLoadState('domcontentloaded');
    return this.page;
  }

  /**
   * No-card arm hand-off: "Open the Elevate App →".
   *
   * Verified in build #64 retry1. Mirrors startMathJourney() but drives the CTA
   * that arm actually renders. Handles both behaviours defensively: the CTA may
   * open a new tab, or navigate the current one.
   */
  async openElevateApp(): Promise<Page> {
    await expect(this.elevateAppCta).toBeEnabled();

    const popupPromise = this.page
      .context()
      .waitForEvent('page', { timeout: 30_000 })
      .catch(() => null);

    await this.elevateAppCta.click();
    const popup = await popupPromise;

    if (popup) {
      await popup.waitForLoadState('domcontentloaded');
      return popup;
    }

    // Same-tab navigation: the hand-off happened in place.
    await this.page.waitForLoadState('domcontentloaded');
    return this.page;
  }
}
