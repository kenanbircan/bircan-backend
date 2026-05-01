'use strict';

const REQUIRED_EVIDENCE_BY_RULE = Object.freeze({
  '190_INVITATION_RECEIVED': ['SkillSelect invitation letter showing subclass, occupation, date and points.'],
  '190_LODGED_WITHIN_60_DAYS': ['SkillSelect invitation letter and intended lodgement date.'],
  '190_STATE_NOMINATION_CURRENT': ['Current state or territory nomination approval letter.'],
  '190_OCCUPATION_ELIGIBLE': ['Occupation list / state nomination evidence confirming the occupation was eligible.'],
  '190_SKILLS_ASSESSMENT_POSITIVE': ['Positive skills assessment outcome letter.'],
  '190_SKILLS_ASSESSMENT_OCCUPATION_MATCH': ['Skills assessment outcome matching nominated occupation.'],
  '190_AGE_UNDER_45': ['Passport biodata page and SkillSelect invitation date.'],
  '190_COMPETENT_ENGLISH': ['Eligible passport or valid English test result.'],
  '190_POINTS_MINIMUM_65': ['Full points schedule and documents supporting each points claim.'],
  '190_POINTS_EVIDENCE_SUPPORTED': ['Evidence for age, English, qualifications, employment, partner and nomination points.'],
  '190_SECTION_48_CHECK': ['Current visa status, refusal notices, bridging visa grant notices and location evidence.'],
  '190_NO_FURTHER_STAY_CHECK': ['Current visa grant notice and any waiver decision.'],
  '190_HEALTH_PIC': ['Health examination results and specialist reports, if relevant.'],
  '190_CHARACTER_PIC': ['Police clearances, court records and character submissions, if relevant.'],
  '190_PIC_4020': ['All prior Department correspondence and copies of documents previously lodged.'],
  '190_FAMILY_UNIT_MEMBERS': ['Relationship, dependency and custody evidence for included family members.']
});

function mapEvidence(input, ruleId) {
  const evidence = input.evidence || [];
  const linked = evidence.filter(e => Array.isArray(e.linkedCriteria) && e.linkedCriteria.includes(ruleId));
  return {
    required: REQUIRED_EVIDENCE_BY_RULE[ruleId] || [],
    provided: linked.filter(e => e.provided !== false).map(e => e.label || e.type || e.evidenceId),
    missing: linked.length ? linked.filter(e => e.provided === false).map(e => e.label || e.type || e.evidenceId) : (REQUIRED_EVIDENCE_BY_RULE[ruleId] || []),
    defects: linked.flatMap(e => e.defects || [])
  };
}

function buildEvidenceChecklist(findings) {
  const mandatoryBeforeLodgement = [];
  const requiredBeforeFinalAdvice = [];
  const recommendedSupportingDocuments = [];

  for (const f of findings) {
    const missing = f.evidenceMissing || [];
    if (!missing.length) continue;
    if (f.severity === 'blocker' || f.legalEffect === 'invalid_application') mandatoryBeforeLodgement.push(...missing);
    else if (['critical', 'high'].includes(f.severity)) requiredBeforeFinalAdvice.push(...missing);
    else recommendedSupportingDocuments.push(...missing);
  }

  const uniq = arr => [...new Set(arr)];
  return {
    mandatoryBeforeLodgement: uniq(mandatoryBeforeLodgement),
    requiredBeforeFinalAdvice: uniq(requiredBeforeFinalAdvice),
    recommendedSupportingDocuments: uniq(recommendedSupportingDocuments)
  };
}

module.exports = { mapEvidence, buildEvidenceChecklist, REQUIRED_EVIDENCE_BY_RULE };
