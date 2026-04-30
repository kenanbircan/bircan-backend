require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('PostgreSQL schema is ready.');
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
