/**
 * Run-specific, non-sensitive registration metadata.
 *
 * Written to artifacts/run-metadata/<runId>.json so every Jenkins build keeps a
 * durable, auditable record of what was registered - without any secret.
 */

import * as fs from 'fs';
import * as path from 'path';
import { maskPhone, redact } from './mask';
import { RegistrationTestData } from './testData';

export interface AppointmentRecord {
  date: string;
  dateLabel: string;
  displayTime: string;
  startTimeIso: string;
  endTimeIso: string;
  timezone: string;
}

export interface RunMetadata {
  runId: string;
  status: 'started' | 'passed' | 'failed';
  startedAtUtc: string;
  finishedAtUtc?: string;
  durationMs?: number;
  environment: {
    registrationUrl: string;
    studentsUrl: string;
    paymentHost?: string;
    ciBuild?: string;
    ciJob?: string;
  };
  parent: {
    email: string;
    emailGeneratedAtLocal: string;
    firstName: string;
    lastName: string;
    country: string;
    countryCode: string;
    phoneMasked: string;
  };
  student: {
    firstName: string;
    grade: string;
    expectedDisplayName: string;
    observedDisplayName?: string;
    observedStatus?: string;
  };
  appointment?: AppointmentRecord;
  payment?: {
    host: string;
    cardMasked: string;
    outcome: string;
  };
  steps: Array<{ name: string; at: string; detail?: string }>;
  /** Non-fatal conditions the run worked around (e.g. a skipped booking). */
  warnings: string[];
  finalUrl?: string;
  failure?: string;
}

const METADATA_DIR = path.resolve(process.cwd(), 'artifacts', 'run-metadata');

export class RunReport {
  readonly metadata: RunMetadata;
  private readonly startedAt = Date.now();

  constructor(data: RegistrationTestData, environment: { registrationUrl: string; studentsUrl: string }) {
    this.metadata = {
      runId: data.runId,
      status: 'started',
      startedAtUtc: new Date().toISOString(),
      environment: {
        registrationUrl: environment.registrationUrl,
        studentsUrl: environment.studentsUrl,
        ciBuild: process.env.BUILD_NUMBER,
        ciJob: process.env.JOB_NAME,
      },
      parent: {
        email: data.generatedEmail.email,
        emailGeneratedAtLocal: data.generatedEmail.generatedAtLocal,
        firstName: data.parent.firstName,
        lastName: data.parent.lastName,
        country: data.parent.country,
        countryCode: data.parent.countryCode,
        phoneMasked: maskPhone(data.parent.phone),
      },
      student: {
        firstName: data.student.firstName,
        grade: data.student.grade,
        expectedDisplayName: data.expectedStudentDisplayName,
      },
      steps: [],
      warnings: [],
    };
  }

  warn(message: string): void {
    this.metadata.warnings.push(redact(message));
  }

  /** Record a completed workflow step. */
  step(name: string, detail?: string): void {
    this.metadata.steps.push({
      name,
      at: new Date().toISOString(),
      detail: detail ? redact(detail) : undefined,
    });
  }

  appointment(record: AppointmentRecord): void {
    this.metadata.appointment = record;
  }

  payment(host: string, cardMasked: string, outcome: string): void {
    this.metadata.payment = { host, cardMasked, outcome };
    this.metadata.environment.paymentHost = host;
  }

  studentObserved(displayName: string, status: string): void {
    this.metadata.student.observedDisplayName = displayName;
    this.metadata.student.observedStatus = status;
  }

  finish(status: 'passed' | 'failed', finalUrl?: string, failure?: string): string {
    this.metadata.status = status;
    this.metadata.finishedAtUtc = new Date().toISOString();
    this.metadata.durationMs = Date.now() - this.startedAt;
    if (finalUrl) this.metadata.finalUrl = finalUrl;
    if (failure) this.metadata.failure = redact(failure).slice(0, 2000);
    return this.write();
  }

  /** Persist the metadata; returns the file path written. */
  write(): string {
    fs.mkdirSync(METADATA_DIR, { recursive: true });
    const file = path.join(METADATA_DIR, `run-${this.metadata.runId}.json`);
    // redact() over the whole document is a belt-and-braces guarantee that no
    // secret can reach a published artifact.
    fs.writeFileSync(file, redact(JSON.stringify(this.metadata, null, 2)), 'utf8');
    return file;
  }
}
