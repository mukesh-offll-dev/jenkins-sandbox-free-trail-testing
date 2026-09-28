/**
 * Environment configuration.
 *
 * Secrets (password, OTP, card data) are ALWAYS read from the environment /
 * Jenkins credentials. They are never hard-coded in a page object or a test and
 * never written into a report artifact.
 */

export interface SandboxUrls {
  registration: string;
  studentsPage: string;
  /** Host that must serve the hosted checkout for the payment step to be trusted. */
  expectedPaymentHost: string;
}

export interface Secrets {
  password: string;
  otp: string;
  cardNumber: string;
  cardExpiry: string;
  cardCvc: string;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `Missing required environment variable ${name}. ` +
      `Copy .env.example to .env for local runs, or bind a Jenkins credential in the pipeline.`,
  );
}

export function urls(): SandboxUrls {
  return {
    registration: required('SANDBOX_BASE_URL', 'https://sandbox.hellothinkster.com'),
    studentsPage: required('ELEVATE_STUDENTS_URL', 'https://elevate-sandbox.hellothinkster.com/students'),
    expectedPaymentHost: required('EXPECTED_PAYMENT_HOST', 'cde.openpaystaging.com'),
  };
}

/**
 * Sandbox-only secrets. Defaults match the authorized sandbox test values from
 * the QA brief so a fresh clone runs without extra setup, but every value can
 * be overridden by an environment variable / Jenkins credential.
 */
export function secrets(): Secrets {
  return {
    password: required('PARENT_PASSWORD', '12345678'),
    otp: required('SANDBOX_OTP', '123123'),
    cardNumber: required('SANDBOX_CARD_NUMBER', '4111111111111111'),
    cardExpiry: required('SANDBOX_CARD_EXPIRY', '12/30'),
    cardCvc: required('SANDBOX_CARD_CVC', '123'),
  };
}

/**
 * Hard safety rail: this suite may only ever talk to sandbox hosts.
 * Any attempt to point it at production fails the run immediately.
 */
export function assertSandboxOnly(): void {
  const { registration, studentsPage, expectedPaymentHost } = urls();
  const checks: Array<[string, string]> = [
    ['SANDBOX_BASE_URL', registration],
    ['ELEVATE_STUDENTS_URL', studentsPage],
  ];

  for (const [name, value] of checks) {
    const host = new URL(value).host;
    if (!/(^|\.)sandbox[.-]|-sandbox\./.test(host)) {
      throw new Error(
        `Refusing to run: ${name}="${value}" does not look like an authorized sandbox host. ` +
          `This suite submits registrations and card data and must never touch production.`,
      );
    }
  }

  if (!/staging|sandbox|test/i.test(expectedPaymentHost)) {
    throw new Error(
      `Refusing to run: EXPECTED_PAYMENT_HOST="${expectedPaymentHost}" is not a recognised sandbox payment host.`,
    );
  }
}
