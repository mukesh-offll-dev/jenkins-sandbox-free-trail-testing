import { expect, Page } from '@playwright/test';
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
