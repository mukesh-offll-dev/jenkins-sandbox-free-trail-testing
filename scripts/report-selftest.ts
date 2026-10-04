/**
 * Self-test for the AI email report. Never touches Thinkster.
 *
 *   npm run report:test            offline: mock Ollama server + no-network mail transport
 *   npm run report:test -- --live  real Ollama Cloud + real SMTP from .env, mock PASS and FAIL data
 *
 * Offline scenarios: PASS, FAIL (with planted secrets), Ollama unreachable,
 * Ollama timeout, invalid AI response, SMTP failure, stale results.
 * Email previews are written to artifacts/ai-report/selftest/.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';
import { createTransport } from 'nodemailer';
import { collectExecutionReport, type ExecutionReport } from '../src/utils/executionReport';
import { analyzeWithOllama, ollamaConfigFromEnv, type OllamaConfig } from '../src/utils/aiAnalyzer';
import { renderEmail, sendReportEmail, smtpConfigFromEnv, type SmtpConfig } from '../src/utils/emailReporter';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const OUT = path.resolve(process.cwd(), 'artifacts', 'ai-report', 'selftest');
const LIVE = process.argv.includes('--live');

// ---- Synthetic Playwright results ------------------------------------------

const PLANTED_SECRETS = [
  '12345678', // PARENT_PASSWORD default
  '123123', // SANDBOX_OTP default
  '4111111111111111',
  'supersecretcookievalue',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLXZhbHVl',
  'bearer-token-should-not-leak',
  'selftest-ollama-key-0001',
];

function writeFixture(name: string, passed: boolean): string {
  const dir = path.join(OUT, 'fixtures', name);
  fs.mkdirSync(dir, { recursive: true });

  const events = {
    consoleErrors: passed ? [] : ['Failed to load resource: the server responded with a status of 403 ()'],
    consoleWarnings: ['[Deprecation] Listener added for a synchronous DOMNodeInserted event'],
    pageErrors: passed ? [] : ['TypeError: Cannot read properties of undefined (reading \'slot\')'],
    failedRequests: passed ? [] : ['POST https://core-api-4.0-sandbox.hellothinkster.com/api/register/parent - HTTP 403'],
  };
  const eventsFile = path.join(dir, 'browser-events.json');
  fs.writeFileSync(eventsFile, JSON.stringify(events));

  const meta = {
    runId: `selftest-${name}`,
    status: passed ? 'passed' : 'failed',
    durationMs: passed ? 241_000 : 95_000,
    appointment: { dateLabel: 'Sun 4 Oct', displayTime: '7:00 PM', timezone: 'America/New_York' },
    steps: [
      { name: 'email-submitted' },
      { name: 'student-questionnaire-completed' },
      { name: 'parent-details-submitted' },
      ...(passed ? [{ name: 'activation-arm-detected', detail: 'card-required' }, { name: 'final-assertions-passed' }] : []),
    ],
    failure: passed
      ? undefined
      : 'Account creation did not complete after 1 verification attempt(s). | visible app errors: Account creation failed. Please try again.',
  };
  const metaFile = path.join(dir, 'run-metadata.json');
  fs.writeFileSync(metaFile, JSON.stringify(meta));

  const leakyLog = [
    `password=${PLANTED_SECRETS[0]} otp=${PLANTED_SECRETS[1]} card ${PLANTED_SECRETS[2]}`,
    `Cookie: session=${PLANTED_SECRETS[3]}`,
    `jwt ${PLANTED_SECRETS[4]}`,
    `Authorization: Bearer ${PLANTED_SECRETS[5]}`,
    `debug key ${PLANTED_SECRETS[6]}`,
  ].join('\n');

  const result = {
    status: passed ? 'passed' : 'failed',
    duration: meta.durationMs,
    error: passed ? undefined : { message: `\u001b[31mError: Account creation did not complete.\u001b[39m\n${leakyLog}` },
    errors: [],
    steps: [
      { title: 'Open the sandbox homepage and submit the unique parent email' },
      { title: 'Verify the phone number with the sandbox OTP', ...(passed ? {} : { error: { message: 'failed' } }) },
    ],
    stdout: [{ text: `[run selftest] parent email: test03101200@tabtortest.com\n${leakyLog}\n` }],
    attachments: [
      { name: 'browser-events', path: eventsFile, contentType: 'application/json' },
      { name: 'run-metadata', path: metaFile, contentType: 'application/json' },
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

// ---- Mock Ollama Cloud ------------------------------------------------------

type MockMode = 'pass' | 'fail' | 'invalid' | 'slow';
const mock = { mode: 'pass' as MockMode, lastAuth: '', lastBody: '' };

const analyses: Record<'pass' | 'fail', object> = {
  pass: {
    status: 'PASSED',
    summary: 'The registration journey completed and all final assertions passed.',
    category: 'NONE',
    warnings: ['One deprecation warning was logged in the browser console.'],
  },
  fail: {
    status: 'FAILED',
    summary: 'Account creation failed at the OTP verification step.',
    failedTest: 'registration.spec.ts > registers a new parent and student',
    failedStep: 'Verify the phone number with the sandbox OTP',
    error: 'Account creation did not complete after 1 verification attempt(s).',
    category: 'THIRD_PARTY',
    likelyCause: 'POST /api/register/parent returned HTTP 403, consistent with a reCAPTCHA rejection.',
    recommendation: 'Check reCAPTCHA scoring for the agent and the register/parent response body.',
    warnings: [],
  },
};

function startMockOllama(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      mock.lastAuth = String(req.headers.authorization ?? '');
      mock.lastBody = body;
      const reply = (content: string) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'mock', message: { role: 'assistant', content }, done: true }));
      };
      if (mock.mode === 'slow') setTimeout(() => reply('{}'), 3_000);
      else if (mock.mode === 'invalid') reply('I think the test failed because of the network, probably.');
      else reply(JSON.stringify(analyses[mock.mode]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

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

const noLeak = (text: string) => PLANTED_SECRETS.filter((s) => text.includes(s));

async function offline(): Promise<void> {
  process.env.OLLAMA_API_KEY = PLANTED_SECRETS[6];
  const server = await startMockOllama();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ollama: OllamaConfig = { apiKey: PLANTED_SECRETS[6], model: 'mock-model', baseUrl: base, timeoutMs: 1_000 };
  const mailOk: SmtpConfig = { enabled: true, port: 587, secure: false, from: 'qa@example.test', to: ['team@example.test'] };
  const jsonTransport = () => createTransport({ jsonTransport: true });

  const passResults = writeFixture('pass', true);
  const failResults = writeFixture('fail', false);
  const save = (name: string, html: string) => fs.writeFileSync(path.join(OUT, `${name}.html`), html, 'utf8');

  console.log('\nPASS mock report');
  mock.mode = 'pass';
  let report = collectExecutionReport({ resultsFile: passResults, pipelineResult: 'SUCCESS', env: jenkinsEnv('201') });
  let ai = await analyzeWithOllama(report, ollama);
  let email = renderEmail(report, ai);
  let sent = await sendReportEmail(email, mailOk, jsonTransport());
  save('pass', email.html);
  check('status PASSED', report.status === 'PASSED', report.status);
  check('AI analysis available', ai.available, !ai.available ? ai.reason : '');
  check('subject', email.subject === '[PASS] Thinkster QA Automation - Jenkins #201', email.subject);
  check('email sent', sent.sent, JSON.stringify(sent));

  console.log('\nFAIL mock report (with planted secrets)');
  mock.mode = 'fail';
  report = collectExecutionReport({ resultsFile: failResults, pipelineResult: 'FAILURE', env: jenkinsEnv('202') });
  ai = await analyzeWithOllama(report, ollama);
  email = renderEmail(report, ai);
  sent = await sendReportEmail(email, mailOk, jsonTransport());
  save('fail', email.html);
  check('status FAILED', report.status === 'FAILED', report.status);
  check('failed step detected', report.tests[0]?.failedStep === 'Verify the phone number with the sandbox OTP', report.tests[0]?.failedStep);
  check('browser evidence collected', report.failedRequests.length === 1 && report.pageErrors.length === 1);
  check('application errors extracted', report.applicationErrors[0] === 'Account creation failed. Please try again.', JSON.stringify(report.applicationErrors));
  check('ANSI codes stripped', !(report.tests[0]?.error ?? '').includes('\u001b'));
  check('API key sent only as Bearer header', mock.lastAuth === `Bearer ${PLANTED_SECRETS[6]}`);
  check('no secret in AI request body', noLeak(mock.lastBody).length === 0, noLeak(mock.lastBody).join(', '));
  check('no secret in email', noLeak(email.html + email.text).length === 0, noLeak(email.html + email.text).join(', '));
  check('AI category rendered', email.html.includes('THIRD_PARTY'));
  check('subject', email.subject === '[FAILED] Thinkster QA Automation - Jenkins #202', email.subject);
  check('email sent', sent.sent, JSON.stringify(sent));

  console.log('\nOllama unavailable (unreachable host)');
  const downConfig = { ...ollama, baseUrl: `http://127.0.0.1:${await closedPort()}` };
  ai = await analyzeWithOllama(report, downConfig);
  email = renderEmail(report, ai);
  sent = await sendReportEmail(email, mailOk, jsonTransport());
  save('ollama-unavailable', email.html);
  check('AI unavailable', !ai.available && /request failed/.test(ai.reason), !ai.available ? ai.reason : 'available');
  check('email says "Unavailable"', email.html.includes('Unavailable'));
  check('raw results still in email', email.html.includes('Verify the phone number with the sandbox OTP'));
  check('email still sent', sent.sent);

  console.log('\nOllama timeout');
  mock.mode = 'slow';
  const t0 = Date.now();
  ai = await analyzeWithOllama(report, ollama);
  check('AI unavailable with timeout reason', !ai.available && /timed out/.test(ai.reason), !ai.available ? ai.reason : 'available');
  check('gave up promptly (no retry on timeout)', Date.now() - t0 < 2_500, `${Date.now() - t0}ms`);

  console.log('\nInvalid AI response');
  mock.mode = 'invalid';
  ai = await analyzeWithOllama(report, ollama);
  email = renderEmail(report, ai);
  sent = await sendReportEmail(email, mailOk, jsonTransport());
  save('invalid-ai', email.html);
  check('falls back on invalid JSON', !ai.available && /invalid AI response/.test(ai.reason), !ai.available ? ai.reason : 'available');
  check('email still sent', sent.sent);

  console.log('\nSMTP failure');
  const badSmtp: SmtpConfig = { ...mailOk, host: '127.0.0.1', port: await closedPort(), user: 'qa', password: 'smtp-pass-0001' };
  const smtpResult = await sendReportEmail(email, badSmtp);
  check('reports failure without throwing', !smtpResult.sent && !smtpResult.skipped, JSON.stringify(smtpResult));
  check('SMTP password not in error', !JSON.stringify(smtpResult).includes('smtp-pass-0001'));

  console.log('\nStale results from an earlier build');
  report = collectExecutionReport({ resultsFile: passResults, buildStartMs: Date.now() + 60_000, pipelineResult: 'FAILURE' });
  check('stale results ignored', !report.resultsAvailable && report.status === 'FAILED', report.resultsNote);

  server.close();
  console.log(`\nEmail previews: ${OUT}`);
}

async function live(): Promise<void> {
  const ollama = ollamaConfigFromEnv();
  const smtp = { ...smtpConfigFromEnv(), enabled: true };
  console.log(`\nLIVE mode: Ollama ${ollama.baseUrl} model=${ollama.model} key=${ollama.apiKey ? 'set' : 'MISSING'}`);
  console.log(`           SMTP ${smtp.host ?? 'MISSING'}:${smtp.port} to=${smtp.to.length} recipient(s)`);

  for (const [name, passed] of [['pass', true], ['fail', false]] as const) {
    console.log(`\n${name.toUpperCase()} mock report -> real Ollama + real SMTP`);
    const report: ExecutionReport = collectExecutionReport({
      resultsFile: writeFixture(`live-${name}`, passed),
      pipelineResult: passed ? 'SUCCESS' : 'FAILURE',
    });
    const ai = await analyzeWithOllama(report, ollama);
    console.log(`  AI: ${ai.available ? `available (${ai.analysis.category}) - ${ai.analysis.summary}` : `Unavailable - ${ai.reason}`}`);
    const email = renderEmail(report, ai);
    fs.writeFileSync(path.join(OUT, `live-${name}.html`), email.html, 'utf8');
    const sent = await sendReportEmail(email, smtp);
    console.log(`  Email: ${sent.sent ? `sent to ${sent.recipients} recipient(s)` : `failed - ${sent.reason}`}`);
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
