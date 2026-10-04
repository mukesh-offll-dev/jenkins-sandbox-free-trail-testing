/**
 * Test-data management for one registration run.
 *
 * Non-secret values live here; secrets come from `env.secrets()`.
 * Values match the authorized sandbox data set in the QA brief.
 */

import { generateParentEmail, GeneratedEmail } from './email';

export interface ParentData {
  firstName: string;
  lastName: string;
  country: string;
  countryCode: string;
  /** Exactly as supplied by the brief - never silently changed. */
  phone: string;
  /** Digits only, for character-by-character typing into the masked input. */
  phoneDigits: string;
}

export interface StudentData {
  firstName: string;
  /** Slider label on the grade picker, e.g. "5". */
  grade: string;
}

export interface BillingData {
  firstName: string;
  lastName: string;
  postalCode: string;
  country: string;
}

export interface RegistrationTestData {
  runId: string;
  generatedEmail: GeneratedEmail;
  parent: ParentData;
  student: StudentData;
  billing: BillingData;
  /** Expected student display name on the students page: "First Last". */
  expectedStudentDisplayName: string;
}

const PARENT_PHONE = '(908) 020-4336';

/** `reserveEmail: false` only for previews that never submit the address. */
export function buildRegistrationTestData(options: { reserveEmail?: boolean } = {}): RegistrationTestData {
  const generatedEmail = generateParentEmail({ reserve: options.reserveEmail ?? true });

  const parent: ParentData = {
    firstName: process.env.PARENT_FIRST_NAME ?? 'Test',
    lastName: process.env.PARENT_LAST_NAME ?? 'Automation',
    country: process.env.PARENT_COUNTRY ?? 'United States',
    countryCode: process.env.PARENT_COUNTRY_CODE ?? '+1',
    phone: process.env.PARENT_PHONE ?? PARENT_PHONE,
    phoneDigits: (process.env.PARENT_PHONE ?? PARENT_PHONE).replace(/\D/g, ''),
  };

  const student: StudentData = {
    firstName: process.env.STUDENT_FIRST_NAME ?? parent.firstName,
    grade: process.env.STUDENT_GRADE ?? '5',
  };

  const billing: BillingData = {
    firstName: parent.firstName,
    lastName: parent.lastName,
    postalCode: process.env.BILLING_POSTAL_CODE ?? '07001',
    country: process.env.BILLING_COUNTRY ?? 'United States',
  };

  return {
    runId: generatedEmail.suffix ? `${generatedEmail.stamp}_${generatedEmail.suffix}` : generatedEmail.stamp,
    generatedEmail,
    parent,
    student,
    billing,
    // The sandbox creates the student as "<student first name> <parent last name>".
    expectedStudentDisplayName: `${student.firstName} ${parent.lastName}`,
  };
}
