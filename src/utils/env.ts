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
  /**
   * Origin that actually serves the registration API.
   *
   * VERIFIED 2026-09-28 against the live sandbox: the widget is served from
   * sandbox.hellothinkster.com but posts to a DIFFERENT origin -
   *   POST https://core-api-4.0-sandbox.hellothinkster.com/api/register/lead
   * Cookies scoped to the marketing host are therefore never sent to it.
   */
  coreApi: string;
}

export interface Secrets {
  password: string;
  otp: string;
  cardNumber: string;
  cardExpiry: string;
  cardCvc: string;
}

/** Parsed form of the THINKSTER_QA_BYPASS cookie string (`name=value`). */
export interface QaBypassCookie {
  name: string;
  value: string;
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
    coreApi: required('SANDBOX_CORE_API_URL', 'https://core-api-4.0-sandbox.hellothinkster.com'),
  };
}

/**
 * Every authorized sandbox origin the QA bypass cookie must be applied to.
 *
 * WHY THIS IS NOT JUST THE REGISTRATION HOST (verified 2026-09-28)
 * ---------------------------------------------------------------
 * A cookie added with `url: 'https://sandbox.hellothinkster.com'` is stored with
 * domain=sandbox.hellothinkster.com, so the browser sends it to that host only.
 * The reCAPTCHA-guarded endpoint lives on a DIFFERENT origin:
 *   POST https://core-api-4.0-sandbox.hellothinkster.com/api/register/lead
 *
 * !! IMPORTANT UNRESOLVED FINDING - the cookie mechanism cannot work here !!
 * Captured with `request.allHeaders()` on a real headed run, every single API
 * call to the core-API origin carried NO cookies at all - not the bypass cookie,
 * not any other cookie:
 *   [CROSS-ORIGIN] core-api-...../api/register/lead                 cookies: none
 *   [CROSS-ORIGIN] core-api-...../api/registration/step-progress/v2 cookies: none
 *   [CROSS-ORIGIN] core-api-...../api/ab/event                      cookies: none
 * That is the expected browser behaviour: `fetch()` defaults to
 * credentials:'same-origin', which omits cookies on cross-origin requests. So no
 * cookie - at any domain, path or SameSite setting - can reach the guarded
 * endpoint from the page.
 *
 * Scoping the cookie to the core-API origin is therefore CORRECT but currently
 * INEFFECTIVE, and backend acceptance of the token remains UNVERIFIED. The real
 * mechanism (a request header? a query parameter? a server-side allow-list?)
 * must be confirmed against Thinkster's QA integration documentation before the
 * integration is changed further. Do not guess it.
 */
export function qaBypassTargets(): string[] {
  const { registration, coreApi } = urls();
  return [registration, coreApi];
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
 * Read the authorized QA reCAPTCHA bypass cookie from the environment.
 *
 * The env var holds the full cookie string in `name=value` format so that it
 * can be sourced verbatim from a Jenkins Secret text credential and pasted
 * directly into .env for local use without any extra parsing at the call site.
 *
 * Returns undefined when the variable is absent or empty, so the test can run
 * without a bypass token (falling back to the reCAPTCHA retry path).
 *
 * The value is intentionally NOT included in the Secrets interface because it
 * is only applied to the browser context, not typed into any form field.
 */
export function qaBypassCookie(): QaBypassCookie | undefined {
  const raw = process.env.THINKSTER_QA_BYPASS?.trim();
  if (!raw) return undefined;
  const eq = raw.indexOf('=');
  if (eq < 1) return undefined;
  return { name: raw.slice(0, eq), value: raw.slice(eq + 1) };
}

/**
 * Hard safety rail: this suite may only ever talk to sandbox hosts.
 * Any attempt to point it at production fails the run immediately.
 */
export function assertSandboxOnly(): void {
  const { registration, studentsPage, expectedPaymentHost, coreApi } = urls();
  const checks: Array<[string, string]> = [
    ['SANDBOX_BASE_URL', registration],
    ['ELEVATE_STUDENTS_URL', studentsPage],
    ['SANDBOX_CORE_API_URL', coreApi],
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
