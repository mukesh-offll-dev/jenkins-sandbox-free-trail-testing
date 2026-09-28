import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { HomePage } from '../src/pages/HomePage';
import { StudentRegistrationPage } from '../src/pages/StudentRegistrationPage';
import { ParentRegistrationPage } from '../src/pages/ParentRegistrationPage';
import { OtpVerificationPage } from '../src/pages/OtpVerificationPage';
import { SchedulingPage } from '../src/pages/SchedulingPage';
import { SandboxPaymentPage } from '../src/pages/SandboxPaymentPage';
import { StudentSelectionPage } from '../src/pages/StudentSelectionPage';

import { assertSandboxOnly, secrets, urls, qaBypassCookie } from '../src/utils/env';
import { buildRegistrationTestData } from '../src/utils/testData';
import { RunReport } from '../src/utils/runReport';
import { safeLog } from '../src/utils/mask';
import { saveRecaptchaState } from '../src/utils/recaptchaState';

const EVIDENCE_DIR = path.resolve(process.cwd(), 'artifacts', 'evidence');

/**
 * The complete Thinkster sandbox free-trial registration journey.
 *
 * One test, one browser context, start to finish: homepage -> questionnaire ->
 * parent details -> SMS OTP -> appointment booking -> sandbox hosted checkout ->
 * Elevate student selection page.
 *
 * Serialised by design (see playwright.config.ts: workers=1, fullyParallel=false)
 * because each execution creates real sandbox data and holds a real calendar slot.
 */
test.describe.configure({ mode: 'serial' });

test.describe('Thinkster sandbox - free trial registration', () => {
  /**
   * The Chromium profile is reused across runs to retain reCAPTCHA reputation,
   * so the APPLICATION session must be reset explicitly: otherwise a previous
   * run's widget progress or Elevate login could leak into this one.
   * Google/reCAPTCHA cookies are deliberately left untouched.
   */
  test.beforeEach(async ({ context }) => {
    for (const domain of [
      'sandbox.hellothinkster.com',
      'elevate-sandbox.hellothinkster.com',
      'core-api-4.0-sandbox.hellothinkster.com',
      '.hellothinkster.com',
      'hellothinkster.com',
    ]) {
      await context.clearCookies({ domain }).catch(() => undefined);
    }
  });

  /**
   * Persist the Google/reCAPTCHA cookie jar after every run, pass or fail.
   * Reputation accrues either way, which reduces 403 bot-scoring rejections on
   * subsequent runs. Thinkster cookies are never carried over.
   */
  test.afterEach(async ({ context }) => {
    await saveRecaptchaState(context);
  });

  test('registers a new parent and student and reaches the student selection page', async ({ page, context }, testInfo) => {
    assertSandboxOnly();

    const { registration, studentsPage, expectedPaymentHost } = urls();
    const config = secrets();
    const data = buildRegistrationTestData();
    const report = new RunReport(data, { registrationUrl: registration, studentsUrl: studentsPage });

    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    safeLog(`[run ${data.runId}] parent email: ${data.generatedEmail.email} (generated ${data.generatedEmail.generatedAtIst})`);

    // Apply the authorized QA reCAPTCHA bypass cookie if configured.
    // Set AFTER beforeEach has cleared Thinkster cookies, and BEFORE the first
    // navigation, so every sandbox request in this run carries the cookie.
    // Scoped to the registration host only; never applied to non-sandbox URLs.
    const bypass = qaBypassCookie();
    if (bypass) {
      await context.addCookies([{
        name: bypass.name,
        value: bypass.value,
        url: registration,
      }]);
      safeLog(`[run ${data.runId}] QA reCAPTCHA bypass cookie applied`);
    }

    const home = new HomePage(page);
    const student = new StudentRegistrationPage(page);
    const parent = new ParentRegistrationPage(page);
    const otp = new OtpVerificationPage(page);
    const scheduling = new SchedulingPage(page);
    const payment = new SandboxPaymentPage(page);

    let studentsTab: Page | undefined;

    try {
      // ---------------------------------------------------------------- step 1
      await test.step('Open the sandbox homepage and submit the unique parent email', async () => {
        await home.open(registration);
        await home.expectLoaded();
        await home.enterParentEmail(data.generatedEmail.email);
        const submit = await home.submitEmail();
        await home.continuePastWelcome();
        report.step(
          'email-submitted',
          `${data.generatedEmail.email}; attempts=${submit.attempts}` +
            (submit.transientErrors.length ? `; transient=${submit.transientErrors.join(' | ')}` : ''),
        );
      });

      // ---------------------------------------------------------------- step 2
      await test.step('Complete the student registration questionnaire (steps 3-8 of 8)', async () => {
        await student.selectChildCount(1);
        await student.enterNameAndSchoolGrade(data.student);
        await student.confirmWorkingGrade(data.student);
        const answers = await student.answerQualifyingQuestions();
        await student.continuePastRoadmap(data.student);
        report.step('student-questionnaire-completed', `grade=${data.student.grade}; ${answers.answer1}`);
      });

      // ---------------------------------------------------------------- step 3
      await test.step('Submit the parent information form', async () => {
        await parent.acceptEbooksAndContinue();
        await parent.expectLoaded();

        const countryCode = await parent.ensureCountryCode(data.parent);
        expect(countryCode).toContain(data.parent.countryCode);

        await parent.fillParentDetails(data.parent, config.password);

        // The supplied phone number must be accepted as-is by the application.
        await parent.expectPhoneAccepted();

        await parent.submit();
        report.step('parent-details-submitted', `country=${data.parent.country} ${data.parent.countryCode}`);
      });

      // ---------------------------------------------------------------- step 4
      await test.step('Verify the phone number with the sandbox OTP', async () => {
        await otp.expectLoaded(data.parent.phoneDigits.slice(-4));
        const verify = await otp.enterOtpAndWaitForAutoSubmit(config.otp);
        report.step(
          'otp-verified',
          `sandbox OTP accepted; registration created; attempts=${verify.attempts}` +
            (verify.transientErrors.length ? `; transient=${verify.transientErrors.join(' | ')}` : ''),
        );
      });

      // ---------------------------------------------------------------- step 5
      await test.step('Book the free 1:1 session from real calendar availability', async () => {
        await scheduling.expectLoaded();

        const timezone = await scheduling.selectTimezone(
          process.env.APPOINTMENT_TIMEZONE ?? 'America/New_York',
        );

        const appointment = await scheduling.selectFirstAvailableAppointment(timezone);
        safeLog(
          `[run ${data.runId}] appointment: ${appointment.dateLabel} ${appointment.displayTime} (${appointment.timezone})`,
        );

        await scheduling.holdSpot();
        await scheduling.expectAppointmentHeld(appointment);
        await scheduling.lockInSpot();

        report.appointment(appointment);
        report.step('appointment-booked', `${appointment.date} ${appointment.displayTime} ${appointment.timezone}`);
      });

      // ---------------------------------------------------------------- step 6
      await test.step('Activate the trial through the sandbox hosted checkout', async () => {
        await payment.continuePastGiftOffer();
        const plan = await payment.acceptDefaultPlan();

        const host = await payment.expectSandboxCheckoutLoaded(expectedPaymentHost);
        await payment.expectCheckoutEmail(data.generatedEmail.email);
        await payment.fillPaymentDetails(data.billing, config);

        const outcome = await payment.submitPayment();

        report.payment(host, payment.maskedCard, outcome);
        report.step('sandbox-payment-completed', `${outcome}; plan=${plan.slice(0, 120)}`);
      });

      // ---------------------------------------------------------------- step 7
      await test.step('Follow the hand-off into the Elevate student selection page', async () => {
        studentsTab = await payment.startMathJourney();
        report.step('handoff-to-elevate', studentsTab.url());
      });

      // ---------------------------------------------------------------- step 8
      await test.step('Assert the final student selection page', async () => {
        if (!studentsTab) throw new Error('The Elevate students tab was never opened.');
        const selection = new StudentSelectionPage(studentsTab);

        await selection.waitUntilLoaded();

        // 1. correct final URL
        await selection.expectUrl(studentsPage);
        // 2. required heading
        await selection.expectHeadingVisible();
        // 3. the newly created student's profile
        const observedName = await selection.expectStudentProfileVisible(data.expectedStudentDisplayName);
        // 4. "In Trial" status
        const observedStatus = await selection.expectInTrialStatus();
        // 5. Select button visible and enabled
        await selection.expectSelectButtonReady();
        // 6. no unexpected application error
        await selection.expectNoApplicationError();

        report.studentObserved(observedName, observedStatus);

        const shot = path.join(EVIDENCE_DIR, `students-page-${data.runId}.png`);
        await selection.screenshot(shot);
        await testInfo.attach('final-students-page', { path: shot, contentType: 'image/png' });

        report.step('final-assertions-passed', `${observedName} / ${observedStatus}`);
      });

      const metadataFile = report.finish('passed', studentsTab?.url());
      await testInfo.attach('run-metadata', { path: metadataFile, contentType: 'application/json' });
      safeLog(`[run ${data.runId}] PASSED - metadata: ${metadataFile}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Capture real failure evidence from every open page in the context.
      for (const [index, open] of context.pages().entries()) {
        const shot = path.join(EVIDENCE_DIR, `failure-${data.runId}-p${index}.png`);
        await open.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
        await testInfo.attach(`failure-page-${index}`, { path: shot, contentType: 'image/png' }).catch(() => undefined);
      }

      const widgetErrors = await new ParentRegistrationPage(page).visibleErrorText().catch(() => []);
      const detail = widgetErrors.length ? `${message} | visible app errors: ${widgetErrors.join(' / ')}` : message;

      const metadataFile = report.finish('failed', page.url(), detail);
      await testInfo.attach('run-metadata', { path: metadataFile, contentType: 'application/json' }).catch(() => undefined);
      safeLog(`[run ${data.runId}] FAILED - ${detail}`);

      throw error;
    }
  });
});
