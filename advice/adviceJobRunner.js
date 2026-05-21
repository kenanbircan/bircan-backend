'use strict';

const { tx, query } = require('../db');
const { createPaidAdviceJob, markAdviceManualReview, markAdviceReady } = require('./pdfReleaseService');

async function claimNextAdviceJob() {
  return tx(async (client) => {
    const { rows } = await client.query(
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

async function runOneAdviceJob({ generateAssessmentPdfNow, maxAttempts = 3 } = {}) {
  if (typeof generateAssessmentPdfNow !== 'function') throw new Error('generateAssessmentPdfNow function is required.');
  const job = await claimNextAdviceJob();
  if (!job) return { ran: false };
  try {
    const result = await generateAssessmentPdfNow(job.assessment_id);
    await markAdviceReady(job.assessment_id);
    return { ran: true, assessmentId: job.assessment_id, status: 'completed', result };
  } catch (err) {
    const nextAttempts = Number(job.attempts || 0) + 1;
    const retry = nextAttempts < maxAttempts && !/requires manual review|cannot be issued|not recognised|missing or incomplete/i.test(String(err && err.message || err));
    if (retry) {
      await query(
        `UPDATE pdf_jobs SET status='queued', last_error=$1, run_after=now() + interval '2 minutes', locked_at=NULL, updated_at=now() WHERE id=$2`,
        [String(err && err.message || err), job.id]
      );
      await query(`UPDATE assessments SET status='pdf_queued', generation_error=$1, updated_at=now() WHERE id=$2`, [String(err && err.message || err), job.assessment_id]).catch(() => null);
      return { ran: true, assessmentId: job.assessment_id, status: 'requeued', error: String(err && err.message || err) };
    }
    await markAdviceManualReview(job.assessment_id, err);
    return { ran: true, assessmentId: job.assessment_id, status: 'failed', error: String(err && err.message || err) };
  }
}

async function runDueAdviceJobs({ generateAssessmentPdfNow, limit = 1 } = {}) {
  const results = [];
  for (let i = 0; i < limit; i += 1) {
    const result = await runOneAdviceJob({ generateAssessmentPdfNow });
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
