
'use strict';

function buildDelegateLegalAnalysis(input = {}) {
  const issues = [];
  const subclass = String(input.subclass || '').trim();

  if (input.occupationMismatch) {
    issues.push({
      severity: 'high',
      issue: 'ANZSCO alignment exposure',
      delegateConcern:
        'The nominated duties may not align substantially with the claimed occupation classification.',
      strategicResponse:
        'Obtain detailed references, organisational hierarchy evidence and technical duty breakdowns.'
    });
  }

  if (input.missingRegistration) {
    issues.push({
      severity: 'fatal',
      issue: 'Licensing or registration exposure',
      delegateConcern:
        'The applicant may not satisfy mandatory licensing requirements at time of decision.',
      strategicResponse:
        'Obtain evidence of registration eligibility or defer lodgement.'
    });
  }

  return {
    subclass,
    summary:
      'Delegate-grade strategic analysis completed.',
    issues
  };
}

module.exports = {
  buildDelegateLegalAnalysis
};
