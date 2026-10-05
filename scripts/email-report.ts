/**
 * Post-build execution report: collect Playwright results -> render -> email.
 *
 * Runs after every Jenkins build (pass or fail). It ALWAYS exits 0 so reporting
 * can never change the real build result; problems are logged and skipped.
 *
 * Inputs (all optional): PIPELINE_RESULT, BUILD_START_MS, RESULTS_FILE, plus the
 * SMTP_* / MAIL_* variables documented in .env.example.
 */
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { collectExecutionReport } from '../src/utils/executionReport';
import { renderEmail, sendReportEmail } from '../src/utils/emailReporter';
import { redactStrict } from '../src/utils/mask';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const OUT_DIR = path.resolve(process.cwd(), 'artifacts', 'email-report');
const log = (message: string) => console.log(`[email-report] ${redactStrict(message)}`);

async function main(): Promise<void> {
  const buildStartMs = Number(process.env.BUILD_START_MS);
  const report = collectExecutionReport({
    resultsFile: process.env.RESULTS_FILE || undefined,
    buildStartMs: Number.isFinite(buildStartMs) && buildStartMs > 0 ? buildStartMs : undefined,
    pipelineResult: process.env.PIPELINE_RESULT,
  });
  log(
    `status=${report.status} tests=${report.tests.length} consoleErrors=${report.consoleErrors.length} ` +
      `pageErrors=${report.pageErrors.length} failedRequests=${report.failedRequests.length}` +
      (report.resultsNote ? ` note="${report.resultsNote}"` : ''),
  );

  const email = renderEmail(report);
  if (email.attachments.length) log(`failure screenshots embedded: ${email.attachments.length}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'execution-report.json'), redactStrict(JSON.stringify(report, null, 2)), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'email.html'), email.html, 'utf8');
  log(`report written to ${OUT_DIR}`);

  const outcome = await sendReportEmail(email);
  if (outcome.sent) {
    log(
      `Email report sent: "${email.subject}" - SMTP accepted ${outcome.accepted}/${outcome.recipients} ` +
        `recipient(s), rejected ${outcome.rejected}; server said: ${outcome.serverResponse}`,
    );
  } else if (outcome.skipped) log(`Email not sent: ${outcome.reason}`);
  else log(`Email reporting failed: ${outcome.reason}`);
}

main()
  .catch((error) => log(`Email reporting failed: ${(error as Error)?.message ?? String(error)}`))
  .finally(() => process.exit(0));
