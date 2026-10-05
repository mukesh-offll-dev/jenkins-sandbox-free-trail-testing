/**
 * Self-test for the email report. Never touches Thinkster.
 *
 *   npm run report:test            offline: no-network mail transport
 *   npm run report:test -- --live  real SMTP from .env, mock PASS and FAIL data
 *
 * Offline scenarios: PASS, FAIL (with planted secrets), no results produced,
 * stale results, non-company sender refused, SMTP failure.
 * Email previews are written to artifacts/email-report/selftest/.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { createTransport } from 'nodemailer';
import { collectExecutionReport } from '../src/utils/executionReport';
import { renderEmail, sendReportEmail, smtpConfigFromEnv, type SmtpConfig } from '../src/utils/emailReporter';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const OUT = path.resolve(process.cwd(), 'artifacts', 'email-report', 'selftest');
const LIVE = process.argv.includes('--live');

// ---- Synthetic Playwright results ------------------------------------------

const PLANTED_SECRETS = [
  '12345678', // PARENT_PASSWORD default
  '123123', // SANDBOX_OTP default
  '4111111111111111',
  'supersecretcookievalue',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLXZhbHVl',
  'bearer-token-should-not-leak',
  'selftest-smtp-pass-0001',
];

const PASS_STEPS = [
  { name: 'widget-variant', detail: 'v1.0.13 · B / widget-experiment-b' },
  { name: 'email-submitted', detail: 'test05101200@tabtortest.com; attempts=1' },
  { name: 'student-questionnaire-completed', detail: 'grade=5' },
  { name: 'parent-details-submitted' },
  { name: 'otp-verified', detail: 'attempts=1' },
  { name: 'appointment-skipped', detail: 'no slots' },
  { name: 'activation-arm-detected', detail: 'card-required' },
  { name: 'sandbox-payment-completed', detail: 'TRIAL ACTIVATED' },
  { name: 'handoff-to-elevate', detail: 'https://elevate-sandbox.hellothinkster.com/students' },
  { name: 'final-assertions-passed', detail: 'Test Automation / In Trial' },
];

function writeFixture(name: string, passed: boolean): string {
  const dir = path.join(OUT, 'fixtures', name);
  fs.mkdirSync(dir, { recursive: true });

  const events = {
    consoleErrors: passed ? [] : ['Failed to load resource: the server responded with a status of 403 ()'],
    consoleWarnings: ['[Deprecation] Listener added for a synchronous DOMNodeInserted event'],
    pageErrors: [],
    failedRequests: passed ? [] : ['POST https://core-api-4.0-sandbox.hellothinkster.com/api/register/parent - HTTP 403'],
  };
  const eventsFile = path.join(dir, 'browser-events.json');
  fs.writeFileSync(eventsFile, JSON.stringify(events));

  const leakyLog = [
    `password=${PLANTED_SECRETS[0]} otp=${PLANTED_SECRETS[1]} card ${PLANTED_SECRETS[2]}`,
    `Cookie: session=${PLANTED_SECRETS[3]}`,
    `jwt ${PLANTED_SECRETS[4]}`,
    `Authorization: Bearer ${PLANTED_SECRETS[5]}`,
    `debug ${PLANTED_SECRETS[6]}`,
  ].join('\n');

  const meta = {
    runId: `selftest-${name}`,
    status: passed ? 'passed' : 'failed',
    durationMs: passed ? 241_000 : 95_000,
    steps: passed ? PASS_STEPS : PASS_STEPS.slice(0, 4),
    warnings: passed
      ? ['Session booking SKIPPED: no available slot on any listed date (Sun 4 Oct - Sat 10 Oct; America/New_York).']
      : [],
    failure: passed
      ? undefined
      : 'Account creation did not complete. | visible app errors: Account creation failed. Please try again.',
  };
  const metaFile = path.join(dir, 'run-metadata.json');
  fs.writeFileSync(metaFile, JSON.stringify(meta));

  // 1x1 PNG standing in for Playwright's failure screenshot.
  const shotFile = path.join(dir, 'test-failed-1.png');
  fs.writeFileSync(
    shotFile,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
  );

  const failureMessage =
    `\u001b[31mError: Account creation did not complete after 4 verification attempt(s).\u001b[39m\n` +
    `Observations:\n` +
    `  attempt 1: /api/register/parent -> HTTP 403 {"error":"reCAPTCHA verification failed. Please try again."}\n` +
    `  attempt 2: /api/register/parent -> HTTP 403 {"error":"reCAPTCHA verification failed. Please try again."}\n` +
    `${leakyLog}`;

  const result = {
    status: passed ? 'passed' : 'failed',
    duration: meta.durationMs,
    error: passed ? undefined : { message: failureMessage },
    errors: [],
    steps: [
      { title: 'Open the sandbox homepage and submit the unique parent email' },
      { title: 'Verify the phone number with the sandbox OTP', ...(passed ? {} : { error: { message: 'failed' } }) },
    ],
    attachments: [
      { name: 'browser-events', path: eventsFile, contentType: 'application/json' },
      { name: 'run-metadata', path: metaFile, contentType: 'application/json' },
      { name: 'screenshot', path: shotFile, contentType: 'image/png' },
    ],
  };

  const results = {
    stats: { startTime: new Date().toISOString(), duration: meta.durationMs },
    errors: [],
    suites: [
      {
        title: 'registration.spec.ts',
        file: 'registration.spec.ts',
        specs: [],
        suites: [
          {
            title: 'Thinkster sandbox - free trial registration',
            file: 'registration.spec.ts',
            specs: [
              {
                title: 'registers a new parent and student and reaches the student selection page',
                file: 'registration.spec.ts',
                tests: [{ results: [result] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const resultsFile = path.join(dir, 'results.json');
  fs.writeFileSync(resultsFile, JSON.stringify(results));
  return resultsFile;
}

const jenkinsEnv = (build: string): NodeJS.ProcessEnv => ({
  ...process.env,
  BUILD_NUMBER: build,
  BUILD_ID: build,
  JOB_NAME: 'Thinkster-Sandbox-Testing',
  BUILD_URL: `http://localhost:8080/job/Thinkster-Sandbox-Testing/${build}/`,
  NODE_NAME: 'built-in',
});

async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

// ---- Runner -------------------------------------------------------------------

let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (!condition) failures++;
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${!condition && detail ? ` -> ${detail}` : ''}`);
}

const leaked = (text: string) => PLANTED_SECRETS.filter((s) => text.includes(s));
const FORBIDDEN_WORDS = /\b(AI|Ollama|LLM)\b|AI Analysis/i;

async function offline(): Promise<void> {
  process.env.SMTP_PASSWORD = PLANTED_SECRETS[6];
  const mailOk: SmtpConfig = {
    enabled: true,
    port: 587,
    secure: false,
    user: 'qa-reports@hellothinkster.com',
    from: 'qa-reports@hellothinkster.com',
    to: ['team@hellothinkster.com'],
  };
  const jsonTransport = () => createTransport({ jsonTransport: true });
  const save = (name: string, html: string) => fs.writeFileSync(path.join(OUT, `${name}.html`), html, 'utf8');

  console.log('\nPASS report');
  let report = collectExecutionReport({ resultsFile: writeFixture('pass', true), pipelineResult: 'SUCCESS', env: jenkinsEnv('201') });
  let email = renderEmail(report);
  let sent = await sendReportEmail(email, mailOk, jsonTransport());
  save('pass', email.html);
  check('status PASSED', report.status === 'PASSED', report.status);
  check('subject', email.subject === '[PASS] Thinkster QA Automation - Jenkins #201', email.subject);
  check('"What Passed" bullets', email.text.includes('What Passed') && email.text.includes('- Parent email submitted and lead captured'));
  check('final page bullet', email.text.includes('Students page verified for Test Automation / In Trial'));
  check('skipped booking shown as warning', email.text.includes('Warnings') && email.text.includes('Session booking SKIPPED'));
  check('no AI wording', !FORBIDDEN_WORDS.test(email.html + email.text), (email.html + email.text).match(FORBIDDEN_WORDS)?.[0]);
  check('no screenshots on a pass', email.attachments.length === 0 && !email.html.includes('Failure Screenshots'));
  check('email sent', sent.sent, JSON.stringify(sent));

  console.log('\nFAIL report (with planted secrets)');
  report = collectExecutionReport({ resultsFile: writeFixture('fail', false), pipelineResult: 'FAILURE', env: jenkinsEnv('202') });
  email = renderEmail(report);
  sent = await sendReportEmail(email, mailOk, jsonTransport());
  save('fail', email.html);
  check('status FAILED', report.status === 'FAILED', report.status);
  check('subject', email.subject === '[FAILED] Thinkster QA Automation - Jenkins #202', email.subject);
  check('failed step bullet', email.text.includes('- Failed at step: Verify the phone number with the sandbox OTP'));
  check('reason bullet', email.text.includes('- Reason: Account creation did not complete after 4 verification attempt(s).'));
  const serverLines = email.text.split('\n').filter((l) => l.startsWith('- Server response:'));
  check('server response collapsed to one bullet', serverLines.length === 1 && serverLines[0].includes('HTTP 403'), String(serverLines.length));
  check('application message bullet', email.text.includes('- Application message shown: Account creation failed. Please try again.'));
  check('last completed step bullet', email.text.includes('- Last completed step: Parent details form submitted'));
  check('ANSI codes stripped', !(email.html + email.text).includes('\u001b'));
  const shot = email.attachments[0];
  check('failure screenshot attached', email.attachments.length === 1 && !!shot && fs.existsSync(shot.path), JSON.stringify(email.attachments));
  check('screenshot embedded inline', !!shot && email.html.includes(`src="cid:${shot.cid}"`) && email.html.includes('Failure Screenshots'));
  check('no secret in email', leaked(email.html + email.text).length === 0, leaked(email.html + email.text).join(', '));
  check('no AI wording', !FORBIDDEN_WORDS.test(email.html + email.text), (email.html + email.text).match(FORBIDDEN_WORDS)?.[0]);
  check('email sent', sent.sent, JSON.stringify(sent));

  console.log('\nNo results produced (pipeline failed early)');
  report = collectExecutionReport({ resultsFile: path.join(OUT, 'missing.json'), pipelineResult: 'FAILURE', env: jenkinsEnv('203') });
  email = renderEmail(report);
  sent = await sendReportEmail(email, mailOk, jsonTransport());
  check('FAILED with explanation', report.status === 'FAILED' && email.text.includes('No Playwright results were produced'));
  check('email still sent', sent.sent);

  console.log('\nStale results from an earlier build');
  report = collectExecutionReport({ resultsFile: writeFixture('stale', true), buildStartMs: Date.now() + 60_000, pipelineResult: 'FAILURE' });
  check('stale results ignored', !report.resultsAvailable && report.status === 'FAILED', report.resultsNote);

  console.log('\nNon-company sender refused');
  const personal = await sendReportEmail(email, { ...mailOk, user: 'someone@gmail.com', from: 'someone@gmail.com' }, jsonTransport());
  check('gmail sender refused', !personal.sent && !personal.skipped && /hellothinkster\.com/.test(personal.reason), JSON.stringify(personal));
  const mixed = await sendReportEmail(email, { ...mailOk, user: 'someone@gmail.com' }, jsonTransport());
  check('company From with personal SMTP login refused', !mixed.sent, JSON.stringify(mixed));

  console.log('\nSMTP failure');
  const badSmtp: SmtpConfig = { ...mailOk, host: '127.0.0.1', port: await closedPort(), password: PLANTED_SECRETS[6] };
  const smtpResult = await sendReportEmail(email, badSmtp);
  check('reports failure without throwing', !smtpResult.sent && !smtpResult.skipped, JSON.stringify(smtpResult));
  check('SMTP password not in error', !JSON.stringify(smtpResult).includes(PLANTED_SECRETS[6]));

  console.log(`\nEmail previews: ${OUT}`);
}

async function live(): Promise<void> {
  const smtp = { ...smtpConfigFromEnv(), enabled: true };
  console.log(`\nLIVE mode: SMTP ${smtp.host ?? 'MISSING'}:${smtp.port} to=${smtp.to.length} recipient(s)`);

  for (const [name, passed] of [['pass', true], ['fail', false]] as const) {
    console.log(`\n${name.toUpperCase()} mock report -> real SMTP`);
    const report = collectExecutionReport({
      resultsFile: writeFixture(`live-${name}`, passed),
      pipelineResult: passed ? 'SUCCESS' : 'FAILURE',
    });
    const email = renderEmail(report);
    fs.writeFileSync(path.join(OUT, `live-${name}.html`), email.html, 'utf8');
    const sent = await sendReportEmail(email, smtp);
    console.log(`  Email: ${sent.sent ? `sent to ${sent.recipients} recipient(s)` : `not sent - ${sent.reason}`}`);
  }
}

fs.mkdirSync(OUT, { recursive: true });
(LIVE ? live() : offline())
  .then(() => {
    if (!LIVE) console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
    process.exit(failures ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
