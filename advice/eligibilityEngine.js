'use strict';

function countRegistryCriteria(registry) {
  const containers = [registry.criteria, registry.criteriaGroups, registry.grantCriteria, registry.requirements].filter(Boolean);
  let count = 0;
  const walk = (value) => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value === 'object') {
      if (value.criterion || value.code || value.id || value.label || value.title) count += 1;
      Object.keys(value).forEach(k => walk(value[k]));
    }
  };
  containers.forEach(walk);
  return count;
}

function runEligibilityEngine(normalised, registry) {
  const risks = [];
  const missingEvidence = [];
  const strengths = [];
  const requiredActions = [];

  if (!normalised.subclass) risks.push('Visa subclass was not identified from the assessment record.');
  if (!normalised.pathway) missingEvidence.push('Selected stream/pathway must be confirmed before final advice is released.');
  if (!normalised.applicantName) missingEvidence.push('Applicant identity/name details should be confirmed.');
  if (!normalised.evidence || !Object.keys(normalised.evidence).length) missingEvidence.push('Evidence upload/availability position is incomplete.');
  if (normalised.subclass) strengths.push(`Assessment record identifies subclass ${normalised.subclass}.`);
  if (normalised.pathway) strengths.push(`Assessment record identifies pathway/stream: ${normalised.pathway}.`);

  const criteriaCount = countRegistryCriteria(registry);
  if (criteriaCount < 6) risks.push('Criteria registry appears too thin for advice-grade assessment.');

  requiredActions.push('Registered migration agent review required before release if any legal or evidence gap remains.');

  const outcome = risks.length || missingEvidence.length ? 'possible_with_issues' : 'likely_suitable_subject_to_evidence';
  return {
    outcome,
    criteriaCount,
    risks,
    missingEvidence,
    strengths,
    requiredActions,
    generatedAt: new Date().toISOString()
  };
}

module.exports = { runEligibilityEngine };
