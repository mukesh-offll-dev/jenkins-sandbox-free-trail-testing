import { expect, Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { ParentData } from '../utils/testData';

/**
 * Parent registration - "YOUR DETAILS" screens 1..2 of 3.
 *
 * Verified locators:
 *   e-books    #twCtaEbooks     "Send me the e-books →"  (YOUR DETAILS · 1 OF 3)
 *   first name #twFname         autocomplete=given-name
 *   last name  #twLname         autocomplete=family-name
 *   phone      #twPphone        input[type=tel], auto-formats to "(NNN) NNN-NNNN"
 *   country    #twCcBtn         opens the code list; #twCcSearch filters;
 *                               rows are `.cc-row` and `.cc-row.sel` is current (US +1 default)
 *   consent    #twSmsConsent    the ONLY consent checkbox; required for SMS verification
 *   password   #twPw            min 8 characters, counter reads "n/8 characters"
 *   submit     #twCtaAbout      "Continue →"
 *
 * Verified validation behaviour: the phone `.err` node ("Enter a valid 10-digit
 * mobile number.") is always in the DOM but `display:none`. The supplied number
 * (908) 020-4336 IS accepted by the application.
 */export class ParentRegistrationPage extends BasePage {
  private readonly ebooksContinue = this.page.locator('#twCtaEbooks');

  private readonly firstNameField = this.page.locator('#twFname');
  private readonly lastNameField = this.page.locator('#twLname');
  private readonly phoneField = this.page.locator('#twPphone');
  private readonly countryCodeButton = this.page.locator('#twCcBtn');
  private readonly countryCodeSearch = this.page.locator('#twCcSearch');
  private readonly selectedCountryRow = this.page.locator('#trial .cc-row.sel');
  private readonly smsConsentCheckbox = this.page.locator('#twSmsConsent');
  private readonly passwordField = this.page.locator('#twPw');
  private readonly continueButton = this.page.locator('#twCtaAbout');

  /** The phone validation message node (permanently present, toggled visible). */
  private readonly phoneError = this.page.locator('#trial .err');

  constructor(page: Page) {
    super(page);
  }

  /** YOUR DETAILS · 1 OF 3 - free e-books hand-off screen. */
  async acceptEbooksAndContinue(): Promise<void> {
    await this.expectVisible(this.ebooksContinue);
    await expect(this.widget).toContainText(/Your free e-books are ready/i);
    await this.ebooksContinue.click();
    await this.expectVisible(this.firstNameField);
  }

  /** YOUR DETAILS · 2 OF 3 - "Share your details". */
  async expectLoaded(): Promise<void> {
    await expect(this.widget).toContainText(/YOUR DETAILS · 2 OF 3/i);
    await expect(this.page.getByRole('heading', { name: /Share your details/i })).toBeVisible();
    await expect(this.continueButton).toBeDisabled();
  }

  /**
   * The sandbox defaults to United States / +1, which is exactly the required
   * test data. We verify it rather than blindly re-selecting, and only open the
   * picker when the default does not match.
   */
  async ensureCountryCode(parent: ParentData): Promise<string> {
    const current = (await this.countryCodeButton.innerText()).replace(/\s+/g, ' ').trim();
    if (current.includes(parent.countryCode)) {
      await expect(this.selectedCountryRow).toContainText(parent.country);
      return current;
    }

    await this.countryCodeButton.click();
    await this.countryCodeSearch.fill(parent.country);
    await this.page.locator('#trial .cc-row', { hasText: parent.country }).first().click();
    await expect(this.countryCodeButton).toContainText(parent.countryCode);
    return (await this.countryCodeButton.innerText()).replace(/\s+/g, ' ').trim();
  }

  async fillParentDetails(parent: ParentData, password: string): Promise<void> {
    await this.firstNameField.fill(parent.firstName);
    await this.lastNameField.fill(parent.lastName);

    // Type digit-by-digit so the widget's input mask/keyup handlers run exactly
    // as they do for a real user; the field then renders "(908) 020-4336".
    await this.phoneField.click();
    await this.phoneField.fill('');
    await this.phoneField.pressSequentially(parent.phoneDigits, { delay: 30 });
    await expect(this.phoneField).toHaveValue(parent.phone);

    await this.smsConsentCheckbox.check();
    await expect(this.smsConsentCheckbox).toBeChecked();

    await this.passwordField.fill(password);
    await expect(this.widget).toContainText(`${password.length}/8 characters`);
  }

  /**
   * The supplied phone number must be accepted by the application.
   * If the sandbox ever rejects it, this surfaces the real, visible error text
   * instead of silently changing the number.
   */
  async expectPhoneAccepted(): Promise<void> {
    await expect(this.phoneError).toBeHidden();
    await expect(this.continueButton).toBeEnabled();
  }

  async submit(): Promise<void> {
    await this.continueButton.click();
  }
}
