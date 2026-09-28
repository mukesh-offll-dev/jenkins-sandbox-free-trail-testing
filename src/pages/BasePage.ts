import { Locator, Page, expect } from '@playwright/test';

/**
 * Shared behaviour for every screen of the Thinkster trial widget.
 *
 * The whole "get started" journey happens inside one in-page widget rooted at
 * `#trial` - the browser URL never changes until the very last hand-off to the
 * Elevate app. Screens are therefore identified by their stable CTA ids
 * (`#twCta*`) and by the widget's own step label (e.g. "GET STARTED · 4 OF 8").
 */
export abstract class BasePage {
  protected readonly widget: Locator;

  constructor(protected readonly page: Page) {
    this.widget = page.locator('#trial');
  }

  /** The widget's step label, e.g. "YOUR DETAILS · 2 OF 3". */
  async stepLabel(): Promise<string> {
    const text = await this.widget.innerText();
    return text.split('\n')[0]?.trim() ?? '';
  }

  /**
   * Wait for a screen to be interactive.
   *
   * Relies only on Playwright auto-waiting - no arbitrary sleeps.
   */
  protected async expectVisible(locator: Locator, timeout = 60_000): Promise<void> {
    await expect(locator).toBeVisible({ timeout });
  }

  /**
   * Assert that no visible validation error is rendered inside the widget.
   *
   * IMPORTANT (verified against the live sandbox): the widget keeps its `.err`
   * nodes permanently in the DOM with `display:none` and only toggles them on.
   * Asserting on text presence produces false failures - visibility is the only
   * correct signal.
   *
   * Two distinct error surfaces exist:
   *   `.err`            per-field validation (e.g. the phone number message)
   *   `.tw-inline-msg`  screen-level banner, e.g. "Something went wrong. Please
   *                     check your email and try again." rendered between
   *                     #twEmailFld and #twCtaLanding when
   *                     POST /api/register/lead fails its reCAPTCHA check
   */
  protected static readonly WIDGET_ERROR_SELECTOR = '.tw-inline-msg, .err';

  /**
   * `.tw-inline-msg` is reused for BOTH failure banners and success toasts - the
   * OTP screen renders "Phone verified successfully!" through it. Treating that
   * as an error made a succeeding step report a phantom failure and pointed the
   * diagnostics at the wrong cause, so success wording is excluded here.
   * The negative-lookahead terms keep "unsuccessful"/"not successful" as errors.
   */
  private static isSuccessMessage(text: string): boolean {
    return /success/i.test(text) && !/unsuccessful|\b(not|failed|fail|error|unable|invalid)\b/i.test(text);
  }

  async expectNoVisibleWidgetError(): Promise<void> {
    const errors = await this.visibleErrorText();
    expect(errors, `The widget displayed error(s): ${JSON.stringify(errors)}`).toEqual([]);
  }

  /** Collect any currently visible widget error text (for failure diagnostics). */
  async visibleErrorText(): Promise<string[]> {
    const messages = await this.widget
      .locator(BasePage.WIDGET_ERROR_SELECTOR)
      .evaluateAll((nodes) =>
        nodes
          .map((n) => ({ text: (n as HTMLElement).innerText.trim(), visible: (n as HTMLElement).offsetHeight > 0 }))
          .filter((n) => n.visible && n.text.length > 0)
          .map((n) => n.text),
      );

    return messages.filter((text) => !BasePage.isSuccessMessage(text));
  }
}
