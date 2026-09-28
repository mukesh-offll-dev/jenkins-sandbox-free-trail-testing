/**
 * Secret hygiene helpers.
 *
 * Everything that is logged, attached to the HTML report or written to the run
 * metadata JSON goes through `redact()` first, so passwords, OTPs and full card
 * numbers can never leak into a published Jenkins artifact.
 */

import { secrets } from './env';

/** Mask a card number to its last 4 digits, e.g. "**** **** **** 1111". */
export function maskCard(cardNumber: string): string {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `**** **** **** ${digits.slice(-4)}`;
}

/** Mask a phone number to its last 4 digits, matching the app's own display. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***-***-${digits.slice(-4)}`;
}

/** Fully redact a value, keeping only its length for debugging. */
export function maskSecret(value: string): string {
  return `***redacted(${value.length})***`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every known secret in an arbitrary string with a safe placeholder.
 * Used for console output and for any text attached to the report.
 */
export function redact(text: string): string {
  let output = text;
  const s = secrets();

  const replacements: Array<[string, string]> = [
    [s.password, '***PASSWORD***'],
    [s.otp, '***OTP***'],
    [s.cardNumber, maskCard(s.cardNumber)],
    [s.cardCvc, '***CVC***'],
  ];

  for (const [secret, placeholder] of replacements) {
    if (!secret || secret.length < 3) continue;
    output = output.replace(new RegExp(escapeRegExp(secret), 'g'), placeholder);
  }

  // Also catch a card number typed with separators.
  const grouped = s.cardNumber.replace(/(\d{4})(?=\d)/g, '$1[ -]?');
  if (s.cardNumber.length >= 12) {
    output = output.replace(new RegExp(grouped, 'g'), maskCard(s.cardNumber));
  }

  // The Elevate hand-off is an SSO deep link of the form
  //   /sso/<url-encoded-email>/<64-char-token>
  // The token is a live credential and must never reach a published artifact.
  output = output.replace(/(\/sso\/[^/\s]+\/)[A-Za-z0-9._-]{16,}/g, '$1***SSO_TOKEN***');

  return output;
}

/** Console logger that redacts secrets before anything reaches the Jenkins log. */
export function safeLog(message: string): void {
  // eslint-disable-next-line no-console
  console.log(redact(message));
}
