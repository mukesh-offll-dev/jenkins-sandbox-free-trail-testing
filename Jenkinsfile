// =============================================================================
//  Thinkster sandbox - free-trial registration regression pipeline (Windows)
// =============================================================================
//
//  HOW TO CHANGE THE EXECUTION INTERVAL
//  ------------------------------------
//  Edit SCHEDULE_CRON below and commit. Ready-made values:
//
//     every 5 minutes  'H/5 * * * *'
//     every 10 minutes 'H/10 * * * *'   <-- current
//     every 30 minutes 'H/30 * * * *'
//     every hour       'H * * * *'
//     every 2 hours    'H */2 * * *'
//     every 4 hours    'H */4 * * *'
//     every 6 hours    'H */6 * * *'
//
//  The leading H spreads load so builds do not all fire on the same minute.
//  It is read at Jenkinsfile parse time, so a single edit is all that is needed.
//
//  NOTE: every run registers a real parent, holds a real calendar slot and
//  submits a sandbox payment, so a sub-hourly interval accumulates sandbox data
//  quickly. disableConcurrentBuilds() below guarantees runs never overlap even
//  if one takes longer than the interval.
// =============================================================================

def SCHEDULE_ENABLED = true
def SCHEDULE_CRON = 'H 8,20 * * *'

pipeline {
    agent any

    options {
        // Requirement 9: never let two registrations overlap - each run creates
        // real sandbox data and holds a real calendar slot.
        disableConcurrentBuilds()
        // Requirement 10: reasonable ceiling for the whole pipeline.
        timeout(time: 45, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '30', artifactNumToKeepStr: '15'))
        skipStagesAfterUnstable()
        // Deliberately NOT using timestamps()/ansiColor() here: those need the
        // Timestamper / AnsiColor plugins, and an unavailable option would fail
        // the whole build on an existing Jenkins. Enable them if you have them.
    }

    triggers {
        // SCHEDULE DISABLED FOR INVESTIGATION (SCHEDULE_ENABLED = false above).
        //
        // An empty cron spec declares no timer, so the previously-registered
        // 10-minute TimerTrigger is dropped the first time this Jenkinsfile is
        // parsed. Builds then only start when triggered manually.
        //
        // WHY: every run registers a real parent, consumes an SMS verification
        // against the one shared phone number and books a real calendar slot.
        // Build #64 alone created two parents and two bookings. A 10-minute
        // interval accumulated sandbox data and deepened the per-number SMS rate
        // limit faster than the failures could be diagnosed.
        cron(SCHEDULE_ENABLED ? SCHEDULE_CRON : '')
    }

    parameters {
        string(
            name: 'GIT_BRANCH',
            defaultValue: 'main',
            description: 'Branch of the automation repository to test with.'
        )
        choice(
            name: 'APPOINTMENT_TIMEZONE',
            choices: ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'],
            description: 'Timezone used for the trial session booking and the browser context.'
        )
        booleanParam(
            name: 'RECORD_VIDEO',
            defaultValue: true,
            description: 'Record video on failure (needs the Playwright ffmpeg binary on the agent).'
        )
        string(
            name: 'MAIL_TO',
            defaultValue: '',
            description: 'Comma-separated report recipients for THIS build. Empty = QA_REPORT_MAIL_TO.'
        )
    }

    environment {
        // ---- Sandbox endpoints (safe, non-secret) ---------------------------
        SANDBOX_BASE_URL      = 'https://sandbox.hellothinkster.com'
        ELEVATE_STUDENTS_URL  = 'https://elevate-sandbox.hellothinkster.com/students'
        EXPECTED_PAYMENT_HOST = 'cde.openpaystaging.com'
        // The widget is served from SANDBOX_BASE_URL but posts to a DIFFERENT
        // origin. assertSandboxOnly() validates this one too, so it must be set.
        SANDBOX_CORE_API_URL  = 'https://core-api-4.0-sandbox.hellothinkster.com'

        // ---- Secrets: Jenkins Credentials (Secret text) ---------------------
        // Create these once under Manage Jenkins > Credentials (see README).
        // Jenkins masks every one of these values in the console log.
        PARENT_PASSWORD       = credentials('thinkster-sandbox-parent-password')
        SANDBOX_OTP           = credentials('thinkster-sandbox-otp')
        SANDBOX_CARD_NUMBER   = credentials('thinkster-sandbox-card-number')
        SANDBOX_CARD_EXPIRY   = credentials('thinkster-sandbox-card-expiry')
        SANDBOX_CARD_CVC      = credentials('thinkster-sandbox-card-cvc')
        // QA reCAPTCHA bypass cookie (cookie-string format: name=value).
        // Credential kind: Secret text.  ID: thinkster-qa-bypass
        //
        // STATUS: applied to the browser context, but backend acceptance is
        // UNVERIFIED. Captured on a real run, every call to the core-API origin
        // carried no cookies at all, because fetch() defaults to
        // credentials:'same-origin' and omits them cross-origin. Keep the
        // credential bound, but do not rely on it to defeat reCAPTCHA until the
        // real mechanism is confirmed with Thinkster's QA team.
        THINKSTER_QA_BYPASS   = credentials('thinkster-qa-bypass')

        // ---- Non-secret test data -------------------------------------------
        // Pinned here so a CI run is explicit and reproducible rather than
        // relying on the code defaults. The generated parent email is always
        // unique per build (see the "Generate unique test data" stage).
        PARENT_FIRST_NAME   = 'Test'
        PARENT_LAST_NAME    = 'Automation'
        PARENT_COUNTRY      = 'United States'
        PARENT_COUNTRY_CODE = '+1'
        PARENT_PHONE        = '(908) 020-4336'
        STUDENT_FIRST_NAME  = 'Test'
        STUDENT_GRADE       = '5'
        BILLING_POSTAL_CODE = '07001'
        BILLING_COUNTRY     = 'United States'

        // ---- Run behaviour --------------------------------------------------
        CI                = 'true'
        VIDEO             = "${params.RECORD_VIDEO ? 'on' : 'off'}"
        // Bounded retry for the app's own reCAPTCHA "try again" path on
        // POST /api/register/lead.
        //
        // Lowered from 5 to 2 during the build #64 investigation. A 403
        // ("reCAPTCHA verification failed") is now classified as NON-RETRYABLE
        // in HomePage and aborts on the first attempt, so this ceiling only
        // still applies to the genuinely transient
        // 400 "reCAPTCHA token is required" race. Keeping it low limits how many
        // live registration requests a single failing build can generate.
        MAX_SUBMIT_ATTEMPTS = '2'

        // No Playwright-level retries: a retry re-runs the ENTIRE stateful
        // journey. In build #64 that created a second parent account, consumed
        // another SMS verification on the shared number and booked a second real
        // calendar slot. Raise this only for a deliberate, supervised run.
        RETRIES = '0'

        // HEADLESS is deliberately LEFT UNSET so the suite runs HEADED.
        // VERIFIED: the Vercel edge answers headless browsers with 403 Forbidden
        // before any application code runs, so the signup widget never renders.
        // Setting HEADLESS=1 here will break every build.
        // Consequence for this agent: the Jenkins service must run with access to
        // an interactive desktop session, otherwise headed Chrome cannot launch.
        // The "Chrome launch smoke test" stage below proves that before the
        // 15-minute journey starts.

        // Drive the Chrome already installed on the agent instead of downloading
        // Playwright's bundled Chromium (~130MB), whose CDN download kept timing
        // out on this agent. playwright.config.ts turns this into `channel`.
        BROWSER_CHANNEL = 'chrome'
        // Used only for the pre-flight existence/permission check below. Playwright
        // itself resolves Chrome from the channel, not from this value.
        CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

        // Still required when RECORD_VIDEO=true: ffmpeg is fetched into this cache.
        // LOCALAPPDATA is unset for some Windows service accounts, which would
        // collapse this to a bare "\ms-playwright"; fall back to a fixed path.
        PLAYWRIGHT_BROWSERS_PATH = "${env.LOCALAPPDATA ? env.LOCALAPPDATA + '\\ms-playwright' : 'C:\\ms-playwright'}"
        // The default 30s connection timeout is short for a throttled agent link.
        PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT = '120000'
        // Jenkins provides BUILD_NUMBER, which the suite appends to the parent
        // email (test<DDMMHHmm>_<BUILD>) so it never collides with a local run.

        // ---- Execution report email (post-build, non-secret) ----------------
        // SMTP_USER/SMTP_PASSWORD are bound only inside the post step, from the
        // 'qa-report-smtp' credential (Username with password). It must be the
        // approved Thinkster company mailbox (@hellothinkster.com); any other
        // sender is refused. smtp.gmail.com serves Google Workspace mailboxes.
        SEND_EMAIL        = 'true'
        SMTP_HOST         = 'smtp.gmail.com'
        SMTP_PORT         = '587'
        SMTP_SECURE       = 'false'
        // Default report recipients (comma-separated). Used for scheduled builds
        // and whenever the MAIL_TO parameter is empty or not yet registered.
        QA_REPORT_MAIL_TO = 'mukesh@hellothinkster.com'
    }

    stages {

        stage('Checkout') {
            steps {
                // Requirement 1: retrieve the Playwright project from GitHub.
                // Configure the repository URL in the job's "Pipeline script from SCM"
                // section; this checkout honours that configuration.
                checkout scm
                bat 'git rev-parse --short HEAD > .git-sha.txt'
                script {
                    def sha = readFile('.git-sha.txt').trim()
                    currentBuild.description = "branch=${params.GIT_BRANCH} sha=${sha} tz=${params.APPOINTMENT_TIMEZONE}"
                }
            }
        }

        stage('Tooling versions') {
            steps {
                bat '''
                    @echo off
                    echo === Node / npm ===
                    node --version
                    npm --version
                '''
            }
        }

        stage('Install dependencies') {
            steps {
                // Requirement 2: reproducible install from the lockfile.
                bat 'npm ci'
            }
        }

        stage('Verify Google Chrome') {
            steps {
                // Requirement 3: drive the system Chrome, so `npx playwright install
                // chromium` is deliberately NOT run anywhere in this pipeline.
                // Confirm the binary exists and is readable by the Jenkins service
                // account; actual launchability is proven by the smoke test below.
                echo "BROWSER_CHANNEL=${env.BROWSER_CHANNEL}  VIDEO=${env.VIDEO}"
                bat '''
                    @echo off
                    if not exist "%CHROME_PATH%" (
                        echo ERROR: Google Chrome was not found at:
                        echo        %CHROME_PATH%
                        echo.
                        echo Install Chrome for ALL USERS on this agent ^(a per-user
                        echo install is invisible to the Jenkins service account^), or
                        echo point CHROME_PATH at the correct location.
                        exit /b 1
                    )
                    echo Found Chrome: %CHROME_PATH%
                '''
                // Reading the version proves the service account really can read the
                // file, not merely that the path exists. Invoked through `bat` rather
                // than the `powershell` DSL step so this needs no extra plugin.
                bat '''
                    @echo off
                    echo Running as: %USERNAME%
                    powershell -NoProfile -Command "Write-Host ('Chrome version: ' + (Get-Item $env:CHROME_PATH).VersionInfo.ProductVersion)"
                '''
            }
        }

        stage('Install Playwright FFmpeg') {
            // Only needed when video recording is enabled. With RECORD_VIDEO
            // unchecked, VIDEO=off and playwright.config.ts disables video, so this
            // stage is skipped entirely and nothing is downloaded.
            when { expression { params.RECORD_VIDEO } }
            steps {
                // ffmpeg only - never chromium (the agent drives system Chrome).
                //
                // Delegated to scripts/ensure-ffmpeg.ts because `npx playwright
                // install ffmpeg` reproducibly times out on this network while
                // curl.exe fetches the same archive in under a second. The script
                // skips the download when the required revision is already cached,
                // tries the official installer first, then falls back to curl.exe.
                // No retry() wrapper: the script already owns its fallback, so
                // retrying would only repeat the slow official-installer timeout.
                timeout(time: 6, unit: 'MINUTES') {
                    bat 'npm run ensure:ffmpeg'
                }
            }
        }

        stage('Generate unique test data') {
            steps {
                // Requirement 4: a brand-new parent email for THIS build,
                // test<DDMMHHmm>_<BUILD>@tabtortest.com in the agent's local time.
                // Preview only: the test generates and reserves its own address.
                bat 'npm run generate:test-data'
            }
        }

        stage('Type check') {
            steps {
                bat 'npm run typecheck'
            }
        }

        stage('Chrome launch smoke test') {
            steps {
                // Requirement 6: prove the service account can actually launch Chrome
                // HEADED before committing to the 15-minute registration journey -
                // headed mode needs an interactive desktop session, and failing here
                // is far cheaper than failing mid-journey. Opens about:blank only:
                // it never contacts Thinkster and creates no account or payment data.
                timeout(time: 2, unit: 'MINUTES') {
                    bat 'npm run smoke:chrome'
                }
            }
        }

        stage('Run tests') {
            steps {
                // Requirement 5 + 8: let the tests fail the build, but always
                // continue to the reporting stages so artifacts are published.
                // test:ci = activation-arm mock (offline), onboarding screens (one
                // lead, no account) and the full registration journey to Elevate.
                // Every failure is screenshotted and embedded in the report email.
                bat 'npm run test:ci'
            }
        }
    }

    post {
        always {
            // Requirement 6: publish JUnit results for Jenkins trend reporting.
            junit testResults: 'test-results/junit/results.xml', allowEmptyResults: true

            // Execution report email, for EVERY result. Must never change the
            // build result: report:email always exits 0, and anything else (missing
            // credential, missing node_modules, timeout) is caught and logged here.
            // Catches Throwable for the same NoSuchMethodError reason as publishHTML below.
            script {
                try {
                    timeout(time: 5, unit: 'MINUTES') {
                        withCredentials([
                            usernamePassword(credentialsId: 'qa-report-smtp', usernameVariable: 'SMTP_USER', passwordVariable: 'SMTP_PASSWORD')
                        ]) {
                            withEnv([
                                "PIPELINE_RESULT=${currentBuild.currentResult}",
                                "BUILD_START_MS=${currentBuild.startTimeInMillis}",
                                // Set explicitly: a newly added parameter is not exported as an
                                // env var until Jenkins has registered it on a previous build.
                                "MAIL_TO=${params.MAIL_TO?.trim() ?: env.QA_REPORT_MAIL_TO}"
                            ]) {
                                bat 'npm run report:email'
                            }
                        }
                    }
                } catch (Throwable e) {
                    // Plain interpolation only: getClass() needs script approval in the
                    // Groovy sandbox and would throw from inside this catch.
                    echo "Email report skipped: ${e}. Build result is unchanged."
                }
            }

            // Requirement 7: archive the safe HTML report and debug artifacts.
            // artifacts/ holds the success screenshot and the redacted,
            // run-specific registration metadata (no secrets by construction).
            archiveArtifacts(
                artifacts: 'playwright-report/**, artifacts/**, test-results/**/*.png, test-results/**/*.webm, test-results/**/*.zip, test-results/**/*.md',
                allowEmptyArchive: true,
                fingerprint: false
            )

            // Optional: renders the Playwright report inline when the
            // HTML Publisher plugin is installed. Guarded so a missing plugin
            // never breaks the build.
            //
            // MUST catch Throwable, not Exception: Jenkins raises
            // java.lang.NoSuchMethodError ("No such DSL method 'publishHTML'")
            // when the HTML Publisher plugin is absent. NoSuchMethodError extends
            // Error, not Exception, so a bare `catch (ignored)` - which Groovy
            // treats as `catch (Exception ignored)` - lets it escape and fails the
            // build during post-processing, masking the real test result.
            script {
                try {
                    publishHTML(target: [
                        reportName           : 'Playwright Report',
                        reportDir            : 'playwright-report',
                        reportFiles          : 'index.html',
                        keepAll              : true,
                        alwaysLinkToLastBuild: true,
                        allowMissing         : true
                    ])
                } catch (Throwable ignored) {
                    echo 'HTML Publisher plugin not available - the report is still archived as a build artifact.'
                }
            }
        }

        success {
            echo "PASSED - the run reached ${env.ELEVATE_STUDENTS_URL} and all mandatory assertions held."
        }

        failure {
            echo 'FAILED - inspect artifacts/evidence/*.png, the Playwright HTML report and any trace zip.'
            echo 'Open a trace locally with:  npx playwright show-trace <trace.zip>'
        }

        cleanup {
            // Keep the workspace lean but preserve nothing sensitive on the agent.
            bat 'if exist .git-sha.txt del /q .git-sha.txt'
        }
    }
}
