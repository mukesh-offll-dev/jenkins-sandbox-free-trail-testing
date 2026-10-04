import * as fs from 'fs';
import * as path from 'path';

/**
 * Unique parent-email generation.
 *
 *   format : test<DDMMHHmm>[_<suffix>]@tabtortest.com
 *   stamp  : local time of the machine running the test, zero-padded
 *   example: test29090201@tabtortest.com, test29090201_2@tabtortest.com
 *
 * Every address handed to a signup is recorded in a ledger, so an address is
 * never reused: not within the same minute, and not on the same DDMMHHmm a year
 * later (the format has no year).
 */

export const EMAIL_PREFIX = 'test';
export const EMAIL_DOMAIN = 'tabtortest.com';
export const TEST_EMAIL_PATTERN = /^test\d{8}(_[a-z0-9]{1,16})?@tabtortest\.com$/;

const DEFAULT_LEDGER = path.resolve(process.cwd(), '.auth', 'used-test-emails.txt');

export interface GeneratedEmail {
  /** The address to type into the application. */
  email: string;
  /** DDMMHHmm in local time. */
  stamp: string;
  /** Collision suffix without the underscore; empty when the base address was free. */
  suffix: string;
  /** ISO-8601 instant the address was generated (UTC). */
  generatedAtUtc: string;
  /** Readable local timestamp with the IANA zone, e.g. "29/09/2026 02:01:07 Asia/Calcutta". */
  generatedAtLocal: string;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** DDMMHHmm in the local time of the running machine. */
export function localStamp(date: Date = new Date()): string {
  return `${pad(date.getDate())}${pad(date.getMonth() + 1)}${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export function localReadable(date: Date = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${zone}`
  );
}

/** Hard guard: only generated @tabtortest.com addresses may reach a signup form. */
export function assertTestEmail(email: string): void {
  if (!TEST_EMAIL_PATTERN.test(email)) {
    throw new Error(
      `Refusing to use "${email}" for signup: test emails must match test<DDMMHHmm>[_suffix]@${EMAIL_DOMAIN}.`,
    );
  }
}

function readLedger(file: string): Set<string> {
  try {
    return new Set(
      fs
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export interface GenerateEmailOptions {
  now?: Date;
  /**
   * Record the address so no later run can reuse it. Default true; pass false
   * only for previews and offline mocks that never submit the address.
   */
  reserve?: boolean;
  ledgerFile?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Generate a brand-new parent email address.
 *
 * Jenkins runs always carry `_<BUILD_NUMBER>`: the Jenkins workspace keeps its
 * own ledger, so this keeps a CI build and a local run started in the same
 * minute from both taking the bare address. Locally the bare address is used
 * when free, then `_2`, `_3`, ...
 */
export function generateParentEmail(options: GenerateEmailOptions = {}): GeneratedEmail {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const ledgerFile = options.ledgerFile ?? DEFAULT_LEDGER;
  const stamp = localStamp(now);
  const used = readLedger(ledgerFile);

  const build = (env.BUILD_NUMBER ?? '').replace(/\D/g, '').slice(0, 8);
  const candidate = (attempt: number) => {
    if (attempt === 1) return build;
    return build ? `${build}x${attempt}` : String(attempt);
  };
  const address = (suffix: string) => `${EMAIL_PREFIX}${stamp}${suffix ? `_${suffix}` : ''}@${EMAIL_DOMAIN}`;

  let attempt = 1;
  while (used.has(address(candidate(attempt)))) attempt++;
  const suffix = candidate(attempt);
  const email = address(suffix);
  assertTestEmail(email);

  if (options.reserve !== false) {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.appendFileSync(ledgerFile, `${email}\n`, 'utf8');
  }

  return {
    email,
    stamp,
    suffix,
    generatedAtUtc: now.toISOString(),
    generatedAtLocal: localReadable(now),
  };
}
