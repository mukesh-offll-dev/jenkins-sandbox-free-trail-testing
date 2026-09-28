/**
 * Unique parent-email generation.
 *
 * Contract from the QA brief:
 *   prefix : mukesh
 *   domain : @tabtortest.com
 *   stamp  : DDMMHHmmSS using the CURRENT time in Asia/Kolkata
 *   example: mukesh2809111245@tabtortest.com
 *
 * The stamp is always computed from Asia/Kolkata regardless of the machine or
 * Playwright context timezone, so the address is stable across CI agents.
 */

const EMAIL_PREFIX = 'mukesh';
const EMAIL_DOMAIN = 'tabtortest.com';
const IST_TIMEZONE = 'Asia/Kolkata';

export interface GeneratedEmail {
  /** The address to type into the application. */
  email: string;
  /** DDMMHHmmSS stamp in Asia/Kolkata. */
  stamp: string;
  /** Optional collision-avoidance suffix that was applied (empty when unused). */
  suffix: string;
  /** ISO-8601 instant the address was generated (UTC). */
  generatedAtUtc: string;
  /** Human readable Asia/Kolkata timestamp, useful in reports. */
  generatedAtIst: string;
}

function istParts(date: Date): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

/** DDMMHHmmSS in Asia/Kolkata. */
export function istStamp(date: Date = new Date()): string {
  const p = istParts(date);
  return `${p.day}${p.month}${p.hour}${p.minute}${p.second}`;
}

/** Readable Asia/Kolkata timestamp, e.g. "28/09/2026 11:12:45 IST". */
export function istReadable(date: Date = new Date()): string {
  const p = istParts(date);
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second} IST`;
}

/**
 * Generate a brand-new parent email address.
 *
 * `uniqueSuffix` should only be supplied when several executions can start in
 * the same second (e.g. multiple CI agents). It is appended to the stamp and
 * kept short so the local part stays well within provider limits.
 */
export function generateParentEmail(options: { uniqueSuffix?: string; now?: Date } = {}): GeneratedEmail {
  const now = options.now ?? new Date();
  const stamp = istStamp(now);
  const rawSuffix = (options.uniqueSuffix ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = rawSuffix.slice(0, 6);

  return {
    email: `${EMAIL_PREFIX}${stamp}${suffix}@${EMAIL_DOMAIN}`,
    stamp,
    suffix,
    generatedAtUtc: now.toISOString(),
    generatedAtIst: istReadable(now),
  };
}

/**
 * Suffix derived from the CI build so concurrent agents can never collide.
 * Returns an empty string for a plain local run (keeps the canonical format).
 */
export function ciCollisionSuffix(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.EMAIL_UNIQUE_SUFFIX?.trim();
  if (explicit) return explicit;

  const build = env.BUILD_NUMBER?.trim();
  const executor = env.EXECUTOR_NUMBER?.trim();
  if (build && executor) return `b${build}e${executor}`;
  if (build) return `b${build}`;
  return '';
}
