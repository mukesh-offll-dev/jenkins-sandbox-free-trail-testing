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

  async expectLoaded(phoneLast4: string): Promise<void> {
    this.attachApiListener();
    await this.expectVisible(this.digit(1), 90_000);
    await expect(this.widget).toContainText(/YOUR DETAILS · 3 OF 3/i);
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

    for (let i = 0; i < 6; i++) {
      const box = this.digit(i + 1);
      await box.click();
      await box.pressSequentially(otp[i], { delay: 80 });
    }

    for (let attempt = 1; attempt <= OtpVerificationPage.MAX_VERIFY_ATTEMPTS; attempt++) {
      // Success == the OTP screen unmounts. Failure == the widget re-enables the
      // CTA (and shows a banner). Race the two real outcomes.
      const outcome = await Promise.race([
        this.digit(1)
          .waitFor({ state: 'hidden', timeout: 90_000 })
          .then(() => 'verified' as const)
          .catch(() => 'pending' as const),
        this.submitButton
          .waitFor({ state: 'visible', timeout: 90_000 })
          .then(async () => ((await this.submitButton.isEnabled()) ? ('retryable' as const) : ('pending' as const)))
          .catch(() => 'pending' as const),
      ]);

      if (outcome === 'verified') {
        return { attempts: attempt, transientErrors };
      }

      // Re-check: the CTA becoming enabled is the app's "you may retry" signal.
      const canRetry = await this.submitButton.isEnabled().catch(() => false);
      const stillOnOtp = await this.digit(1).isVisible().catch(() => false);

      if (!stillOnOtp) {
        return { attempts: attempt, transientErrors };
      }

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

      // Take the app's own retry path: the CTA is now enabled, so clicking it is
      // correct here (unlike during the auto-submit window, where it is disabled).
      await this.page.waitForTimeout(4_000 * attempt);
      await this.submitButton.click();
    }

    throw new Error('Unreachable: OTP verification loop exhausted.');
  }

  /** Available for negative/diagnostic use only. */
  async isResendAvailable(): Promise<boolean> {
    return this.resendButton.isEnabled();
  }
}
