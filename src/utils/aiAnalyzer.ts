import { redactStrict } from './mask';
import type { ExecutionReport } from './executionReport';

/**
 * Evidence-based failure analysis via the Ollama Cloud chat API
 * (POST {OLLAMA_BASE_URL}/api/chat, Bearer OLLAMA_API_KEY).
 * Never throws: any failure becomes `{ available: false, reason }`.
 */

export const ISSUE_CATEGORIES = [
  'APPLICATION',
  'AUTOMATION',
  'NETWORK',
  'ENVIRONMENT',
  'AUTHENTICATION',
  'THIRD_PARTY',
  'UNKNOWN',
  'NONE',
] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export interface AiAnalysis {
  status: string;
  summary: string;
  failedTest: string;
  failedStep: string;
  error: string;
  category: IssueCategory;
  likelyCause: string;
  recommendation: string;
  warnings: string[];
}

export type AiResult =
  | { available: true; model: string; analysis: AiAnalysis }
  | { available: false; reason: string };

export interface OllamaConfig {
  apiKey?: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

export function ollamaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OllamaConfig {
  const timeout = Number(env.OLLAMA_TIMEOUT_MS);
  return {
    apiKey: env.OLLAMA_API_KEY?.trim() || undefined,
    model: env.OLLAMA_MODEL?.trim() || 'gpt-oss:120b',
    baseUrl: (env.OLLAMA_BASE_URL?.trim() || 'https://ollama.com').replace(/\/+$/, '').replace(/\/api$/, ''),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000,
  };
}

export const SYSTEM_PROMPT = `You are a QA automation failure-analysis assistant.

Analyze the supplied Playwright/Jenkins execution evidence.

Use ONLY the supplied evidence.
Do not invent causes, errors, application behavior, or missing information.

Determine:

1. Overall status
2. Failed test, if any
3. Failed step, if any
4. What happened
5. Important error message
6. Issue category
7. Likely cause only if supported by evidence
8. Recommended investigation/action

Possible categories:

APPLICATION
AUTOMATION
NETWORK
ENVIRONMENT
AUTHENTICATION
THIRD_PARTY
UNKNOWN
NONE

If everything passed, summarize the successful execution and mention important warnings.

If the evidence is insufficient to determine the root cause, say:

"Insufficient evidence from the available logs to determine the root cause."

Return JSON only:

{
  "status": "PASSED",
  "summary": "",
  "failedTest": "",
  "failedStep": "",
  "error": "",
  "category": "NONE",
  "likelyCause": "",
  "recommendation": "",
  "warnings": []
}`;

const MAX_EVIDENCE_CHARS = 12_000;

/** The subset of the report worth sending, capped and redacted. */
export function buildEvidence(report: ExecutionReport): string {
  const build = (maxItems: number) =>
    JSON.stringify(
      {
        overallStatus: report.status,
        pipelineResult: report.pipelineResult,
        resultsAvailable: report.resultsAvailable,
        resultsNote: report.resultsNote,
        tests: report.tests,
        run: report.run,
        applicationErrors: report.applicationErrors.slice(0, maxItems),
        consoleErrors: report.consoleErrors.slice(0, maxItems),
        consoleWarnings: report.consoleWarnings.slice(0, maxItems),
        pageErrors: report.pageErrors.slice(0, maxItems),
        failedRequests: report.failedRequests.slice(0, maxItems),
        testLogTail: report.stdoutTail.slice(-maxItems),
      },
      null,
      1,
    );

  let evidence = build(20);
  if (evidence.length > MAX_EVIDENCE_CHARS) evidence = build(6);
  evidence = redactStrict(evidence);
  return evidence.length > MAX_EVIDENCE_CHARS ? `${evidence.slice(0, MAX_EVIDENCE_CHARS)}\n...[truncated]` : evidence;
}

const text = (value: unknown, max = 1000) => (typeof value === 'string' ? redactStrict(value.trim()).slice(0, max) : '');

/** Returns null for anything that is not a usable analysis object. */
export function parseAiResponse(raw: string): AiAnalysis | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const obj = parsed as Record<string, unknown>;
  const summary = text(obj.summary);
  if (!summary) return null;

  const category = text(obj.category, 40).toUpperCase() as IssueCategory;
  return {
    status: text(obj.status, 20).toUpperCase(),
    summary,
    failedTest: text(obj.failedTest),
    failedStep: text(obj.failedStep),
    error: text(obj.error),
    category: ISSUE_CATEGORIES.includes(category) ? category : 'UNKNOWN',
    likelyCause: text(obj.likelyCause),
    recommendation: text(obj.recommendation),
    warnings: Array.isArray(obj.warnings) ? obj.warnings.map((w) => text(w, 300)).filter(Boolean).slice(0, 10) : [],
  };
}

const MAX_ATTEMPTS = 2;

export async function analyzeWithOllama(
  report: ExecutionReport,
  config: OllamaConfig = ollamaConfigFromEnv(),
): Promise<AiResult> {
  if (!config.apiKey) return { available: false, reason: 'OLLAMA_API_KEY is not configured.' };

  const body = JSON.stringify({
    model: config.model,
    stream: false,
    format: 'json',
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildEvidence(report) },
    ],
  });

  let reason = 'Ollama Cloud request failed.';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${config.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { available: false, reason: `Ollama Cloud request timed out after ${config.timeoutMs}ms.` };
      }
      reason = `Ollama Cloud request failed: ${text((error as Error)?.message, 200) || 'network error'}.`;
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }

    if (!response.ok) {
      reason = `Ollama Cloud request failed: HTTP ${response.status}.`;
      const transient = response.status === 429 || response.status >= 500;
      if (transient && attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      return { available: false, reason };
    }

    let content = '';
    try {
      const payload = (await response.json()) as { message?: { content?: unknown } };
      content = typeof payload?.message?.content === 'string' ? payload.message.content : '';
    } catch (error) {
      const timedOut = ['TimeoutError', 'AbortError'].includes((error as Error)?.name);
      return {
        available: false,
        reason: timedOut
          ? `Ollama Cloud request timed out after ${config.timeoutMs}ms.`
          : 'AI Analysis unavailable due to invalid AI response.',
      };
    }

    const analysis = parseAiResponse(content);
    return analysis
      ? { available: true, model: config.model, analysis }
      : { available: false, reason: 'AI Analysis unavailable due to invalid AI response.' };
  }

  return { available: false, reason };
}
