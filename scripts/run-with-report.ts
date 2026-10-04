/**
 * Local equivalent of the Jenkins flow: run the registration test, then ALWAYS
 * send the AI email report, and exit with the test's own result.
 *
 *   npm run test:registration:report             (headed by default)
 *   npm run test:registration:report -- --headed (extra args go to Playwright)
 */
import { spawnSync } from 'child_process';

const extraArgs = process.argv.slice(2);
const test = spawnSync('npx', ['playwright', 'test', 'tests/registration.spec.ts', ...extraArgs], {
  stdio: 'inherit',
  shell: true,
});

console.log('\n[run-with-report] test finished - generating AI report and sending email...');
spawnSync('npx', ['tsx', 'scripts/ai-report.ts'], { stdio: 'inherit', shell: true });

process.exit(test.status ?? 1);
