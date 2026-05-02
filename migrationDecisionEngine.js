'use strict';

/**
 * Bircan Migration - Single-file Multi-Subclass Migration Decision Engine
 * ---------------------------------------------------------------------
 * Dependency-free. Place this file beside server.js and import with:
 * const { runDecisionEngine, buildLegalEngineBundle } = require('./migrationDecisionEngine');
 *
 * Purpose:
 * - Deterministic first-pass legal/risk simulation across supported subclasses.
 * - GPT may be used after this only as a drafting/writing layer; it must not override these results.
 * - Treats questionnaire answers as indications only unless evidence markers are present.
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
  partner: ['820', '309', '300'],
  temporary: ['500', '600'],
  protection: ['866']
};

function text(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch (_) { return ''; }
}

function lower(v) { return text(v).toLowerCase(); }

function isNo(v) {
  const s = lower(v);
  return ['no', 'false', 'not held', 'none', 'n/a', 'na', 'not applicable', 'withdrawn', 'refused', 'expired', 'cancelled', 'unknown'].includes(s);
}

function isYes(v) {
  const s = lower(v);
  return ['yes', 'true', 'held', 'approved', 'valid', 'current', 'satisfied', 'met', 'positive'].includes(s);
}

function isUnknown(v) {
  const s = lower(v);
  return !s || ['unknown', 'unsure', 'not sure', 'unclear', 'to be confirmed', 'tbc', 'pending'].includes(s);
}

function numeric(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function dateValue(v) {
  const s = text(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function yearsBetween(start, end) {
  const s = dateValue(start);
  const e = dateValue(end);
  if (!s || !e) return null;
  let y = e.getFullYear() - s.getFullYear();
  const m = e.getMonth() - s.getMonth();
  if (m < 0 || (m === 0 && e.getDate() < s.getDate())) y -= 1;
  return y;
}

function flatten(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

function getPayload(assessment) {
  const payload = assessment && assessment.form_payload ? assessment.form_payload : assessment || {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload.formData || payload.payload || payload.data || payload;
  return { payload, answers: answers || {}, flat: flatten(answers || {}) };
}

function findAny(flat, names) {
  const entries = Object.entries(flat || {});
  const wanted = names.map(n => lower(n));
  for (const [k, v] of entries) {
    const lk = lower(k).replace(/[_-]/g, ' ');
    if (wanted.some(w => lk.includes(w))) return v;
  }
  return undefined;
}

function hasEvidence(flat, names) {
  const v = findAny(flat, names);
  if (v === undefined || v === null || v === '') return false;
  if (isNo(v) || isUnknown(v)) return false;
  return true;
}

function answerStatus(flat, names, opts = {}) {
  const v = findAny(flat, names);
  if (v === undefined || v === null || v === '') return { status: 'unknown', value: '', verified: false };
  if (isNo(v)) return { status: 'fail', value: text(v), verified: false };
  if (isUnknown(v)) return { status: 'unknown', value: text(v), verified: false };
  if (opts.numericMin !== undefined) {
    const n = numeric(v);
    if (n === null) return { status: 'unknown', value: text(v), verified: false };
    return { status: n >= opts.numericMin ? 'pass' : 'fail', value: String(n), verified: true };
  }
  if (isYes(v) || text(v)) return { status: 'pass', value: text(v), verified: true };
  return { status: 'unknown', value: text(v), verified: false };
}

function makeFinding({ id, criterion, status, severity, legalEffect, finding, consequence, evidenceGap, recommendation, recordedInformation, layer }) {
  const st = status || 'unknown';
  return {
    ruleId: id,
    criterion,
    status: st,
    severity: severity || 'medium',
    legalEffect: legalEffect || 'EVIDENCE_GAP',
    decisionLayer: layer || 'time_of_decision',
    finding: finding || defaultFinding(st),
    legalConsequence: consequence || defaultConsequence(legalEffect),
    evidenceGap: Array.isArray(evidenceGap) ? evidenceGap : (evidenceGap ? [evidenceGap] : []),
    recommendation: recommendation || defaultRecommendation(st, legalEffect),
    recordedInformation: recordedInformation || ''
  };
}

function defaultFinding(status) {
  if (status === 'pass') return 'Indicated as satisfied on the questionnaire, subject to verification of supporting evidence.';
  if (status === 'fail') return 'Not satisfied on the information provided.';
  return 'Evidence required / not verified from the submitted questionnaire.';
}

function defaultConsequence(effect) {
  switch (effect) {
    case 'INVALID_APPLICATION': return 'Invalid application / not lodgeable risk.';
    case 'REFUSAL_LIKELY': return 'Refusal risk if the criterion is not satisfied or not evidenced.';
    case 'DISCRETIONARY_RISK': return 'Discretionary or adverse consideration risk requiring legal review.';
    default: return 'Evidence gap requiring review before final advice.';
  }
}

function defaultRecommendation(status, effect) {
  if (status === 'pass') return 'Verify and retain supporting evidence on file before lodgement action.';
  if (effect === 'INVALID_APPLICATION') return 'Resolve this issue before lodgement. Do not lodge until verified.';
  return 'Obtain supporting evidence and complete legal review before lodgement action.';
}

function aggregate(findings) {
  const blockerFails = findings.filter(f => f.severity === 'blocker' && f.status === 'fail');
  const blockerUnknowns = findings.filter(f => f.severity === 'blocker' && f.status === 'unknown');
  const criticalFails = findings.filter(f => f.severity === 'critical' && f.status === 'fail');
  const criticalUnknowns = findings.filter(f => f.severity === 'critical' && f.status === 'unknown');
  const highRisks = findings.filter(f => ['high', 'critical'].includes(f.severity) && ['fail', 'risk'].includes(f.status));

  if (blockerFails.length) {
    return {
      outcome: 'NOT_LODGEABLE',
      lodgementPosition: 'NOT LODGEABLE',
      riskLevel: 'CRITICAL',
      primaryReason: blockerFails[0].criterion,
      blockers: blockerFails.map(f => f.criterion)
    };
  }
  if (blockerUnknowns.length) {
    return {
      outcome: 'VALIDITY_NOT_CONFIRMED',
      lodgementPosition: 'NOT LODGEABLE UNTIL VALIDITY IS VERIFIED',
      riskLevel: 'CRITICAL',
      primaryReason: blockerUnknowns[0].criterion,
      blockers: blockerUnknowns.map(f => f.criterion)
    };
  }
  if (criticalFails.length) {
    return {
      outcome: 'HIGH_REFUSAL_RISK',
      lodgementPosition: 'LODGEABLE ONLY AFTER ADVERSE CRITERIA ARE RESOLVED',
      riskLevel: 'HIGH',
      primaryReason: criticalFails[0].criterion,
      blockers: []
    };
  }
  if (criticalUnknowns.length || highRisks.length) {
    return {
      outcome: 'EVIDENCE_REQUIRED',
      lodgementPosition: 'EVIDENCE REQUIRED BEFORE LODGEMENT',
      riskLevel: 'HIGH',
      primaryReason: (criticalUnknowns[0] || highRisks[0]).criterion,
      blockers: []
    };
  }
  if (findings.some(f => f.status === 'unknown')) {
    return {
      outcome: 'EVIDENCE_REQUIRED',
      lodgementPosition: 'EVIDENCE REQUIRED BEFORE FINAL ADVICE',
      riskLevel: 'MEDIUM',
      primaryReason: findings.find(f => f.status === 'unknown').criterion,
      blockers: []
    };
  }
  return {
    outcome: 'POTENTIALLY_LODGEABLE',
    lodgementPosition: 'POTENTIALLY LODGEABLE SUBJECT TO FINAL DOCUMENT REVIEW',
    riskLevel: 'LOW',
    primaryReason: 'No blocker detected on questionnaire answers',
    blockers: []
  };
}

function commonPublicInterest(flat, subclass) {
  const findings = [];
  const health = answerStatus(flat, ['health issue', 'medical issue', 'health requirement', 'pic 4005', 'pic 4007']);
  findings.push(makeFinding({
    id: `${subclass}_HEALTH`, criterion: 'Health requirement', status: health.status === 'fail' ? 'risk' : health.status,
    severity: health.status === 'fail' ? 'high' : 'medium', legalEffect: 'DISCRETIONARY_RISK', recordedInformation: health.value,
    evidenceGap: ['Health examination results', 'Medical reports if relevant'], recommendation: 'Review health evidence and waiver position, if relevant, before final advice.'
  }));
  const character = answerStatus(flat, ['character issue', 'criminal', 'police', 'court', 'pic 4001', 'character requirement']);
  findings.push(makeFinding({
    id: `${subclass}_CHARACTER`, criterion: 'Character requirement', status: character.status === 'fail' ? 'risk' : character.status,
    severity: character.status === 'fail' ? 'high' : 'medium', legalEffect: 'DISCRETIONARY_RISK', recordedInformation: character.value,
    evidenceGap: ['Police certificates', 'Court documents if relevant'], recommendation: 'Obtain and review character evidence before lodgement strategy is confirmed.'
  }));
  const integrity = answerStatus(flat, ['pic 4020', 'false document', 'misleading', 'integrity', 'previous fraud']);
  findings.push(makeFinding({
    id: `${subclass}_PIC4020`, criterion: 'Integrity / PIC 4020 risk', status: integrity.status === 'fail' ? 'risk' : integrity.status,
    severity: integrity.status === 'fail' ? 'critical' : 'medium', legalEffect: 'REFUSAL_LIKELY', recordedInformation: integrity.value,
    evidenceGap: ['Prior visa/application records', 'Department correspondence', 'Documents previously submitted'], recommendation: 'Conduct an integrity review before proceeding.'
  }));
  return findings;
}

function runSkilledEngine(assessment, subclass) {
  const { flat } = getPayload(assessment);
  const findings = [];

  if (['189', '190', '491'].includes(subclass)) {
    const invitation = answerStatus(flat, ['invitation received', 'skillselect invitation', 'invitation date', 'invitation']);
    findings.push(makeFinding({
      id: `${subclass}_INVITATION`, criterion: 'Valid SkillSelect invitation', status: invitation.status,
      severity: 'blocker', legalEffect: 'INVALID_APPLICATION', layer: 'validity', recordedInformation: invitation.value,
      evidenceGap: ['SkillSelect invitation letter showing invitation date, nominated occupation and points score'],
      recommendation: 'Obtain and verify the SkillSelect invitation before lodgement.'
    }));
  }

  if (subclass === '190') {
    const nomination = answerStatus(flat, ['state nomination', 'territory nomination', 'nomination approval', 'nomination date', 'nominating state']);
    findings.push(makeFinding({
      id: '190_NOMINATION', criterion: 'Current state or territory nomination', status: nomination.status,
      severity: 'blocker', legalEffect: 'INVALID_APPLICATION', layer: 'validity', recordedInformation: nomination.value,
      evidenceGap: ['State or territory nomination approval letter', 'Evidence nomination is current and matches the nominated occupation'],
      recommendation: 'Do not proceed until nomination is verified.'
    }));
  }

  if (subclass === '491') {
    const sponsorOrNomination = answerStatus(flat, ['regional nomination', 'family sponsor', '491 nomination', '491 sponsor', 'designated regional']);
    findings.push(makeFinding({
      id: '491_REGIONAL_NOMINATION_OR_SPONSOR', criterion: 'Regional nomination or eligible family sponsorship', status: sponsorOrNomination.status,
      severity: 'blocker', legalEffect: 'INVALID_APPLICATION', layer: 'validity', recordedInformation: sponsorOrNomination.value,
      evidenceGap: ['State/territory nomination or eligible family sponsor evidence'],
      recommendation: 'Verify the nomination or sponsorship pathway before lodgement.'
    }));
  }

  const skills = answerStatus(flat, ['skills assessment', 'positive skills', 'assessment authority', 'skills outcome']);
  findings.push(makeFinding({
    id: `${subclass}_SKILLS`, criterion: 'Suitable skills assessment for nominated occupation', status: skills.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: skills.value,
    evidenceGap: ['Skills assessment outcome letter', 'Assessment authority details', 'Assessment date and reference number'],
    recommendation: 'Verify the skills assessment outcome and validity against the invitation date.'
  }));

  const occupation = answerStatus(flat, ['nominated occupation', 'anzsco', 'occupation list', 'occupation eligibility']);
  findings.push(makeFinding({
    id: `${subclass}_OCCUPATION`, criterion: 'Nominated occupation eligibility', status: occupation.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: occupation.value,
    evidenceGap: ['Nominated occupation/ANZSCO evidence', 'Occupation list or nomination list evidence at the relevant time'],
    recommendation: 'Confirm occupation eligibility and alignment with the invitation/nomination.'
  }));

  const english = answerStatus(flat, ['english', 'ielts', 'pte', 'competent english', 'passport-based claim']);
  findings.push(makeFinding({
    id: `${subclass}_ENGLISH`, criterion: 'English language requirement', status: english.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: english.value,
    evidenceGap: ['English test result or eligible passport evidence'],
    recommendation: 'Collect and verify English evidence before final advice.'
  }));

  const pointsVal = findAny(flat, ['points total', 'points claimed', 'points score', 'calculated points', 'pass mark']);
  const points = answerStatus({ points: pointsVal }, ['points'], { numericMin: 65 });
  findings.push(makeFinding({
    id: `${subclass}_POINTS`, criterion: 'Points test threshold', status: points.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: points.value,
    evidenceGap: ['Full points calculation', 'Evidence for each points claim'],
    recommendation: 'Complete a full evidence-based points calculation.'
  }));

  const dob = findAny(flat, ['date of birth', 'dob', 'birth date']);
  const invDate = findAny(flat, ['invitation date', 'skillselect invitation date']);
  const age = yearsBetween(dob, invDate);
  findings.push(makeFinding({
    id: `${subclass}_AGE`, criterion: 'Age requirement at invitation', status: age === null ? 'unknown' : (age < 45 ? 'pass' : 'fail'),
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: age === null ? '' : `Calculated age ${age}`,
    evidenceGap: ['Passport biodata page', 'SkillSelect invitation letter'],
    recommendation: 'Verify identity and invitation date.'
  }));

  const s48 = answerStatus(flat, ['section 48', 'no further stay', '8503', '8534', '8535', 'onshore bar']);
  findings.push(makeFinding({
    id: `${subclass}_S48_NFS`, criterion: 'Section 48 / No Further Stay / onshore validity restrictions', status: s48.status === 'pass' ? 'risk' : s48.status,
    severity: s48.status === 'fail' ? 'medium' : 'blocker', legalEffect: 'INVALID_APPLICATION', layer: 'validity', recordedInformation: s48.value,
    evidenceGap: ['Current visa grant notice', 'VEVO', 'Refusal/cancellation notices', 'Waiver decision if relevant'],
    recommendation: 'Resolve any onshore validity restriction before lodgement action.'
  }));

  findings.push(...commonPublicInterest(flat, subclass));
  const aggregateResult = aggregate(findings);
  return buildDecision(assessment, subclass, 'Skilled migration', findings, aggregateResult);
}

function runEmployerEngine(assessment, subclass) {
  const { flat } = getPayload(assessment);
  const findings = [];

  const sponsor = answerStatus(flat, ['sponsor approved', 'standard business sponsor', 'approved sponsor', 'sponsorship approval']);
  findings.push(makeFinding({
    id: `${subclass}_SPONSOR`, criterion: 'Approved sponsor / employer eligibility', status: sponsor.status,
    severity: 'blocker', legalEffect: 'INVALID_APPLICATION', layer: 'validity', recordedInformation: sponsor.value,
    evidenceGap: ['Sponsorship approval', 'Employer registration and business evidence'],
    recommendation: 'Verify sponsor eligibility before lodgement.'
  }));

  const nomination = answerStatus(flat, ['nomination approved', 'nomination lodged', 'nomination', 'position nomination']);
  findings.push(makeFinding({
    id: `${subclass}_NOMINATION`, criterion: 'Valid nomination', status: nomination.status,
    severity: 'blocker', legalEffect: 'INVALID_APPLICATION', layer: 'validity', recordedInformation: nomination.value,
    evidenceGap: ['Nomination application/approval', 'Position description', 'Organisation chart'],
    recommendation: 'Verify the nomination and nominated position before lodgement.'
  }));

  const occupation = answerStatus(flat, ['occupation', 'anzsco', 'occupation list', 'skills in demand', 'csit', 'mltssl', 'stsol', 'rol']);
  findings.push(makeFinding({
    id: `${subclass}_OCCUPATION`, criterion: 'Eligible nominated occupation', status: occupation.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: occupation.value,
    evidenceGap: ['ANZSCO/title evidence', 'Occupation list evidence', 'Position description'],
    recommendation: 'Confirm the nominated occupation is eligible and correctly classified.'
  }));

  const genuine = answerStatus(flat, ['genuine position', 'genuine need', 'position genuine', 'business need']);
  findings.push(makeFinding({
    id: `${subclass}_GENUINE_POSITION`, criterion: 'Genuine position / genuine need', status: genuine.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: genuine.value,
    evidenceGap: ['Business case', 'Position description', 'Organisation chart', 'Financial/business activity evidence'],
    recommendation: 'Prepare evidence showing genuine need for the position.'
  }));

  const salary = answerStatus(flat, ['salary', 'tsmit', 'market salary', 'annual market salary rate', 'amsr', 'income threshold']);
  findings.push(makeFinding({
    id: `${subclass}_SALARY`, criterion: 'Salary / market rate / threshold requirement', status: salary.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: salary.value,
    evidenceGap: ['Employment contract', 'Market salary evidence', 'Payroll/comparable salary evidence'],
    recommendation: 'Verify salary meets the applicable threshold and market salary requirements.'
  }));

  if (['482', '494'].includes(subclass)) {
    const lmt = answerStatus(flat, ['labour market testing', 'lmt', 'advertising', 'job ads']);
    findings.push(makeFinding({
      id: `${subclass}_LMT`, criterion: 'Labour market testing / advertising', status: lmt.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: lmt.value,
      evidenceGap: ['Job advertisements', 'LMT report', 'Exemption basis if applicable'],
      recommendation: 'Verify LMT compliance or exemption before nomination strategy is finalised.'
    }));
  }

  if (subclass === '186') {
    const stream = findAny(flat, ['stream', 'trt', 'direct entry', 'labour agreement']);
    findings.push(makeFinding({
      id: '186_STREAM', criterion: 'Subclass 186 stream selection', status: stream ? 'pass' : 'unknown',
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: text(stream),
      evidenceGap: ['Confirmation of TRT, Direct Entry or Labour Agreement stream'],
      recommendation: 'Confirm stream first because the legal criteria differ materially.'
    }));
    const trtPeriod = answerStatus(flat, ['trt employment', 'years with employer', 'two years', 'three years', '457', '482 employment period']);
    findings.push(makeFinding({
      id: '186_TRT_OR_DE_REQUIREMENTS', criterion: '186 TRT / Direct Entry pathway requirements', status: trtPeriod.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: trtPeriod.value,
      evidenceGap: ['Employment history', 'Payslips', 'Skills assessment if Direct Entry', 'English evidence'],
      recommendation: 'Verify the selected stream requirements before proceeding.'
    }));
  }

  if (subclass === '187') {
    const regional = answerStatus(flat, ['regional', 'rsms', 'regional employer', 'regional location']);
    findings.push(makeFinding({
      id: '187_REGIONAL_LEGACY', criterion: 'RSMS / Subclass 187 regional and legacy pathway', status: regional.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: regional.value,
      evidenceGap: ['Regional location evidence', 'Legacy/transitional eligibility evidence'],
      recommendation: 'Confirm whether a lawful legacy/transitional 187 pathway is available.'
    }));
  }

  if (subclass === '494') {
    const regional494 = answerStatus(flat, ['regional employer', 'designated regional', '494 regional', 'regional location']);
    findings.push(makeFinding({
      id: '494_REGIONAL', criterion: 'Designated regional employment requirement', status: regional494.status,
      severity: 'blocker', legalEffect: 'INVALID_APPLICATION', recordedInformation: regional494.value,
      evidenceGap: ['Regional location evidence', 'Employer location evidence'],
      recommendation: 'Verify designated regional eligibility before lodgement.'
    }));
  }

  const experience = answerStatus(flat, ['work experience', 'years experience', 'relevant experience', 'two years experience', 'three years experience']);
  findings.push(makeFinding({
    id: `${subclass}_EXPERIENCE`, criterion: 'Relevant skills and work experience', status: experience.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: experience.value,
    evidenceGap: ['CV', 'Employment references', 'Payslips/tax evidence', 'Qualification/skills evidence'],
    recommendation: 'Verify relevant experience and qualifications against occupation requirements.'
  }));

  const english = answerStatus(flat, ['english', 'ielts', 'pte', 'vocational english', 'competent english']);
  findings.push(makeFinding({
    id: `${subclass}_ENGLISH`, criterion: 'English language requirement', status: english.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: english.value,
    evidenceGap: ['English test result or exemption/passport evidence'],
    recommendation: 'Verify English evidence before final advice.'
  }));

  findings.push(...commonPublicInterest(flat, subclass));
  const aggregateResult = aggregate(findings);
  return buildDecision(assessment, subclass, 'Employer sponsored migration', findings, aggregateResult);
}

function runPartnerEngine(assessment, subclass) {
  const { flat } = getPayload(assessment);
  const findings = [];

  const sponsor = answerStatus(flat, ['sponsor eligible', 'australian sponsor', 'sponsor citizenship', 'permanent resident sponsor', 'eligible new zealand']);
  findings.push(makeFinding({
    id: `${subclass}_SPONSOR`, criterion: 'Eligible partner/prospective marriage sponsor', status: sponsor.status,
    severity: 'blocker', legalEffect: 'INVALID_APPLICATION', layer: 'validity', recordedInformation: sponsor.value,
    evidenceGap: ['Sponsor passport/citizenship/PR evidence', 'Sponsor identity evidence'],
    recommendation: 'Verify sponsor eligibility before lodgement.'
  }));

  if (subclass === '300') {
    const intent = answerStatus(flat, ['intention to marry', 'marriage plans', 'wedding', 'prospective marriage']);
    findings.push(makeFinding({
      id: '300_INTENTION_TO_MARRY', criterion: 'Genuine intention to marry', status: intent.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: intent.value,
      evidenceGap: ['Notice/arrangements for marriage', 'Relationship evidence', 'Statements'],
      recommendation: 'Verify genuine intention and marriage plans.'
    }));
  } else {
    const relationship = answerStatus(flat, ['genuine relationship', 'spouse', 'de facto', 'relationship evidence', 'living together']);
    findings.push(makeFinding({
      id: `${subclass}_RELATIONSHIP`, criterion: 'Genuine and continuing relationship', status: relationship.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: relationship.value,
      evidenceGap: ['Relationship statement', 'Financial/social/household evidence', 'Communication/travel evidence'],
      recommendation: 'Prepare relationship evidence across financial, household, social and commitment aspects.'
    }));

    const marriageOrDefacto = answerStatus(flat, ['married', 'marriage certificate', 'de facto 12 months', 'registered relationship']);
    findings.push(makeFinding({
      id: `${subclass}_MARRIAGE_DEFACTO`, criterion: 'Marriage or de facto pathway evidence', status: marriageOrDefacto.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: marriageOrDefacto.value,
      evidenceGap: ['Marriage certificate or de facto/registered relationship evidence'],
      recommendation: 'Verify the correct partner pathway and supporting documents.'
    }));
  }

  const location = answerStatus(flat, ['onshore', 'offshore', 'current location', 'in australia']);
  findings.push(makeFinding({
    id: `${subclass}_LOCATION`, criterion: 'Correct onshore/offshore pathway', status: location.status,
    severity: 'blocker', legalEffect: 'INVALID_APPLICATION', layer: 'validity', recordedInformation: location.value,
    evidenceGap: ['Current location confirmation', 'Current visa/immigration status'],
    recommendation: 'Confirm the applicant location matches the selected subclass at lodgement and decision stages.'
  }));

  const sponsorshipLimits = answerStatus(flat, ['sponsorship limitation', 'previous partner sponsorship', 'family violence', 'sponsor convictions']);
  findings.push(makeFinding({
    id: `${subclass}_SPONSOR_LIMITS`, criterion: 'Sponsorship limitations and adverse sponsor issues', status: sponsorshipLimits.status === 'fail' ? 'risk' : sponsorshipLimits.status,
    severity: 'high', legalEffect: 'DISCRETIONARY_RISK', recordedInformation: sponsorshipLimits.value,
    evidenceGap: ['Prior sponsorship history', 'Police checks if required', 'Adverse information records'],
    recommendation: 'Review sponsor limitations and disclosure obligations before lodgement.'
  }));

  findings.push(...commonPublicInterest(flat, subclass));
  const aggregateResult = aggregate(findings);
  return buildDecision(assessment, subclass, 'Partner / family migration', findings, aggregateResult);
}

function runTemporaryEngine(assessment, subclass) {
  const { flat } = getPayload(assessment);
  const findings = [];

  if (subclass === '500') {
    const enrolment = answerStatus(flat, ['coe', 'confirmation of enrolment', 'enrolment', 'course']);
    findings.push(makeFinding({
      id: '500_COE', criterion: 'Confirmation of enrolment / course requirement', status: enrolment.status,
      severity: 'blocker', legalEffect: 'INVALID_APPLICATION', layer: 'validity', recordedInformation: enrolment.value,
      evidenceGap: ['Confirmation of Enrolment (CoE)', 'Course details'],
      recommendation: 'Verify CoE and course details before lodgement.'
    }));
    const genuineStudent = answerStatus(flat, ['genuine student', 'gs requirement', 'genuine temporary entrant', 'study intention']);
    findings.push(makeFinding({
      id: '500_GS', criterion: 'Genuine Student requirement', status: genuineStudent.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: genuineStudent.value,
      evidenceGap: ['Study statement', 'Career/course rationale', 'Financial and personal circumstances evidence'],
      recommendation: 'Prepare a coherent Genuine Student response with supporting evidence.'
    }));
    const funds = answerStatus(flat, ['financial capacity', 'funds', 'bank statement', 'financial evidence']);
    findings.push(makeFinding({
      id: '500_FUNDS', criterion: 'Financial capacity', status: funds.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: funds.value,
      evidenceGap: ['Bank statements', 'Income evidence', 'Sponsorship/funding evidence'],
      recommendation: 'Verify financial capacity evidence before lodgement.'
    }));
    const oshc = answerStatus(flat, ['oshc', 'health insurance', 'overseas student health cover']);
    findings.push(makeFinding({
      id: '500_OSHC', criterion: 'Overseas Student Health Cover', status: oshc.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: oshc.value,
      evidenceGap: ['OSHC policy certificate'],
      recommendation: 'Verify OSHC covers the required period.'
    }));
  }

  if (subclass === '600') {
    const purpose = answerStatus(flat, ['visit purpose', 'tourism', 'business visitor', 'family visit', 'purpose of visit']);
    findings.push(makeFinding({
      id: '600_PURPOSE', criterion: 'Genuine temporary visit purpose', status: purpose.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: purpose.value,
      evidenceGap: ['Itinerary', 'Invitation letter if relevant', 'Purpose of visit evidence'],
      recommendation: 'Verify visit purpose and supporting documents.'
    }));
    const incentives = answerStatus(flat, ['home ties', 'employment ties', 'family ties', 'return incentive', 'assets']);
    findings.push(makeFinding({
      id: '600_RETURN_INCENTIVE', criterion: 'Incentive to return / genuine temporary stay', status: incentives.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: incentives.value,
      evidenceGap: ['Employment evidence', 'Family ties', 'Assets', 'Previous travel history'],
      recommendation: 'Prepare evidence addressing temporary stay and return incentives.'
    }));
    const funds = answerStatus(flat, ['funds', 'financial capacity', 'bank statement', 'sponsor support']);
    findings.push(makeFinding({
      id: '600_FUNDS', criterion: 'Financial capacity for visit', status: funds.status,
      severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: funds.value,
      evidenceGap: ['Bank statements', 'Income evidence', 'Support evidence if sponsored'],
      recommendation: 'Verify financial capacity for the proposed stay.'
    }));
  }

  findings.push(...commonPublicInterest(flat, subclass));
  const aggregateResult = aggregate(findings);
  return buildDecision(assessment, subclass, subclass === '500' ? 'Student visa' : 'Visitor visa', findings, aggregateResult);
}

function runProtectionEngine(assessment, subclass) {
  const { flat } = getPayload(assessment);
  const findings = [];

  const location = answerStatus(flat, ['in australia', 'onshore', 'current location']);
  findings.push(makeFinding({
    id: '866_ONSHORE', criterion: 'Applicant in Australia for Subclass 866 pathway', status: location.status,
    severity: 'blocker', legalEffect: 'INVALID_APPLICATION', layer: 'validity', recordedInformation: location.value,
    evidenceGap: ['Current location evidence', 'Current visa/immigration status'],
    recommendation: 'Confirm applicant is in Australia and can make a valid protection visa application.'
  }));

  const claims = answerStatus(flat, ['protection claims', 'refugee claims', 'fear of harm', 'persecution', 'complementary protection']);
  findings.push(makeFinding({
    id: '866_CLAIMS', criterion: 'Protection claims / refugee or complementary protection basis', status: claims.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: claims.value,
    evidenceGap: ['Detailed statement of claims', 'Country information', 'Identity evidence', 'Supporting evidence'],
    recommendation: 'Prepare a detailed claims statement and evidence review before lodgement.'
  }));

  const identity = answerStatus(flat, ['identity', 'passport', 'national id', 'identity documents']);
  findings.push(makeFinding({
    id: '866_IDENTITY', criterion: 'Identity, nationality and credibility evidence', status: identity.status,
    severity: 'critical', legalEffect: 'REFUSAL_LIKELY', recordedInformation: identity.value,
    evidenceGap: ['Passport/identity documents', 'Nationality evidence', 'Explanation for missing documents'],
    recommendation: 'Verify identity/nationality and address any credibility issues.'
  }));

  const bars = answerStatus(flat, ['protection bar', 'safe third country', 'previous protection refusal', 's48a', 'character exclusion']);
  findings.push(makeFinding({
    id: '866_BARS', criterion: 'Protection visa bars, exclusions or adverse history', status: bars.status === 'pass' ? 'risk' : bars.status,
    severity: 'blocker', legalEffect: 'INVALID_APPLICATION', recordedInformation: bars.value,
    evidenceGap: ['Prior protection application records', 'Immigration history', 'Adverse decision records'],
    recommendation: 'Review statutory bars and adverse history before lodgement.'
  }));

  findings.push(...commonPublicInterest(flat, subclass));
  const aggregateResult = aggregate(findings);
  return buildDecision(assessment, subclass, 'Protection visa', findings, aggregateResult);
}

function runGenericEngine(assessment, subclass) {
  const { flat } = getPayload(assessment);
  const findings = [];
  findings.push(makeFinding({
    id: `${subclass}_GENERIC_EVIDENCE`, criterion: 'Subclass-specific legal criteria', status: 'unknown', severity: 'critical', legalEffect: 'EVIDENCE_GAP',
    evidenceGap: ['Subclass-specific evidence and eligibility criteria'], recommendation: 'Configure a subclass-specific rule pack before relying on automated assessment.'
  }));
  findings.push(...commonPublicInterest(flat, subclass));
  const aggregateResult = aggregate(findings);
  return buildDecision(assessment, subclass, 'Generic migration assessment', findings, aggregateResult);
}

function buildDecision(assessment, subclass, group, findings, aggregateResult) {
  const mandatoryEvidence = [];
  for (const f of findings) {
    for (const e of f.evidenceGap || []) {
      if (e && !mandatoryEvidence.includes(e)) mandatoryEvidence.push(e);
    }
  }
  return {
    subclass,
    group,
    supported: SUPPORTED_SUBCLASSES.includes(subclass),
    outcome: aggregateResult.outcome,
    lodgementPosition: aggregateResult.lodgementPosition,
    riskLevel: aggregateResult.riskLevel,
    primaryReason: aggregateResult.primaryReason,
    blockers: aggregateResult.blockers,
    findings,
    evidenceRequired: mandatoryEvidence,
    nextSteps: [
      'Collect and upload the required evidence.',
      'Complete legal review of all unverified, adverse or risk findings.',
      'Confirm final lodgement strategy before application action.'
    ],
    qualityFlags: buildQualityFlags(findings, aggregateResult),
    generatedAt: new Date().toISOString(),
    reference: assessment && assessment.id
  };
}

function buildQualityFlags(findings, aggregateResult) {
  const flags = [];
  if (aggregateResult.blockers && aggregateResult.blockers.length) flags.push(`Validity/primary blocker(s): ${aggregateResult.blockers.join('; ')}`);
  const unknowns = findings.filter(f => f.status === 'unknown').map(f => f.criterion);
  if (unknowns.length) flags.push(`Evidence gaps: ${unknowns.slice(0, 8).join('; ')}${unknowns.length > 8 ? '...' : ''}`);
  const risks = findings.filter(f => f.status === 'risk').map(f => f.criterion);
  if (risks.length) flags.push(`Risk findings requiring review: ${risks.join('; ')}`);
  return flags;
}

function runDecisionEngine(assessment) {
  const subclass = text(assessment && (assessment.visa_type || assessment.subclass || assessment.visaSubclass)).replace(/[^0-9]/g, '') || 'unknown';
  if (GROUPS.skilled.includes(subclass)) return runSkilledEngine(assessment, subclass);
  if (GROUPS.employer.includes(subclass)) return runEmployerEngine(assessment, subclass);
  if (GROUPS.partner.includes(subclass)) return runPartnerEngine(assessment, subclass);
  if (GROUPS.temporary.includes(subclass)) return runTemporaryEngine(assessment, subclass);
  if (GROUPS.protection.includes(subclass)) return runProtectionEngine(assessment, subclass);
  return runGenericEngine(assessment, subclass);
}

function buildLegalEngineBundle(decision, assessment) {
  const title = `Preliminary Migration Advice – Subclass ${decision.subclass || (assessment && assessment.visa_type) || ''}`.trim();
  const criterionFindings = (decision.findings || []).map(f => ({
    ruleId: f.ruleId,
    criterion: f.criterion,
    status: f.status,
    finding: f.finding,
    evidenceConsidered: f.recordedInformation || 'Questionnaire answer only; original evidence not verified.',
    legalConsequence: f.legalConsequence,
    legalEffect: f.legalEffect,
    evidenceGap: (f.evidenceGap || []).join('; '),
    recommendation: f.recommendation,
    severity: f.severity,
    decisionLayer: f.decisionLayer
  }));

  const blockersText = decision.blockers && decision.blockers.length
    ? `The following validity or primary blocker(s) require attention before lodgement: ${decision.blockers.join('; ')}.`
    : 'No hard validity blocker was conclusively identified from the questionnaire answers, subject to evidence verification.';

  return {
    engine: 'Bircan single-file multi-subclass delegate simulator',
    title,
    subclass: decision.subclass,
    riskLevel: decision.riskLevel,
    lodgementPosition: decision.lodgementPosition,
    outcome: decision.outcome,
    primaryReason: decision.primaryReason,
    summary: `The delegate-simulator engine assessed this matter as ${decision.outcome}. Risk level: ${decision.riskLevel}. Lodgement position: ${decision.lodgementPosition}. Primary reason: ${decision.primaryReason}.`,
    executiveSummary: `This preliminary assessment is based on questionnaire information only. The engine has classified the matter as ${decision.lodgementPosition} with ${decision.riskLevel} risk, subject to review of original supporting evidence and current law/policy.`,
    applicationValidity: blockersText,
    scopeAndSafeguards: 'This letter is a preliminary migration assessment based on questionnaire answers. It is subject to identity verification, conflict checks, review of original supporting documents, signed service terms where required, and confirmation of current migration law and policy before lodgement action.',
    criterionFindings,
    evidenceRequired: decision.evidenceRequired || [],
    nextSteps: decision.nextSteps || [],
    qualityFlags: decision.qualityFlags || [],
    gptDraftingBoundary: 'GPT may only improve wording using these controlled findings. It must not invent evidence, upgrade prospects, remove blockers, or change risk level or lodgement position.',
    importantQualification: 'This preliminary advice is based on questionnaire information only and is not a guarantee of visa grant. Final advice requires review of original documents and confirmation of current law, policy and Department requirements at the relevant time.'
  };
}

function supportedSubclasses() {
  return SUPPORTED_SUBCLASSES.slice();
}

module.exports = {
  runDecisionEngine,
  buildLegalEngineBundle,
  supportedSubclasses
};
