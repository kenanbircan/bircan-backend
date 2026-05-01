'use strict';

const { DECISION, RISK, STATUS, SEVERITY, LEGAL_EFFECT, DECISION_LABELS } = require('./190.constants');
const { buildEvidenceChecklist } = require('./190.evidence-mapper');

function aggregate190Decision(findings) {
  const failedBlockers = findings.filter(f => f.severity === SEVERITY.BLOCKER && f.status === STATUS.FAIL);
  const unknownBlockers = findings.filter(f => f.severity === SEVERITY.BLOCKER && f.status === STATUS.UNKNOWN);
  const criticalFails = findings.filter(f => f.severity === SEVERITY.CRITICAL && [STATUS.FAIL, STATUS.RISK].includes(f.status));
  const unknownCritical = findings.filter(f => f.severity === SEVERITY.CRITICAL && f.status === STATUS.UNKNOWN);
  const highRisks = findings.filter(f => f.severity === SEVERITY.HIGH && [STATUS.FAIL, STATUS.RISK, STATUS.UNKNOWN].includes(f.status));

  let finalPosition;
  if (failedBlockers.length) {
    finalPosition = {
      lodgementPosition: DECISION.NOT_LODGEABLE,
      lodgementLabel: DECISION_LABELS[DECISION.NOT_LODGEABLE],
      riskLevel: RISK.CRITICAL,
      primaryReason: failedBlockers[0].criterion,
      canGenerateAdviceLetter: true,
      requiresManualReview: true
    };
  } else if (unknownBlockers.length) {
    finalPosition = {
      lodgementPosition: DECISION.NOT_LODGEABLE,
      lodgementLabel: 'Not lodgeable until validity is confirmed',
      riskLevel: RISK.CRITICAL,
      primaryReason: unknownBlockers[0].criterion,
      canGenerateAdviceLetter: true,
      requiresManualReview: true
    };
  } else if (criticalFails.length) {
    finalPosition = {
      lodgementPosition: DECISION.LODGEABLE_HIGH_RISK,
      lodgementLabel: DECISION_LABELS[DECISION.LODGEABLE_HIGH_RISK],
      riskLevel: RISK.HIGH,
      primaryReason: criticalFails[0].criterion,
      canGenerateAdviceLetter: true,
      requiresManualReview: true
    };
  } else if (unknownCritical.length || highRisks.length) {
    finalPosition = {
      lodgementPosition: DECISION.LODGEABLE_WITH_EVIDENCE_GAPS,
      lodgementLabel: DECISION_LABELS[DECISION.LODGEABLE_WITH_EVIDENCE_GAPS],
      riskLevel: unknownCritical.length ? RISK.MEDIUM : RISK.HIGH,
      primaryReason: (unknownCritical[0] || highRisks[0]).criterion,
      canGenerateAdviceLetter: true,
      requiresManualReview: true
    };
  } else {
    finalPosition = {
      lodgementPosition: DECISION.LODGEABLE,
      lodgementLabel: DECISION_LABELS[DECISION.LODGEABLE],
      riskLevel: RISK.LOW,
      primaryReason: 'No blocker detected by the Subclass 190 decision engine',
      canGenerateAdviceLetter: true,
      requiresManualReview: false
    };
  }

  const blockers = findings.filter(f => f.legalEffect === LEGAL_EFFECT.INVALID_APPLICATION && f.status !== STATUS.PASS);
  const validityStatus = failedBlockers.length ? 'invalid' : unknownBlockers.length ? 'cannot_confirm' : 'valid';

  return {
    finalPosition,
    validityAssessment: {
      status: validityStatus,
      blockers: blockers.map(f => ({ ruleId: f.ruleId, criterion: f.criterion, status: f.status, reasoning: f.reasoning }))
    },
    evidenceChecklist: buildEvidenceChecklist(findings),
    metrics: {
      totalRules: findings.length,
      pass: findings.filter(f => f.status === STATUS.PASS).length,
      fail: findings.filter(f => f.status === STATUS.FAIL).length,
      unknown: findings.filter(f => f.status === STATUS.UNKNOWN).length,
      risk: findings.filter(f => f.status === STATUS.RISK).length
    }
  };
}

module.exports = { aggregate190Decision };
