import { expect, Locator, Page } from '@playwright/test';
import { BasePage } from './BasePage';
import { StudentData } from '../utils/testData';

/**
 * Student (child) registration - widget screens 3..8 of "GET STARTED".
 *
 * This is where the sandbox actually creates the student record: the child's
 * first name, school grade, working grade and the two qualifying questions are
 * all submitted as part of the registration payload.
 *
 * Verified locators:
 *   child count   #twCountRow .countbtn   (".sel" marks the selection, "1 child" default)
 *                 #twCtaCount
 *   child name    #twNameFld              placeholder "First name"
 *   grade slider  #hSchool                button, aria-label "School grade" (shows "?" until set)
 *                 #trial .sp-tlab         clickable grade labels: K,1..8,AL1,GEM,AL2
 *                 #twCtaNameGrade
 *   working grade #hWork                  button, aria-label "Working grade"
 *                 #twCtaWorkGrade
 *   question 1    #trial .opt  +  #twCtaQ1
 *   question 2    #trial .opt  +  #twCtaQ2
 *   roadmap       #twCtaRoadmap
 *
 * Note: the grade "slider" accepts a plain click on its tick labels - no drag
 * simulation is required, which keeps the step fast and stable.
 */
export class StudentRegistrationPage extends BasePage {
  private readonly childCountOptions = this.page.locator('#twCountRow .countbtn');
  private readonly childCountContinue = this.page.locator('#twCtaCount');

  private readonly childNameField = this.page.locator('#twNameFld');
  private readonly schoolGradeHandle = this.page.locator('#hSchool');
  private readonly nameGradeContinue = this.page.locator('#twCtaNameGrade');

  private readonly workingGradeHandle = this.page.locator('#hWork');
  private readonly workingGradeContinue = this.page.locator('#twCtaWorkGrade');

  private readonly options = this.page.locator('#trial .opt');
  private readonly question1Continue = this.page.locator('#twCtaQ1');
  private readonly question2Continue = this.page.locator('#twCtaQ2');

  private readonly roadmapContinue = this.page.locator('#twCtaRoadmap');

  constructor(page: Page) {
    super(page);
  }

  private gradeLabel(grade: string) {
    return this.page.locator('#trial .sp-tlab', { hasText: new RegExp(`^${grade}$`) });
  }

  /** Screen 3 of 8 - "How many children are you exploring Thinkster for?" */
  async selectChildCount(count: 1 | 2 | 3 = 1): Promise<void> {
    await this.expectVisible(this.childCountContinue);
    await expect(this.widget).toContainText(/How many children/i);

    const option = this.childCountOptions.nth(count - 1);
    await option.click();
    await expect(option).toHaveClass(/\bsel\b/);

    await this.childCountContinue.click();
    await this.expectVisible(this.childNameField);
  }

  // ---- Interactive coverage (onboarding.spec.ts) ---------------------------
  //
  // Verified live 2026-10-05: the count tiles are <div class="countbtn"> holding
  // "<n>" and "child(ren)" as separate elements (textContent "2children"), so they
  // are matched by regex; ".sel" marks the choice. Each grade control is a custom
  // ARIA slider <button role="slider" aria-label="School grade" | "Working grade">
  // on #axis1 / #axis2 with 12 tick labels (.sp-tlab, data-i 0..11). It responds
  // to dragging only, and aria-valuenow stays "5" whatever is shown.

  /** Grade tick labels as rendered, K .. AL2. */
  static readonly GRADE_LABELS = ['K', '1', '2', '3', '4', '5', '6', '7', '8', 'AL1', 'GEM', 'AL2'] as const;

  /** How the school-grade value (#twV1) and the working-screen summary spell each tick. */
  static gradeText(label: string): string {
    const names: Record<string, string> = { K: 'Kindergarten', AL1: 'Algebra 1', GEM: 'Geometry', AL2: 'Algebra 2' };
    return names[label] ?? `Grade ${label}`;
  }

  private static readonly SAVE_LINES: Record<1 | 2 | 3, RegExp> = {
    1: /Adding a second child saves 5%/i,
    2: /save 5% on the second child/i,
    3: /save 5% on the second and third child/i,
  };

  readonly childCountScreen = this.childCountContinue;
  readonly nameGradeScreen = this.childNameField;
  readonly workingGradeScreen = this.workingGradeHandle;
  readonly question1Screen = this.question1Continue;

  private countTile(count: 1 | 2 | 3): Locator {
    return this.childCountOptions.filter({ hasText: new RegExp(`^\\s*${count}\\s*child`) });
  }

  private slider(kind: 'school' | 'working'): Locator {
    return this.page.getByRole('slider', { name: kind === 'school' ? 'School grade' : 'Working grade' });
  }

  private tick(kind: 'school' | 'working', label: string): Locator {
    return this.page.locator(`#${kind === 'school' ? 'axis1' : 'axis2'} .sp-tlab`).filter({ hasText: new RegExp(`^${label}$`) });
  }

  /** Select a count, prove only that tile is selected and its savings line shows. */
  async chooseChildCount(count: 1 | 2 | 3): Promise<void> {
    await this.expectVisible(this.childCountContinue);
    await expect(this.widget).toContainText(/How many children/i);
    await this.countTile(count).click();
    await this.expectChildCountSelected(count);
    await expect(this.page.locator('#twSaveLine')).toHaveText(StudentRegistrationPage.SAVE_LINES[count]);
  }

  async expectChildCountSelected(count: 1 | 2 | 3): Promise<void> {
    for (const n of [1, 2, 3] as const) {
      if (n === count) await expect(this.countTile(n)).toHaveClass(/\bsel\b/);
      else await expect(this.countTile(n)).not.toHaveClass(/\bsel\b/);
    }
  }

  async continueFromChildCount(): Promise<void> {
    await this.childCountContinue.click();
    await this.expectVisible(this.childNameField);
    await expect(this.widget).toContainText(/Tell us your child's first name/i);
  }

  async enterChildName(name: string): Promise<void> {
    await this.childNameField.fill(name);
    await expect(this.childNameField).toHaveValue(name);
  }

  /** Drag the real slider handle onto a tick label and verify what the UI shows. */
  async dragGrade(kind: 'school' | 'working', label: string): Promise<void> {
    const handle = this.slider(kind);
    const tick = this.tick(kind, label);
    await handle.dragTo(tick);
    await expect(handle).toHaveText(label);
    // The handle sits exactly on the chosen tick (both use the same left %).
    const tickLeft = await tick.evaluate((el) => (el as HTMLElement).style.left);
    await expect.poll(() => handle.evaluate((el) => (el as HTMLElement).style.left)).toBe(tickLeft);
    if (kind === 'school') {
      await expect(this.page.locator('#twV1')).toHaveText(StudentRegistrationPage.gradeText(label));
    }
  }

  /**
   * Drag K -> AL2 through every tick. Returns any ticks where aria-valuenow does
   * not match the tick index (a known accessibility defect), without failing.
   */
  async sweepGrade(kind: 'school' | 'working'): Promise<string[]> {
    const ariaMismatches: string[] = [];
    for (const [index, label] of StudentRegistrationPage.GRADE_LABELS.entries()) {
      await this.dragGrade(kind, label);
      const now = await this.slider(kind).getAttribute('aria-valuenow');
      if (now !== String(index)) ariaMismatches.push(`${label}: aria-valuenow=${now} (expected ${index})`);
    }
    return ariaMismatches;
  }

  async continueFromNameGrade(childName: string): Promise<void> {
    await expect(this.nameGradeContinue).toBeEnabled();
    await this.nameGradeContinue.click();
    await this.expectVisible(this.workingGradeHandle);
    await expect(this.widget).toContainText(new RegExp(`Where is ${childName} actually working today`, 'i'));
  }

  /** "You told us <name>'s school grade" + "<Grade> · <year> school year". */
  async expectSchoolGradeSummary(childName: string, label: string): Promise<void> {
    await expect(this.widget).toContainText(new RegExp(`You told us ${childName}'s school grade`, 'i'));
    await expect(this.widget).toContainText(new RegExp(`${StudentRegistrationPage.gradeText(label)} · \\d{4}`));
  }

  /** "Edit" re-opens the name/school-grade screen with the previous answers kept. */
  async editSchoolGrade(expectedName: string, expectedLabel: string): Promise<void> {
    await this.page.getByRole('button', { name: 'Edit', exact: true }).click();
    await this.expectVisible(this.childNameField);
    await expect(this.childNameField).toHaveValue(expectedName);
    await expect(this.slider('school')).toHaveText(expectedLabel);
  }

  async continueFromWorkingGrade(): Promise<void> {
    await expect(this.workingGradeContinue).toBeEnabled();
    await this.workingGradeContinue.click();
    await this.expectVisible(this.question1Continue);
  }

  /** The question screen proves the chosen count was kept: "CHILD 1 OF <n>". */
  async expectQuestionsForChildCount(childName: string, count: 1 | 2 | 3): Promise<void> {
    await expect(this.widget).toContainText(new RegExp(`What's the one thing you want to change for ${childName}`, 'i'));
    if (count === 1) await expect(this.widget).not.toContainText(/CHILD 1 OF/i);
    else await expect(this.widget).toContainText(new RegExp(`CHILD 1 OF ${count}`, 'i'));
  }

  /** Screen 4 of 8 - child's first name + school grade. */
  async enterNameAndSchoolGrade(student: StudentData): Promise<void> {
    await expect(this.widget).toContainText(/Tell us your child's first name/i);

    // CTA stays disabled until BOTH name and grade are provided.
    await expect(this.nameGradeContinue).toBeDisabled();

    await this.childNameField.fill(student.firstName);
    await expect(this.childNameField).toHaveValue(student.firstName);

    await this.gradeLabel(student.grade).click();
    await expect(this.schoolGradeHandle).toHaveText(student.grade);

    await expect(this.nameGradeContinue).toBeEnabled();
    await this.expectNoVisibleWidgetError();
    await this.nameGradeContinue.click();
    await this.expectVisible(this.workingGradeHandle);
  }

  /** Screen 5 of 8 - "Where is <child> actually working today?" */
  async confirmWorkingGrade(student: StudentData): Promise<void> {
    await expect(this.widget).toContainText(new RegExp(`Where is ${student.firstName} actually working today`, 'i'));
    await expect(this.workingGradeContinue).toBeDisabled();

    await this.gradeLabel(student.grade).click();
    await expect(this.workingGradeHandle).toHaveText(student.grade);

    await expect(this.workingGradeContinue).toBeEnabled();
    await this.workingGradeContinue.click();
    await this.expectVisible(this.question1Continue);
  }

  /** Screens 6 and 7 of 8 - the two qualifying questions. */
  async answerQualifyingQuestions(): Promise<{ answer1: string; answer2: string }> {
    await expect(this.widget).toContainText(/What's the one thing you want to change/i);
    await expect(this.question1Continue).toBeDisabled();

    const first = this.options.first();
    const answer1 = (await first.innerText()).trim();
    await first.click();
    await expect(this.question1Continue).toBeEnabled();
    await this.question1Continue.click();

    await this.expectVisible(this.question2Continue);
    await expect(this.widget).toContainText(/What have you tried/i);
    await expect(this.question2Continue).toBeDisabled();

    const second = this.options.first();
    const answer2 = (await second.innerText()).trim();
    await second.click();
    await expect(this.question2Continue).toBeEnabled();
    await this.question2Continue.click();

    // Screen 8 of 8 renders an animated roadmap; auto-waiting covers the animation.
    await this.expectVisible(this.roadmapContinue, 90_000);
    return { answer1, answer2 };
  }

  /** Screen 8 of 8 - the personalised roadmap. */
  async continuePastRoadmap(student: StudentData): Promise<void> {
    await expect(this.widget).toContainText(/CONFIDENCE ROADMAP/i);
    await expect(this.widget).toContainText(new RegExp(student.firstName, 'i'));
    await this.roadmapContinue.click();
  }
}
