'use strict';

/**
 * pdfReleaseService.js — Migration Engine Design compliant release service v39.
 *
 * Source-of-truth rules enforced here:
 * - Payment finalisation queues advice only.
 * - Worker may render/store an AI draft PDF, but it must not release it to the client.
 * - After successful generation, status moves to rma_review_required, not pdf_ready.
 * - pdf_ready is reserved for a separate RMA approval action.
 */

const { query } = require('../db');
const { ADVICE_STATUS } = require('./adviceStatus');

async function createPaidAdviceJob({ assessmentId, runAfter = null, resetFailure = true } = {}) {
  if (!assessmentId) throw new Error('assessmentId is required to queue an advice job.');

  const sql = `
    INSERT INTO pdf_jobs (assessment_id, status, run_after, locked_at, last_error, created_at, updated_at)
    VALUES ($1,'queued',COALESCE($2::timestamptz, now()),NULL,NULL,now(),now())
    ON CONFLICT (assessment_id) DO UPDATE SET
      status=CASE
        WHEN pdf_jobs.status IN ('completed','pdf_ready','rma_approved') AND $3::boolean=false THEN pdf_jobs.status
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
     SET status=CASE
           WHEN status IN ('pdf_ready','rma_approved') THEN status
           ELSE 'pdf_queued'
         END,
         generation_error=NULL,
         updated_at=now()
     WHERE id=$1
       AND payment_status='paid'
       AND status NOT IN ('pdf_ready','rma_approved')`,
    [assessmentId]
  ).catch(() => null);

  return rows[0] || null;
}

async function markAdviceGenerating(assessmentId) {
  await query(
    `UPDATE assessments
     SET status='pdf_generating', generation_error=NULL, updated_at=now()
     WHERE id=$1 AND payment_status='paid'`,
    [assessmentId]
  );
}

async function markAdviceManualReview(assessmentId, error) {
  const message = String(error && error.message ? error.message : error || 'Advice letter requires manual review before release.');
  await query(
    `UPDATE assessments
     SET status='manual_review_required', generation_error=$1, updated_at=now()
     WHERE id=$2`,
    [message, assessmentId]
  ).catch(() => null);
  await query(
    `INSERT INTO pdf_jobs (assessment_id, status, last_error, created_at, updated_at)
     VALUES ($1,'failed',$2,now(),now())
     ON CONFLICT (assessment_id) DO UPDATE SET
       status='failed', last_error=$2, locked_at=NULL, updated_at=now()`,
    [assessmentId, message]
  ).catch(() => null);
}

async function markAdviceReady(assessmentId) {
  // The worker has produced a draft PDF/advice output. It is NOT client-ready yet.
  // The Migration Engine Design requires RMA review before client release.
  await query(
    `UPDATE assessments
     SET status='rma_review_required',
         generation_error=NULL,
         updated_at=now()
     WHERE id=$1 AND status NOT IN ('pdf_ready','rma_approved')`,
    [assessmentId]
  ).catch(() => null);

  await query(
    `UPDATE pdf_jobs
     SET status='rma_review_required', locked_at=NULL, last_error=NULL, updated_at=now()
     WHERE assessment_id=$1`,
    [assessmentId]
  ).catch(() => null);
}

module.exports = {
  ADVICE_STATUS,
  createPaidAdviceJob,
  markAdviceGenerating,
  markAdviceManualReview,
  markAdviceReady
};
