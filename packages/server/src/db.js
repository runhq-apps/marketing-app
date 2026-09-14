import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// A relative RUNHQ_DB_PATH resolves against the server package, not the current directory:
// `npm start` and `node packages/server/src/index.js` must open the same database, or
// seeded data appears to vanish depending on where you happened to be standing.
const PACKAGE_ROOT = resolve(new URL('..', import.meta.url).pathname);
const DB_PATH = process.env.RUNHQ_DB_PATH
  ? resolve(PACKAGE_ROOT, process.env.RUNHQ_DB_PATH)
  : resolve(PACKAGE_ROOT, 'data/marketing.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT NOT NULL UNIQUE,
  website      TEXT,
  currency     TEXT NOT NULL DEFAULT 'USD',
  sdk_key      TEXT NOT NULL UNIQUE,
  sdk_secret   TEXT NOT NULL,
  target_cac   REAL,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL,
  name               TEXT NOT NULL,
  auth_type          TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'unconfigured',
  credentials        TEXT,
  config             TEXT NOT NULL DEFAULT '{}',
  last_sync_at       TEXT,
  last_sync_status   TEXT,
  last_sync_error    TEXT,
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_project ON channels(project_id);

CREATE TABLE IF NOT EXISTS spend_daily (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  spend       REAL NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks      INTEGER NOT NULL DEFAULT 0,
  currency    TEXT NOT NULL DEFAULT 'USD',
  source      TEXT NOT NULL DEFAULT 'api',
  UNIQUE(channel_id, date)
);
CREATE INDEX IF NOT EXISTS idx_spend_project_date ON spend_daily(project_id, date);

CREATE TABLE IF NOT EXISTS stages (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  position      INTEGER NOT NULL,
  is_conversion INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, key)
);

CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  anon_id       TEXT,
  external_id   TEXT,
  email         TEXT,
  name          TEXT,
  company       TEXT,
  channel_id    TEXT REFERENCES channels(id) ON DELETE SET NULL,
  first_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  campaign      TEXT,
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_term      TEXT,
  utm_content   TEXT,
  click_id      TEXT,
  referrer      TEXT,
  landing_page  TEXT,
  stage         TEXT,
  value         REAL NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'open',
  country       TEXT,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_project ON leads(project_id, first_seen);
CREATE INDEX IF NOT EXISTS idx_leads_anon ON leads(project_id, anon_id);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(project_id, email);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lead_id     TEXT REFERENCES leads(id) ON DELETE CASCADE,
  anon_id     TEXT,
  name        TEXT NOT NULL,
  stage       TEXT,
  value       REAL NOT NULL DEFAULT 0,
  url         TEXT,
  referrer    TEXT,
  props       TEXT NOT NULL DEFAULT '{}',
  ts          TEXT NOT NULL,
  -- Set by importers that can be re-run (payment processors, CSV replays). NULL for
  -- SDK events, which are one-shot by nature; SQLite allows any number of NULLs
  -- under a unique index, so only the re-runnable ones are constrained.
  dedupe_key  TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_project_ts ON events(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_lead ON events(lead_id, ts);

CREATE TABLE IF NOT EXISTS revenue_sources (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL DEFAULT 'stripe',
  name              TEXT NOT NULL,
  credentials       TEXT,
  config            TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'unconfigured',
  account_ref       TEXT,
  account_name      TEXT,
  livemode          INTEGER NOT NULL DEFAULT 1,
  last_sync_at      TEXT,
  last_sync_status  TEXT,
  last_sync_error   TEXT,
  last_hook_at      TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE(project_id, provider, account_ref)
);
CREATE INDEX IF NOT EXISTS idx_revenue_sources_project ON revenue_sources(project_id);

-- The money ledger, one row per charge and one per refund. Analytics still reads
-- revenue from the events table; this keeps the processor's own record so MRR, refunds
-- and per-customer history survive a re-sync and can be reconciled against it.
CREATE TABLE IF NOT EXISTS payments (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id        TEXT NOT NULL REFERENCES revenue_sources(id) ON DELETE CASCADE,
  external_id      TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'payment',
  customer_ref     TEXT,
  -- The product's own id for whoever paid, when the payment carries one (Stripe charge
  -- metadata). customer_ref is the processor's id for them; this is the id the product
  -- passed to runhq.identify(), which is what leads are keyed by.
  user_ref         TEXT,
  email            TEXT,
  name             TEXT,
  lead_id          TEXT REFERENCES leads(id) ON DELETE SET NULL,
  amount           REAL NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT 'USD',
  description      TEXT,
  invoice_ref      TEXT,
  subscription_ref TEXT,
  status           TEXT,
  livemode         INTEGER NOT NULL DEFAULT 1,
  occurred_at      TEXT NOT NULL,
  synced_at        TEXT NOT NULL,
  UNIQUE(source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_project_date ON payments(project_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_payments_lead ON payments(lead_id);
CREATE INDEX IF NOT EXISTS idx_payments_email ON payments(project_id, email);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(project_id, customer_ref);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id          TEXT NOT NULL REFERENCES revenue_sources(id) ON DELETE CASCADE,
  external_id        TEXT NOT NULL,
  customer_ref       TEXT,
  email              TEXT,
  lead_id            TEXT REFERENCES leads(id) ON DELETE SET NULL,
  status             TEXT NOT NULL,
  plan               TEXT,
  interval           TEXT,
  quantity           INTEGER NOT NULL DEFAULT 1,
  amount             REAL NOT NULL DEFAULT 0,
  mrr                REAL NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'USD',
  started_at         TEXT,
  current_period_end TEXT,
  canceled_at        TEXT,
  synced_at          TEXT NOT NULL,
  UNIQUE(source_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_subs_project ON subscriptions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_lead ON subscriptions(lead_id);

CREATE TABLE IF NOT EXISTS audit_findings (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'project',
  scope_id       TEXT,
  severity       TEXT NOT NULL,
  title          TEXT NOT NULL,
  detail         TEXT NOT NULL,
  fix            TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open',
  first_detected TEXT NOT NULL,
  last_detected  TEXT NOT NULL,
  UNIQUE(project_id, code, scope_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL,
  rows_written INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_channel ON sync_runs(channel_id, started_at);

CREATE TABLE IF NOT EXISTS site_scans (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  scanned_at  TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  detected    TEXT NOT NULL DEFAULT '{}',
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_scans_project ON site_scans(project_id, scanned_at);
`;

db.exec(SCHEMA);

// Bump this when SCHEMA changes in a way older files need patched in.
const MIGRATIONS = [
  'ALTER TABLE events ADD COLUMN dedupe_key TEXT',
  // The product's own id for whoever paid, when the payment carries one. Kept apart from
  // customer_ref, which is the processor's id for them and answers a different question.
  'ALTER TABLE payments ADD COLUMN user_ref TEXT',
];
for (const m of MIGRATIONS) { try { db.exec(m); } catch { /* already applied */ } }

// Indexes over migrated columns have to come after the migrations that add them.
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON events(dedupe_key)');
db.exec('CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(project_id, user_ref)');

export const uid = () => randomUUID();
export const now = () => new Date().toISOString();

export function all(sql, params = {}) { return db.prepare(sql).all(params); }
export function get(sql, params = {}) { return db.prepare(sql).get(params) ?? null; }
export function run(sql, params = {}) { return db.prepare(sql).run(params); }
export function tx(fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
