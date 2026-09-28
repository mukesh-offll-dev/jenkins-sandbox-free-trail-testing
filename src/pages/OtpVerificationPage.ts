import { expect, Page } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * Phone (SMS) verification - "YOUR DETAILS · 3 OF 3".
 *
 * Verified locators:
 *   digits  getByLabel("Digit 1") .. getByLabel("Digit 6")   maxlength=1, inputmode=numeric
 *   resend  #twResendBtn   (disabled during the countdown)
 *   change  #twChangeNumBtn
 *   submit  #twCtaOtp      "Verify & complete registration →"
 *
 * CRITICAL VERIFIED BEHAVIOUR
 * ---------------------------
 * The widget AUTO-SUBMITS as soon as the 6th digit is entered: it fires
 * POST /api/sms/verify-code and then POST /api/register/parent by itself, while
 * `#twCtaOtp` is still rendered `disabled`.
 *
 * Clicking `#twCtaOtp` after typing therefore triggers a SECOND verify-code +
 * register/parent round trip. Observed consequence on the live sandbox: the API
 * answered "Parent already exists" and the widget reset back to
 * "GET STARTED · 3 OF 8", destroying the run.
 *
 * This page object deliberately NEVER clicks the CTA; it types the code and then
 * waits for the OTP screen to disappear, which is the true completion signal.
 */
export class OtpVerificationPage extends BasePage {
  private readonly submitButton = this.page.locator('#twCtaOtp');
  private readonly resendButton = this.page.locator('#twResendBtn');

  constructor(page: Page) {
    super(page);
  }

  private digit(index: number) {
    return this.page.getByLabel(`Digit ${index}`);
  }

  async expectLoaded(phoneLast4: string): Promise<void> {
    await this.expectVisible(this.digit(1), 90_000);
    await expect(this.widget).toContainText(/YOUR DETAILS · 3 OF 3/i);
    await expect(this.page.getByRole('heading', { name: /Enter the 6-digit code/i })).toBeVisible();
    // The app masks the destination number - assert only on the last 4 digits.
    await expect(this.widget).toContainText(new RegExp(`\\*{3}-\\*{3}-${phoneLast4}`));
    await expect(this.submitButton).toBeDisabled();
  }

  /**
   * Enter the sandbox OTP and wait for the widget to auto-advance.
   * Never clicks the CTA - see the class comment for why that is essential.
   */
  async enterOtpAndWaitForAutoSubmit(otp: string): Promise<void> {
    if (!/^\d{6}$/.test(otp)) {
      throw new Error('Configured SANDBOX_OTP must be exactly 6 digits.');
    }

    for (let i = 0; i < 6; i++) {
      const box = this.digit(i + 1);
      await box.click();
      await box.pressSequentially(otp[i], { delay: 80 });
    }

    // The 6th keystroke triggers verification; the OTP inputs then unmount.
    await expect(this.digit(1)).toBeHidden({ timeout: 120_000 });
  }

  /** Available for negative/diagnostic use only. */
  async isResendAvailable(): Promise<boolean> {
    return this.resendButton.isEnabled();
  }
}
