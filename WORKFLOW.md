# Verified Registration Workflow & Locator Reference

Everything below was observed on the **live sandbox** (`sandbox.hellothinkster.com`,
trial widget **v1.0.11**) on 28 Sep 2026 using Playwright + browser DOM inspection.
No locator in this document was guessed.

## Structural facts that shape the whole suite

| Fact | Consequence for automation |
|---|---|
| The entire 13-screen journey runs inside **one in-page widget** rooted at `#trial`. The browser URL stays `https://sandbox.hellothinkster.com/` until the very end. | Screens cannot be identified by URL. They are identified by their stable CTA ids (`#twCta*`) and the widget's step label (e.g. `GET STARTED · 4 OF 8`). |
| The app exposes **no `data-testid` attributes** anywhere. | Locators use stable element **ids**, ARIA roles/labels, and semantic classes. |
| Validation errors (`.err`) are **permanently in the DOM** with `display:none`. | Error assertions must use **visibility**, never text presence. Asserting on text produced a false failure. |
| There are **two** error surfaces: `div.tw-inline-msg` (screen-level banner, e.g. the reCAPTCHA failure) and `.err` (per-field validation). | Error detection must watch **both**. Watching only `.err` made a 403 look like a silent failure. |
| `#trial` carries an A/B class (`widget-experiment-a` / `-b`). | Assertions target text/ids common to both variants. |
| The final CTA opens the Elevate app in a **new tab**. | Requires `context.waitForEvent('page')`, not a navigation wait. |

## Step-by-step

### Phase A — `GET STARTED · 1..8 OF 8`

| # | Screen | Key locators | Notes |
|---|---|---|---|
| 1 | Trial signup | `#twEmailFld` (email), `#twCtaLanding` | CTA **disabled** until the address is valid. `POST /api/register/lead`. |
| 2 | "You just did the hard part." | `#twCtaCongrats`, `#twSkipVid` | Post-lead confirmation. |
| 3 | "How many children…" | `#twCountRow .countbtn` (`.sel` = chosen), `#twCtaCount` | Plain `div`s, not buttons. "1 child" is the default. |
| 4 | Child name + school grade | `#twNameFld`, `#hSchool` (handle, shows `?`), `#trial .sp-tlab` (labels `K,1..8,AL1,GEM,AL2`), `#twCtaNameGrade` | The "slider" accepts a **click on a tick label** — no drag needed. CTA needs both name and grade. |
| 5 | Working grade | `#hWork`, `#trial .sp-tlab`, `#twCtaWorkGrade`, `#twEditSchoolGrade` | Same slider pattern. |
| 6 | Question 1 | `#trial .opt`, `#twCtaQ1` | Radio-style cards. |
| 7 | Question 2 | `#trial .opt`, `#twCtaQ2` | |
| 8 | Confidence roadmap | `#twCtaRoadmap`, `#twEditBtn`, `#twReplayBtn` | Animated; auto-waiting covers it. |

### Phase B — `YOUR DETAILS · 1..3 OF 3`

| # | Screen | Key locators | Notes |
|---|---|---|---|
| 9 | Free e-books | `#twCtaEbooks` | |
| 10 | "Share your details" | `#twFname`, `#twLname`, `#twPphone`, `#twCcBtn` / `#twCcSearch` / `.cc-row(.sel)`, `#twSmsConsent`, `#twPw`, `#twCtaAbout` | Country defaults to **United States / +1** (matches the required data). `#twSmsConsent` is the **only** consent checkbox and is required for SMS. Password min 8 (counter reads `n/8 characters`). |
| 11 | OTP | `getByLabel('Digit 1')…`, `#twCtaOtp`, `#twResendBtn`, `#twChangeNumBtn` | See the critical note below. |

#### Phone-number validation — resolved, not worked around
`fill()`-ing `(908) 020-4336` renders the text *"⚠ Enter a valid 10-digit mobile number."*
in the DOM. Investigation showed that node is `display:none` — it is present even for a
known-good control number. **The supplied number is accepted.** The field auto-formats
digits to `(908) 020-4336`; the suite types digits sequentially so the input mask runs.

#### CRITICAL: the OTP screen auto-submits
Entering the 6th digit makes the widget fire `POST /api/sms/verify-code` **and**
`POST /api/register/parent` on its own, while `#twCtaOtp` is still `disabled`.

Clicking `#twCtaOtp` afterwards triggers a **second** round trip. Observed live: the API
replied `"Parent already exists"` and the widget **reset to `GET STARTED · 3 OF 8`**,
destroying the run. The suite therefore types the code and waits for the OTP inputs to
unmount — it never clicks that CTA.

### Phase C — `YOUR SESSION · 1..2 OF 2`

| # | Screen | Key locators | Notes |
|---|---|---|---|
| 12 | Pick your free session | `#twSessTzSel` (56 timezones), `#trial .dchip[data-ghl-date="YYYY-MM-DD"]` (`.on` selected, `.none` unavailable), `#twMoreDates` (3 → 7 days), `#trial .tslot[data-ghl-slot]` (`.on` selected), `#twCtaASess`, `#twSkipASess` | Availability comes from `GET /api/calendar/free-slots`. `data-ghl-slot` is JSON: `{startTime,endTime,displayTime}` — the suite reads the real ISO times from it. Changing the timezone re-fetches slots. |
| 13 | Spot held | `#twCtaSpotHeld` | 10-minute countdown. Restates the booking, e.g. *"Your session spot is held / Tuesday, September 29 / 2:00 PM · 45 min · 1:1"* — the suite verifies this before continuing. |

### Phase D — `ACTIVATE TRIAL · 1..3 OF 3`

| # | Screen | Key locators | Notes |
|---|---|---|---|
| 14 | $25 gift offer | `#twCtaGift` | |
| 15 | Plan | `#twCtaAActivate`, `#twFootOpts` | Default "Ignite · 2×/week", `$0 due today`. |
| 16 | Hosted checkout | `#twHostedCheckoutFrame` | **Nested iframes** — see below. |
| 17 | Trial activated | `#twCtaAThanks` | Shows `✓ $0 charged today`. Opens a **new tab**. |

#### Payment iframe topology (verified)
```
iframe#twHostedCheckoutFrame  ->  https://cde.openpaystaging.com/pay/<uuid>   (sandbox)
  ├─ input[autocomplete="email"]        (pre-filled from registration, disabled)
  ├─ input[autocomplete="given-name"] / input[autocomplete="family-name"]
  ├─ input[autocomplete="postal-code"]
  ├─ select[name="rcrs-country"]
  ├─ button "Add payment method"
  ├─ iframe[name="card-number-element"] -> input[name="cardNumber"]
  ├─ iframe[name="card-expiry-element"] -> input[name="cardExpiry"]
  └─ iframe[name="card-cvc-element"]    -> input[name="cardCvc"]
```
Reached with `page.frameLocator('#twHostedCheckoutFrame').frameLocator('iframe[name="card-number-element"]')…`.
The host is asserted to equal `cde.openpaystaging.com` **before any card data is typed**.
The "I have read and agree to Terms of Service" line is static text — there is no
checkbox to tick. Stripe/Airwallex fraud iframes are also present but are not interacted with.

### Phase E — Elevate student selection

`https://elevate-sandbox.hellothinkster.com/students` — title *"Thinkster Math - Student Learning Platform"*.
`h1` "Who's Ready to Learn Today?", "Select your profile to begin.", a card with avatar
initials + student name + **In Trial** badge + **Select** button, and a header "Log Out".

> The page mounts a Next.js route announcer `div#__next-route-announcer__[role="alert"]`
> containing the document title. It is **not** an error; asserting `[role="alert"]` count
> is 0 produced a false failure. The suite excludes it and asserts that no *visible*
> alert with error text is displayed.

## Backend calls observed (evidence trail)

```
POST /api/register/lead                 201  Lead captured successfully
POST /api/registration/step-progress/v2 200  (per questionnaire step)
POST /api/sms/send-verification         200
POST /api/sms/verify-code               200
POST /api/register/parent               201  { parent_id, students:[{ student_id, grade_level:"5" }] }
GET  /api/calendar/free-slots?...       200  { slots: { "YYYY-MM-DD": [...] } }
```

## Known application defects found during this exercise

1. **reCAPTCHA race on lead capture.** The widget submits `POST /api/register/lead`
   before its lazily-loaded reCAPTCHA v3 token exists →
   `400 {"error":"reCAPTCHA token is required"}`, surfaced as
   *"Something went wrong. Please check your email and try again."*
   The script only loads after the user interacts with the form (anchor iframe attaches
   ~0.8 s after the email field is filled). A human never notices; automation hits it
   immediately. Mitigated by waiting for reCAPTCHA to initialise, plus a bounded retry
   on the app's own "try again" path.
2. **reCAPTCHA bot-scoring rejection.** When Google scores the session as automated the
   API returns `403 {"error":"reCAPTCHA verification failed. Please try again."}`. The
   widget shows the same `div.tw-inline-msg` banner and re-enables the CTA.

   > **Correction to an earlier note in this file:** I initially recorded this case as a
   > *silent* failure with no user feedback. That was wrong — it was my own selector bug.
   > I was only watching `#trial .err` (the per-field validation nodes), whereas the
   > screen-level banner is `div.tw-inline-msg`. Once the correct selector was used, the
   > banner was observed on the 403 path too. The suite now watches both selectors and
   > records the real HTTP status from `POST /api/register/lead`.

   Observed retry behaviour from a real run (`run-2809125415`), which then passed:
   ```
   attempt 1: banner shown
   attempt 2: HTTP 403 {"error":"reCAPTCHA verification failed. Please try again."} | banner shown
   attempt 3: HTTP 403 ... | banner shown
   attempt 4: HTTP 403 ... | banner shown
   attempt 5: success -> journey completed, all final assertions passed
   ```
   Bot scoring degrades with repeated registrations from one IP, so a persistent 403 is an
   **external blocker**, not an automation defect.
3. **Duplicate-submit regression.** Clicking `#twCtaOtp` after the auto-submit resets the
   entire widget to `GET STARTED · 3 OF 8` instead of reporting "Parent already exists".
