'use strict';

const { asBool, normaliseString, lower, numberOrNull } = require('./190.utils');

function pick(obj, keys, fallback = null) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return fallback;
}

function normalise190Input(raw = {}) {
  const q = raw.answers || raw.questionnaire || raw.formData || raw;
  const applicant = raw.applicant || q.applicant || {};
  const skillselect = raw.skillselect || q.skillselect || {};
  const nomination = raw.nomination || q.nomination || {};
  const occupation = raw.occupation || q.occupation || {};
  const skillsAssessment = raw.skillsAssessment || raw.skills_assessment || q.skillsAssessment || q.skills_assessment || {};
  const english = raw.english || q.english || {};
  const points = raw.points || q.points || {};
  const risks = raw.healthCharacterIntegrity || raw.risks || q.healthCharacterIntegrity || q.risks || {};

  return {
    reference: pick(raw, ['reference', 'submissionId', 'id'], null),
    subclass: '190',
    applicant: {
      fullName: normaliseString(pick(applicant, ['fullName', 'name', 'applicantName'], pick(q, ['fullName', 'applicantName', 'name'], ''))),
      dateOfBirth: pick(applicant, ['dateOfBirth', 'dob'], pick(q, ['dateOfBirth', 'dob'], null)),
      passportCountry: normaliseString(pick(applicant, ['passportCountry', 'citizenship', 'countryOfPassport'], pick(q, ['passportCountry', 'citizenship'], ''))),
      currentLocation: normaliseString(pick(applicant, ['currentLocation', 'location'], pick(q, ['currentLocation'], 'unknown'))),
      currentVisaSubclass: normaliseString(pick(applicant, ['currentVisaSubclass', 'currentVisa'], pick(q, ['currentVisaSubclass', 'currentVisa'], ''))),
      visaExpiryDate: pick(applicant, ['visaExpiryDate'], pick(q, ['visaExpiryDate'], null)),
      previousRefusalInAustralia: asBool(pick(applicant, ['previousRefusalInAustralia', 'previousRefusal'], pick(q, ['previousRefusalInAustralia', 'previousRefusal'], null))),
      section48BarRisk: asBool(pick(applicant, ['section48BarRisk', 'section48', 's48'], pick(q, ['section48BarRisk', 'section48', 's48'], null))),
      noFurtherStayCondition: asBool(pick(applicant, ['noFurtherStayCondition', '8503', '8534', '8535'], pick(q, ['noFurtherStayCondition', '8503', '8534', '8535'], null)))
    },
    skillselect: {
      eoiSubmitted: asBool(pick(skillselect, ['eoiSubmitted'], pick(q, ['eoiSubmitted'], null))),
      eoiId: normaliseString(pick(skillselect, ['eoiId', 'EOI'], pick(q, ['eoiId', 'EOI'], ''))),
      invitationReceived: asBool(pick(skillselect, ['invitationReceived', 'hasInvitation'], pick(q, ['invitationReceived', 'hasInvitation'], null))),
      invitationDate: pick(skillselect, ['invitationDate'], pick(q, ['invitationDate'], null)),
      invitationSubclass: normaliseString(pick(skillselect, ['invitationSubclass'], pick(q, ['invitationSubclass'], ''))),
      invitationOccupation: normaliseString(pick(skillselect, ['invitationOccupation'], pick(q, ['invitationOccupation'], ''))),
      invitationPoints: numberOrNull(pick(skillselect, ['invitationPoints'], pick(q, ['invitationPoints'], null)))
    },
    nomination: {
      nominatedByStateOrTerritory: asBool(pick(nomination, ['nominatedByStateOrTerritory', 'hasNomination'], pick(q, ['nominatedByStateOrTerritory', 'hasNomination'], null))),
      nominatingState: normaliseString(pick(nomination, ['nominatingState', 'state'], pick(q, ['nominatingState', 'state'], ''))),
      nominationStatus: lower(pick(nomination, ['nominationStatus', 'status'], pick(q, ['nominationStatus'], 'unknown'))),
      nominationApprovalDate: pick(nomination, ['nominationApprovalDate'], pick(q, ['nominationApprovalDate'], null)),
      nominationOccupation: normaliseString(pick(nomination, ['nominationOccupation'], pick(q, ['nominationOccupation'], '')))
    },
    occupation: {
      nominatedOccupation: normaliseString(pick(occupation, ['nominatedOccupation', 'occupation'], pick(q, ['nominatedOccupation', 'occupation'], ''))),
      anzscoCode: normaliseString(pick(occupation, ['anzscoCode'], pick(q, ['anzscoCode'], ''))),
      occupationListStatus: lower(pick(occupation, ['occupationListStatus'], pick(q, ['occupationListStatus'], 'unknown')))
    },
    skillsAssessment: {
      hasPositiveSkillsAssessment: asBool(pick(skillsAssessment, ['hasPositiveSkillsAssessment', 'positiveSkillsAssessment', 'hasSkillsAssessment'], pick(q, ['hasPositiveSkillsAssessment', 'positiveSkillsAssessment', 'hasSkillsAssessment'], null))),
      assessingAuthority: normaliseString(pick(skillsAssessment, ['assessingAuthority'], pick(q, ['assessingAuthority'], ''))),
      outcomeDate: pick(skillsAssessment, ['outcomeDate', 'skillsAssessmentDate'], pick(q, ['outcomeDate', 'skillsAssessmentDate'], null)),
      expiryDate: pick(skillsAssessment, ['expiryDate', 'skillsAssessmentExpiry'], pick(q, ['expiryDate', 'skillsAssessmentExpiry'], null)),
      assessedOccupation: normaliseString(pick(skillsAssessment, ['assessedOccupation'], pick(q, ['assessedOccupation'], ''))),
      validAtInvitationDate: asBool(pick(skillsAssessment, ['validAtInvitationDate'], pick(q, ['validAtInvitationDate'], null)))
    },
    english: {
      claimedLevel: lower(pick(english, ['claimedLevel', 'level'], pick(q, ['englishLevel', 'claimedEnglishLevel'], 'unknown'))),
      testType: normaliseString(pick(english, ['testType'], pick(q, ['englishTestType'], ''))),
      testDate: pick(english, ['testDate'], pick(q, ['englishTestDate'], null)),
      evidenceProvided: asBool(pick(english, ['evidenceProvided'], pick(q, ['englishEvidenceProvided'], null))),
      scores: english.scores || q.englishScores || null
    },
    points: {
      claimedTotal: numberOrNull(pick(points, ['claimedTotal', 'total'], pick(q, ['claimedPoints', 'pointsTotal'], null))),
      breakdown: points.breakdown || q.pointsBreakdown || {}
    },
    healthCharacterIntegrity: {
      healthIssueDisclosed: asBool(pick(risks, ['healthIssueDisclosed', 'healthIssue'], pick(q, ['healthIssueDisclosed', 'healthIssue'], null))),
      characterIssueDisclosed: asBool(pick(risks, ['characterIssueDisclosed', 'characterIssue'], pick(q, ['characterIssueDisclosed', 'characterIssue'], null))),
      pic4020IssueDisclosed: asBool(pick(risks, ['pic4020IssueDisclosed', 'pic4020Issue'], pick(q, ['pic4020IssueDisclosed', 'pic4020Issue'], null))),
      previousFalseDocumentConcern: asBool(pick(risks, ['previousFalseDocumentConcern'], pick(q, ['previousFalseDocumentConcern'], null))),
      debtToCommonwealth: asBool(pick(risks, ['debtToCommonwealth'], pick(q, ['debtToCommonwealth'], null)))
    },
    familyMembers: Array.isArray(raw.familyMembers || q.familyMembers) ? (raw.familyMembers || q.familyMembers) : [],
    evidence: Array.isArray(raw.evidence || q.evidence) ? (raw.evidence || q.evidence) : []
  };
}

module.exports = { normalise190Input };
