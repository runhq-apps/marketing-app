import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Each test file gets its own on-disk database, so nothing leaks between them. */
export function useTempDb() {
  process.env.RUNHQ_DB_PATH = join(mkdtempSync(join(tmpdir(), 'marketing-test-')), 'test.db');
  process.env.RUNHQ_SECRET = 'test-secret-value-that-is-long-enough-000';
  process.env.RUNHQ_SYNC_INTERVAL_HOURS = '0';
}

export const today = () => new Date().toISOString().slice(0, 10);
export const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
export const atDay = (n, hour = 12) => `${daysAgo(n)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
