import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { redactStrict } from './mask';
import { BROWSER_EVENTS_ATTACHMENT, type BrowserEvents } from './browserEvents';
import type { RunMetadata } from './runReport';

/**
 * One normalized view of a Jenkins/Playwright execution, built from the
 * artifacts the suite already writes (Playwright JSON results, the run-metadata
 * attachment and the browser-events attachment). Every string is redacted.
 */

export type RunStatus = 'PASSED' | 'FAILED';

export interface TestOutcome {
  file: string;
  title: string;
  status: string;
  durationMs: number;
  failedStep?: string;
  error?: string;
  /** PNG screenshots Playwright/the spec attached to a test that did not pass. */
  screenshots: string[];
}

export interface ExecutionReport {
  status: RunStatus;
  timestamp: string;
  timestampIst: string;
  pipelineResult?: string;
  jenkins: { jobName?: string; buildNumber?: string; buildId?: string; buildUrl?: string; nodeName?: string };
  git: { branch?: string; commit?: string };
  resultsAvailable: boolean;
  resultsNote?: string;
  tests: TestOutcome[];
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  failedRequests: string[];
  applicationErrors: string[];
  run?: {
    runId: string;
    status: string;
    durationMs?: number;
    /** Steps recorded by the spec, in order (registration.spec.ts report.step names). */
    completedSteps: Array<{ name: string; detail?: string }>;
    activationArm?: string;
    widgetVariant?: string;
    appointment?: string;
    warnings: string[];
    finalUrl?: string;
    failure?: string;
  };
}

export const DEFAULT_RESULTS_FILE = path.resolve(process.cwd(), 'test-results', 'json', 'results.json');

const MAX_ERROR_CHARS = 1500;

// Minimal shape of Playwright's JSON reporter output that this module reads.
interface JsonStep { title: string; error?: unknown; steps?: JsonStep[] }
interface JsonAttachment { name: string; path?: string; contentType?: string }
interface JsonResult {
  status: string;
  duration: number;
  error?: { message?: string };
  errors?: Array<{ message?: string }>;
  steps?: JsonStep[];
  attachments?: JsonAttachment[];
}
interface JsonSpec { title: string; file: string; tests: Array<{ results: JsonResult[] }> }
interface JsonSuite { title: string; file: string; specs?: JsonSpec[]; suites?: JsonSuite[] }
interface JsonReport { stats?: { startTime?: string }; suites?: JsonSuite[]; errors?: Array<{ message?: string }> }

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');
const clean = (text: string, max = MAX_ERROR_CHARS) => redactStrict(stripAnsi(text)).trim().slice(0, max);

function readJson<T>(file: string | undefined): T | undefined {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function collectSpecs(suites: JsonSuite[] = []): JsonSpec[] {
  return suites.flatMap((suite) => [...(suite.specs ?? []), ...collectSpecs(suite.suites)]);
}

function firstFailedStep(steps: JsonStep[] = []): string | undefined {
  return steps.find((step) => step.error)?.title;
}

/** Existing PNGs attached to a failed result (Playwright's own + the spec's failure-page-N), max 3. */
function failureScreenshots(attachments: JsonAttachment[] = []): string[] {
  const files = attachments
    .filter((a) => a.path && (a.contentType === 'image/png' || a.path.toLowerCase().endsWith('.png')))
    .filter((a) => a.name !== 'final-students-page')
    .map((a) => a.path as string)
    .filter((file) => fs.existsSync(file));
  return [...new Set(files)].slice(0, 3);
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function istTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} IST`;
}

function summarizeRun(meta: RunMetadata): NonNullable<ExecutionReport['run']> {
  const steps = meta.steps ?? [];
  const appointment = meta.appointment
    ? `${meta.appointment.dateLabel} ${meta.appointment.displayTime} (${meta.appointment.timezone})`
    : undefined;
  return {
    runId: meta.runId,
    status: meta.status,
    durationMs: meta.durationMs,
    completedSteps: steps.map((s) => ({ name: s.name, detail: s.detail ? clean(s.detail, 200) : undefined })),
    activationArm: steps.find((s) => s.name === 'activation-arm-detected')?.detail,
    widgetVariant: steps.find((s) => s.name === 'widget-variant')?.detail,
    warnings: (meta.warnings ?? []).map((w) => clean(w, 500)),
    appointment,
    finalUrl: meta.finalUrl ? clean(meta.finalUrl, 300) : undefined,
    failure: meta.failure ? clean(meta.failure) : undefined,
  };
}

export interface CollectOptions {
  resultsFile?: string;
  /** Results that started before this instant belong to an earlier build. */
  buildStartMs?: number;
  /** Jenkins currentBuild.currentResult at report time (SUCCESS, FAILURE, ...). */
  pipelineResult?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export function collectExecutionReport(options: CollectOptions = {}): ExecutionReport {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const pipelineResult = options.pipelineResult?.trim() || undefined;

  const report: ExecutionReport = {
    status: 'FAILED',
    timestamp: now.toISOString(),
    timestampIst: istTimestamp(now),
    pipelineResult,
    jenkins: {
      jobName: env.JOB_NAME,
      buildNumber: env.BUILD_NUMBER,
      buildId: env.BUILD_ID,
      buildUrl: env.BUILD_URL,
      nodeName: env.NODE_NAME,
    },
    git: {
      branch: env.GIT_BRANCH || (git(['rev-parse', '--abbrev-ref', 'HEAD'])?.replace(/^HEAD$/, '') || undefined),
      commit: env.GIT_COMMIT || git(['rev-parse', 'HEAD']),
    },
    resultsAvailable: false,
    tests: [],
    consoleErrors: [],
    consoleWarnings: [],
    pageErrors: [],
    failedRequests: [],
    applicationErrors: [],
  };

  const json = readJson<JsonReport>(options.resultsFile ?? DEFAULT_RESULTS_FILE);
  const startedAt = json?.stats?.startTime ? Date.parse(json.stats.startTime) : NaN;

  if (!json) {
    report.resultsNote = 'No Playwright results were produced: the pipeline stopped before or during test execution.';
  } else if (options.buildStartMs && !(startedAt >= options.buildStartMs)) {
    report.resultsNote =
      'The only Playwright results on disk are from an earlier build, so this build stopped before the tests ran.';
  } else {
    report.resultsAvailable = true;
    const events: BrowserEvents = { consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [] };

    for (const spec of collectSpecs(json.suites)) {
      for (const test of spec.tests) {
        const result = test.results[test.results.length - 1];
        if (!result) continue;

        const message = result.error?.message ?? result.errors?.find((e) => e.message)?.message;
        const passed = result.status === 'passed' || result.status === 'skipped';
        report.tests.push({
          file: spec.file,
          title: spec.title,
          status: result.status,
          durationMs: Math.round(result.duration),
          failedStep: firstFailedStep(result.steps),
          error: message ? clean(message) : undefined,
          screenshots: passed ? [] : failureScreenshots(result.attachments),
        });

        for (const attachment of result.attachments ?? []) {
          if (attachment.name === BROWSER_EVENTS_ATTACHMENT) {
            const captured = readJson<BrowserEvents>(attachment.path);
            if (captured) {
              events.consoleErrors.push(...(captured.consoleErrors ?? []));
              events.consoleWarnings.push(...(captured.consoleWarnings ?? []));
              events.pageErrors.push(...(captured.pageErrors ?? []));
              events.failedRequests.push(...(captured.failedRequests ?? []));
            }
          } else if (attachment.name === 'run-metadata') {
            const meta = readJson<RunMetadata>(attachment.path);
            if (meta) report.run = summarizeRun(meta);
          }
        }
      }
    }

    for (const error of json.errors ?? []) {
      if (error.message) {
        report.tests.push({
          file: '(global)',
          title: 'Playwright setup',
          status: 'failed',
          durationMs: 0,
          error: clean(error.message),
          screenshots: [],
        });
      }
    }

    const unique = (list: string[]) => [...new Set(list.map((item) => clean(item, 300)))];
    report.consoleErrors = unique(events.consoleErrors);
    report.consoleWarnings = unique(events.consoleWarnings);
    report.pageErrors = unique(events.pageErrors);
    report.failedRequests = unique(events.failedRequests);

    // The registration spec appends visible widget errors to its failure detail.
    const appErrors = report.run?.failure?.split('| visible app errors:')[1];
    if (appErrors) report.applicationErrors = appErrors.split(' / ').map((e) => e.trim()).filter(Boolean);

    if (report.tests.length === 0) report.resultsNote = 'Playwright produced a results file but it contains no tests.';
  }

  const testsPassed =
    report.tests.length > 0 && report.tests.every((t) => t.status === 'passed' || t.status === 'skipped');
  const pipelineOk = !pipelineResult || pipelineResult === 'SUCCESS';
  report.status = report.resultsAvailable && testsPassed && pipelineOk ? 'PASSED' : 'FAILED';

  return report;
}
