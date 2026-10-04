import { createTransport, type Transporter } from 'nodemailer';
import { redactStrict } from './mask';
import type { ExecutionReport } from './executionReport';
import type { AiResult } from './aiAnalyzer';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const shortSha = (sha?: string) => (sha ? sha.slice(0, 7) : 'unknown');
const seconds = (ms?: number) => (ms === undefined ? '' : `${Math.round(ms / 1000)}s`);

function failureFromResults(report: ExecutionReport) {
  const failed = report.tests.find((t) => t.status !== 'passed' && t.status !== 'skipped');
  const error = (failed?.error ?? '').split('\nCall log:')[0].trim();
  return {
    test: failed ? `${failed.file} > ${failed.title}` : '',
    step: failed?.failedStep ?? '',
    error: (error.length > 600 ? `${error.slice(0, 600)}...` : error) || report.resultsNote || '',
  };
}

function aiRows(report: ExecutionReport, ai: AiResult): Array<[string, string]> {
  if (!ai.available) return [['AI Analysis', 'Unavailable'], ['Reason', ai.reason]];

  const a = ai.analysis;
  const passed = report.status === 'PASSED';
  const rows: Array<[string, string]> = [['Summary', a.summary]];
  if (!passed) {
    rows.push(
      ['Failed Test', a.failedTest || '-'],
      ['Failed Step', a.failedStep || '-'],
      ['Error', a.error || '-'],
      ['Category', a.category],
      ['Likely Cause', a.likelyCause || '-'],
      ['Recommendation', a.recommendation || '-'],
    );
  } else if (a.category !== 'NONE' && a.category !== 'UNKNOWN') {
    rows.push(['Category', a.category]);
  }
  rows.push(['Warnings', a.warnings.length ? a.warnings.join('\n') : 'None']);
  return rows;
}

export function renderEmail(report: ExecutionReport, ai: AiResult): RenderedEmail {
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

  const testRows: Array<[string, string, string]> = report.tests.length
    ? report.tests.map((t) => [`${t.file} > ${t.title}`, t.status.toUpperCase(), seconds(t.durationMs)])
    : [[report.resultsNote ?? 'No test results available.', '', '']];

  const runWarnings = report.run?.warnings ?? [];
  const results: Array<[string, string]> = passed
    ? [
        [
          'Summary',
          runWarnings.length
            ? 'All configured tests completed successfully, with the warnings below.'
            : 'All configured tests completed successfully.',
        ],
      ]
    : (() => {
        const f = failureFromResults(report);
        return [
          ['Failed Test', f.test || '-'],
          ['Failed Step', f.step || '-'],
          ['Error', f.error || '-'],
        ] as Array<[string, string]>;
      })();
  if (runWarnings.length) results.push(['Warnings', runWarnings.join('\n')]);
  if (report.run?.widgetVariant) results.push(['Widget Variant', report.run.widgetVariant]);
  if (report.run?.activationArm) results.push(['Activation Arm', report.run.activationArm]);
  if (report.run?.appointment) results.push(['Appointment', report.run.appointment]);
  results.push([
    'Browser Evidence',
    `${report.consoleErrors.length} console errors, ${report.consoleWarnings.length} warnings, ` +
      `${report.pageErrors.length} page errors, ${report.failedRequests.length} failed requests`,
  ]);

  const aiDetails = aiRows(report, ai);
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
  const kv = (rows: Array<[string, string]>) =>
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="${cell}color:#57606a;width:160px;white-space:nowrap">${escapeHtml(k)}</td>` +
          `<td style="${cell}white-space:pre-wrap;word-break:break-word">${escapeHtml(v)}</td></tr>`,
      )
      .join('');
  const section = (title: string, body: string) =>
    `<h3 style="margin:24px 0 8px;font-size:15px;color:#24292f">${escapeHtml(title)}</h3>` +
    `<table style="border-collapse:collapse;width:100%;font-size:13px">${body}</table>`;

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
    section('Run Details', kv(details)) +
    section('Test Summary', testsHtml) +
    section(passed ? 'Result' : 'Failure (from Playwright results)', kv(results)) +
    section(ai.available ? `AI Analysis (${ai.model})` : 'AI Analysis', kv(aiDetails)) +
    (linksHtml ? `<div style="margin-top:24px">${linksHtml}</div>` : '') +
    `</div></body></html>`;

  // ---- Plain text ----------------------------------------------------------
  const line = '--------------------------------';
  const kvText = (rows: Array<[string, string]>) => rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  const text = [
    'Thinkster QA Automation Report',
    '',
    kvText(details),
    line,
    'Test Summary',
    ...testRows.map(([name, status, dur]) => `${name}  ${status} ${dur}`.trim()),
    line,
    passed ? 'Result' : 'Failure (from Playwright results)',
    kvText(results),
    line,
    'AI Analysis',
    kvText(aiDetails),
    ...(links.length ? [line, kvText(links)] : []),
  ].join('\n');

  return { subject, html: redactStrict(html), text: redactStrict(text) };
}

// ---- Sending -----------------------------------------------------------------

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
