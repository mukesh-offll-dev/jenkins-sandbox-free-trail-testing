import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const isCI = !!process.env.CI;

/**
 * The registration journey is a single, stateful, one-shot workflow:
 *  - it must never run in parallel with itself (duplicate registrations / held slots),
 *  - it must stay inside ONE browser context from homepage to the students page.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',

  // A full registration (8 questionnaire steps + OTP + scheduling + hosted checkout)
  // routinely needs several minutes end to end.
  timeout: 15 * 60 * 1000,
  expect: {
    timeout: 20 * 1000,
  },

  // Hard serialization: one worker, no parallelism, no overlapping registrations.
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'test-results/junit/results.xml' }],
    ['json', { outputFile: 'test-results/json/results.json' }],
  ],

  use: {
    baseURL: process.env.SANDBOX_BASE_URL ?? 'https://sandbox.hellothinkster.com',

    // Debug artefacts required by the QA brief.
    screenshot: 'only-on-failure',
    // Video needs the Playwright ffmpeg binary. Set VIDEO=off on agents where
    // that binary cannot be downloaded; CI keeps the default.
    video: process.env.VIDEO === 'off' ? 'off' : 'retain-on-failure',
    trace: 'on-first-retry',

    actionTimeout: 30 * 1000,
    navigationTimeout: 90 * 1000,

    // Deterministic US locale/timezone so the scheduler offers US business hours
    // and the appointment we record matches what a US parent would see.
    locale: 'en-US',
    timezoneId: process.env.APPOINTMENT_TIMEZONE ?? 'America/New_York',

    viewport: { width: 1536, height: 864 },
    ignoreHTTPSErrors: true,

    /**
     * The sandbox guards its registration endpoints with reCAPTCHA v3.
     * A default Playwright launch advertises itself as automated
     * (`navigator.webdriver === true`, `--enable-automation`), which reCAPTCHA
     * scores as a bot - `POST /api/register/lead` then returns
     * 403 {"error":"reCAPTCHA verification failed. Please try again."} and the
     * widget silently stays on step 1.
     *
     * Presenting the browser as an ordinary Chrome session is required to test
     * this authorized sandbox at all. It does not bypass any assertion.
     */
    launchOptions: {
      args: ['--disable-blink-features=AutomationControlled'],
      ignoreDefaultArgs: ['--enable-automation'],
    },
  },

  projects: [
    {
      name: 'chromium',
      // By default Playwright's own bundled Chromium is used, which is what the
      // Jenkins agent installs via `npx playwright install chromium`.
      //
      // Set BROWSER_CHANNEL=chrome (or msedge) to drive an already-installed
      // system browser instead - useful on machines/networks where the Chromium
      // CDN download is blocked.
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
      },
    },
  ],
});
