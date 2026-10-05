import { test, expect } from './fixtures';

import { HomePage } from '../src/pages/HomePage';
import { WelcomeVideoPage } from '../src/pages/WelcomeVideoPage';
import { StudentRegistrationPage } from '../src/pages/StudentRegistrationPage';
import { assertSandboxOnly, urls } from '../src/utils/env';
import { generateParentEmail } from '../src/utils/email';
import { safeLog } from '../src/utils/mask';

/**
 * Interactive coverage of the onboarding screens between the email and the
 * parent form: welcome video, Continue / Skip, child count 1-3, both grade
 * sliders K -> AL2 and the "Edit" link.
 *
 * Stops on the first qualifying question, before "Share your details", so it
 * captures one lead and never creates an account, sends an SMS or pays.
 * The full journey to Elevate is covered by registration.spec.ts.
 */
test.describe.configure({ mode: 'serial' });

test.describe('Thinkster sandbox - onboarding screens (no account created)', () => {
  test.beforeEach(async ({ context }) => {
    for (const domain of ['sandbox.hellothinkster.com', 'core-api-4.0-sandbox.hellothinkster.com', '.hellothinkster.com']) {
      await context.clearCookies({ domain }).catch(() => undefined);
    }
  });

  test('video, child count, grade sliders and edit behave correctly', async ({ page }, testInfo) => {
    assertSandboxOnly();
    const email = generateParentEmail().email;
    const childName = process.env.STUDENT_FIRST_NAME ?? 'Test';

    const home = new HomePage(page);
    const video = new WelcomeVideoPage(page);
    const student = new StudentRegistrationPage(page);

    // Signals that would block the flow: uncaught page errors and failing Thinkster API calls.
    const pageErrors: string[] = [];
    const apiFailures: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message.slice(0, 200)));
    page.on('response', (response) => {
      if (/^https:\/\/core-api[^/]*\.hellothinkster\.com\/api\//.test(response.url()) && response.status() >= 400) {
        apiFailures.push(`${response.request().method()} ${response.url().split('?')[0]} -> HTTP ${response.status()}`);
      }
    });

    await test.step('Submit a generated parent email', async () => {
      await home.open(urls().registration);
      await home.expectLoaded();
      safeLog(`[onboarding] ${await home.widgetVariant()} - parent email ${email}`);
      await home.enterParentEmail(email);
      await home.submitEmail();
      await video.expectLoaded();
    });

    await test.step('Welcome video is present, plays and pauses', async () => {
      await video.expectVideoPresent();
      const playedTo = await video.playAndExpectPlaying();
      const pausedAt = await video.pauseAndExpectPaused();
      safeLog(`[onboarding] video played to ${playedTo.toFixed(1)}s, paused at ${pausedAt.toFixed(1)}s`);
    });

    await test.step('"Continue" opens the child-count screen', async () => {
      await video.continue();
      await expect(student.childCountScreen).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#trial')).toContainText(/How many children are you exploring Thinkster for/i);
    });

    await test.step('Back, then "Skip the video" also opens the child-count screen', async () => {
      await student.goBack(video.continueButton);
      await video.expectLoaded();
      await video.skipVideo();
      await expect(student.childCountScreen).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('#trial')).toContainText(/How many children are you exploring Thinkster for/i);
    });

    for (const count of [1, 2, 3] as const) {
      await test.step(`${count} ${count === 1 ? 'child' : 'children'}: selection is kept through the questionnaire`, async () => {
        await student.chooseChildCount(count);
        await student.continueFromChildCount();

        // Back keeps the selection.
        await student.goBack(student.childCountScreen);
        await student.expectChildCountSelected(count);
        await student.continueFromChildCount();

        await student.enterChildName(childName);
        await student.dragGrade('school', '5');
        await student.continueFromNameGrade(childName);
        await student.dragGrade('working', '5');
        await student.continueFromWorkingGrade();
        await student.expectQuestionsForChildCount(childName, count);

        await student.goBack(student.workingGradeScreen);
        await student.goBack(student.nameGradeScreen);
        await student.goBack(student.childCountScreen);
      });
    }

    await test.step('School-grade slider: drag K -> AL2 and check every position', async () => {
      await student.chooseChildCount(1);
      await student.continueFromChildCount();
      await student.enterChildName(childName);
      const ariaDefects = await student.sweepGrade('school');
      reportAriaDefect(testInfo, 'School grade', ariaDefects);
      await student.dragGrade('school', '5');
      await student.continueFromNameGrade(childName);
      await student.expectSchoolGradeSummary(childName, '5');
    });

    await test.step('"Edit" changes the school grade and the new value is shown', async () => {
      await student.editSchoolGrade(childName, '5');
      await student.dragGrade('school', '7');
      await student.continueFromNameGrade(childName);
      await student.expectSchoolGradeSummary(childName, '7');
    });

    await test.step('Working-grade slider: drag K -> AL2, then Continue', async () => {
      const ariaDefects = await student.sweepGrade('working');
      reportAriaDefect(testInfo, 'Working grade', ariaDefects);
      await student.dragGrade('working', '7');
      await student.continueFromWorkingGrade();
      await student.expectQuestionsForChildCount(childName, 1);
    });

    await test.step('No page errors or failing Thinkster API calls during onboarding', async () => {
      expect(pageErrors, 'uncaught page errors').toEqual([]);
      expect(apiFailures, 'failing Thinkster API calls').toEqual([]);
    });
  });
});

/** aria-valuenow never follows the drag (verified 2026-10-05): record it, don't fail on it. */
function reportAriaDefect(testInfo: import('@playwright/test').TestInfo, slider: string, mismatches: string[]): void {
  if (!mismatches.length) return;
  const description = `${slider} slider: aria-valuenow does not follow the visible grade (${mismatches.length}/12 ticks), e.g. ${mismatches[0]}`;
  testInfo.annotations.push({ type: 'known-defect', description });
  safeLog(`[onboarding] KNOWN DEFECT - ${description}`);
}
