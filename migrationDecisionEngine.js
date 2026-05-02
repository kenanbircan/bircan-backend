'use strict';

/**
 * migrationDecisionEngine.js
 * Single-file, dependency-free Migration Decision Engine.
 *
 * Purpose:
 * - Deterministic delegate-simulator layer for supported subclasses.
 * - GPT may still be used elsewhere for drafting, but this file produces the controlling
 *   risk level, lodgement position, criteria findings, evidence gaps and next steps.
 * - No external imports. Safe for Render deployment beside server.js.
 *
 * Expected server.js import:
 *   const { runDecisionEngine, buildLegalEngineBundle } = require('./migrationDecisionEngine');
 *
 * Expected server.js use:
 *   const decision = runDecisionEngine(assessment);
 *   const adviceBundle = buildLegalEngineBundle(decision, assessment);
 */

const SUPPORTED_SUBCLASSES = [
  '189', '190', '491',
  '482', '186', '187', '494',
  '500', '600',
  '820', '309', '300',
  '866'
];

const GROUPS = {
  skilled: ['189', '190', '491'],
  employer: ['482', '186', '187', '494'],
  studentVisitor: ['500', '600'],
  partnerFamily: ['820', '309', '300'],
  protection: ['866']
};

function normaliseSubclass(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function flattenObject(input, prefix = '', out = {}) {
  if (!isPlainObject(input)) return out;
  for (const [k, v] of Object.entries(input)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flattenObject(v, key, out);
    else if (Array.isArray(v)) out[key] = v.map(x => isPlainObject(x) ? JSON.stringify(x) : String(x)).join('; ');
    else if (v !== undefined && v !== null && String(v).trim() !== '') out[key] = v;
  }
  return out;
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function toText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

function textIncludesAny(value, words) {
  const t = toText(value).toLowerCase();
  return words.some(w => t.includes(String(w).toLowerCase()));
}

function isAffirmative(v) {
  const t = toText(v).toLowerCase();
  if (!t) return false;
  return ['yes', 'true', 'y', 'approved', 'valid', 'current', 'held', 'positive', 'suitable', 'met', 'pass', 'paid'].some(x => t === x || t.includes(x));
}

function isNegative(v) {
  const t = toText(v).toLowerCase();
  if (!t) return false;
  return ['no', 'false', 'n', 'refused', 'withdrawn', 'expired', 'invalid', 'not held', 'not met', 'fail', 'failed', 'none'].some(x => t === x || t.includes(x));
}

function getPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).split('.').reduce((acc, part) => acc && acc[part] !== undefined ? acc[part] : undefined, obj);
}

function pickFrom(keys, ctx) {
  const { answers, flat } = ctx;
  for (const key of keys) {
    const direct = getPath(answers, key);
    if (direct !== undefined && direct !== null && String(direct).trim() !== '') return direct;
    if (flat[key] !== undefined && flat[key] !== null && String(flat[key]).trim() !== '') return flat[key];
  }
  const lowerFlat = Object.fromEntries(Object.entries(flat).map(([k, v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    const target = String(key).toLowerCase();
    for (const [k, v] of Object.entries(lowerFlat)) {
      if (k.endsWith(target) || k.includes(target)) return v;
    }
  }
  return null;
}

function numberFrom(v) {
  if (v === undefined || v === null) return null;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function normaliseAssessmentInput(assessmentOrPayload) {
  const assessment = assessmentOrPayload && assessmentOrPayload.form_payload !== undefined
    ? assessmentOrPayload
    : { form_payload: assessmentOrPayload || {} };

  const payload = assessment.form_payload || {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload.formData || payload.data || payload;
  const flat = flattenObject(answers || {});
  const subclass = normaliseSubclass(assessment.visa_type || payload?.meta?.visaType || payload?.visaType || answers?.visaType || answers?.subclass);

  return { assessment, payload, answers: answers || {}, flat, subclass };
}

function makeFinding({
  ruleId,
  criterion,
  status,
  severity,
  legalEffect,
  decisionLayer,
  evidenceConsidered,
  evidenceGap,
  finding,
  legalConsequence,
  recommendation
}) {
  const safeStatus = ['pass', 'fail', 'unknown', 'risk'].includes(status) ? status : 'unknown';
  const safeSeverity = severity || (safeStatus === 'fail' ? 'critical' : 'medium');
  const safeEffect = legalEffect || (safeStatus === 'fail' ? 'REFUSAL_LIKELY' : 'EVIDENCE_GAP');
  return {
    ruleId,
    criterion,
    status: safeStatus,
    severity: safeSeverity,
    legalEffect: safeEffect,
    decisionLayer: decisionLayer || 'time_of_decision',
    evidenceConsidered: evidenceConsidered || 'Questionnaire answers only; original documents have not been verified.',
    finding: finding || defaultFinding(criterion, safeStatus),
    legalConsequence: legalConsequence || defaultConsequence(safeEffect),
    evidenceGap: evidenceGap || defaultEvidenceGap(criterion, safeStatus),
    recommendation: recommendation || defaultRecommendation(safeEffect, safeStatus)
  };
}

function defaultFinding(criterion, status) {
  if (status === 'pass') return `${criterion} appears satisfied on the answers provided, subject to document verification.`;
  if (status === 'fail') return `${criterion} is not satisfied on the answers provided or required evidence has not been identified.`;
  if (status === 'risk') return `${criterion} raises a risk requiring legal review before lodgement.`;
  return `${criterion} cannot be safely treated as met because the required facts or documents are incomplete.`;
}

function defaultConsequence(effect) {
  switch (effect) {
    case 'INVALID_APPLICATION': return 'This may prevent a valid application from being made unless resolved before lodgement.';
    case 'REFUSAL_LIKELY': return 'If not resolved, this is likely to create a refusal risk.';
    case 'DISCRETIONARY_RISK': return 'This requires discretionary or merits-based assessment and should be reviewed before any strategy is recommended.';
    default: return 'Further evidence is required before a reliable legal conclusion can be reached.';
  }
}

function defaultEvidenceGap(criterion, status) {
  if (status === 'pass') return 'Original supporting document must still be checked and retained on file.';
  return `Evidence required to verify: ${criterion}.`;
}

function defaultRecommendation(effect, status) {
  if (status === 'pass') return 'Verify the original evidence before relying on this criterion.';
  if (effect === 'INVALID_APPLICATION') return 'Do not lodge until this validity issue is resolved.';
  if (effect === 'REFUSAL_LIKELY') return 'Resolve this criterion and obtain supporting evidence before lodgement.';
  if (effect === 'DISCRETIONARY_RISK') return 'Obtain documents and conduct a legal review before proceeding.';
  return 'Request further evidence before final advice.';
}

function evaluateBoolean(ctx, keys) {
  const v = pickFrom(keys, ctx);
  if (v === null) return 'unknown';
  if (isAffirmative(v)) return 'pass';
  if (isNegative(v)) return 'fail';
  return 'unknown';
}

function evaluateRiskNoIssue(ctx, keys) {
  const v = pickFrom(keys, ctx);
  if (v === null) return 'unknown';
  if (isNegative(v) || textIncludesAny(v, ['none', 'no issue', 'no problem', 'not applicable'])) return 'pass';
  if (isAffirmative(v) || textIncludesAny(v, ['issue', 'concern', 'yes', 'criminal', 'medical', 'false', 'misleading', 'refusal', 'cancellation'])) return 'risk';
  return 'unknown';
}

function hasAnyEvidence(ctx, keys) {
  return pickFrom(keys, ctx) !== null;
}

function pointsStatus(ctx) {
  const points = numberFrom(pickFrom(['points', 'points.total', 'claimedPoints', 'totalPoints', 'passMark', 'pointsScore', 'engineCalculatedTotal'], ctx));
  if (points === null) return 'unknown';
  return points >= 65 ? 'pass' : 'fail';
}

function ageUnder45Status(ctx) {
  const age = numberFrom(pickFrom(['age', 'applicant.age', 'ageAtInvitation', 'age_at_invitation'], ctx));
  if (age !== null) return age < 45 ? 'pass' : 'fail';
  const dob = pickFrom(['dateOfBirth', 'dob', 'applicant.dateOfBirth', 'applicant.dob'], ctx);
  if (dob) return 'unknown';
  return 'unknown';
}

function healthCharacterIntegrityFindings(ctx) {
  return [
    makeFinding({
      ruleId: 'COMMON_HEALTH',
      criterion: 'Health requirement',
      status: evaluateRiskNoIssue(ctx, ['health', 'healthIssue', 'healthIssues', 'medicalIssue', 'healthRequirement']),
      severity: 'high',
      legalEffect: 'DISCRETIONARY_RISK',
      evidenceGap: 'Health examinations, medical reports and waiver-related evidence if applicable.',
      recommendation: 'Review health evidence before final advice or lodgement.'
    }),
    makeFinding({
      ruleId: 'COMMON_CHARACTER',
      criterion: 'Character requirement',
      status: evaluateRiskNoIssue(ctx, ['character', 'characterIssue', 'criminalHistory', 'policeClearance', 'courtMatter']),
      severity: 'high',
      legalEffect: 'DISCRETIONARY_RISK',
      evidenceGap: 'Police certificates, court documents and character submissions if required.',
      recommendation: 'Obtain police and court documents before final advice.'
    }),
    makeFinding({
      ruleId: 'COMMON_INTEGRITY_PIC4020',
      criterion: 'Integrity / PIC 4020 risk',
      status: evaluateRiskNoIssue(ctx, ['pic4020', 'integrity', 'falseDocument', 'misleadingInformation', 'previousFalseDocumentConcern']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Prior application records, Department correspondence and copies of documents previously submitted.',
      recommendation: 'Conduct an integrity review before any lodgement action.'
    })
  ];
}

function skilledBase(ctx) {
  const subclass = ctx.subclass;
  const findings = [];
  findings.push(makeFinding({
    ruleId: `${subclass}_INVITATION`,
    criterion: 'Valid SkillSelect invitation',
    status: evaluateBoolean(ctx, ['invitation', 'skillselect.invitationReceived', 'invitationReceived', 'hasInvitation', 'skillSelectInvitation']),
    severity: 'blocker',
    legalEffect: 'INVALID_APPLICATION',
    decisionLayer: 'validity',
    evidenceGap: 'SkillSelect invitation letter showing subclass, invitation date, nominated occupation and points score.',
    recommendation: 'Do not lodge until a valid invitation is verified.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_OCCUPATION`,
    criterion: 'Nominated occupation eligibility',
    status: hasAnyEvidence(ctx, ['occupation', 'nominatedOccupation', 'anzsco', 'anzscoCode']) ? 'unknown' : 'unknown',
    severity: 'critical',
    legalEffect: 'REFUSAL_LIKELY',
    evidenceGap: 'Nominated occupation, ANZSCO code and relevant occupation list evidence at the relevant time.',
    recommendation: 'Confirm occupation list eligibility and alignment with the invitation and skills assessment.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_SKILLS`,
    criterion: 'Suitable skills assessment',
    status: evaluateBoolean(ctx, ['skillsAssessment', 'skills_assessment', 'hasSkillsAssessment', 'positiveSkillsAssessment', 'skillsAssessment.valid', 'skillsAssessment.hasPositiveSkillsAssessment']),
    severity: 'critical',
    legalEffect: 'REFUSAL_LIKELY',
    evidenceGap: 'Skills assessment outcome letter, assessing authority, occupation and validity at invitation.',
    recommendation: 'Obtain and verify the skills assessment before relying on this pathway.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_AGE`,
    criterion: 'Age requirement',
    status: ageUnder45Status(ctx),
    severity: 'critical',
    legalEffect: 'REFUSAL_LIKELY',
    evidenceGap: 'Passport biodata page and invitation date evidence to confirm age at invitation.',
    recommendation: 'Verify age at invitation before final advice.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_ENGLISH`,
    criterion: 'English language requirement',
    status: evaluateBoolean(ctx, ['english', 'englishEvidence', 'competentEnglish', 'englishTest', 'english.claimedLevel', 'english.evidenceProvided']),
    severity: 'critical',
    legalEffect: 'REFUSAL_LIKELY',
    evidenceGap: 'English test results or eligible passport evidence.',
    recommendation: 'Verify English evidence before lodgement.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_POINTS`,
    criterion: 'Points test threshold',
    status: pointsStatus(ctx),
    severity: 'critical',
    legalEffect: 'REFUSAL_LIKELY',
    evidenceGap: 'Full points calculation and documents supporting each claimed point category.',
    recommendation: 'Complete a points calculation before final advice.'
  }));
  return findings;
}

function run189(ctx) {
  return [
    ...skilledBase(ctx),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function run190(ctx) {
  return [
    ...skilledBase(ctx),
    makeFinding({
      ruleId: '190_STATE_NOMINATION',
      criterion: 'Current state or territory nomination',
      status: evaluateBoolean(ctx, ['nomination', 'stateNomination', 'territoryNomination', 'nominatedByStateOrTerritory', 'nomination.status', 'stateNominationApproved']),
      severity: 'blocker',
      legalEffect: 'INVALID_APPLICATION',
      decisionLayer: 'validity',
      evidenceGap: 'State or territory nomination approval letter confirming current nomination and nominated occupation.',
      recommendation: 'Do not lodge until a current nomination is verified.'
    }),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function run491(ctx) {
  const nominationOrSponsor = evaluateBoolean(ctx, ['nomination', 'stateNomination', 'regionalNomination', 'familySponsor', 'eligibleFamilySponsor', 'sponsorship']);
  return [
    ...skilledBase(ctx),
    makeFinding({
      ruleId: '491_NOMINATION_OR_SPONSORSHIP',
      criterion: 'State/territory nomination or eligible family sponsorship',
      status: nominationOrSponsor,
      severity: 'blocker',
      legalEffect: 'INVALID_APPLICATION',
      decisionLayer: 'validity',
      evidenceGap: 'Regional nomination approval or eligible family sponsorship evidence.',
      recommendation: 'Verify nomination or sponsorship before lodgement.'
    }),
    makeFinding({
      ruleId: '491_REGIONAL_REQUIREMENT',
      criterion: 'Designated regional requirement',
      status: evaluateBoolean(ctx, ['regional', 'designatedRegional', 'regionalArea', 'regionalRequirement']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Evidence linking residence, employment, study or sponsorship to the relevant regional area.',
      recommendation: 'Confirm regional eligibility before proceeding.'
    }),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function employerBase(ctx) {
  const subclass = ctx.subclass;
  const findings = [];
  findings.push(makeFinding({
    ruleId: `${subclass}_SPONSOR`,
    criterion: 'Approved sponsor / eligible employer',
    status: evaluateBoolean(ctx, ['sponsor', 'approvedSponsor', 'sponsorApproved', 'employerSponsor', 'businessSponsor']),
    severity: 'blocker',
    legalEffect: 'INVALID_APPLICATION',
    decisionLayer: 'validity',
    evidenceGap: 'Sponsor approval, ABN/business evidence and evidence the employer is lawfully operating.',
    recommendation: 'Verify the sponsor or employer before proceeding.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_NOMINATION`,
    criterion: 'Approved nomination / nomination eligibility',
    status: evaluateBoolean(ctx, ['nomination', 'nominationApproved', 'employerNomination', 'positionNomination', 'nomination.status']),
    severity: 'blocker',
    legalEffect: 'INVALID_APPLICATION',
    decisionLayer: 'validity',
    evidenceGap: 'Nomination approval or nomination application evidence, occupation, salary and position details.',
    recommendation: 'Do not proceed until nomination eligibility is verified.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_GENUINE_POSITION`,
    criterion: 'Genuine position',
    status: evaluateBoolean(ctx, ['genuinePosition', 'positionGenuine', 'genuineRole', 'position.genuine']),
    severity: 'critical',
    legalEffect: 'REFUSAL_LIKELY',
    evidenceGap: 'Position description, organisational chart, business need evidence and employment contract.',
    recommendation: 'Verify that the role is genuine and required by the business.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_OCCUPATION`,
    criterion: 'Occupation eligibility and duties alignment',
    status: hasAnyEvidence(ctx, ['occupation', 'nominatedOccupation', 'anzsco', 'positionTitle']) ? 'unknown' : 'unknown',
    severity: 'critical',
    legalEffect: 'REFUSAL_LIKELY',
    evidenceGap: 'ANZSCO, occupation list evidence, duty statement and employment contract.',
    recommendation: 'Confirm occupation eligibility and duties alignment.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_SALARY`,
    criterion: 'Salary / market salary requirement',
    status: evaluateBoolean(ctx, ['salary', 'marketSalary', 'annualMarketSalaryRate', 'tsmit', 'incomeThreshold']),
    severity: 'critical',
    legalEffect: 'REFUSAL_LIKELY',
    evidenceGap: 'Salary evidence, market salary comparison, contract and payslips if relevant.',
    recommendation: 'Verify salary and market salary compliance before lodgement.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_SKILLS_EXPERIENCE`,
    criterion: 'Skills and work experience',
    status: evaluateBoolean(ctx, ['skills', 'workExperience', 'relevantExperience', 'employmentExperience', 'experienceYears', 'skillsAssessment']),
    severity: 'critical',
    legalEffect: 'REFUSAL_LIKELY',
    evidenceGap: 'CV, references, payslips, tax records, qualifications and skills assessment if required.',
    recommendation: 'Verify work experience and skills evidence before relying on this criterion.'
  }));
  findings.push(makeFinding({
    ruleId: `${subclass}_ENGLISH`,
    criterion: 'English language requirement',
    status: evaluateBoolean(ctx, ['english', 'englishEvidence', 'englishTest', 'competentEnglish', 'vocationalEnglish']),
    severity: 'high',
    legalEffect: 'REFUSAL_LIKELY',
    evidenceGap: 'English test result, passport evidence or exemption evidence if applicable.',
    recommendation: 'Verify English evidence or exemption before final advice.'
  }));
  return findings;
}

function run482(ctx) {
  return [
    ...employerBase(ctx),
    makeFinding({
      ruleId: '482_LMT',
      criterion: 'Labour market testing / exemption',
      status: evaluateBoolean(ctx, ['labourMarketTesting', 'lmt', 'lmtCompleted', 'lmtExemption']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'LMT advertising evidence or exemption basis.',
      recommendation: 'Confirm LMT or exemption before nomination lodgement.'
    }),
    makeFinding({
      ruleId: '482_TEMPORARY_INTENT_COMPLIANCE',
      criterion: 'Temporary stay and visa compliance risk',
      status: evaluateRiskNoIssue(ctx, ['complianceIssue', 'visaBreach', 'conditionBreach', 'overstay', 'temporaryIntentRisk']),
      severity: 'high',
      legalEffect: 'DISCRETIONARY_RISK',
      evidenceGap: 'Current visa grant notice, VEVO and explanation of any compliance history.',
      recommendation: 'Review compliance history before final advice.'
    }),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function run186(ctx) {
  const stream = toText(pickFrom(['stream', 'visaStream', 'ensStream', '186Stream'], ctx)).toLowerCase();
  const findings = [...employerBase(ctx)];
  findings.push(makeFinding({
    ruleId: '186_STREAM',
    criterion: 'Correct 186 stream identified',
    status: stream ? 'pass' : 'unknown',
    severity: 'critical',
    legalEffect: 'EVIDENCE_GAP',
    evidenceGap: 'Confirmation whether the application is TRT, Direct Entry or Labour Agreement stream.',
    recommendation: 'Confirm the correct 186 stream before final advice.'
  }));
  if (stream.includes('trt') || stream.includes('temporary residence transition')) {
    findings.push(makeFinding({
      ruleId: '186_TRT_EMPLOYMENT_PERIOD',
      criterion: 'TRT employment period with sponsoring employer',
      status: evaluateBoolean(ctx, ['trtEmploymentPeriod', 'employmentPeriodMet', 'workedForEmployer', 'sameEmployerPeriod']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Payslips, employment contracts, superannuation, tax and visa history evidence.',
      recommendation: 'Verify TRT employment period before lodgement.'
    }));
  } else if (stream.includes('direct')) {
    findings.push(makeFinding({
      ruleId: '186_DE_SKILLS_ASSESSMENT',
      criterion: 'Direct Entry skills assessment',
      status: evaluateBoolean(ctx, ['skillsAssessment', 'positiveSkillsAssessment', 'skillsAssessment.valid']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Skills assessment outcome letter and validity evidence.',
      recommendation: 'Verify skills assessment before Direct Entry lodgement.'
    }));
    findings.push(makeFinding({
      ruleId: '186_DE_THREE_YEARS_EXPERIENCE',
      criterion: 'Direct Entry skilled employment experience',
      status: evaluateBoolean(ctx, ['threeYearsExperience', 'relevantExperience', 'employmentExperience']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Employment references, payslips, tax and duties evidence.',
      recommendation: 'Verify skilled employment experience before lodgement.'
    }));
  }
  findings.push(...healthCharacterIntegrityFindings(ctx));
  return findings;
}

function run187(ctx) {
  return [
    ...employerBase(ctx),
    makeFinding({
      ruleId: '187_LEGACY_ELIGIBILITY',
      criterion: 'Subclass 187 legacy/transitional eligibility',
      status: evaluateBoolean(ctx, ['legacyEligible', 'transitionalEligibility', 'rsmsLegacy', '187Eligible']),
      severity: 'blocker',
      legalEffect: 'INVALID_APPLICATION',
      evidenceGap: 'Evidence that a lawful 187 pathway remains available under transitional/legacy rules.',
      recommendation: 'Do not proceed unless legacy/transitional eligibility is confirmed.'
    }),
    makeFinding({
      ruleId: '187_REGIONAL_EMPLOYER',
      criterion: 'Regional employer and regional position',
      status: evaluateBoolean(ctx, ['regionalEmployer', 'regionalPosition', 'regionalArea', 'regionalLocation']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Regional location, employer and position evidence.',
      recommendation: 'Confirm regional eligibility before proceeding.'
    }),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function run494(ctx) {
  return [
    ...employerBase(ctx),
    makeFinding({
      ruleId: '494_REGIONAL_EMPLOYER',
      criterion: 'Regional employer / designated regional area',
      status: evaluateBoolean(ctx, ['regionalEmployer', 'regionalPosition', 'designatedRegional', 'regionalArea']),
      severity: 'blocker',
      legalEffect: 'INVALID_APPLICATION',
      evidenceGap: 'Evidence the employer and position are in a designated regional area.',
      recommendation: 'Do not lodge until regional eligibility is verified.'
    }),
    makeFinding({
      ruleId: '494_SKILLS_ASSESSMENT',
      criterion: 'Skills assessment if required',
      status: evaluateBoolean(ctx, ['skillsAssessment', 'positiveSkillsAssessment', 'skillsAssessmentRequiredMet']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Skills assessment or exemption evidence if applicable.',
      recommendation: 'Verify skills assessment requirement before final advice.'
    }),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function run500(ctx) {
  return [
    makeFinding({
      ruleId: '500_COE',
      criterion: 'Confirmation of Enrolment / course enrolment',
      status: evaluateBoolean(ctx, ['coe', 'confirmationOfEnrolment', 'courseEnrolment', 'enrolled']),
      severity: 'blocker',
      legalEffect: 'INVALID_APPLICATION',
      evidenceGap: 'Confirmation of Enrolment or evidence of course enrolment.',
      recommendation: 'Do not lodge until enrolment evidence is verified.'
    }),
    makeFinding({
      ruleId: '500_GENUINE_STUDENT',
      criterion: 'Genuine student requirement',
      status: evaluateBoolean(ctx, ['genuineStudent', 'gsRequirement', 'studyPurpose', 'genuineTemporaryEntrant']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Study history, financial circumstances, ties, career plan and statement evidence.',
      recommendation: 'Prepare a properly evidenced genuine student assessment.'
    }),
    makeFinding({
      ruleId: '500_FINANCIAL_CAPACITY',
      criterion: 'Financial capacity',
      status: evaluateBoolean(ctx, ['financialCapacity', 'funds', 'bankStatement', 'sufficientFunds']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Financial evidence, source of funds and sponsor evidence if applicable.',
      recommendation: 'Verify financial capacity before lodgement.'
    }),
    makeFinding({
      ruleId: '500_OSHC',
      criterion: 'Overseas Student Health Cover',
      status: evaluateBoolean(ctx, ['oshc', 'studentHealthCover', 'healthCover']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'OSHC policy evidence covering the required period.',
      recommendation: 'Verify OSHC before lodgement.'
    }),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function run600(ctx) {
  return [
    makeFinding({
      ruleId: '600_PURPOSE',
      criterion: 'Genuine temporary visit purpose',
      status: evaluateBoolean(ctx, ['visitPurpose', 'tourismPurpose', 'businessVisitorPurpose', 'genuineVisitor']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Travel purpose, itinerary, invitation letters and supporting documents.',
      recommendation: 'Clarify and evidence the purpose of visit.'
    }),
    makeFinding({
      ruleId: '600_INCENTIVE_TO_RETURN',
      criterion: 'Incentive to return / temporary stay',
      status: evaluateBoolean(ctx, ['incentiveToReturn', 'homeTies', 'employmentHomeCountry', 'familyTies', 'assets']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Employment, family, asset, study or business ties supporting temporary stay.',
      recommendation: 'Prepare evidence showing genuine temporary stay.'
    }),
    makeFinding({
      ruleId: '600_FINANCIAL_SUPPORT',
      criterion: 'Funds for stay',
      status: evaluateBoolean(ctx, ['funds', 'financialSupport', 'bankStatement', 'sufficientFunds']),
      severity: 'high',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Bank statements, sponsor letter and source of funds evidence.',
      recommendation: 'Verify funds and source of support before lodgement.'
    }),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function partnerBase(ctx, subclass) {
  return [
    makeFinding({
      ruleId: `${subclass}_SPONSOR`,
      criterion: 'Eligible sponsor',
      status: evaluateBoolean(ctx, ['sponsor', 'eligibleSponsor', 'partnerSponsor', 'sponsorEligible']),
      severity: 'blocker',
      legalEffect: 'INVALID_APPLICATION',
      evidenceGap: 'Sponsor citizenship/residence evidence, identity and sponsorship eligibility documents.',
      recommendation: 'Verify sponsor eligibility before lodgement.'
    }),
    makeFinding({
      ruleId: `${subclass}_RELATIONSHIP`,
      criterion: 'Genuine and continuing relationship',
      status: evaluateBoolean(ctx, ['relationship', 'genuineRelationship', 'continuingRelationship', 'partnerRelationship']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Relationship statement, financial/social/household/commitment evidence and identity documents.',
      recommendation: 'Prepare a complete relationship evidence matrix.'
    }),
    makeFinding({
      ruleId: `${subclass}_STATUS`,
      criterion: 'Relationship status requirement',
      status: evaluateBoolean(ctx, ['married', 'deFacto', 'relationshipRegistered', 'prospectiveMarriage', 'relationshipStatus']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Marriage certificate, de facto evidence, registration certificate or prospective marriage evidence as applicable.',
      recommendation: 'Verify the relationship pathway and required evidence.'
    }),
    makeFinding({
      ruleId: `${subclass}_FAMILY_VIOLENCE_PUBLIC_INTEREST`,
      criterion: 'Sponsorship limitations / public interest issues',
      status: evaluateRiskNoIssue(ctx, ['sponsorLimitation', 'familyViolence', 'sponsorConviction', 'publicInterestIssue']),
      severity: 'high',
      legalEffect: 'DISCRETIONARY_RISK',
      evidenceGap: 'Sponsor history, police checks and any limitation/exemption submissions.',
      recommendation: 'Review sponsorship limitations before proceeding.'
    }),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function run820(ctx) { return partnerBase(ctx, '820'); }
function run309(ctx) { return partnerBase(ctx, '309'); }
function run300(ctx) {
  return [
    makeFinding({
      ruleId: '300_INTENDED_MARRIAGE',
      criterion: 'Intention to marry eligible sponsor',
      status: evaluateBoolean(ctx, ['intentionToMarry', 'prospectiveMarriage', 'weddingPlans', 'noticeOfIntendedMarriage']),
      severity: 'blocker',
      legalEffect: 'INVALID_APPLICATION',
      evidenceGap: 'Notice of Intended Marriage, evidence of wedding plans and sponsor eligibility evidence.',
      recommendation: 'Verify intention to marry and sponsor eligibility before lodgement.'
    }),
    ...partnerBase(ctx, '300')
  ];
}

function run866(ctx) {
  return [
    makeFinding({
      ruleId: '866_ONSHORE',
      criterion: 'Applicant in Australia / protection application jurisdiction',
      status: evaluateBoolean(ctx, ['inAustralia', 'currentLocationAustralia', 'onshore', 'location']),
      severity: 'blocker',
      legalEffect: 'INVALID_APPLICATION',
      evidenceGap: 'Identity, arrival, current location and visa status evidence.',
      recommendation: 'Confirm jurisdiction and lawful pathway before lodgement.'
    }),
    makeFinding({
      ruleId: '866_PROTECTION_CLAIMS',
      criterion: 'Protection claims and convention/complementary protection basis',
      status: evaluateBoolean(ctx, ['protectionClaim', 'fearOfHarm', 'refugeeClaim', 'complementaryProtection', 'persecution']),
      severity: 'critical',
      legalEffect: 'REFUSAL_LIKELY',
      evidenceGap: 'Detailed claims, country information, identity evidence and corroborating documents.',
      recommendation: 'Prepare a detailed protection claims assessment and evidence matrix.'
    }),
    makeFinding({
      ruleId: '866_EXCLUSION_RISKS',
      criterion: 'Exclusion / security / character risks',
      status: evaluateRiskNoIssue(ctx, ['securityRisk', 'exclusion', 'seriousCrime', 'warCrime', 'characterIssue']),
      severity: 'critical',
      legalEffect: 'DISCRETIONARY_RISK',
      evidenceGap: 'Character, security and background documents if any adverse issue exists.',
      recommendation: 'Conduct a detailed risk review before lodgement.'
    }),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function runGeneric(ctx) {
  return [
    makeFinding({
      ruleId: `${ctx.subclass || 'GENERIC'}_IDENTITY`,
      criterion: 'Identity and passport evidence',
      status: evaluateBoolean(ctx, ['passport', 'identity', 'passportProvided', 'identityEvidence']),
      severity: 'blocker',
      legalEffect: 'INVALID_APPLICATION',
      evidenceGap: 'Passport biodata page and identity documents.',
      recommendation: 'Verify identity before any final advice.'
    }),
    makeFinding({
      ruleId: `${ctx.subclass || 'GENERIC'}_PRIMARY_CRITERIA`,
      criterion: 'Primary subclass criteria',
      status: 'unknown',
      severity: 'critical',
      legalEffect: 'EVIDENCE_GAP',
      evidenceGap: 'Subclass-specific criteria must be reviewed manually or configured in the engine.',
      recommendation: 'Do not treat this subclass as assessed until criteria are mapped.'
    }),
    ...healthCharacterIntegrityFindings(ctx)
  ];
}

function runFindingsForSubclass(ctx) {
  switch (ctx.subclass) {
    case '189': return run189(ctx);
    case '190': return run190(ctx);
    case '491': return run491(ctx);
    case '482': return run482(ctx);
    case '186': return run186(ctx);
    case '187': return run187(ctx);
    case '494': return run494(ctx);
    case '500': return run500(ctx);
    case '600': return run600(ctx);
    case '820': return run820(ctx);
    case '309': return run309(ctx);
    case '300': return run300(ctx);
    case '866': return run866(ctx);
    default: return runGeneric(ctx);
  }
}

function aggregateDecision(findings) {
  const blockers = findings.filter(f => f.severity === 'blocker' && f.status === 'fail');
  const blockerRisks = findings.filter(f => f.severity === 'blocker' && f.status === 'risk');
  const criticalFails = findings.filter(f => f.severity === 'critical' && f.status === 'fail');
  const criticalRisks = findings.filter(f => f.severity === 'critical' && f.status === 'risk');
  const unknowns = findings.filter(f => f.status === 'unknown');

  if (blockers.length > 0) {
    return {
      lodgementPosition: 'NOT_LODGEABLE',
      riskLevel: 'CRITICAL',
      primaryReason: blockers[0].criterion,
      validityStatus: 'invalid_or_not_established'
    };
  }
  if (blockerRisks.length > 0 || criticalFails.length > 0 || criticalRisks.length > 0) {
    return {
      lodgementPosition: 'LODGEABLE_HIGH_RISK',
      riskLevel: 'HIGH',
      primaryReason: (blockerRisks[0] || criticalFails[0] || criticalRisks[0]).criterion,
      validityStatus: 'requires_legal_review'
    };
  }
  if (unknowns.length > 0) {
    return {
      lodgementPosition: 'EVIDENCE_REQUIRED_BEFORE_LODGEMENT',
      riskLevel: 'MEDIUM',
      primaryReason: unknowns[0].criterion,
      validityStatus: 'cannot_confirm'
    };
  }
  return {
    lodgementPosition: 'POTENTIALLY_LODGEABLE_SUBJECT_TO_DOCUMENT_REVIEW',
    riskLevel: 'LOW',
    primaryReason: 'No blocker identified on provided answers',
    validityStatus: 'potentially_valid_subject_to_documents'
  };
}

function groupForSubclass(subclass) {
  for (const [group, list] of Object.entries(GROUPS)) {
    if (list.includes(subclass)) return group;
  }
  return 'generic';
}

function uniqueList(list) {
  return Array.from(new Set((list || []).filter(Boolean).map(x => String(x).trim()).filter(Boolean)));
}

function collectEvidenceRequired(findings) {
  return uniqueList(findings
    .filter(f => f.status !== 'pass')
    .map(f => f.evidenceGap)
    .flatMap(x => String(x || '').split(/;|\n/).map(s => s.trim())));
}

function collectNextSteps(findings, finalPosition) {
  const steps = [];
  if (finalPosition.lodgementPosition === 'NOT_LODGEABLE') {
    steps.push('Do not lodge the application until all validity blockers are resolved and documents are reviewed.');
  }
  steps.push(...findings.filter(f => f.status !== 'pass').slice(0, 12).map(f => f.recommendation));
  steps.push('Arrange a Registered Migration Agent review of original documents before final advice or lodgement.');
  return uniqueList(steps);
}

function runDecisionEngine(assessmentOrPayload) {
  const ctx = normaliseAssessmentInput(assessmentOrPayload);
  const findings = runFindingsForSubclass(ctx);
  const finalPosition = aggregateDecision(findings);
  return {
    ok: true,
    engine: 'single-file-migration-decision-engine',
    version: '2026.05-delegate-simulator-v1',
    subclass: ctx.subclass,
    group: groupForSubclass(ctx.subclass),
    supported: SUPPORTED_SUBCLASSES.includes(ctx.subclass),
    finalPosition,
    lodgementPosition: finalPosition.lodgementPosition,
    riskLevel: finalPosition.riskLevel,
    primaryReason: finalPosition.primaryReason,
    validityAssessment: {
      status: finalPosition.validityStatus,
      blockers: findings.filter(f => f.severity === 'blocker' && f.status !== 'pass').map(f => f.criterion)
    },
    findings,
    criteriaFindings: findings,
    evidenceChecklist: {
      requiredBeforeFinalAdvice: collectEvidenceRequired(findings),
      requiredBeforeLodgement: collectEvidenceRequired(findings).slice(0, 20)
    },
    nextSteps: collectNextSteps(findings, finalPosition),
    qualityFlags: buildQualityFlags(findings, ctx)
  };
}

function buildQualityFlags(findings, ctx) {
  const flags = [];
  if (!SUPPORTED_SUBCLASSES.includes(ctx.subclass)) flags.push(`Subclass ${ctx.subclass || 'unknown'} is not fully configured in the engine.`);
  const unknownCount = findings.filter(f => f.status === 'unknown').length;
  const failCount = findings.filter(f => f.status === 'fail').length;
  const riskCount = findings.filter(f => f.status === 'risk').length;
  if (failCount) flags.push(`${failCount} criterion finding(s) are failed on the provided answers.`);
  if (riskCount) flags.push(`${riskCount} criterion finding(s) require legal risk review.`);
  if (unknownCount) flags.push(`${unknownCount} criterion finding(s) require further evidence before final advice.`);
  flags.push('Engine output is preliminary and requires original document verification before lodgement action.');
  return flags;
}

function humanPosition(position) {
  switch (position) {
    case 'NOT_LODGEABLE': return 'Not lodgeable on the information provided';
    case 'LODGEABLE_HIGH_RISK': return 'Potentially lodgeable but high risk';
    case 'EVIDENCE_REQUIRED_BEFORE_LODGEMENT': return 'Evidence required before lodgement position can be confirmed';
    case 'POTENTIALLY_LODGEABLE_SUBJECT_TO_DOCUMENT_REVIEW': return 'Potentially lodgeable subject to document review';
    default: return position || 'Requires review';
  }
}

function buildLegalEngineBundle(decision, assessment = {}) {
  const applicantName = assessment.applicant_name || assessment?.form_payload?.meta?.applicantName || 'the applicant';
  const subclass = decision.subclass || assessment.visa_type || 'visa';
  const title = `Preliminary Migration Advice – Subclass ${subclass}`;

  const summary = `Based on the questionnaire answers assessed by the Migration Decision Engine, ${applicantName}'s Subclass ${subclass} matter is classified as: ${humanPosition(decision.lodgementPosition)}. Risk level: ${decision.riskLevel}. Primary reason: ${decision.primaryReason || 'further evidence required'}.`;

  const criterionFindings = (decision.findings || []).map(f => ({
    ruleId: f.ruleId,
    criterion: f.criterion,
    status: f.status,
    evidenceConsidered: f.evidenceConsidered,
    finding: f.finding,
    legalConsequence: f.legalConsequence,
    evidenceGap: f.evidenceGap,
    recommendation: f.recommendation,
    legalEffect: f.legalEffect,
    severity: f.severity,
    decisionLayer: f.decisionLayer
  }));

  const bundle = {
    source: 'migration-decision-engine',
    engineVersion: decision.version,
    title,
    riskLevel: decision.riskLevel,
    lodgementPosition: decision.lodgementPosition,
    humanLodgementPosition: humanPosition(decision.lodgementPosition),
    primaryReason: decision.primaryReason,
    validityAssessment: decision.validityAssessment,
    summary,
    summaryOfAdvice: summary,
    summaryOfFindings: summary,
    keyIssues: criterionFindings.filter(f => f.status !== 'pass').slice(0, 8).map(f => `${f.criterion}: ${f.legalEffect}`),
    keyRisks: criterionFindings.filter(f => ['fail', 'risk'].includes(f.status)).slice(0, 8).map(f => `${f.criterion}: ${f.legalConsequence}`),
    criterionFindings,
    criteriaFindings: criterionFindings,
    findings: criterionFindings,
    evidenceRequired: decision.evidenceChecklist?.requiredBeforeFinalAdvice || [],
    evidenceChecklist: decision.evidenceChecklist || {},
    nextSteps: decision.nextSteps || [],
    recommendations: decision.nextSteps || [],
    qualityFlags: decision.qualityFlags || [],
    disclaimer: 'This is a preliminary assessment based on questionnaire answers only. It is subject to verification of original documents, confirmation of current law and policy, conflict checks, and the terms of any client agreement before further immigration assistance or lodgement action.'
  };

  // Compatibility fields for stricter PDF builders that expect a GPT advice bundle.
  bundle.gptAdviceBundle = {
    controlledBy: 'migration-decision-engine',
    riskLevel: bundle.riskLevel,
    lodgementPosition: bundle.lodgementPosition,
    summary: bundle.summary,
    criterionFindings: bundle.criterionFindings,
    evidenceRequired: bundle.evidenceRequired,
    nextSteps: bundle.nextSteps,
    qualityFlags: bundle.qualityFlags
  };

  return bundle;
}

function supportedSubclasses() {
  return SUPPORTED_SUBCLASSES.slice();
}

module.exports = {
  runDecisionEngine,
  buildLegalEngineBundle,
  supportedSubclasses,
  SUPPORTED_SUBCLASSES
};
