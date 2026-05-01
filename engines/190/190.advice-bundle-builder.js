'use strict';

function build190AdviceBundle(input, findings, aggregate) {
  return {
    subclass: '190',
    reference: input.reference,
    applicant: {
      fullName: input.applicant.fullName || null,
      email: input.applicant.email || input.clientEmail || null
    },
    finalPosition: aggregate.finalPosition,
    validityAssessment: aggregate.validityAssessment,
    criteriaFindings: findings.map(f => ({
      ruleId: f.ruleId,
      criterion: f.criterion,
      legalSource: f.legalSource,
      status: f.status,
      severity: f.severity,
      legalEffect: f.legalEffect,
      evidenceReliedOn: f.evidenceReliedOn,
      evidenceMissing: f.evidenceMissing,
      reasoning: f.reasoning,
      recommendation: f.recommendation,
      points: f.points || undefined
    })),
    evidenceChecklist: aggregate.evidenceChecklist,
    gptBoundary: {
      permitted: true,
      role: 'language_only',
      sourceData: 'Use only finalPosition, validityAssessment, criteriaFindings and evidenceChecklist.',
      forbidden: [
        'Do not invent facts, documents, scores or dates.',
        'Do not alter pass/fail/unknown/risk outcomes.',
        'Do not state the application is lodgeable if the engine says NOT_LODGEABLE.',
        'Do not remove any critical, blocker, health, character or PIC 4020 risk.'
      ]
    }
  };
}

function build190GptSystemPrompt() {
  return `You are drafting a preliminary Australian migration advice letter for review by a Registered Migration Agent.
Use only the supplied structured Subclass 190 decision-engine output.
Do not invent facts, documents, dates, scores, legal outcomes or evidence.
Do not override rule outcomes.
For each criterion, write: criterion, evidence considered, rule finding, legal consequence, and practical recommendation.
If finalPosition.lodgementPosition is NOT_LODGEABLE, do not describe the application as lodgeable.
If evidence is missing, say exactly what evidence is missing.
Avoid generic wording unless tied to a specific rule finding.`;
}

module.exports = { build190AdviceBundle, build190GptSystemPrompt };
