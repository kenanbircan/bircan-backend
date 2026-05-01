'use strict';

const DECISION = Object.freeze({
  NOT_LODGEABLE: 'NOT_LODGEABLE',
  LODGEABLE_HIGH_RISK: 'LODGEABLE_HIGH_RISK',
  LODGEABLE_WITH_EVIDENCE_GAPS: 'LODGEABLE_WITH_EVIDENCE_GAPS',
  LODGEABLE: 'LODGEABLE'
});

const RISK = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL'
});

const STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  UNKNOWN: 'unknown',
  RISK: 'risk',
  NOT_APPLICABLE: 'not_applicable'
});

const SEVERITY = Object.freeze({
  BLOCKER: 'blocker',
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
});

const LEGAL_EFFECT = Object.freeze({
  INVALID_APPLICATION: 'invalid_application',
  REFUSAL_LIKELY: 'refusal_likely',
  DISCRETIONARY_RISK: 'discretionary_risk',
  EVIDENCE_GAP: 'evidence_gap',
  NO_ADVERSE_FINDING: 'no_adverse_finding'
});

const DECISION_LABELS = Object.freeze({
  [DECISION.NOT_LODGEABLE]: 'Not lodgeable',
  [DECISION.LODGEABLE_HIGH_RISK]: 'Potentially lodgeable but high refusal risk',
  [DECISION.LODGEABLE_WITH_EVIDENCE_GAPS]: 'Potentially lodgeable subject to evidence gaps',
  [DECISION.LODGEABLE]: 'Appears lodgeable subject to document verification'
});

module.exports = { DECISION, RISK, STATUS, SEVERITY, LEGAL_EFFECT, DECISION_LABELS };
