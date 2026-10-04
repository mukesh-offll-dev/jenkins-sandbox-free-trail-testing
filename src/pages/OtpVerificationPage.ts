import { expect, Page } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * Phone (SMS) verification - "YOUR DETAILS · 3 OF 3".
 *
 * Verified locators:
 *   digits  getByLabel("Digit 1") .. getByLabel("Digit 6")   maxlength=1, inputmode=numeric,
 *                                                            autocomplete="one-time-code"
 *   resend  #twResendBtn   (disabled during the countdown)
 *   change  #twChangeNumBtn
 *   submit  #twCtaOtp      "Verify & complete registration →"
 *
 * CRITICAL VERIFIED BEHAVIOUR - the CTA has two distinct states
 * -------------------------------------------------------------
 * 1) HAPPY PATH: the widget AUTO-SUBMITS as soon as the 6th digit is entered. It
 *    fires POST /api/sms/verify-code and then POST /api/register/parent by
 *    itself, while `#twCtaOtp` is still rendered DISABLED.
 *
 *    Clicking the CTA during this window triggers a SECOND verify-code +
 *    register/parent round trip. Observed live: the API answered "Parent already
 *    exists" and the widget RESET to "GET STARTED · 3 OF 8", destroying the run.
 *    => never click while disabled.
 *
 * 2) FAILURE PATH: when account creation fails (POST /api/register/parent is also
 *    reCAPTCHA protected, so bot scoring can reject it) the widget shows
 *    "Account creation failed. Please try again." AND ENABLES `#twCtaOtp`.
 *    => in that state the CTA is the app's own documented retry action, so
 *       clicking it is correct.
 *
 * This page object therefore keys entirely off the CTA's enabled state, and
 * records the real HTTP status of the registration calls for diagnostics.
 */
export class OtpVerificationPage extends BasePage {
  private readonly submitButton = this.page.locator('#twCtaOtp');
  private readonly resendButton = this.page.locator('#twResendBtn');

  private static readonly MAX_VERIFY_ATTEMPTS = 4;

  /** Live capture of the registration API results, for accurate diagnostics. */
  private apiResults: Array<{ endpoint: string; status: number; body: string }> = [];
  private listenerAttached = false;

  constructor(page: Page) {
    super(page);
  }

  private digit(index: number) {
    return this.page.getByLabel(`Digit ${index}`);
  }

  private attachApiListener(): void {
    if (this.listenerAttached) return;
    this.listenerAttached = true;
    this.page.on('response', async (response) => {
      const url = response.url();
      if (!/\/api\/(sms\/verify-code|register\/parent)$/.test(url)) return;
      let body = '';
      try {
        body = (await response.text()).slice(0, 220);
      } catch {
        body = '<unreadable>';
      }
      this.apiResults.push({
        endpoint: url.replace(/^https:\/\/[^/]+/, ''),
        status: response.status(),
        body,
      });
    });
  }

  private lastApiResult(): string {
    const last = this.apiResults[this.apiResults.length - 1];
    return last ? `${last.endpoint} -> HTTP ${last.status} ${last.body}` : 'no verify-code/register-parent response observed';
  }

  /**
   * Error surfaces on the phone/OTP screens, verified live:
   *   .tw-inline-msg - screen-level banner (e.g. "Too many verification attempts
   *                    for this number.")
   *   .err           - per-field validation
   */
  private static readonly ERROR_SELECTOR = '#trial .tw-inline-msg, #trial .err';

  /** Conditions that mean the OTP screen will NEVER appear - fail fast. */
  private static readonly BLOCKING_ERROR =
    /too many|rate limit|rate-limit|try again later|temporarily blocked|invalid (phone|number)|not a valid/i;

  async expectLoaded(phoneLast4: string): Promise<void> {
    this.attachApiListener();

    /**
     * Race the OTP entry boxes against a blocking error banner.
     *
     * Previously this waited 90s for `#twOtp1` unconditionally. When the SMS
     * step is rate limited ("Too many verification attempts for this number.")
     * that field is never rendered, so the run burned the full 90s and then
     * failed with a generic visibility timeout that hid the real cause.
     */
    const blocked = await Promise.race([
      this.digit(1)
        .waitFor({ state: 'visible', timeout: 90_000 })
        .then(() => null)
        .catch(() => 'timeout' as const),
      this.page
        .waitForFunction(
          (sel) =>
            Array.from(document.querySelectorAll(sel as string)).some(
              (el) =>
                (el as HTMLElement).offsetHeight > 0 &&
                /too many|rate limit|rate-limit|try again later|temporarily blocked|invalid (phone|number)|not a valid/i.test(
                  (el as HTMLElement).innerText,
                ),
            ),
          OtpVerificationPage.ERROR_SELECTOR,
          { timeout: 90_000 },
        )
        .then(() => 'error' as const)
        .catch(() => null),
    ]);

    if (blocked === 'error' || blocked === 'timeout') {
      const banners = this.page.locator(OtpVerificationPage.ERROR_SELECTOR);
      const messages: string[] = [];
      const count = await banners.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const node = banners.nth(i);
        if (await node.isVisible().catch(() => false)) {
          const text = (await node.innerText().catch(() => '')).trim();
          if (text) messages.push(text);
        }
      }
      const blocking = messages.find((m) => OtpVerificationPage.BLOCKING_ERROR.test(m));

      if (blocking) {
        throw new Error(
          `SMS verification was refused by the sandbox, so the OTP screen never appeared.\n` +
            `  Application message: "${blocking}"\n` +
            `  API: ${this.lastApiResult()}\n` +
            `This is an ENVIRONMENT / TEST-DATA limit, not an automation defect: the suite reuses ` +
            `one fixed mobile number, and the sandbox rate-limits verification per number. ` +
            `Wait for the limit to reset or provision a different authorized test number. ` +
            `Failing immediately instead of requesting another OTP.`,
        );
      }
      if (blocked === 'timeout') {
        throw new Error(
          `The OTP entry field (${'#twOtp1'}) never became visible within 90s and no blocking ` +
            `banner was shown.\n  API: ${this.lastApiResult()}\n` +
            `Visible messages: ${messages.length ? messages.join(' | ') : '<none>'}`,
        );
      }
    }

    await this.expectStepLabel(/YOUR DETAILS · 3 OF 3/i);
    await expect(this.page.getByRole('heading', { name: /Enter the 6-digit code/i })).toBeVisible();
    // The app masks the destination number - assert only on the last 4 digits.
    await expect(this.widget).toContainText(new RegExp(`\\*{3}-\\*{3}-${phoneLast4}`));
    // Proof of the auto-submit contract: nothing to click yet.
    await expect(this.submitButton).toBeDisabled();
  }

  /**
   * Enter the sandbox OTP, let the widget auto-submit, and recover from a
   * failed account creation using the app's own retry affordance.
   *
   * Returns how many verification attempts were needed plus the errors observed.
   */
  async enterOtpAndWaitForAutoSubmit(otp: string): Promise<{ attempts: number; transientErrors: string[] }> {
    if (!/^\d{6}$/.test(otp)) {
      throw new Error('Configured SANDBOX_OTP must be exactly 6 digits.');
    }

    this.attachApiListener();
    const transientErrors: string[] = [];

    // Human-paced entry: POST /api/register/parent fires on the 6th digit and is
    // reCAPTCHA v3 scored, and sub-second entry of all six digits reads as a bot.
    const digitGapMs = Number(process.env.OTP_DIGIT_DELAY_MS ?? 2_000);
    for (let i = 0; i < 6; i++) {
      const box = this.digit(i + 1);
      await box.click();
      await box.pressSequentially(otp[i], { delay: 80 });
      if (i < 5 && digitGapMs > 0) await this.page.waitForTimeout(digitGapMs);
    }

    for (let attempt = 1; attempt <= OtpVerificationPage.MAX_VERIFY_ATTEMPTS; attempt++) {
      // Two real outcomes, each of which is genuinely waited for:
      //   the OTP screen unmounts   -> verification and account creation are done
      //   #twCtaOtp becomes ENABLED -> the app is offering its own retry
      //
      // Waiting for the CTA to be merely *visible* is wrong: it is rendered
      // visible-but-disabled for the entire auto-submit window (expectLoaded()
      // asserts precisely that), so such a wait resolves in milliseconds and the
      // loop concludes "account creation failed" before the auto-submit has even
      // answered. Enabled-ness is the only signal that distinguishes the states.
      const outcome = await Promise.race([
        this.digit(1)
          .waitFor({ state: 'hidden', timeout: 120_000 })
          .then(() => 'verified' as const)
          .catch(() => 'timeout' as const),
        expect(this.submitButton)
          .toBeEnabled({ timeout: 120_000 })
          .then(() => 'retryable' as const)
          .catch(() => 'timeout' as const),
      ]);

      if (outcome === 'verified') {
        return { attempts: attempt, transientErrors };
      }

      // An enabled CTA does NOT by itself mean failure: the widget enables it as
      // soon as POST /api/sms/verify-code succeeds (banner "Phone verified
      // successfully!") while POST /api/register/parent is still in flight.
      // Clicking in that window fires a second register/parent round trip, which
      // the API answers "Parent already exists" and the widget resets to
      // GET STARTED · 3 OF 8, destroying the run. So always let the success path
      // finish first and only then treat the screen as stuck.
      const unmounted = await this.digit(1)
        .waitFor({ state: 'hidden', timeout: 30_000 })
        .then(() => true)
        .catch(() => false);

      if (unmounted) {
        return { attempts: attempt, transientErrors };
      }

      const canRetry = await this.submitButton.isEnabled().catch(() => false);
      const banner = (await this.visibleErrorText()).join(' / ');
      transientErrors.push(`attempt ${attempt}: ${this.lastApiResult()}${banner ? ` | banner: "${banner}"` : ''}`);

      if (attempt === OtpVerificationPage.MAX_VERIFY_ATTEMPTS || !canRetry) {
        throw new Error(
          `Account creation did not complete after ${attempt} verification attempt(s).\n` +
            `Observations:\n  ${transientErrors.join('\n  ')}\n` +
            `POST /api/register/parent is reCAPTCHA protected, so a 4xx here is usually the same ` +
            `bot-scoring rejection seen on /api/register/lead. A persistent failure is an EXTERNAL ` +
            `BLOCKER rather than an automation defect.`,
        );
      }

      // Take the app's own retry path: the CTA is enabled and the screen has not
      // unmounted, so this is the documented failure state, not the auto-submit window.
      await this.submitButton.click();
    }

    throw new Error('Unreachable: OTP verification loop exhausted.');
  }

  /** Available for negative/diagnostic use only. */
  async isResendAvailable(): Promise<boolean> {
    return this.resendButton.isEnabled();
  }
}
