
'use strict';

function calculateRiskScore(input = {}) {
  let score = 0;

  if (input.missingCriticalEvidence) score += 35;
  if (input.timelineInconsistency) score += 25;
  if (input.noRegistration) score += 40;
  if (input.weakEmployerEvidence) score += 20;

  let band = 'low';

  if (score >= 70) band = 'critical';
  else if (score >= 45) band = 'high';
  else if (score >= 20) band = 'moderate';

  return {
    score,
    band
  };
}

module.exports = {
  calculateRiskScore
};
