
'use strict';

function evaluateEvidenceWeight(evidence = []) {
  return evidence.map(item => {
    if (item.type === 'tax_record') {
      return { ...item, weight: 'high' };
    }

    if (item.type === 'statutory_declaration') {
      return { ...item, weight: 'moderate' };
    }

    return { ...item, weight: 'low' };
  });
}

module.exports = {
  evaluateEvidenceWeight
};
