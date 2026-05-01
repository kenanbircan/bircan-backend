'use strict';

const { STATUS, SEVERITY, LEGAL_EFFECT } = require('./190.constants');
const { ageAt, daysBetween, lower } = require('./190.utils');
const { mapEvidence } = require('./190.evidence-mapper');
const { calculate190Points } = require('./190.points-calculator');

function finding(input, spec, status, reasoning, recommendation, override = {}) {
  const evidence = mapEvidence(input, spec.ruleId);
  const legalEffect = status === STATUS.PASS ? LEGAL_EFFECT.NO_ADVERSE_FINDING : spec.legalEffect;
  return {
    ruleId: spec.ruleId,
    criterion: spec.criterion,
    legalSource: spec.legalSource,
    decisionLayer: spec.decisionLayer,
    status,
    severity: spec.severity,
    legalEffect,
    evidenceReliedOn: evidence.provided,
    evidenceMissing: status === STATUS.PASS ? [] : evidence.missing,
    evidenceDefects: evidence.defects,
    reasoning,
    recommendation,
    ...override
  };
}

const LS = {
  regs: 'Migration Regulations 1994, Schedule 1 and Schedule 2 criteria for Subclass 190; points-tested skilled migration framework.',
  act: 'Migration Act 1958 and Migration Regulations 1994.'
};

const rules = [
  {
    ruleId: '190_INVITATION_RECEIVED', criterion: 'Valid SkillSelect invitation received', decisionLayer: 'validity', severity: SEVERITY.BLOCKER, legalEffect: LEGAL_EFFECT.INVALID_APPLICATION, legalSource: LS.regs,
    evaluate(input) {
      if (input.skillselect.invitationReceived === true && lower(input.skillselect.invitationSubclass) === '190') return finding(input, this, STATUS.PASS, 'A Subclass 190 SkillSelect invitation is recorded.', 'Verify the invitation letter before lodgement.');
      if (input.skillselect.invitationReceived === false) return finding(input, this, STATUS.FAIL, 'No SkillSelect invitation is recorded. Without an invitation, a Subclass 190 application should not be lodged.', 'Obtain a valid Subclass 190 invitation before proceeding.');
      return finding(input, this, STATUS.UNKNOWN, 'The invitation position cannot be verified from the available answers.', 'Obtain the SkillSelect invitation letter before any lodgement step.');
    }
  },
  {
    ruleId: '190_LODGED_WITHIN_60_DAYS', criterion: 'Lodgement within invitation period', decisionLayer: 'validity', severity: SEVERITY.BLOCKER, legalEffect: LEGAL_EFFECT.INVALID_APPLICATION, legalSource: LS.regs,
    evaluate(input, ctx) {
      const intended = ctx.intendedLodgementDate || new Date();
      const elapsed = daysBetween(input.skillselect.invitationDate, intended);
      if (elapsed === null) return finding(input, this, STATUS.UNKNOWN, 'The invitation date or intended lodgement date is missing, so the invitation period cannot be confirmed.', 'Confirm the invitation date and ensure lodgement occurs within the permitted invitation period.');
      if (elapsed >= 0 && elapsed <= 60) return finding(input, this, STATUS.PASS, `The intended lodgement appears to be ${elapsed} day(s) after invitation.`, 'Verify dates against the invitation letter.');
      return finding(input, this, STATUS.FAIL, `The intended lodgement appears to be ${elapsed} day(s) after invitation. This is outside the standard 60-day invitation period.`, 'Do not lodge on this invitation. Obtain a new invitation if required.');
    }
  },
  {
    ruleId: '190_STATE_NOMINATION_CURRENT', criterion: 'Current state or territory nomination', decisionLayer: 'validity', severity: SEVERITY.BLOCKER, legalEffect: LEGAL_EFFECT.INVALID_APPLICATION, legalSource: LS.regs,
    evaluate(input) {
      const status = lower(input.nomination.nominationStatus);
      if (input.nomination.nominatedByStateOrTerritory === true && status === 'approved') return finding(input, this, STATUS.PASS, 'An approved state or territory nomination is recorded.', 'Verify the nomination approval letter and occupation match.');
      if (['withdrawn', 'refused', 'expired'].includes(status)) return finding(input, this, STATUS.FAIL, `Nomination status is recorded as ${status}. A current approved nomination is not established.`, 'Secure a current nomination before proceeding.');
      if (input.nomination.nominatedByStateOrTerritory === false) return finding(input, this, STATUS.FAIL, 'No state or territory nomination is recorded.', 'Obtain state or territory nomination before proceeding.');
      return finding(input, this, STATUS.UNKNOWN, 'Current nomination cannot be verified from the information supplied.', 'Provide current state or territory nomination approval evidence.');
    }
  },
  {
    ruleId: '190_OCCUPATION_ELIGIBLE', criterion: 'Nominated occupation eligible and aligned', decisionLayer: 'time_of_invitation', severity: SEVERITY.CRITICAL, legalEffect: LEGAL_EFFECT.REFUSAL_LIKELY, legalSource: LS.regs,
    evaluate(input) {
      const s = lower(input.occupation.occupationListStatus);
      if (s === 'eligible') return finding(input, this, STATUS.PASS, 'The nominated occupation is recorded as eligible.', 'Retain evidence of occupation list eligibility at the relevant time.');
      if (s === 'ineligible') return finding(input, this, STATUS.FAIL, 'The nominated occupation is recorded as ineligible.', 'Do not proceed unless occupation eligibility can be legally established.');
      return finding(input, this, STATUS.UNKNOWN, 'Occupation list eligibility has not been confirmed.', 'Confirm occupation eligibility against the relevant state and legislative list at invitation.');
    }
  },
  {
    ruleId: '190_SKILLS_ASSESSMENT_POSITIVE', criterion: 'Positive skills assessment valid at invitation', decisionLayer: 'time_of_invitation', severity: SEVERITY.CRITICAL, legalEffect: LEGAL_EFFECT.REFUSAL_LIKELY, legalSource: LS.regs,
    evaluate(input) {
      if (input.skillsAssessment.hasPositiveSkillsAssessment === true && input.skillsAssessment.validAtInvitationDate === true) return finding(input, this, STATUS.PASS, 'A positive skills assessment valid at invitation is recorded.', 'Verify the assessment outcome letter.');
      if (input.skillsAssessment.hasPositiveSkillsAssessment === false) return finding(input, this, STATUS.FAIL, 'No positive skills assessment is recorded.', 'Obtain a positive skills assessment before relying on this criterion.');
      if (input.skillsAssessment.validAtInvitationDate === false) return finding(input, this, STATUS.FAIL, 'The skills assessment is recorded as not valid at the invitation date.', 'Obtain legal review before proceeding.');
      return finding(input, this, STATUS.UNKNOWN, 'The validity of the skills assessment at invitation cannot be confirmed.', 'Provide the skills assessment outcome letter and validity dates.');
    }
  },
  {
    ruleId: '190_SKILLS_ASSESSMENT_OCCUPATION_MATCH', criterion: 'Skills assessment occupation matches nominated occupation', decisionLayer: 'time_of_invitation', severity: SEVERITY.CRITICAL, legalEffect: LEGAL_EFFECT.REFUSAL_LIKELY, legalSource: LS.regs,
    evaluate(input) {
      const nominated = lower(input.occupation.nominatedOccupation || input.skillselect.invitationOccupation);
      const assessed = lower(input.skillsAssessment.assessedOccupation);
      if (nominated && assessed && nominated === assessed) return finding(input, this, STATUS.PASS, 'The assessed occupation matches the nominated occupation.', 'Verify against the outcome letter and invitation.');
      if (nominated && assessed && nominated !== assessed) return finding(input, this, STATUS.FAIL, `The assessed occupation (${input.skillsAssessment.assessedOccupation}) does not match the nominated occupation (${input.occupation.nominatedOccupation || input.skillselect.invitationOccupation}).`, 'Resolve the occupation mismatch before proceeding.');
      return finding(input, this, STATUS.UNKNOWN, 'Occupation matching cannot be verified because nominated or assessed occupation data is missing.', 'Provide both the invitation/nomination occupation and skills assessment outcome.');
    }
  },
  {
    ruleId: '190_AGE_UNDER_45', criterion: 'Applicant under 45 at invitation', decisionLayer: 'time_of_invitation', severity: SEVERITY.CRITICAL, legalEffect: LEGAL_EFFECT.REFUSAL_LIKELY, legalSource: LS.regs,
    evaluate(input) {
      const age = ageAt(input.applicant.dateOfBirth, input.skillselect.invitationDate);
      if (age === null) return finding(input, this, STATUS.UNKNOWN, 'Age at invitation cannot be calculated because date of birth or invitation date is missing.', 'Confirm date of birth and invitation date.');
      if (age < 45) return finding(input, this, STATUS.PASS, `Applicant was ${age} at invitation.`, 'Verify date of birth against passport.');
      return finding(input, this, STATUS.FAIL, `Applicant was ${age} at invitation, which does not satisfy the under-45 requirement.`, 'Do not proceed without specialist legal review.');
    }
  },
  {
    ruleId: '190_COMPETENT_ENGLISH', criterion: 'Competent English', decisionLayer: 'time_of_invitation', severity: SEVERITY.CRITICAL, legalEffect: LEGAL_EFFECT.REFUSAL_LIKELY, legalSource: LS.regs,
    evaluate(input) {
      const level = lower(input.english.claimedLevel);
      if (['competent', 'proficient', 'superior', 'passport'].includes(level) && input.english.evidenceProvided === true) return finding(input, this, STATUS.PASS, `English is recorded as ${level} with evidence provided.`, 'Verify passport or test result before lodgement.');
      if (['none', 'below competent'].includes(level)) return finding(input, this, STATUS.FAIL, 'Competent English is not recorded.', 'Obtain eligible passport evidence or a valid English test result.');
      return finding(input, this, STATUS.UNKNOWN, 'Competent English cannot be verified from the available information.', 'Provide eligible passport evidence or English test results.');
    }
  },
  {
    ruleId: '190_POINTS_MINIMUM_65', criterion: 'Minimum points score', decisionLayer: 'time_of_invitation', severity: SEVERITY.CRITICAL, legalEffect: LEGAL_EFFECT.REFUSAL_LIKELY, legalSource: LS.regs,
    evaluate(input) {
      const points = calculate190Points(input);
      const total = points.total ?? input.skillselect.invitationPoints ?? input.points.claimedTotal;
      if (total === null || total === undefined) return finding(input, this, STATUS.UNKNOWN, 'The total points score cannot be calculated or verified.', 'Prepare a full points calculation with supporting evidence.', { points });
      if (total >= 65) return finding(input, this, STATUS.PASS, `The recorded points score is ${total}.`, 'Verify each points component against documentary evidence.', { points });
      return finding(input, this, STATUS.FAIL, `The recorded points score is ${total}, below the minimum threshold of 65.`, 'Do not proceed unless the points score can be lawfully established at or above 65.', { points });
    }
  },
  {
    ruleId: '190_POINTS_EVIDENCE_SUPPORTED', criterion: 'Points claims supported by evidence', decisionLayer: 'time_of_decision', severity: SEVERITY.HIGH, legalEffect: LEGAL_EFFECT.REFUSAL_LIKELY, legalSource: LS.regs,
    evaluate(input) {
      const missing = mapEvidence(input, this.ruleId).missing;
      if (missing.length === 0 && (input.evidence || []).some(e => (e.linkedCriteria || []).includes(this.ruleId))) return finding(input, this, STATUS.PASS, 'Evidence is linked to points claims.', 'Review each document for consistency before lodgement.');
      return finding(input, this, STATUS.UNKNOWN, 'The points score may be claimed, but supporting evidence is incomplete or not mapped.', 'Map each points component to documentary evidence.');
    }
  },
  {
    ruleId: '190_SECTION_48_CHECK', criterion: 'Section 48 / onshore application bar', decisionLayer: 'validity', severity: SEVERITY.BLOCKER, legalEffect: LEGAL_EFFECT.INVALID_APPLICATION, legalSource: LS.act,
    evaluate(input) {
      const onshore = lower(input.applicant.currentLocation).includes('australia');
      if (input.applicant.section48BarRisk === true && onshore) return finding(input, this, STATUS.FAIL, 'Section 48 risk is recorded and the applicant appears to be in Australia.', 'Do not lodge onshore without confirming whether an available exception applies.');
      if (input.applicant.section48BarRisk === false) return finding(input, this, STATUS.PASS, 'No section 48 bar risk is recorded.', 'Verify current visa and refusal history.');
      return finding(input, this, STATUS.UNKNOWN, 'Section 48 position cannot be confirmed.', 'Review visa history, refusal notices and current location.');
    }
  },
  {
    ruleId: '190_NO_FURTHER_STAY_CHECK', criterion: 'No further stay condition', decisionLayer: 'validity', severity: SEVERITY.BLOCKER, legalEffect: LEGAL_EFFECT.INVALID_APPLICATION, legalSource: LS.act,
    evaluate(input) {
      if (input.applicant.noFurtherStayCondition === true) return finding(input, this, STATUS.FAIL, 'A no further stay condition is recorded.', 'Do not lodge unless a waiver or valid pathway is confirmed.');
      if (input.applicant.noFurtherStayCondition === false) return finding(input, this, STATUS.PASS, 'No no-further-stay condition is recorded.', 'Verify against the current visa grant notice.');
      return finding(input, this, STATUS.UNKNOWN, 'No further stay condition status cannot be confirmed.', 'Review the current visa grant notice.');
    }
  },
  {
    ruleId: '190_HEALTH_PIC', criterion: 'Health requirement', decisionLayer: 'time_of_decision', severity: SEVERITY.HIGH, legalEffect: LEGAL_EFFECT.DISCRETIONARY_RISK, legalSource: LS.act,
    evaluate(input) {
      if (input.healthCharacterIntegrity.healthIssueDisclosed === true) return finding(input, this, STATUS.RISK, 'Health issues are disclosed.', 'Obtain health examination results and specialist advice before final advice.');
      if (input.healthCharacterIntegrity.healthIssueDisclosed === false) return finding(input, this, STATUS.PASS, 'No health issue is disclosed.', 'Health examinations may still be required by the Department.');
      return finding(input, this, STATUS.UNKNOWN, 'Health position cannot be confirmed.', 'Confirm health disclosures and obtain health examination results when available.');
    }
  },
  {
    ruleId: '190_CHARACTER_PIC', criterion: 'Character requirement', decisionLayer: 'time_of_decision', severity: SEVERITY.HIGH, legalEffect: LEGAL_EFFECT.DISCRETIONARY_RISK, legalSource: LS.act,
    evaluate(input) {
      if (input.healthCharacterIntegrity.characterIssueDisclosed === true) return finding(input, this, STATUS.RISK, 'Character issues are disclosed.', 'Obtain police clearances and court documents for legal review.');
      if (input.healthCharacterIntegrity.characterIssueDisclosed === false) return finding(input, this, STATUS.PASS, 'No character issue is disclosed.', 'Police clearances may still be required.');
      return finding(input, this, STATUS.UNKNOWN, 'Character position cannot be confirmed.', 'Confirm character disclosures and obtain police clearances.');
    }
  },
  {
    ruleId: '190_PIC_4020', criterion: 'Integrity / PIC 4020 risk', decisionLayer: 'time_of_decision', severity: SEVERITY.CRITICAL, legalEffect: LEGAL_EFFECT.REFUSAL_LIKELY, legalSource: LS.act,
    evaluate(input) {
      if (input.healthCharacterIntegrity.pic4020IssueDisclosed === true || input.healthCharacterIntegrity.previousFalseDocumentConcern === true) return finding(input, this, STATUS.RISK, 'Integrity or false-document concerns are disclosed.', 'Conduct manual legal review before any lodgement step.');
      if (input.healthCharacterIntegrity.pic4020IssueDisclosed === false && input.healthCharacterIntegrity.previousFalseDocumentConcern === false) return finding(input, this, STATUS.PASS, 'No integrity issue is disclosed.', 'Check prior applications and documents for consistency.');
      return finding(input, this, STATUS.UNKNOWN, 'Integrity position cannot be confirmed.', 'Review all prior Department correspondence and documents.');
    }
  },
  {
    ruleId: '190_FAMILY_UNIT_MEMBERS', criterion: 'Included family members', decisionLayer: 'time_of_decision', severity: SEVERITY.MEDIUM, legalEffect: LEGAL_EFFECT.EVIDENCE_GAP, legalSource: LS.act,
    evaluate(input) {
      const family = input.familyMembers || [];
      const risky = family.filter(m => m.includedInApplication && (m.custodyIssue === true || m.dependencyEvidenceProvided === false));
      if (!family.length) return finding(input, this, STATUS.NOT_APPLICABLE, 'No included family members are recorded.', 'No family-unit evidence issue identified from the answers.');
      if (risky.length) return finding(input, this, STATUS.RISK, 'One or more included family members require relationship, custody or dependency evidence.', 'Obtain complete family-unit documents before lodgement.');
      return finding(input, this, STATUS.PASS, 'No family-unit issue is apparent from the answers.', 'Verify relationship documents before lodgement.');
    }
  }
];

function run190Rules(input, ctx = {}) {
  return rules.map(rule => rule.evaluate(input, ctx));
}

module.exports = { rules, run190Rules };
