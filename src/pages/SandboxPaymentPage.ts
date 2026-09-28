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
export class SandboxPaymentPage extends BasePage {
  private readonly giftContinue = this.page.locator('#twCtaGift');
  private readonly planContinue = this.page.locator('#twCtaAActivate');
  private readonly checkoutFrameElement = this.page.locator('#twHostedCheckoutFrame');
  private readonly successCta = this.page.locator('#twCtaAThanks');

  constructor(page: Page) {
    super(page);
  }

  private get checkout(): FrameLocator {
    return this.page.frameLocator('#twHostedCheckoutFrame');
  }

  /** ACTIVATE TRIAL · 1 OF 3 - the $25 gift-card offer. */
  async continuePastGiftOffer(): Promise<void> {
    await this.expectVisible(this.giftContinue, 120_000);
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
   * Final hand-off. VERIFIED: "Start your child's math journey →" opens the
   * Elevate app in a NEW TAB (popup) - it does not navigate the current page.
   * Returns the popup page, which stays inside the same browser context.
   */
  async startMathJourney(): Promise<Page> {
    await expect(this.successCta).toBeEnabled();

    const [popup] = await Promise.all([
      this.page.context().waitForEvent('page', { timeout: 120_000 }),
      this.successCta.click(),
    ]);

    await popup.waitForLoadState('domcontentloaded');
    return popup;
  }
}
