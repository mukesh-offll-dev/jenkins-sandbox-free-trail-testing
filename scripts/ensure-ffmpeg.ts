/**
 * Ensure Playwright's ffmpeg binary is present, with a curl fallback.
 *
 * WHY THIS EXISTS (verified on this network)
 * -----------------------------------------
 * `npx playwright install ffmpeg` times out on the Windows agent:
 *     Error: Failed to download FFmpeg (playwright ffmpeg v1011)
 *     ... at TLSSocket.emitRequestTimeout
 * even with PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=120000. Fetching the exact
 * same archive with curl.exe completed in 0.35s. The CDN is fast; Playwright's
 * own Node downloader is what fails here. So we try the official installer
 * first and fall back to curl.exe, which is built into Windows 10+.
 *
 * Nothing about the ffmpeg revision or URL is hardcoded blindly: the revision
 * comes from the installed playwright-core's browsers.json, and the URL layout
 * is verified against that same installed copy before any download. If a future
 * Playwright upgrade changes either, this fails loudly instead of fetching a
 * mismatched binary.
 *
 * Only relevant when video recording is on; the pipeline skips this entirely
 * when RECORD_VIDEO=false.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Playwright's own marker filename, confirmed against playwright-core. */
const MARKER = 'INSTALLATION_COMPLETE';
const ZIP_NAME = 'ffmpeg-win64.zip';
/** Verified to exist in the installed playwright-core before use (see below). */
const PATH_TEMPLATE = `builds/ffmpeg/%s/${ZIP_NAME}`;
const DEFAULT_HOST = 'https://cdn.playwright.dev/dbazure/download/playwright';

const INSTALL_TIMEOUT_MS = 90_000;
const CURL_TIMEOUT_S = 120;

function log(message: string): void {
  console.log(`[ensure-ffmpeg] ${message}`);
}

function coreDir(): string {
  return path.dirname(require.resolve('playwright-core/package.json'));
}

/** The ffmpeg revision the INSTALLED Playwright expects - never hardcoded. */
function requiredRevision(dir: string): string {
  const raw = fs.readFileSync(path.join(dir, 'browsers.json'), 'utf8');
  const entry = (JSON.parse(raw).browsers as Array<{ name: string; revision: string }>).find(
    (b) => b.name === 'ffmpeg',
  );
  if (!entry?.revision) {
    throw new Error('Could not read the ffmpeg revision from playwright-core/browsers.json.');
  }
  return entry.revision;
}

/**
 * Confirm the installed Playwright still uses the URL layout we build below.
 * Guards requirement: never download from a hardcoded URL that the installed
 * version has moved away from.
 */
function assertUrlLayoutSupported(dir: string): void {
  const bundle = fs.readFileSync(path.join(dir, 'lib', 'coreBundle.js'), 'utf8');
  if (!bundle.includes(PATH_TEMPLATE)) {
    throw new Error(
      `This Playwright build no longer uses the expected download layout "${PATH_TEMPLATE}".\n` +
        `Refusing to guess a URL. Update PATH_TEMPLATE in scripts/ensure-ffmpeg.ts to match ` +
        `node_modules/playwright-core/lib/coreBundle.js.`,
    );
  }
}

function browsersRoot(): string {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (configured) return configured;
  // Playwright's Windows default cache location.
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) throw new Error('Set PLAYWRIGHT_BROWSERS_PATH: LOCALAPPDATA is not defined.');
  return path.join(localAppData, 'ms-playwright');
}

/**
 * Run the executable and confirm it reports the revision Playwright expects.
 * This is also the service-account execute-permission check: if the account
 * cannot execute the file, spawnSync fails here.
 */
function executableReportsRevision(exe: string, revision: string): boolean {
  const result = spawnSync(exe, ['-version'], { encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) {
    log(`executable check failed: ${result.error?.message ?? `exit ${result.status}`}`);
    return false;
  }
  const firstLine = (result.stdout || '').split('\n')[0]?.trim() ?? '';
  log(`ffmpeg reports: ${firstLine}`);
  // Playwright's builds embed the revision, e.g. "n7.0.1-playwright-build-1011".
  if (!firstLine.includes(`playwright-build-${revision}`)) {
    log(`WARNING: expected playwright-build-${revision} in the version string.`);
    return false;
  }
  return true;
}

function isFullyInstalled(dir: string, exe: string, revision: string): boolean {
  if (!fs.existsSync(exe)) return false;
  if (!fs.existsSync(path.join(dir, MARKER))) {
    log('executable present but the installation marker is missing - treating as incomplete.');
    return false;
  }
  return executableReportsRevision(exe, revision);
}

/** Official installer, bounded so a hanging download cannot stall the build. */
function tryPlaywrightInstall(): boolean {
  log(`attempting "npx playwright install ffmpeg" (timeout ${INSTALL_TIMEOUT_MS / 1000}s)...`);
  const result = spawnSync('npx', ['playwright', 'install', 'ffmpeg'], {
    stdio: 'inherit',
    shell: true,
    timeout: INSTALL_TIMEOUT_MS,
  });
  if (result.status === 0) {
    log('official installer succeeded.');
    return true;
  }
  const why = result.error?.message ?? `exit code ${result.status}`;
  log(`official installer did not succeed (${why}) - falling back to curl.exe.`);
  return false;
}

function curlDownload(url: string, destination: string): void {
  log(`downloading via curl.exe: ${url}`);
  const result = spawnSync(
    'curl.exe',
    ['-L', '--fail', '--silent', '--show-error', '--max-time', String(CURL_TIMEOUT_S), '-o', destination, url],
    { encoding: 'utf8', timeout: (CURL_TIMEOUT_S + 30) * 1000 },
  );
  if (result.status !== 0) {
    throw new Error(`curl.exe failed: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`);
  }
  const bytes = fs.statSync(destination).size;
  if (bytes < 100_000) {
    throw new Error(`Downloaded archive is only ${bytes} bytes - it is not a valid ffmpeg build.`);
  }
  log(`downloaded ${bytes} bytes.`);
}

function extractZip(zip: string, destination: string): void {
  log(`extracting into ${destination}`);
  fs.mkdirSync(destination, { recursive: true });
  // Escape single quotes for the PowerShell string literals.
  const ps = (value: string) => value.replace(/'/g, "''");
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${ps(zip)}' -DestinationPath '${ps(destination)}' -Force`,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Expand-Archive failed: ${result.stderr?.trim() || `exit ${result.status}`}`);
  }
}

function main(): void {
  if (os.platform() !== 'win32') {
    throw new Error(`This helper targets the Windows agent; current platform is ${os.platform()}.`);
  }

  const dir = coreDir();
  const revision = requiredRevision(dir);
  const root = browsersRoot();
  const installDir = path.join(root, `ffmpeg-${revision}`);
  const exe = path.join(installDir, 'ffmpeg-win64.exe');

  log(`playwright-core requires ffmpeg revision ${revision}`);
  log(`browser cache: ${root}`);

  // Requirement: skip the download entirely when it is already installed.
  if (isFullyInstalled(installDir, exe, revision)) {
    log('already installed and executable - nothing to do.');
    return;
  }

  assertUrlLayoutSupported(dir);

  if (!tryPlaywrightInstall() || !fs.existsSync(exe)) {
    const host = (process.env.PLAYWRIGHT_DOWNLOAD_HOST?.trim() || DEFAULT_HOST).replace(/\/+$/, '');
    const url = `${host}/${PATH_TEMPLATE.replace('%s', revision)}`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ffmpeg-'));
    const zip = path.join(tmp, ZIP_NAME);
    try {
      curlDownload(url, zip);
      extractZip(zip, installDir);
    } finally {
      // Requirement: temporary files are always cleaned up.
      fs.rmSync(tmp, { recursive: true, force: true });
      log('temporary download removed.');
    }
  }

  if (!fs.existsSync(exe)) {
    throw new Error(`ffmpeg was not produced at ${exe}.`);
  }
  // Requirement: validate BEFORE writing the marker, so a partial install is
  // never recorded as complete and the next run retries cleanly.
  if (!executableReportsRevision(exe, revision)) {
    throw new Error(
      `ffmpeg at ${exe} did not validate. The Jenkins service account may lack execute ` +
        `permission on that path, or the archive was corrupt.`,
    );
  }
  fs.writeFileSync(path.join(installDir, MARKER), '');
  log(`installed and validated: ${exe}`);
}

try {
  main();
  log('PASSED');
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[ensure-ffmpeg] FAILED\n${message}`);
  console.error(
    '\nTo proceed without video recording, re-run this job with RECORD_VIDEO unchecked -\n' +
      'no ffmpeg download is attempted in that mode.',
  );
  process.exit(1);
}
