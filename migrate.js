require('dotenv').config();

const { pool, query } = require('./db');

const MIGRATION_NAME = '20260501_safe_startup_schema_for_login_payment_pdf';

async function q(sql, params = []) {
  const text = sql.trim().replace(/\s+/g, ' ');
  console.log('[migration]', text.slice(0, 180) + (text.length > 180 ? '...' : ''));
  return query(sql, params);
}

async function columnExists(table, column) {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
     LIMIT 1`,
    [table, column]
  );
  return Boolean(rows[0]);
}

async function tableExists(table) {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = $1
     LIMIT 1`,
    [table]
  );
  return Boolean(rows[0]);
}

async function ensurePaymentsIdDefaultSafe() {
  const { rows } = await query(`
    SELECT data_type, udt_name, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'payments'
      AND column_name = 'id'
    LIMIT 1
  `);
  const col = rows[0];
  if (!col || col.column_default) return;

  const type = `${col.data_type || ''} ${col.udt_name || ''}`.toLowerCase();
  if (type.includes('uuid')) {
    await q(`ALTER TABLE payments ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
  } else if (type.includes('bigint') || type.includes('int8')) {
    await q(`CREATE SEQUENCE IF NOT EXISTS payments_id_seq`);
    await q(`ALTER TABLE payments ALTER COLUMN id SET DEFAULT nextval('payments_id_seq')`);
  } else if (type.includes('integer') || type.includes('int4')) {
    await q(`CREATE SEQUENCE IF NOT EXISTS payments_id_seq`);
    await q(`ALTER TABLE payments ALTER COLUMN id SET DEFAULT nextval('payments_id_seq')`);
  }
}

async function ensureColumn(table, definition) {
  const name = String(definition).trim().split(/\s+/)[0].replace(/"/g, '');
  if (!(await columnExists(table, name))) {
    await q(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function ensureRequiredSchema() {
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await q(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      name text,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS assessments (
      id text PRIMARY KEY,
      client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
      client_email text NOT NULL,
      applicant_email text,
      applicant_name text,
      visa_type text NOT NULL,
      selected_plan text NOT NULL DEFAULT 'instant',
      active_plan text,
      status text NOT NULL DEFAULT 'payment_pending',
      payment_status text NOT NULL DEFAULT 'unpaid',
      stripe_session_id text,
      stripe_payment_intent text,
      amount_cents integer,
      currency text DEFAULT 'aud',
      form_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      pdf_bytes bytea,
      pdf_mime text,
      pdf_filename text,
      pdf_sha256 text,
      pdf_generated_at timestamptz,
      generation_attempts integer NOT NULL DEFAULT 0,
      generation_locked_at timestamptz,
      generation_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS payments (
      id bigserial PRIMARY KEY,
      client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
      client_email text NOT NULL,
      service_type text NOT NULL DEFAULT 'visa_assessment',
      service_ref text NOT NULL,
      visa_type text,
      plan text,
      stripe_session_id text UNIQUE,
      stripe_payment_intent text,
      amount_cents integer,
      currency text DEFAULT 'aud',
      status text NOT NULL DEFAULT 'paid',
      raw_payload jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS pdf_jobs (
      id bigserial PRIMARY KEY,
      assessment_id text UNIQUE NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'queued',
      attempts integer NOT NULL DEFAULT 0,
      run_after timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const clientCols = [
    `name text`,
    `password_hash text`,
    `created_at timestamptz NOT NULL DEFAULT now()`,
    `updated_at timestamptz NOT NULL DEFAULT now()`
  ];
  for (const col of clientCols) await ensureColumn('clients', col);

  const assessmentCols = [
    `client_id uuid`,
    `client_email text`,
    `applicant_email text`,
    `applicant_name text`,
    `visa_type text`,
    `selected_plan text DEFAULT 'instant'`,
    `active_plan text`,
    `status text DEFAULT 'payment_pending'`,
    `payment_status text DEFAULT 'unpaid'`,
    `stripe_session_id text`,
    `stripe_payment_intent text`,
    `amount_cents integer`,
    `currency text DEFAULT 'aud'`,
    `form_payload jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `pdf_bytes bytea`,
    `pdf_mime text`,
    `pdf_filename text`,
    `pdf_sha256 text`,
    `pdf_generated_at timestamptz`,
    `generation_attempts integer NOT NULL DEFAULT 0`,
    `generation_locked_at timestamptz`,
    `generation_error text`,
    `created_at timestamptz NOT NULL DEFAULT now()`,
    `updated_at timestamptz NOT NULL DEFAULT now()`
  ];
  for (const col of assessmentCols) await ensureColumn('assessments', col);

  const paymentCols = [
    `client_id uuid`,
    `client_email text`,
    `service_type text DEFAULT 'visa_assessment'`,
    `service_ref text`,
    `visa_type text`,
    `plan text`,
    `stripe_session_id text`,
    `stripe_payment_intent text`,
    `amount_cents integer`,
    `currency text DEFAULT 'aud'`,
    `status text DEFAULT 'paid'`,
    `raw_payload jsonb`,
    `created_at timestamptz NOT NULL DEFAULT now()`,
    `updated_at timestamptz NOT NULL DEFAULT now()`
  ];
  for (const col of paymentCols) await ensureColumn('payments', col);

  const jobCols = [
    `assessment_id text`,
    `status text DEFAULT 'queued'`,
    `attempts integer NOT NULL DEFAULT 0`,
    `run_after timestamptz NOT NULL DEFAULT now()`,
    `locked_at timestamptz`,
    `last_error text`,
    `created_at timestamptz NOT NULL DEFAULT now()`,
    `updated_at timestamptz NOT NULL DEFAULT now()`
  ];
  for (const col of jobCols) await ensureColumn('pdf_jobs', col);

  await ensurePaymentsIdDefaultSafe();

  await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_stripe_session_id_unique ON payments (stripe_session_id) WHERE stripe_session_id IS NOT NULL`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_jobs_assessment_id_unique ON pdf_jobs (assessment_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_assessments_client_email ON assessments (lower(client_email))`);
  await q(`CREATE INDEX IF NOT EXISTS idx_assessments_client_id ON assessments (client_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_payments_client_email ON payments (lower(client_email))`);
  await q(`CREATE INDEX IF NOT EXISTS idx_payments_client_id ON payments (client_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_pdf_jobs_status_run_after ON pdf_jobs (status, run_after)`);

  await q(`INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET applied_at = now()`, [MIGRATION_NAME]);
}

async function verifySchema() {
  const required = {
    clients: ['id', 'email', 'password_hash'],
    assessments: ['id', 'client_id', 'client_email', 'visa_type', 'selected_plan', 'payment_status', 'pdf_bytes', 'pdf_generated_at'],
    payments: ['id', 'client_id', 'client_email', 'service_type', 'service_ref', 'stripe_session_id', 'status'],
    pdf_jobs: ['id', 'assessment_id', 'status', 'run_after']
  };

  const missing = [];
  for (const [table, columns] of Object.entries(required)) {
    if (!(await tableExists(table))) {
      missing.push(`${table}.*`);
      continue;
    }
    for (const column of columns) {
      if (!(await columnExists(table, column))) missing.push(`${table}.${column}`);
    }
  }

  if (missing.length) {
    throw new Error(`Database migration incomplete. Missing: ${missing.join(', ')}`);
  }

  console.log('[migration] Schema verification passed.');
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for migration.');

  // Prevent two Render instances from changing schema at the same time.
  await q(`SELECT pg_advisory_lock(hashtext('bircan_migration_schema_lock'))`);
  try {
    await ensureRequiredSchema();
    await verifySchema();
  } finally {
    await q(`SELECT pg_advisory_unlock(hashtext('bircan_migration_schema_lock'))`);
  }
}

main()
  .then(async () => {
    console.log('[migration] Completed successfully.');
    await pool.end();
  })
  .catch(async (err) => {
    console.error('[migration] FAILED:', err);
    try { await pool.end(); } catch (_) {}
    process.exit(1);
  });
