import { test as base, expect, BrowserContext, Page } from '@playwright/test';
import * as path from 'path';
import { PROFILE_DIR } from '../src/utils/recaptchaState';

/**
 * Custom `context` / `page` fixtures backed by a PERSISTENT Chromium profile.
 *
 * WHY (verified against the live sandbox)
 * --------------------------------------
 * reCAPTCHA v3 guards `POST /api/register/lead` and `POST /api/register/parent`.
 * A brand-new throwaway browser profile is scored as a bot, so the API answers
 *   403 {"error":"reCAPTCHA verification failed. Please try again."}
 *
 * Proven side by side from the same machine and IP, at the same moment, using an
 * identical interaction sequence:
 *   persistent profile -> 201 Lead captured successfully
 *   fresh context      -> 403 reCAPTCHA verification failed
 *
 * Persisting only the `_GRECAPTCHA` cookie via storageState was NOT sufficient -
 * the full on-disk profile is what earns a human-like score. Playwright rejects
 * a bare `--user-data-dir` argument, so `launchPersistentContext` is required.
 *
 * Because that bypasses Playwright's automatic artifact wiring, this fixture
 * re-implements it: tracing is always recorded and saved on failure, and video is
 * recorded unless VIDEO=off.
 *
 * Set PERSISTENT_PROFILE=on to opt in. Default is OFF, i.e. standard ephemeral
 * contexts with Playwright's native artifact handling.
 */

const PERSISTENT = process.env.PERSISTENT_PROFILE === 'on';

export const test = base.extend<{ context: BrowserContext; page: Page }>({
  context: async ({ playwright }, use, testInfo) => {
    const projectUse = testInfo.project.use as Record<string, unknown>;
    const headless = (projectUse.headless as boolean | undefined) ?? true;
    const channel = projectUse.channel as string | undefined;
    const recordVideo =
      process.env.VIDEO === 'off' ? undefined : { dir: testInfo.outputPath('video') };

    const common = {
      viewport: (projectUse.viewport as { width: number; height: number } | undefined) ?? {
        width: 1536,
        height: 864,
      },
      locale: (projectUse.locale as string | undefined) ?? 'en-US',
      timezoneId: (projectUse.timezoneId as string | undefined) ?? 'America/New_York',
      ignoreHTTPSErrors: true,
      recordVideo,
    };

    let context: BrowserContext;

    if (PERSISTENT) {
      context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
        ...common,
        headless,
        channel,
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
      });
    } else {
      const browser = await playwright.chromium.launch({
        headless,
        channel,
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
      });
      context = await browser.newContext({
        ...common,
        storageState: projectUse.storageState as string | undefined,
      });
    }

    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    await use(context);

    // Preserve the trace when the test did not pass, mirroring Playwright's
    // built-in `trace: 'on-first-retry'`/failure behaviour.
    const failed = testInfo.status !== testInfo.expectedStatus;
    if (failed) {
      const tracePath = testInfo.outputPath('trace.zip');
      await context.tracing.stop({ path: tracePath }).catch(() => undefined);
      await testInfo.attach('trace', { path: tracePath, contentType: 'application/zip' }).catch(() => undefined);
    } else {
      await context.tracing.stop().catch(() => undefined);
    }

    const browser = context.browser();
    await context.close().catch(() => undefined);
    if (!PERSISTENT) await browser?.close().catch(() => undefined);

    // Attach the video only on failure, matching `video: 'retain-on-failure'`.
    if (failed && recordVideo) {
      for (const page of context.pages()) {
        const file = await page.video()?.path().catch(() => undefined);
        if (file) await testInfo.attach('video', { path: file, contentType: 'video/webm' }).catch(() => undefined);
      }
    }
  },

  page: async ({ context }, use) => {
    // A persistent context starts with one about:blank page - reuse it.
    const page = context.pages()[0] ?? (await context.newPage());
    await use(page);
  },
});

export { expect };
export const PROFILE_PATH = path.resolve(PROFILE_DIR);
