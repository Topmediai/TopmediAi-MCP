import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Environment } from './auth-protocol.js';
import { sanitizeDiagnostic, type Diagnostic } from './redaction.js';

/** Retain the local report, optionally create a shareable copy, and return only a console summary. */
export async function saveDiagnosticReports(report: Record<string, any>, directory: string,
  environment: Environment, share: boolean): Promise<Diagnostic> {
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, `latest-${environment}.json`), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  if (share) await writeFile(resolve(directory, `shared-${environment}.json`),
    JSON.stringify(sanitizeDiagnostic(report), null, 2) + '\n', { mode: 0o600 });
  return sanitizeDiagnostic({ environment, token_configured: report.status?.token_configured,
    task: report.task ? { status: report.task.status } : undefined, report_saved: true, shared_report_saved: share });
}
