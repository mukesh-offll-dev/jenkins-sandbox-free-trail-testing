// =============================================================================
//  Thinkster sandbox - free-trial registration regression pipeline (Windows)
// =============================================================================
//
//  HOW TO CHANGE THE EXECUTION INTERVAL
//  ------------------------------------
//  Edit SCHEDULE_CRON below and commit. Ready-made values:
//
//     every hour      'H * * * *'
//     every 2 hours   'H */2 * * *'   <-- default
//     every 3 hours   'H */3 * * *'
//     every 4 hours   'H */4 * * *'
//     every 6 hours   'H */6 * * *'
//
//  The leading H spreads load so builds do not all fire on the minute.
//  It is read at Jenkinsfile parse time, so a single edit is all that is needed.
// =============================================================================

def SCHEDULE_CRON = 'H/5 * * * *'

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
        cron(SCHEDULE_CRON)
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
    }

    environment {
        // ---- Sandbox endpoints (safe, non-secret) ---------------------------
        SANDBOX_BASE_URL      = 'https://sandbox.hellothinkster.com'
        ELEVATE_STUDENTS_URL  = 'https://elevate-sandbox.hellothinkster.com/students'
        EXPECTED_PAYMENT_HOST = 'cde.openpaystaging.com'

        // ---- Secrets: Jenkins Credentials (Secret text) ---------------------
        // Create these once under Manage Jenkins > Credentials (see README).
        // Jenkins masks every one of these values in the console log.
        PARENT_PASSWORD     = credentials('thinkster-sandbox-parent-password')
        SANDBOX_OTP         = credentials('thinkster-sandbox-otp')
        SANDBOX_CARD_NUMBER = credentials('thinkster-sandbox-card-number')
        SANDBOX_CARD_EXPIRY = credentials('thinkster-sandbox-card-expiry')
        SANDBOX_CARD_CVC    = credentials('thinkster-sandbox-card-cvc')

        // ---- Run behaviour --------------------------------------------------
        CI                = 'true'
        VIDEO             = "${params.RECORD_VIDEO ? 'on' : 'off'}"

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
        // Jenkins provides BUILD_NUMBER / EXECUTOR_NUMBER, which the suite uses
        // to guarantee a collision-free parent email per build.
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
                // stamped DDMMHHmmSS in Asia/Kolkata and suffixed with the build
                // number so concurrent agents can never collide.
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
                // before committing to the 15-minute registration journey. Opens
                // about:blank only - it never contacts Thinkster and creates no
                // account or payment data.
                timeout(time: 2, unit: 'MINUTES') {
                    bat 'npm run smoke:chrome'
                }
            }
        }

        stage('Run registration test') {
            steps {
                // Requirement 5 + 8: let the test fail the build, but always
                // continue to the reporting stages so artifacts are published.
                bat 'npm run test:registration'
            }
        }
    }

    post {
        always {
            // Requirement 6: publish JUnit results for Jenkins trend reporting.
            junit testResults: 'test-results/junit/results.xml', allowEmptyResults: true

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
