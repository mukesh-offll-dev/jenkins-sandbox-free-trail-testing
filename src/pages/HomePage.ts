import { expect, Page } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * Homepage + free-trial signup entry point.
 *
 * Verified locators (live sandbox, widget v1.0.11):
 *   region  #trial            role=region, aria-label="Trial signup"
 *   email   #twEmailFld       input[type=email], placeholder "Parent email address"
 *   submit  #twCtaLanding     "Try Thinkster Risk-Free →" (disabled until email valid)
 *   next    #twCtaCongrats    "Continue →" on the "You just did the hard part." screen
 *
 * KNOWN APPLICATION RACE (diagnosed against the live sandbox)
 * ----------------------------------------------------------
 * The widget guards `POST /api/register/lead` with reCAPTCHA v3, but the
 * reCAPTCHA script is loaded lazily and the widget does NOT wait for a token
 * before submitting. Submitting within a second or two of page load reproducibly
 * returns:
 *     400 {"error":"reCAPTCHA token is required"}
 * and the widget then renders the visible message
 *     "Something went wrong. Please check your email and try again."
 *
 * A human never hits this because typing an email takes a few seconds. This page
 * object therefore (a) waits for the reCAPTCHA script to load before submitting
 * and (b) retries the submit a bounded number of times, which is exactly the
 * "try again" path the application itself instructs the user to take.
 * No assertion is weakened: if the lead is never captured, the real error text
 * from the application is raised.
 */
export class HomePage extends BasePage {
  private readonly emailField = this.page.locator('#twEmailFld');
  private readonly startTrialButton = this.page.locator('#twCtaLanding');
  private readonly congratsContinueButton = this.page.locator('#twCtaCongrats');

  /**
   * Two different error surfaces exist in this widget, verified live:
   *   .tw-inline-msg - screen-level banner (e.g. the reCAPTCHA/lead failure),
   *                    injected between #twEmailFld and #twCtaLanding
   *   .err           - per-field validation (e.g. the phone number message)
   */
  private static readonly ERROR_SELECTOR = '#trial .tw-inline-msg, #trial .err';
  private readonly widgetError = this.page.locator(HomePage.ERROR_SELECTOR);

  private static readonly MAX_SUBMIT_ATTEMPTS = Number(process.env.MAX_SUBMIT_ATTEMPTS ?? 5);

  /**
   * Server/UI conditions that will NEVER succeed on a retry. Retrying these
   * makes things worse: each attempt is another live registration request, which
   * is how "Too many verification attempts for this number" was reached.
   *
   * NOTE: `reCAPTCHA verification failed` is included explicitly. It ends with
   * "Please try again.", which does NOT match the `try again later` pattern, so
   * Jenkins build #64 retried it five times and produced five 403s in a row.
   * A bot-scoring rejection is a server-side decision about this browser/IP; it
   * does not become true on the 5th identical attempt.
   */
  private static readonly NON_RETRYABLE =
    /too many|rate limit|rate-limit|slow down|already (exists|registered|in use)|account exists|try again later|temporarily blocked|recaptcha verification failed/i;

  /** True when the observed lead response must not be retried. */
  private nonRetryableLead(): string | null {
    const last = this.leadResponses[this.leadResponses.length - 1];
    if (!last) return null;
    if (last.status === 429) return `HTTP 429 (rate limited): ${last.body}`;
    // Any 403 on the lead endpoint is a server-side refusal (bot scoring or an
    // unrecognised QA bypass). Verified in build #64: 5 attempts -> 5x 403.
    if (last.status === 403) return `HTTP 403 (server refused): ${last.body}`;
    if (HomePage.NON_RETRYABLE.test(last.body)) return `HTTP ${last.status}: ${last.body}`;
    return null;
  }

  /** Live capture of the lead-capture API result, for accurate diagnostics. */
  private leadResponses: Array<{ status: number; body: string }> = [];
  private leadListenerAttached = false;

  constructor(page: Page) {
    super(page);
  }

  /**
   * Record the real status/body of every POST /api/register/lead so failures
   * report what the server actually said instead of inferring it from the UI.
   *
   * Idempotent, and attached from BOTH open() and submitEmail(): guarding on
   * `leadResponses.length` was wrong, because before the first response that
   * array is still empty, so repeated calls stacked duplicate listeners - and
   * calling submitEmail() without open() left diagnostics completely blind.
   */
  private attachLeadListener(): void {
    if (this.leadListenerAttached) return;
    this.leadListenerAttached = true;
    this.page.on('response', async (response) => {
      if (!/\/api\/register\/lead$/.test(response.url())) return;
      let body = '';
      try {
        body = (await response.text()).slice(0, 200);
      } catch {
        body = '<unreadable>';
      }
      this.leadResponses.push({ status: response.status(), body });
    });
  }

  private lastLeadResult(): string {
    const last = this.leadResponses[this.leadResponses.length - 1];
    return last ? `HTTP ${last.status} ${last.body}` : 'no POST /api/register/lead observed';
  }

  async open(url: string): Promise<void> {
    this.attachLeadListener();
    const response = await this.page.goto(url, { waitUntil: 'domcontentloaded' });

    /**
     * Distinguish an EDGE BLOCK from an application or automation fault.
     *
     * VERIFIED: a headless browser receives 403 Forbidden from the Vercel edge
     * (body "Forbidden", content-type text/plain) before any application code
     * runs. Without this check the run failed 60s later with a misleading
     * "#twEmailFld not visible", which looks like a selector defect.
     */
    const status = response?.status();
    if (status && status >= 400) {
      throw new Error(
        `ENVIRONMENT FAILURE (not an automation defect): GET ${url} returned HTTP ${status}.\n` +
          `The sandbox document was blocked before the signup widget could render, so no ` +
          `registration step can run.\n` +
          `Verified cause: the edge rejects headless browsers - headless returns 403 while a ` +
          `headed browser returns 200 from the same machine and IP.\n` +
          `Fix: run headed (the default; HEADLESS=1 forces headless), or have the sandbox ` +
          `allow-list the CI agent.`,
      );
    }

    await this.expectVisible(this.emailField);
    await expect(this.page).toHaveTitle(/Thinkster/i);
  }

  /** The signup widget must be present and advertise step 1 of 8. */
  async expectLoaded(): Promise<void> {
    await expect(this.widget).toBeVisible();
    await expect(this.widget).toContainText(/GET STARTED · 1 OF 8/i);
    await expect(this.page.getByRole('heading', { name: /Your risk-free trial includes/i })).toBeVisible();
  }

  /** The CTA is disabled until a syntactically valid address is entered. */
  async expectSubmitDisabledBeforeEmail(): Promise<void> {
    await expect(this.startTrialButton).toBeDisabled();
  }

  async enterParentEmail(email: string): Promise<void> {
    await this.emailField.fill(email);
    await expect(this.emailField).toHaveValue(email);
  }

  /**
   * Wait until the lazily-loaded reCAPTCHA widget has initialised.
   *
   * VERIFIED: the reCAPTCHA script is only injected once the user interacts with
   * the signup form, and its anchor iframe attaches ~0.8s after the email field
   * is filled. Submitting before that reproducibly returns
   * 400 {"error":"reCAPTCHA token is required"}.
   *
   * Best-effort: never fails the test on its own, because `submitEmail()` retries.
   */
  async waitForRecaptchaReady(timeout = 45_000): Promise<boolean> {
    try {
      await this.page.locator('iframe[src*="api2/anchor"]').first().waitFor({ state: 'attached', timeout });
      // Small settle so grecaptcha can mint a token for the first submit.
      await this.page.waitForTimeout(4_000);
      return true;
    } catch {
      return false;
    }
  }

  /** Currently visible widget error text, or null when the widget is clean. */
  private async visibleError(): Promise<string | null> {
    const count = await this.widgetError.count();
    for (let i = 0; i < count; i++) {
      const node = this.widgetError.nth(i);
      if (await node.isVisible().catch(() => false)) {
        const text = (await node.innerText()).trim();
        if (text) return text;
      }
    }
    return null;
  }

  /**
   * Submit the email and land on screen 2 of 8.
   *
   * Retries only the application's own transient reCAPTCHA failures:
   *   400 "reCAPTCHA token is required"          -> widget shows a visible error
   *   403 "reCAPTCHA verification failed..."     -> widget shows NOTHING and
   *                                                 silently stays on step 1
   * The second case is an application bug (no user feedback), so a silent
   * non-advance is also treated as retryable rather than as an automation fault.
   */
  async submitEmail(): Promise<{ attempts: number; transientErrors: string[] }> {
    this.attachLeadListener();
    await this.waitForRecaptchaReady();

    const transientErrors: string[] = [];

    for (let attempt = 1; attempt <= HomePage.MAX_SUBMIT_ATTEMPTS; attempt++) {
      // The widget may already have advanced (a slow success from a previous
      // attempt); in that case #twCtaLanding no longer exists and re-clicking
      // would throw a misleading "element not found".
      if (await this.congratsContinueButton.isVisible().catch(() => false)) {
        return { attempts: attempt, transientErrors };
      }

      await expect(this.startTrialButton).toBeEnabled();
      await this.startTrialButton.click();

      // Race the success screen against the widget's visible error message.
      const outcome = await Promise.race([
        this.congratsContinueButton
          .waitFor({ state: 'visible', timeout: 25_000 })
          .then(() => 'advanced' as const)
          .catch(() => 'pending' as const),
        this.page
          .waitForFunction(
            () =>
              Array.from(document.querySelectorAll('#trial .tw-inline-msg, #trial .err')).some(
                (el) => (el as HTMLElement).offsetHeight > 0 && (el as HTMLElement).innerText.trim().length > 0,
              ),
            undefined,
            { timeout: 25_000 },
          )
          .then(() => 'error' as const)
          .catch(() => 'pending' as const),
      ]);

      if (outcome === 'advanced') {
        return { attempts: attempt, transientErrors };
      }

      const error = await this.visibleError();
      transientErrors.push(
        `attempt ${attempt}: ${this.lastLeadResult()}` +
          (error ? ` | banner: "${error}"` : ' | no banner shown (silent failure)'),
      );

      /**
       * Abort immediately on a condition a retry cannot fix. Each retry is a real
       * registration request against the live sandbox, so retrying a rate limit
       * actively deepens it.
       */
      const fatal = this.nonRetryableLead() ?? (error && HomePage.NON_RETRYABLE.test(error) ? `banner: "${error}"` : null);
      if (fatal) {
        throw new Error(
          `The sandbox rejected the lead with a NON-RETRYABLE condition on attempt ${attempt}.\n` +
            `  ${fatal}\n` +
            `Stopping immediately instead of retrying: further attempts would add more live ` +
            `registration requests and deepen any rate limit.\n` +
            `Observations:\n  ${transientErrors.join('\n  ')}`,
        );
      }

      if (attempt === HomePage.MAX_SUBMIT_ATTEMPTS) {
        throw new Error(
          `The sandbox refused to capture the lead after ${attempt} attempts.\n` +
            `Observations:\n  ${transientErrors.join('\n  ')}\n` +
            `POST /api/register/lead is reCAPTCHA v3 protected:\n` +
            `  400 "reCAPTCHA token is required"        -> submitted before the lazily-loaded token existed\n` +
            `  403 "reCAPTCHA verification failed..."   -> Google scored this browser/IP as automated\n` +
            `A persistent 403 is an EXTERNAL BLOCKER (bot scoring), not an automation defect: the same ` +
            `suite passes end to end when the session is scored as human.`,
        );
      }

      // Progressive backoff: give reCAPTCHA time to settle / rescore before
      // taking the app's own "try again" path.
      await this.page.waitForTimeout(5_000 * attempt);
    }

    throw new Error('Unreachable: email submission loop exhausted.');
  }

  async continuePastWelcome(): Promise<void> {
    await expect(this.widget).toContainText(/You just did the hard part/i);
    await this.congratsContinueButton.click();
  }
}
