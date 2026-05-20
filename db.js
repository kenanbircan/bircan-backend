const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. This server intentionally has no JSON or in-memory fallback.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 8000),
  query_timeout: Number(process.env.PG_QUERY_TIMEOUT_MS || 20000),
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 20000),
  keepAlive: true,
  application_name: process.env.PGAPPNAME || 'bircan-migration-backend'
});

async function query(text, params = []) {
  return pool.query(text, params);
}

async function tx(fn, opts = {}) {
  const client = await pool.connect();
  const statementTimeoutMs = Number(opts.statementTimeoutMs || process.env.PG_TX_STATEMENT_TIMEOUT_MS || 20000);
  try {
    await client.query('BEGIN');
    if (statementTimeoutMs > 0) {
      await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(statementTimeoutMs))}`);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
