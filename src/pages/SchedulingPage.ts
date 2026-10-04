import { expect, Locator, Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { AppointmentRecord } from '../utils/runReport';

/**
 * Appointment scheduling - "YOUR SESSION" screens 1..2 of 2.
 *
 * Verified locators:
 *   timezone  #twSessTzSel                select.tzsel (56 options, defaults to the browser timezone)
 *   dates     #trial .dchip               data-ghl-date="YYYY-MM-DD";
 *                                         ".on" = selected, ".none" = no availability (and no data attr)
 *   more      #twMoreDates                "+ More dates" expands 3 -> 7 days
 *   times     #trial .tslot               data-ghl-slot = JSON {startTime,endTime,displayTime};
 *                                         ".on" = selected
 *   hold      #twCtaASess                 "Hold my spot →"
 *   skip      #twSkipASess                "Skip for now" - only when nothing is bookable
 *   confirm   #twCtaSpotHeld              "Lock in this spot →" on the held-spot screen
 *
 * Availability is read from the live DOM (backed by GET /api/calendar/free-slots)
 * and never hard-coded.
 */
export class SchedulingPage extends BasePage {
  private readonly timezoneSelect = this.page.locator('#twSessTzSel');
  private readonly dateChips = this.page.locator('#trial .dchip');
  private readonly moreDatesButton = this.page.locator('#twMoreDates');
  private readonly timeSlots = this.page.locator('#trial .tslot');
  private readonly holdSpotButton = this.page.locator('#twCtaASess');
  private readonly lockInButton = this.page.locator('#twCtaSpotHeld');
  private readonly skipButton = this.page
    .locator('#twSkipASess')
    .or(this.page.getByRole('button', { name: /Skip for now/i }))
    .first();

  constructor(page: Page) {
    super(page);
  }

  async expectLoaded(): Promise<void> {
    await this.expectVisible(this.holdSpotButton, 120_000);
    await this.expectStepLabel(/YOUR SESSION · 1 OF 2/i);
    await expect(this.page.getByRole('heading', { name: /Pick your free session/i })).toBeVisible();
  }

  /**
   * Wait for "Loading available sessions..." to finish. VERIFIED 2026-10-04 the
   * free-slots call can hang for over 30s; false means it never loaded.
   */
  async waitForCalendar(timeout = 90_000): Promise<boolean> {
    return this.timezoneSelect
      .waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);
  }

  /** Display all times in an explicit timezone so the booking is deterministic. */
  async selectTimezone(timezoneId: string): Promise<string> {
    await this.timezoneSelect.selectOption(timezoneId);
    await expect(this.timezoneSelect).toHaveValue(timezoneId);
    // Wait for the date strip, not a time slot: VERIFIED 2026-10-04 the first
    // three days can all be fully booked, so no slot renders until a later date
    // is chosen via "+ More dates" (done in selectFirstAvailableAppointment).
    await expect(this.dateChips.first()).toBeVisible({ timeout: 60_000 });
    return timezoneId;
  }

  /** Reveal the full 7-day strip so we can find a future date with availability. */
  async expandAllDates(): Promise<void> {
    if (await this.moreDatesButton.isVisible().catch(() => false)) {
      await this.moreDatesButton.click();
      await expect(this.moreDatesButton).toBeHidden({ timeout: 20_000 }).catch(() => undefined);
    }
  }

  /** Dates that actually have availability, in calendar order. */
  async availableDates(): Promise<string[]> {
    await expect(this.dateChips.first()).toBeVisible();
    const chips = await this.dateChips.all();
    const dates: string[] = [];
    for (const chip of chips) {
      const cls = (await chip.getAttribute('class')) ?? '';
      const date = await chip.getAttribute('data-ghl-date');
      if (date && !/\bnone\b/.test(cls)) dates.push(date);
    }
    return dates;
  }

  private chipFor(date: string): Locator {
    return this.page.locator(`#trial .dchip[data-ghl-date="${date}"]`);
  }

  /** Labels of every date chip on screen, e.g. ["Sun 4 Oct", "Mon 5 Oct"]. */
  async shownDates(): Promise<string[]> {
    return (await this.dateChips.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  }

  /**
   * Pick the first genuinely available slot, preferring a future date over today.
   * Returns null when no listed date has a bookable slot - VERIFIED 2026-10-04 the
   * sandbox calendar can return {"slots":{}} for the whole 7-day window.
   */
  async selectFirstAvailableAppointment(timezoneId: string): Promise<AppointmentRecord | null> {
    await this.expandAllDates();

    // Availability arrives asynchronously from /api/calendar/free-slots; poll
    // instead of reading the chips once while they may still be loading.
    let dates: string[] = [];
    await expect
      .poll(async () => (dates = await this.availableDates()).length, { timeout: 30_000 })
      .toBeGreaterThan(0)
      .catch(() => undefined);
    if (dates.length === 0) return null;

    const today = new Date().toISOString().slice(0, 10);
    const ordered = [...dates.filter((d) => d > today), ...dates.filter((d) => d <= today)];

    for (const date of ordered) {
      const chip = this.chipFor(date);
      if (!(await chip.isVisible().catch(() => false))) continue;

      await chip.click();
      await expect(chip).toHaveClass(/\bon\b/);

      // isVisible() does not wait; waitFor() really gives the slots time to load.
      const slot = this.timeSlots.first();
      const hasSlot = await slot
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
      if (!hasSlot) continue;

      await slot.click();
      const selected = this.page.locator('#trial .tslot.on').first();
      await expect(selected).toBeVisible();

      const raw = await selected.getAttribute('data-ghl-slot');
      if (!raw) throw new Error(`Selected time slot on ${date} exposed no data-ghl-slot payload.`);
      const parsed = JSON.parse(raw) as { startTime: string; endTime: string; displayTime: string };

      return {
        date,
        dateLabel: (await chip.innerText()).replace(/\s+/g, ' ').trim(),
        displayTime: parsed.displayTime,
        startTimeIso: parsed.startTime,
        endTimeIso: parsed.endTime,
        timezone: timezoneId,
      };
    }

    return null;
  }

  /**
   * The app's own "Skip for now — I'll book later" path, used only when no slot
   * can be booked. Waits until the widget has actually left the scheduling screen.
   */
  async skipBooking(): Promise<void> {
    await expect(this.skipButton).toBeEnabled();
    await this.skipButton.click();
    await expect(this.holdSpotButton).toBeHidden({ timeout: 60_000 });
  }

  async holdSpot(): Promise<void> {
    await expect(this.holdSpotButton).toBeEnabled();
    await this.holdSpotButton.click();
    await this.expectVisible(this.lockInButton, 120_000);
  }

  /**
   * Verify the held appointment is reflected back to the user before continuing.
   * The confirmation screen restates the date/time, e.g.
   * "Your session spot is held / Tuesday, September 29 / 2:00 PM · 45 min · 1:1".
   */
  async expectAppointmentHeld(appointment: AppointmentRecord): Promise<void> {
    await this.expectStepLabel(/YOUR SESSION · 2 OF 2/i);
    await expect(this.page.getByRole('heading', { name: /Your session spot is held/i })).toBeVisible();
    await expect(this.widget).toContainText(appointment.displayTime);

    // Cross-check the weekday/month/day rendered by the app against the slot ISO.
    const start = new Date(appointment.startTimeIso);
    const monthDay = start.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      timeZone: appointment.timezone,
    });
    await expect(this.widget).toContainText(monthDay);
  }

  async lockInSpot(): Promise<void> {
    await this.lockInButton.click();
  }
}
