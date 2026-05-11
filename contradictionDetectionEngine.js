
'use strict';

function detectContradictions(data = {}) {
  const findings = [];

  if (
    data.claimedEmploymentStart &&
    data.taxRecordStart &&
    data.claimedEmploymentStart !== data.taxRecordStart
  ) {
    findings.push({
      severity: 'high',
      type: 'timeline inconsistency',
      detail:
        'Claimed employment commencement differs from taxation record chronology.'
    });
  }

  if (
    data.claimedOccupation &&
    data.actualDuties &&
    data.actualDuties.includes('clerical')
  ) {
    findings.push({
      severity: 'moderate',
      type: 'occupation inconsistency',
      detail:
        'Operational or clerical duties may weaken professional occupation positioning.'
    });
  }

  return findings;
}

module.exports = {
  detectContradictions
};
