
'use strict';

function assessLodgementReadiness(risk = {}) {
  if (risk.band === 'critical') {
    return 'Not presently suitable for lodgement';
  }

  if (risk.band === 'high') {
    return 'Further evidence reconciliation recommended before lodgement';
  }

  if (risk.band === 'moderate') {
    return 'Conditional lodgement readiness';
  }

  return 'Generally suitable for lodgement subject to final review';
}

module.exports = {
  assessLodgementReadiness
};
