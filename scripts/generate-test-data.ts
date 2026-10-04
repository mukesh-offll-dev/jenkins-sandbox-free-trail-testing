/**
 * Pre-flight test-data generation for CI.
 *
 * Prints (and records) the unique parent email that THIS build will register,
 * so the value appears in the Jenkins console and in an archived artifact even
 * if the browser run later fails. No secret is printed.
 *
 * Run with:  npm run generate:test-data
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildRegistrationTestData } from '../src/utils/testData';
import { assertSandboxOnly, urls } from '../src/utils/env';
import { maskPhone } from '../src/utils/mask';

assertSandboxOnly();

// Preview only: not reserved, so the real test run can still take this address.
const data = buildRegistrationTestData({ reserveEmail: false });
const { registration, studentsPage } = urls();

const plan = {
  runId: data.runId,
  plannedAtUtc: new Date().toISOString(),
  ci: {
    job: process.env.JOB_NAME ?? null,
    build: process.env.BUILD_NUMBER ?? null,
    executor: process.env.EXECUTOR_NUMBER ?? null,
  },
  environment: { registration, studentsPage },
  parent: {
    email: data.generatedEmail.email,
    generatedAtLocal: data.generatedEmail.generatedAtLocal,
    stamp: data.generatedEmail.stamp,
    collisionSuffix: data.generatedEmail.suffix || null,
    name: `${data.parent.firstName} ${data.parent.lastName}`,
    country: `${data.parent.country} (${data.parent.countryCode})`,
    phoneMasked: maskPhone(data.parent.phone),
  },
  student: {
    firstName: data.student.firstName,
    grade: data.student.grade,
    expectedDisplayName: data.expectedStudentDisplayName,
  },
};

const outDir = path.resolve(process.cwd(), 'artifacts', 'run-metadata');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `planned-${data.runId}.json`);
fs.writeFileSync(outFile, JSON.stringify(plan, null, 2), 'utf8');

console.log('--- planned registration data (no secrets) ---');
console.log(`  parent email : ${plan.parent.email}`);
console.log(`  generated at : ${plan.parent.generatedAtLocal}`);
console.log(`  parent       : ${plan.parent.name} / ${plan.parent.country} / ${plan.parent.phoneMasked}`);
console.log(`  student      : ${plan.student.expectedDisplayName} (grade ${plan.student.grade})`);
console.log(`  target       : ${studentsPage}`);
console.log(`  written to   : ${outFile}`);

/**
 * NOTE: the email printed here is a preview generated from the same utility the
 * test uses. The test regenerates it at runtime, so the minute (or a collision
 * suffix) may differ - uniqueness is guaranteed by the email ledger either way.
 */
