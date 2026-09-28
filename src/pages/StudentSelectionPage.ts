import { expect, Locator, Page } from '@playwright/test';

/**
 * Student selection page on the Elevate app - the definitive success state.
 *
 * Verified live:
 *   url      https://elevate-sandbox.hellothinkster.com/students
 *   title    "Thinkster Math - Student Learning Platform"
 *   h1       "Who's Ready to Learn Today?"
 *   sub      "Select your profile to begin."
 *   card     avatar initials + student name + "In Trial" badge + "Select" button
 *   header   "Log Out" button
 *
 * The app exposes no data-testid attributes, so this page object uses role and
 * text based locators, which are the most stable option available here.
 */
export class StudentSelectionPage {
  private readonly heading: Locator;
  private readonly subheading: Locator;
  private readonly logOutButton: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: "Who's Ready to Learn Today?" });
    this.subheading = page.getByText(/Select your profile to begin/i);
    this.logOutButton = page.getByRole('button', { name: /Log Out/i });
  }

  /** Wait for the app shell to finish loading after the hand-off. */
  async waitUntilLoaded(): Promise<void> {
    await expect(this.heading).toBeVisible({ timeout: 120_000 });
    await expect(this.subheading).toBeVisible();
    await expect(this.logOutButton).toBeVisible();
  }

  /** Assertion 1 - the final URL. */
  async expectUrl(expectedUrl: string): Promise<void> {
    await expect(this.page).toHaveURL(expectedUrl, { timeout: 120_000 });
  }

  /** Assertion 2 - the required heading. */
  async expectHeadingVisible(): Promise<void> {
    await expect(this.heading).toBeVisible();
  }

  /** The profile card belonging to the newly created student. */
  studentCard(studentName: string): Locator {
    return this.page
      .locator('div')
      .filter({ hasText: new RegExp(`^${escapeRegex(studentName)}$`) })
      .locator('xpath=ancestor-or-self::div[.//button][1]')
      .last();
  }

  /** Assertion 3 - the new student's profile is displayed. */
  async expectStudentProfileVisible(studentName: string): Promise<string> {
    const nameNode = this.page.getByText(studentName, { exact: true });
    await expect(nameNode).toBeVisible({ timeout: 60_000 });
    return (await nameNode.innerText()).trim();
  }

  /** Assertion 4 - the student carries the "In Trial" status. */
  async expectInTrialStatus(): Promise<string> {
    const badge = this.page.getByText('In Trial', { exact: true });
    await expect(badge).toBeVisible();
    return (await badge.innerText()).trim();
  }

  /** Assertion 5 - the Select button is visible AND enabled. */
  async expectSelectButtonReady(): Promise<void> {
    const select = this.page.getByRole('button', { name: 'Select', exact: true });
    await expect(select).toBeVisible();
    await expect(select).toBeEnabled();
  }

  /** Assertion 6 - no unexpected application error is displayed. */
  async expectNoApplicationError(): Promise<void> {
    const errorPatterns = [
      /something went wrong/i,
      /unexpected error/i,
      /application error/i,
      /internal server error/i,
      /failed to (load|fetch)/i,
      /\b5\d\d\b\s+error/i,
    ];

    const body = await this.page.locator('body').innerText();
    for (const pattern of errorPatterns) {
      expect(body, `Unexpected application error matching ${pattern} on the students page`).not.toMatch(pattern);
    }

    /**
     * Only alerts that are actually DISPLAYED count as an error shown to the
     * user, and two well-known benign nodes must be excluded:
     *   - Next.js's route announcer (`#__next-route-announcer__`), an a11y
     *     live-region that simply mirrors the document title. Verified content
     *     on a healthy page: "Thinkster Math - Student Learning Platform".
     *   - empty, zero-size toast containers.
     * Asserting on the raw `[role="alert"]` count produced a false failure on a
     * fully healthy students page.
     */
    const pageTitle = await this.page.title();
    const displayedAlerts = await this.page
      .locator('[role="alert"]')
      .evaluateAll(
        (nodes, title) =>
          nodes
            .filter((node) => (node as HTMLElement).id !== '__next-route-announcer__')
            .map((node) => {
              const el = node as HTMLElement;
              return {
                text: (el.innerText || '').trim(),
                visible: el.offsetHeight > 0 && el.offsetWidth > 0,
              };
            })
            .filter((entry) => entry.visible && entry.text.length > 0 && entry.text !== title)
            .map((entry) => entry.text.slice(0, 200)),
        pageTitle,
      );

    expect(
      displayedAlerts,
      `The students page displayed alert(s): ${JSON.stringify(displayedAlerts)}`,
    ).toEqual([]);
  }

  async screenshot(filePath: string): Promise<void> {
    await this.page.screenshot({ path: filePath, fullPage: true });
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
