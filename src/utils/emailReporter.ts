import * as fs from 'fs';
import * as path from 'path';
import { createTransport, type Transporter } from 'nodemailer';
import { redactStrict } from './mask';
import type { ExecutionReport } from './executionReport';

export interface EmailAttachment {
  filename: string;
  path: string;
  /** Content-ID referenced by the inline <img src="cid:..."> in the HTML body. */
  cid: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: EmailAttachment[];
}

// Keep the message well under common mail-server size limits (Gmail: 25 MB).
const MAX_SCREENSHOTS = 6;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

/** Failure screenshots to embed, with the test each belongs to. */
function collectScreenshots(report: ExecutionReport): Array<EmailAttachment & { caption: string }> {
  const shots: Array<EmailAttachment & { caption: string }> = [];
  let total = 0;
  for (const test of report.tests) {
    for (const file of test.screenshots) {
      if (shots.length >= MAX_SCREENSHOTS) return shots;
      let size: number;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      if (size > MAX_SCREENSHOT_BYTES || total + size > MAX_TOTAL_BYTES) continue;
      total += size;
      const index = shots.length + 1;
      shots.push({
        filename: `failure-${index}-${path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_')}`,
        path: file,
        cid: `failure-shot-${index}@thinkster-qa`,
        caption: `${test.file} > ${test.title}`,
      });
    }
  }
  return shots;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const shortSha = (sha?: string) => (sha ? sha.slice(0, 7) : 'unknown');
const seconds = (ms?: number) => (ms === undefined ? '' : `${Math.round(ms / 1000)}s`);
const clip = (value: string, max = 300) => (value.length > max ? `${value.slice(0, max)}...` : value);

/** Readable wording for the step names written by registration.spec.ts; null = not listed. */
const STEP_LABELS: Record<string, (detail?: string) => string | null> = {
  'widget-variant': () => null,
  'email-submitted': () => 'Parent email submitted and lead captured',
  'student-questionnaire-completed': () => 'Student questionnaire completed',
  'parent-details-submitted': () => 'Parent details form submitted',
  'otp-verified': () => 'Phone verified with the sandbox OTP and parent account created',
  'appointment-booked': (d) => `Free 1:1 session booked${d ? ` (${d})` : ''}`,
  'appointment-skipped': () => 'Session booking skipped - no available slot (see Warnings)',
  'activation-arm-detected': (d) => `Trial activation path: ${d ?? 'unknown'}`,
  'trial-activated-without-card': () => 'Trial activated without a card',
  'sandbox-payment-completed': () => 'Sandbox payment accepted and trial activated',
  'handoff-to-elevate': () => 'Handed off to the Elevate app',
  'final-assertions-passed': (d) =>
    `Students page verified${d ? ` for ${d}` : ''}: URL, heading, student profile, In Trial status and Select button`,
};

function stepLabel(name: string, detail?: string): string | null {
  const label = STEP_LABELS[name];
  return label ? label(detail) : name;
}

function failureBullets(report: ExecutionReport): string[] {
  const failed = report.tests.find((t) => t.status !== 'passed' && t.status !== 'skipped');
  if (!failed) return [report.resultsNote ?? 'The pipeline failed before any test result was produced.'];

  const bullets = [`Failed test: ${failed.file} > ${failed.title}`];
  if (failed.failedStep) bullets.push(`Failed at step: ${failed.failedStep}`);

  const lines = (failed.error ?? '')
    .split('\nCall log:')[0]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0]) bullets.push(`Reason: ${clip(lines[0].replace(/^Error:\s*/, ''))}`);

  // Keep the lines that state the direct cause; collapse repeated retry lines.
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const attempt = line.match(/^attempt \d+:\s*(.+)$/i);
    const detail = attempt ? `Server response: ${attempt[1]}` : /^(Locator|Expected|Received|Timeout):/.test(line) ? line : null;
    if (!detail || seen.has(detail)) continue;
    seen.add(detail);
    bullets.push(clip(detail));
    if (seen.size >= 4) break;
  }

  for (const message of report.applicationErrors.slice(0, 2)) bullets.push(`Application message shown: ${clip(message)}`);

  const last = report.run?.completedSteps.filter((s) => s.name !== 'widget-variant').pop();
  if (last && failed.file === 'registration.spec.ts') {
    bullets.push(`Last completed step: ${stepLabel(last.name, last.detail) ?? last.name}`);
  }

  for (const other of report.tests.filter((t) => t !== failed && t.status !== 'passed' && t.status !== 'skipped')) {
    const reason = (other.error ?? '').split(/\r?\n/)[0].replace(/^Error:\s*/, '').trim();
    bullets.push(
      `Also failed: ${other.file} > ${other.title}` +
        (other.failedStep ? ` at "${other.failedStep}"` : '') +
        (reason ? ` - ${clip(reason, 200)}` : ''),
    );
  }
  return bullets;
}

function passBullets(report: ExecutionReport): string[] {
  const bullets = report.tests.map(
    (t) => `${t.file} > ${t.title}: ${t.status === 'skipped' ? 'skipped' : `passed in ${seconds(t.durationMs)}`}`,
  );
  for (const step of report.run?.completedSteps ?? []) {
    const label = stepLabel(step.name, step.detail);
    if (label) bullets.push(label);
  }
  return bullets;
}

export function renderEmail(report: ExecutionReport): RenderedEmail {
  const passed = report.status === 'PASSED';
  const build = report.jenkins.buildNumber ? `Jenkins #${report.jenkins.buildNumber}` : 'Local run';
  const subject = `[${passed ? 'PASS' : 'FAILED'}] Thinkster QA Automation - ${build}`;

  const details: Array<[string, string]> = [
    ['Status', report.status],
    ['Jenkins Build', report.jenkins.buildNumber ? `#${report.jenkins.buildNumber}` : 'Local run'],
    ['Execution Time', report.timestampIst],
    ['Git Commit', shortSha(report.git.commit)],
  ];
  if (report.git.branch) details.push(['Branch', report.git.branch]);
  if (report.jenkins.jobName) details.push(['Job', report.jenkins.jobName]);
  if (report.jenkins.nodeName) details.push(['Node', report.jenkins.nodeName]);
  if (report.pipelineResult) details.push(['Pipeline Result', report.pipelineResult]);
  if (report.run?.widgetVariant) details.push(['Widget Variant', report.run.widgetVariant]);
  details.push([
    'Browser Evidence',
    `${report.consoleErrors.length} console errors, ${report.consoleWarnings.length} console warnings, ` +
      `${report.pageErrors.length} page errors, ${report.failedRequests.length} failed requests`,
  ]);

  const testRows: Array<[string, string, string]> = report.tests.length
    ? report.tests.map((t) => [`${t.file} > ${t.title}`, t.status.toUpperCase(), seconds(t.durationMs)])
    : [[report.resultsNote ?? 'No test results available.', '', '']];

  const resultTitle = passed ? 'What Passed' : 'Why It Failed';
  const resultBullets = (passed ? passBullets(report) : failureBullets(report)).map((b) => redactStrict(b));
  const warnings = report.run?.warnings ?? [];
  const screenshots = passed ? [] : collectScreenshots(report);

  const buildUrl = report.jenkins.buildUrl;
  const links: Array<[string, string]> = buildUrl
    ? [
        ['Jenkins Build', buildUrl],
        ['Playwright Report', `${buildUrl.replace(/\/?$/, '/')}Playwright_20Report/`],
      ]
    : [];

  // ---- HTML ----------------------------------------------------------------
  const color = passed ? '#1a7f37' : '#cf222e';
  const cell = 'padding:6px 10px;border-bottom:1px solid #eaeef2;vertical-align:top;';
  const heading = (title: string) => `<h3 style="margin:24px 0 8px;font-size:15px;color:#24292f">${escapeHtml(title)}</h3>`;
  const table = (body: string) => `<table style="border-collapse:collapse;width:100%;font-size:13px">${body}</table>`;
  const kv = (rows: Array<[string, string]>) =>
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="${cell}color:#57606a;width:160px;white-space:nowrap">${escapeHtml(k)}</td>` +
          `<td style="${cell}white-space:pre-wrap;word-break:break-word">${escapeHtml(v)}</td></tr>`,
      )
      .join('');
  const list = (items: string[]) =>
    `<ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.6">` +
    items.map((item) => `<li style="word-break:break-word">${escapeHtml(item)}</li>`).join('') +
    `</ul>`;

  const testsHtml = testRows
    .map(([name, status, dur]) => {
      const c = status === 'PASSED' ? '#1a7f37' : status ? '#cf222e' : '#57606a';
      return (
        `<tr><td style="${cell}">${escapeHtml(name)}</td>` +
        `<td style="${cell}color:${c};font-weight:600;white-space:nowrap">${escapeHtml(status)}</td>` +
        `<td style="${cell}color:#57606a;white-space:nowrap">${escapeHtml(dur)}</td></tr>`
      );
    })
    .join('');

  const linksHtml = links
    .map(([k, url]) => `<p style="margin:4px 0;font-size:13px">${escapeHtml(k)}: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`)
    .join('');

  const html =
    `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#f6f8fa;font-family:Segoe UI,Arial,sans-serif;color:#24292f">` +
    `<div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #d0d7de;border-radius:6px;padding:20px">` +
    `<h2 style="margin:0 0 4px;font-size:18px">Thinkster QA Automation Report</h2>` +
    `<div style="display:inline-block;margin:8px 0 4px;padding:4px 10px;border-radius:4px;background:${color};color:#ffffff;font-weight:600;font-size:13px">${report.status}</div>` +
    heading('Run Details') +
    table(kv(details)) +
    heading('Test Summary') +
    table(testsHtml) +
    heading(resultTitle) +
    list(resultBullets) +
    (warnings.length ? heading('Warnings') + list(warnings) : '') +
    (screenshots.length
      ? heading('Failure Screenshots') +
        screenshots
          .map(
            (s) =>
              `<p style="margin:8px 0 4px;font-size:12px;color:#57606a">${escapeHtml(s.caption)} - ${escapeHtml(s.filename)}</p>` +
              `<img src="cid:${s.cid}" alt="${escapeHtml(s.filename)}" style="display:block;max-width:100%;height:auto;border:1px solid #d0d7de;border-radius:4px">`,
          )
          .join('')
      : '') +
    (linksHtml ? `<div style="margin-top:24px">${linksHtml}</div>` : '') +
    `</div></body></html>`;

  // ---- Plain text ----------------------------------------------------------
  const line = '--------------------------------';
  const bulletsText = (items: string[]) => items.map((item) => `- ${item}`).join('\n');
  const text = [
    'Thinkster QA Automation Report',
    '',
    details.map(([k, v]) => `${k}: ${v}`).join('\n'),
    line,
    'Test Summary',
    ...testRows.map(([name, status, dur]) => `${name}  ${status} ${dur}`.trim()),
    line,
    resultTitle,
    bulletsText(resultBullets),
    ...(warnings.length ? [line, 'Warnings', bulletsText(warnings)] : []),
    ...(screenshots.length
      ? [line, 'Failure Screenshots (attached)', bulletsText(screenshots.map((s) => `${s.filename} - ${s.caption}`))]
      : []),
    ...(links.length ? [line, links.map(([k, v]) => `${k}: ${v}`).join('\n')] : []),
  ].join('\n');

  return {
    subject,
    html: redactStrict(html),
    text: redactStrict(text),
    attachments: screenshots.map(({ filename, path: file, cid }) => ({ filename, path: file, cid })),
  };
}

// ---- Sending -----------------------------------------------------------------

/** Reports may only be sent from the company mailbox, never a personal account. */
export const COMPANY_MAIL_DOMAIN = 'hellothinkster.com';

export interface SmtpConfig {
  enabled: boolean;
  host?: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from?: string;
  to: string[];
}

export function smtpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  const port = Number(env.SMTP_PORT);
  return {
    enabled: env.SEND_EMAIL?.trim().toLowerCase() === 'true',
    host: env.SMTP_HOST?.trim() || undefined,
    port: Number.isFinite(port) && port > 0 ? port : 587,
    secure: env.SMTP_SECURE?.trim().toLowerCase() === 'true',
    user: env.SMTP_USER?.trim() || undefined,
    password: env.SMTP_PASSWORD || undefined,
    from: env.MAIL_FROM?.trim() || env.SMTP_USER?.trim() || undefined,
    to: (env.MAIL_TO ?? '')
      .split(/[,;]/)
      .map((a) => a.trim())
      .filter(Boolean),
  };
}

const bareAddress = (value: string) => (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
const isCompanyAddress = (value: string) => bareAddress(value).endsWith(`@${COMPANY_MAIL_DOMAIN}`);

export type EmailOutcome =
  | { sent: true; recipients: number; accepted: number; rejected: number; serverResponse: string }
  | { sent: false; skipped: boolean; reason: string };

/** Never throws. `transport` is injectable for offline tests. */
export async function sendReportEmail(
  email: RenderedEmail,
  config: SmtpConfig = smtpConfigFromEnv(),
  transport?: Transporter,
): Promise<EmailOutcome> {
  if (!config.enabled) return { sent: false, skipped: true, reason: 'SEND_EMAIL is not "true".' };

  const missing = [
    !transport && !config.host && 'SMTP_HOST',
    !config.from && 'MAIL_FROM (or SMTP_USER)',
    config.to.length === 0 && 'MAIL_TO',
  ].filter(Boolean);
  if (missing.length) return { sent: false, skipped: false, reason: `missing configuration: ${missing.join(', ')}` };

  const nonCompany = [
    ...new Set([config.from, config.user].filter((v): v is string => !!v && !isCompanyAddress(v)).map(bareAddress)),
  ];
  if (nonCompany.length) {
    return {
      sent: false,
      skipped: false,
      reason:
        `sender ${nonCompany.join(', ')} is not a @${COMPANY_MAIL_DOMAIN} address; ` +
        `set the qa-report-smtp credential (SMTP_USER/SMTP_PASSWORD) to the approved Thinkster mailbox.`,
    };
  }

  const mailer =
    transport ??
    createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.password ?? '' } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });

  try {
    const info = (await mailer.sendMail({
      from: config.from,
      to: config.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: email.attachments.map((a) => ({ filename: a.filename, path: a.path, cid: a.cid, contentType: 'image/png' })),
    })) as { accepted?: unknown[]; rejected?: unknown[]; response?: unknown };
    const accepted = Array.isArray(info?.accepted) ? info.accepted.length : config.to.length;
    const rejected = Array.isArray(info?.rejected) ? info.rejected.length : 0;
    if (accepted === 0) {
      return { sent: false, skipped: false, reason: `SMTP server rejected all ${rejected} recipient(s).` };
    }
    return {
      sent: true,
      recipients: config.to.length,
      accepted,
      rejected,
      serverResponse: typeof info?.response === 'string' ? redactStrict(info.response).slice(0, 120) : 'n/a',
    };
  } catch (error) {
    return { sent: false, skipped: false, reason: redactStrict((error as Error)?.message ?? String(error)).slice(0, 300) };
  } finally {
    mailer.close();
  }
}
