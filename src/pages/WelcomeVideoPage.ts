import { expect, FrameLocator, Locator, Page } from '@playwright/test';
import { BasePage } from './BasePage';

/**
 * "YOU'RE IN MOTION - You just did the hard part." screen shown after the email.
 *
 * Verified live 2026-10-05 (widget v1.0.13 B/C):
 *   video     #twCongratsVidWrap iframe[title="FUNNEL VIDEO"] - a Vimeo embed, not
 *             a <video> in the page; no autoplay. The real <video> lives inside the
 *             cross-origin frame, with buttons named Play / Pause / Mute / Fullscreen.
 *             Vimeo hides its controls a few seconds into playback until the
 *             pointer moves over the player.
 *   continue  #twCtaCongrats  "Continue →"
 *   skip      #twSkipVid      "Skip the video"
 * Both buttons lead to "How many children are you exploring Thinkster for?".
 */
export class WelcomeVideoPage extends BasePage {
  readonly continueButton = this.page.locator('#twCtaCongrats');
  readonly skipButton = this.page.locator('#twSkipVid');
  private readonly playerIframe = this.page.locator('#twCongratsVidWrap iframe[title="FUNNEL VIDEO"]');

  constructor(page: Page) {
    super(page);
  }

  private get player(): FrameLocator {
    return this.page.frameLocator('#twCongratsVidWrap iframe[title="FUNNEL VIDEO"]');
  }

  private get video(): Locator {
    return this.player.locator('video');
  }

  private playbackState(): Promise<{ paused: boolean; time: number }> {
    return this.video.evaluate((v) => ({ paused: (v as HTMLVideoElement).paused, time: (v as HTMLVideoElement).currentTime }));
  }

  async expectLoaded(): Promise<void> {
    await expect(this.continueButton).toBeVisible({ timeout: 60_000 });
    await expect(this.widget).toContainText(/You just did the hard part/i);
    await expect(this.skipButton).toBeVisible();
  }

  async expectVideoPresent(): Promise<void> {
    await expect(this.playerIframe).toBeVisible();
    await expect(this.playerIframe).toHaveAttribute('src', /player\.vimeo\.com\/video\/\d+/);
    await expect(this.video).toBeAttached({ timeout: 30_000 });
  }

  /** Press Play and prove playback really advances (not just a "playing" flag). */
  async playAndExpectPlaying(): Promise<number> {
    await this.player.getByRole('button', { name: 'Play', exact: true }).first().click();
    let first = 0;
    await expect
      .poll(async () => (first = (await this.playbackState()).time), { timeout: 30_000, message: 'video currentTime never advanced' })
      .toBeGreaterThan(1);
    await expect
      .poll(async () => (await this.playbackState()).time, { timeout: 10_000, message: 'video stopped advancing' })
      .toBeGreaterThan(first + 1);
    expect((await this.playbackState()).paused).toBe(false);
    return (await this.playbackState()).time;
  }

  /** Reveal the auto-hidden controls, press Pause, and prove time stops. */
  async pauseAndExpectPaused(): Promise<number> {
    await this.playerIframe.hover();
    await this.playerIframe.hover({ position: { x: 20, y: 40 } });
    await this.player.getByRole('button', { name: 'Pause', exact: true }).first().click();
    await expect.poll(async () => (await this.playbackState()).paused, { timeout: 5_000 }).toBe(true);
    const frozenAt = (await this.playbackState()).time;
    await this.page.waitForTimeout(2_000);
    expect((await this.playbackState()).time, 'paused video kept advancing').toBeCloseTo(frozenAt, 1);
    return frozenAt;
  }

  async continue(): Promise<void> {
    await this.continueButton.click();
  }

  async skipVideo(): Promise<void> {
    await this.skipButton.click();
  }
}
