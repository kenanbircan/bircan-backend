'use strict';

const ADVICE_STATUS = Object.freeze({
  AWAITING_PAYMENT: 'awaiting_payment',
  QUEUED: 'pdf_queued',
  GENERATING: 'pdf_generating',
  MANUAL_REVIEW: 'manual_review_required',
  FAILED: 'pdf_failed',
  READY: 'pdf_ready',
  RELEASE_LOCKED: 'release_locked',
  ACTIVE: 'active'
});

function normaliseAdviceStatus(value, context = {}) {
  const raw = String(value || '').toLowerCase().trim();
  const paid = context.paid === true || String(context.paymentStatus || '').toLowerCase() === 'paid';
  const hasPdf = context.hasPdf === true;
  const locked = context.locked === true || Number(context.releaseSecondsRemaining || 0) > 0;

  if (context.type === 'citizenship_test') return ADVICE_STATUS.ACTIVE;
  if (!paid) return ADVICE_STATUS.AWAITING_PAYMENT;
  if (locked) return ADVICE_STATUS.RELEASE_LOCKED;
  if (hasPdf || raw === 'pdf_ready' || raw === 'advice_ready') return ADVICE_STATUS.READY;
  if (/manual[_\s-]?review/.test(raw)) return ADVICE_STATUS.MANUAL_REVIEW;
  if (/failed|error|blocked/.test(raw)) return ADVICE_STATUS.FAILED;
  if (/generating|processing|building|running/.test(raw)) return ADVICE_STATUS.GENERATING;
  return ADVICE_STATUS.QUEUED;
}

function clientStatusLabel(status) {
  return ({
    awaiting_payment: 'Awaiting payment',
    pdf_queued: 'Advice letter queued',
    pdf_generating: 'Advice letter generating',
    manual_review_required: 'Manual review required',
    pdf_failed: 'Manual review required',
    pdf_ready: 'PDF ready',
    release_locked: 'Locked until release',
    active: 'Active'
  })[String(status || '')] || 'Processing';
}

function progressForStatus(status) {
  return ({
    awaiting_payment: 0,
    release_locked: 25,
    pdf_queued: 40,
    pdf_generating: 70,
    manual_review_required: 15,
    pdf_failed: 10,
    pdf_ready: 100,
    active: 100
  })[String(status || '')] || 0;
}

function isClientReady(status) {
  return String(status || '') === ADVICE_STATUS.READY;
}

module.exports = {
  ADVICE_STATUS,
  normaliseAdviceStatus,
  clientStatusLabel,
  progressForStatus,
  isClientReady
};
