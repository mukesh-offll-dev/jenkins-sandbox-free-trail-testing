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
 *   skip      #twSkipASess                (never used - we must really book)
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

  constructor(page: Page) {
    super(page);
  }

  async expectLoaded(): Promise<void> {
    await this.expectVisible(this.holdSpotButton, 120_000);
    await expect(this.widget).toContainText(/YOUR SESSION · 1 OF 2/i);
    await expect(this.page.getByRole('heading', { name: /Pick your free session/i })).toBeVisible();
  }

  /** Display all times in an explicit timezone so the booking is deterministic. */
  async selectTimezone(timezoneId: string): Promise<string> {
    await this.timezoneSelect.selectOption(timezoneId);
    await expect(this.timezoneSelect).toHaveValue(timezoneId);
    // Slots are re-fetched for the new timezone.
    await expect(this.timeSlots.first()).toBeVisible({ timeout: 60_000 });
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

  /**
   * Pick the first genuinely available slot, preferring a future date over today.
   * Throws a descriptive error if the calendar has no availability at all.
   */
  async selectFirstAvailableAppointment(timezoneId: string): Promise<AppointmentRecord> {
    await this.expandAllDates();

    const dates = await this.availableDates();
    if (dates.length === 0) {
      throw new Error('Scheduling failed: the sandbox calendar returned no available dates.');
    }

    const today = new Date().toISOString().slice(0, 10);
    const ordered = [...dates.filter((d) => d > today), ...dates.filter((d) => d <= today)];

    for (const date of ordered) {
      const chip = this.chipFor(date);
      if (!(await chip.isVisible().catch(() => false))) continue;

      await chip.click();
      await expect(chip).toHaveClass(/\bon\b/);

      const slot = this.timeSlots.first();
      if (!(await slot.isVisible({ timeout: 20_000 }).catch(() => false))) continue;

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

    throw new Error(
      `Scheduling failed: none of the advertised dates (${dates.join(', ')}) exposed a selectable time slot.`,
    );
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
    await expect(this.widget).toContainText(/YOUR SESSION · 2 OF 2/i);
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
