'use strict';

const { query } = require('../db');
const { ADVICE_STATUS } = require('./adviceStatus');

async function createPaidAdviceJob({ assessmentId, runAfter = null, resetFailure = true } = {}) {
  if (!assessmentId) throw new Error('assessmentId is required to queue an advice job.');
  const sql = `
    INSERT INTO pdf_jobs (assessment_id, status, run_after, locked_at, last_error, created_at, updated_at)
    VALUES ($1,'queued',COALESCE($2::timestamptz, now()),NULL,NULL,now(),now())
    ON CONFLICT (assessment_id) DO UPDATE SET
      status=CASE
        WHEN pdf_jobs.status='completed' AND $3::boolean=false THEN pdf_jobs.status
        WHEN pdf_jobs.status='failed' AND $3::boolean=false THEN pdf_jobs.status
        ELSE 'queued'
      END,
      run_after=COALESCE($2::timestamptz, pdf_jobs.run_after, now()),
      locked_at=NULL,
      last_error=CASE WHEN $3::boolean=true THEN NULL ELSE pdf_jobs.last_error END,
      updated_at=now()
    RETURNING *`;
  const { rows } = await query(sql, [assessmentId, runAfter, resetFailure !== false]);
  await query(
    `UPDATE assessments
     SET status=CASE WHEN status IN ('pdf_ready','advice_ready') THEN status ELSE 'pdf_queued' END,
         updated_at=now()
     WHERE id=$1 AND payment_status='paid' AND (pdf_bytes IS NULL OR octet_length(pdf_bytes) <= 1024)`,
    [assessmentId]
  ).catch(() => null);
  return rows[0] || null;
}

async function markAdviceGenerating(assessmentId) {
  await query(`UPDATE assessments SET status='pdf_generating', generation_error=NULL, updated_at=now() WHERE id=$1`, [assessmentId]);
}

async function markAdviceManualReview(assessmentId, error) {
  const message = String(error && error.message ? error.message : error || 'Advice letter requires manual review before release.');
  await query(`UPDATE assessments SET status='manual_review_required', generation_error=$1, updated_at=now() WHERE id=$2`, [message, assessmentId]).catch(() => null);
  await query(
    `INSERT INTO pdf_jobs (assessment_id, status, last_error, created_at, updated_at)
     VALUES ($1,'failed',$2,now(),now())
     ON CONFLICT (assessment_id) DO UPDATE SET status='failed', last_error=$2, locked_at=NULL, updated_at=now()`,
    [assessmentId, message]
  ).catch(() => null);
}

async function markAdviceReady(assessmentId) {
  await query(`UPDATE pdf_jobs SET status='completed', locked_at=NULL, last_error=NULL, updated_at=now() WHERE assessment_id=$1`, [assessmentId]).catch(() => null);
}

module.exports = {
  ADVICE_STATUS,
  createPaidAdviceJob,
  markAdviceGenerating,
  markAdviceManualReview,
  markAdviceReady
};
