# Thinkster Sandbox — Free-Trial Registration Automation

End-to-end Playwright (TypeScript, Page Object Model) automation for the **complete**
Thinkster sandbox free-trial registration journey, plus a Windows Jenkins pipeline that
runs it on a schedule.

The test drives the real application UI from the marketing homepage all the way to the
Elevate student-selection page — 17 screens including SMS OTP verification, live calendar
booking and a sandbox hosted-checkout payment.

> **Sandbox only.** The suite refuses to start unless the configured hosts look like
> sandbox hosts (`src/utils/env.ts → assertSandboxOnly`), and it verifies the hosted
> checkout is served by `cde.openpaystaging.com` *before* typing any card data.

## Verified outcome

```
✓ 1 [chromium] › tests\registration.spec.ts › registers a new parent and student
    and reaches the student selection page (1.4m)
  1 passed
```

Final state asserted on every run:

| # | Assertion | Verified |
|---|---|---|
| 1 | URL is `https://elevate-sandbox.hellothinkster.com/students` | ✅ |
| 2 | Heading "Who's Ready to Learn Today?" visible | ✅ |
| 3 | New student's profile displayed (`Mukesh Automation`) | ✅ |
| 4 | Student status is **In Trial** | ✅ |
| 5 | **Select** button visible *and* enabled | ✅ |
| 6 | No unexpected application error displayed | ✅ |

`WORKFLOW.md` documents every screen, the verified locators, the payment iframe topology
and three genuine application defects found along the way.

## Project layout

```
thinkster-qa-automation/
├─ playwright.config.ts          one worker, serial, HTML+JUnit+JSON reporters
├─ Jenkinsfile                   Windows declarative pipeline (default: every 2 hours)
├─ WORKFLOW.md                   verified workflow + locator reference
├─ .env.example                  environment template
├─ scripts/
│  └─ generate-test-data.ts      CI pre-flight: prints/records the unique email
├─ src/
│  ├─ pages/
│  │  ├─ BasePage.ts                 shared widget helpers + error-visibility rules
│  │  ├─ HomePage.ts                 homepage / email capture (+ reCAPTCHA handling)
│  │  ├─ StudentRegistrationPage.ts  child name, grade sliders, qualifying questions
│  │  ├─ ParentRegistrationPage.ts   parent details, country code, consent, password
│  │  ├─ OtpVerificationPage.ts      SMS OTP (auto-submit aware)
│  │  ├─ SchedulingPage.ts           timezone, real availability, hold + confirm
│  │  ├─ SandboxPaymentPage.ts       gift, plan, nested-iframe hosted checkout
│  │  └─ StudentSelectionPage.ts     final assertions on the Elevate app
│  └─ utils/
│     ├─ email.ts                unique parent email (DDMMHHmmSS, Asia/Kolkata)
│     ├─ testData.ts             test-data management
│     ├─ env.ts                  configuration, secrets, sandbox-only guard
│     ├─ mask.ts                 secret redaction for logs and artifacts
│     └─ runReport.ts            run-specific, non-sensitive metadata JSON
└─ tests/
   └─ registration.spec.ts       the complete journey, one browser context
```

## Install

```powershell
npm ci
npx playwright install chromium
Copy-Item .env.example .env
```

### If the Playwright CDN is blocked

`npx playwright install chromium` can fail on restricted networks
(`Download failure` / TLS timeout). You can drive an already-installed browser instead:

```powershell
# in .env
BROWSER_CHANNEL=chrome     # or msedge
VIDEO=off                  # video needs Playwright's ffmpeg binary
```

Leave both unset in CI to use bundled Chromium and record video on failure.

## Run locally

```powershell
npm test                    # the full journey, headless
npm run test:headed         # watch it happen
npm run test:ui             # Playwright UI mode
npm run test:debug          # step through with the inspector
npm run typecheck           # TypeScript only
npm run generate:test-data  # preview this run's unique email (no secrets)
npm run clean               # remove reports/artifacts
```

Each execution registers a **brand-new parent**:
`mukesh<DDMMHHmmSS>@tabtortest.com`, stamped in **Asia/Kolkata**
(e.g. `mukesh2809120423@tabtortest.com`). In CI a `b<BUILD>e<EXECUTOR>` suffix is appended
so concurrent agents can never collide. An email is never reused.

## Reports, evidence and debugging

| Artifact | Location |
|---|---|
| Playwright HTML report | `playwright-report/index.html` (`npm run report`) |
| JUnit XML (Jenkins) | `test-results/junit/results.xml` |
| JSON results | `test-results/json/results.json` |
| Success screenshot | `artifacts/evidence/students-page-<runId>.png` |
| Failure screenshots (all tabs) | `artifacts/evidence/failure-<runId>-p<n>.png` |
| Run metadata (redacted) | `artifacts/run-metadata/run-<runId>.json` |
| Trace (on first retry) | `test-results/**/trace.zip` |
| Video (on failure) | `test-results/**/*.webm` |

Debugging a failure:

```powershell
npm run report                                  # open the HTML report
npx playwright show-trace test-results\<...>\trace.zip
npx playwright test --headed --debug            # reproduce interactively
```

The run metadata records the exact appointment booked, the payment host, the masked card
and every workflow step with timestamps — enough to reconstruct any run.

### Secret hygiene

Password, OTP, CVC and the full card number never reach a log or an artifact.
`src/utils/mask.ts` redacts them (plus the Elevate **SSO token** in the hand-off URL)
from anything written out. Verified:

```
run-2809120423.json:  ".../sso/mukesh...%40tabtortest.com/***SSO_TOKEN***"
run-2809120423.json:  "cardMasked": "**** **** **** 1111"
run-2809120423.json:  "phoneMasked": "***-***-4336"
grep for 12345678 / 123123 / 4111111111111111  ->  no matches
```

## Push to GitHub

```powershell
git init
git add .
git commit -m "Thinkster sandbox registration automation"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

`.gitignore` already excludes `.env`, `node_modules/`, reports and artifacts.
**Never commit `.env`.**

## Jenkins pipeline (Windows)

Verified target: Jenkins **2.568.3** at `http://localhost:8080`.

### 1. Create the credentials

*Manage Jenkins → Credentials → System → Global → Add Credentials*, kind
**Secret text**, for each:

| Credential ID | Value |
|---|---|
| `thinkster-sandbox-parent-password` | `12345678` |
| `thinkster-sandbox-otp` | `123123` |
| `thinkster-sandbox-card-number` | `4111111111111111` |
| `thinkster-sandbox-card-expiry` | `12/30` |
| `thinkster-sandbox-card-cvc` | `123` |

Jenkins masks these in the console output automatically.

### 2. Create the job

*New Item → Pipeline* → name it e.g. `thinkster-sandbox-registration`:

- **Pipeline → Definition:** *Pipeline script from SCM*
- **SCM:** Git, your repository URL, branch `*/main`
- **Script Path:** `Jenkinsfile`
- Save. The `Jenkinsfile` supplies the trigger, timeout and concurrency settings itself,
  so no other job or global configuration needs to change.

Run once manually ("Build Now") so Jenkins registers the cron trigger.

### 3. What the pipeline does

`Checkout → Tooling versions → npm ci → playwright install chromium →
generate unique test data → typecheck → run registration test → publish + archive`

- `disableConcurrentBuilds()` — registrations can never overlap
- `timeout(45, MINUTES)` — pipeline ceiling
- `junit` — test trend reporting; `archiveArtifacts` — HTML report, evidence, metadata,
  traces and videos
- Failure status is preserved: reporting happens in `post { always }`, so a failed test
  still publishes artifacts **and** still fails the build
- Parameters: `GIT_BRANCH`, `APPOINTMENT_TIMEZONE`, `RECORD_VIDEO`

### 4. Change the schedule

One line at the top of the `Jenkinsfile`:

```groovy
def SCHEDULE_CRON = 'H */2 * * *'   // default: every 2 hours
```

| Interval | Value |
|---|---|
| hourly | `'H * * * *'` |
| every 2 hours | `'H */2 * * *'` |
| every 3 hours | `'H */3 * * *'` |
| every 4 hours | `'H */4 * * *'` |
| every 6 hours | `'H */6 * * *'` |

The leading `H` spreads builds across the hour instead of firing them all on the minute.

## Known application behaviour you will hit

`POST /api/register/lead` is protected by invisible **reCAPTCHA v3** (site key
`6Lc4XnYsAAAAAODq0svz1csIi7-fUCynO2pTOsP5`), and the widget submits it without waiting for
its own token. Two failure modes show the same red banner
*"Something went wrong. Please check your email and try again."* (`div.tw-inline-msg`,
injected between `#twEmailFld` and `#twCtaLanding`):

| Status | Meaning | Handling |
|---|---|---|
| `400 reCAPTCHA token is required` | Submitted before the lazily-loaded token existed | `HomePage.waitForRecaptchaReady()` waits for the reCAPTCHA anchor iframe (attaches ~0.8 s after the email field is filled) |
| `403 reCAPTCHA verification failed` | Google scored the session as automated | Up to 5 attempts with progressive backoff, taking the app's own "try again" path |

`playwright.config.ts` also launches with `--disable-blink-features=AutomationControlled`
and drops `--enable-automation`, because a default Playwright launch is reliably scored as
a bot. Real evidence from run `2809125415`, which **passed** on the 5th attempt:

```
attempt 1: banner shown
attempt 2: HTTP 403 {"error":"reCAPTCHA verification failed. Please try again."} | banner shown
attempt 3: HTTP 403 ... | banner shown
attempt 4: HTTP 403 ... | banner shown
attempt 5: success -> full journey completed, all 6 final assertions passed
```

### ⚠️ This is the suite's one real limitation

reCAPTCHA scoring **degrades with repeated registrations from the same machine/IP**. After
roughly 20 runs in two hours, every attempt began returning 403 and the suite could no
longer get past step 1 — while a long-lived human browser profile on the *same machine and
IP, at the same moment*, still received `201 Lead captured successfully`.

That is rate-limiting working as designed, and it is an **external blocker**: no amount of
test code reliably defeats bot scoring, and trying to is the wrong engineering answer.

**The correct fix is server-side** — ask for one of these on the sandbox environment:

1. Google's **test reCAPTCHA keys** (`6LeIxAcTAAAA...`), which always verify, or
2. reCAPTCHA disabled entirely on `*-sandbox` hosts, or
3. an allowlisted automation header/secret that skips the reCAPTCHA check.

Any of those makes the suite deterministic. Until then:

- run it **sparingly** (the 2-hour Jenkins schedule is comfortably within tolerance)
- `retries: 1` in CI gives each build a second chance
- `PERSISTENT_PROFILE=on` reuses an on-disk Chromium profile, which can help once that
  profile has accumulated reputation (off by default; it replaces Playwright's native
  artifact wiring with the equivalent logic in `tests/fixtures.ts`)

Reproduce the bug manually: open the homepage with DevTools → Network, **paste** an email
and click the CTA within ~1–2 seconds. Typing it slowly (3–4 s) succeeds with
`201 Lead captured successfully`. Screenshots of the defect are in
`artifacts/evidence/recaptcha-bug-*.png`.

## Design notes

- **One browser context** for the whole journey; the final hand-off popup is captured with
  `context.waitForEvent('page')` and stays in the same context.
- **No arbitrary waits for state** — Playwright auto-waiting and retrying assertions
  throughout. The only fixed delays are a deliberate reCAPTCHA settle and the payment
  outcome poll, both documented in code.
- **Serial by design:** `workers: 1`, `fullyParallel: false`, plus
  `disableConcurrentBuilds()` in CI.
- **Nothing is hardcoded that the app controls:** the appointment is chosen from live
  `.dchip[data-ghl-date]` / `.tslot[data-ghl-slot]` availability (preferring a future
  date), and the ISO times are read back from the DOM.
- **Assertions are never weakened to get green.** Two failures during development were
  traced to over-broad assertions of mine (an always-present hidden `.err` node and
  Next.js's `role="alert"` route announcer) and were made *more precise*, with the reason
  documented in code. The reCAPTCHA retry targets a real application race, and still fails
  loudly with the real API error if the lead is never captured.
