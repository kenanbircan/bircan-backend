'use strict';

const { tx, query } = require('../db');
const { createPaidAdviceJob, markAdviceManualReview, markAdviceReady } = require('./pdfReleaseService');

async function claimNextAdviceJob({ assessmentId } = {}) {
  return tx(async (client) => {
    const { rows } = assessmentId ? await client.query(
      `SELECT * FROM pdf_jobs
       WHERE assessment_id=$1
         AND (
           status IN ('queued','failed')
           OR (status='processing' AND (locked_at IS NULL OR locked_at < now() - interval '10 minutes'))
         )
       ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [assessmentId]
    ) : await client.query(
      `SELECT * FROM pdf_jobs
       WHERE status='queued' AND run_after <= now()
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );
    const job = rows[0];
    if (!job) return null;
    await client.query(
      `UPDATE pdf_jobs SET status='processing', locked_at=now(), attempts=COALESCE(attempts,0)+1, updated_at=now() WHERE id=$1`,
      [job.id]
    );
    return job;
  });
}

async function runOneAdviceJob({ generateAssessmentPdfNow, maxAttempts = 3, assessmentId } = {}) {
  if (typeof generateAssessmentPdfNow !== 'function') throw new Error('generateAssessmentPdfNow function is required.');
  const job = await claimNextAdviceJob({ assessmentId });
  if (!job) return { ran: false };
  try {
    const result = await generateAssessmentPdfNow(job.assessment_id);
    await markAdviceReady(job.assessment_id);
    return { ran: true, assessmentId: job.assessment_id, status: 'completed', result };
  } catch (err) {
    const nextAttempts = Number(job.attempts || 0) + 1;
    const message = String(err && err.message || err);
    const deterministicRetryable = /grant criteria|criteria registry|criteria coverage|coverage validation|pathway|stream/i.test(message);
    const retry = nextAttempts < maxAttempts && (deterministicRetryable || !/requires manual review|cannot be issued|not recognised|missing or incomplete/i.test(message));
    if (retry) {
      await query(
        `UPDATE pdf_jobs SET status='queued', last_error=$1, run_after=now() + interval '2 minutes', locked_at=NULL, updated_at=now() WHERE id=$2`,
        [message, job.id]
      );
      await query(`UPDATE assessments SET status='pdf_queued', generation_error=$1, updated_at=now() WHERE id=$2`, [message, job.assessment_id]).catch(() => null);
      return { ran: true, assessmentId: job.assessment_id, status: 'requeued', error: message };
    }
    await markAdviceManualReview(job.assessment_id, err);
    return { ran: true, assessmentId: job.assessment_id, status: 'failed', error: message };
  }
}

async function runDueAdviceJobs({ generateAssessmentPdfNow, limit = 1, assessmentId } = {}) {
  const results = [];
  for (let i = 0; i < limit; i += 1) {
    const result = await runOneAdviceJob({ generateAssessmentPdfNow, assessmentId: i === 0 ? assessmentId : undefined });
    results.push(result);
    if (!result.ran) break;
  }
  return results;
}

module.exports = {
  createPaidAdviceJob,
  claimNextAdviceJob,
  runOneAdviceJob,
  runDueAdviceJobs
};
