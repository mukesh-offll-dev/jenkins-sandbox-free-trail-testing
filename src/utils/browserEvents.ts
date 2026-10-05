import type { BrowserContext, TestInfo } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { redactedJson } from './mask';

/**
 * Passive browser-event capture for the post-run execution report.
 * Listeners only observe: they never wait on, block or alter the test.
 */

const MAX_PER_KIND = 50;
const MAX_TEXT = 300;

export const BROWSER_EVENTS_ATTACHMENT = 'browser-events';

export interface BrowserEvents {
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  failedRequests: string[];
}

// Query strings can carry tokens; the origin + path is enough to diagnose.
function urlWithoutQuery(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split('?')[0];
  }
}

export function captureBrowserEvents(context: BrowserContext): BrowserEvents {
  const events: BrowserEvents = { consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [] };
  const push = (list: string[], text: string) => {
    if (list.length < MAX_PER_KIND) list.push(text.slice(0, MAX_TEXT));
  };

  context.on('console', (msg) => {
    if (msg.type() === 'error') push(events.consoleErrors, msg.text());
    else if (msg.type() === 'warning') push(events.consoleWarnings, msg.text());
  });
  context.on('weberror', (webError) => push(events.pageErrors, webError.error().message));
  context.on('requestfailed', (request) =>
    push(
      events.failedRequests,
      `${request.method()} ${urlWithoutQuery(request.url())} - ${request.failure()?.errorText ?? 'request failed'}`,
    ),
  );
  context.on('response', (response) => {
    if (response.status() >= 400) {
      push(
        events.failedRequests,
        `${response.request().method()} ${urlWithoutQuery(response.url())} - HTTP ${response.status()}`,
      );
    }
  });

  return events;
}

export async function attachBrowserEvents(testInfo: TestInfo, events: BrowserEvents): Promise<void> {
  const file = testInfo.outputPath(`${BROWSER_EVENTS_ATTACHMENT}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, redactedJson(events), 'utf8');
  await testInfo.attach(BROWSER_EVENTS_ATTACHMENT, { path: file, contentType: 'application/json' });
}
