'use strict';

/**
 * Bircan Migration deterministic decision engines for Subclass 190 and Subclass 482.
 *
 * Purpose:
 * - GPT must not decide eligibility.
 * - This file evaluates questionnaire facts into controlled legal findings.
 * - GPT may only rewrite these findings into client-safe professional language.
 *
 * Status vocabulary:
 * - SATISFIED_INDICATED: questionnaire indicates the criterion may be met, subject to document verification.
 * - NOT_SATISFIED: questionnaire indicates the criterion is not met or an adverse answer is present.
 * - UNCONFIRMED: required information/evidence is missing, unclear, or not sufficient to assess.
 * - NOT_APPLICABLE: criterion does not apply to this stream or fact pattern.
 */

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function cleanText(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(cleanText).filter(Boolean).join('; ');
  if (isPlainObject(v)) return JSON.stringify(v);
  return String(v).replace(/\s+/g, ' ').trim();
}
function normKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function flatten(input, prefix = '', out = {}) {
  if (!isPlainObject(input)) return out;
  for (const [k, v] of Object.entries(input)) {
    if (['password', 'token', 'auth', 'authorization', 'bm_session'].includes(normKey(k))) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flatten(v, key, out);
    else if (Array.isArray(v)) out[key] = v.map(cleanText).filter(Boolean).join('; ');
    else if (v !== undefined && v !== null && String(v).trim() !== '') out[key] = cleanText(v);
  }
  return out;
}
function flatFromAssessment(assessment) {
  const p = assessment && isPlainObject(assessment.form_payload) ? assessment.form_payload : {};
  const base = isPlainObject(p.answers) ? p.answers : isPlainObject(p.formPayload) ? p.formPayload : isPlainObject(p.rawSubmission) ? p.rawSubmission : p;
  return { ...flatten(base), ...(isPlainObject(p.flatAnswers) ? flatten(p.flatAnswers) : {}) };
}
function pick(flat, aliases) {
  const wanted = aliases.map(normKey);
  for (const [k, v] of Object.entries(flat || {})) {
    const nk = normKey(k);
    if (wanted.some(a => nk === a || nk.includes(a) || a.includes(nk))) {
      const val = cleanText(v);
      if (val) return val;
    }
  }
  return '';
}
function yes(v) { return /\b(yes|y|approved|valid|current|held|satisfied|met|pass|positive|available|competent|proficient|superior|confirmed|lodged|completed)\b/i.test(cleanText(v)); }
function no(v) { return /\b(no|not|none|absent|missing|refused|rejected|withdrawn|cancelled|expired|invalid|unresolved|unsure|unknown|failed|bar|adverse|criminal|breach|condition present)\b/i.test(cleanText(v)); }
function parseNumber(v) { const m = cleanText(v).match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; }
function parseDate(v) { const d = new Date(cleanText(v)); return Number.isNaN(d.getTime()) ? null : d; }
function ageAt(dob, atDate) {
  if (!dob || !atDate) return null;
  let age = atDate.getFullYear() - dob.getFullYear();
  const m = atDate.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && atDate.getDate() < dob.getDate())) age--;
  return age;
}
function finding({ id, criterion, status, fact = '', basis = '', consequence = '', evidence = [], recommendation = '', severity = 'review', stage = 'grant', confidence = 'MEDIUM' }) {
  return {
    id,
    criterion,
    status,
    stage,
    severity,
    confidence,
    fact: cleanText(fact),
    basis: cleanText(basis || fact || 'No sufficient questionnaire answer was identified.'),
    legal_consequence: cleanText(consequence),
    evidence_required: Array.isArray(evidence) ? evidence.filter(Boolean) : [cleanText(evidence)].filter(Boolean),
    recommendation: cleanText(recommendation)
  };
}
function assessPresence({ id, criterion, value, evidence, consequenceIfMissing, recommendation, stage = 'grant', critical = false }) {
  if (!value) {
    return finding({ id, criterion, status: 'UNCONFIRMED', stage, severity: critical ? 'critical' : 'review', confidence: 'HIGH', consequence: consequenceIfMissing, evidence, recommendation });
  }
  if (no(value)) {
    return finding({ id, criterion, status: 'NOT_SATISFIED', fact: value, stage, severity: critical ? 'critical' : 'adverse', confidence: 'HIGH', consequence: consequenceIfMissing, evidence, recommendation });
  }
  if (yes(value)) {
    return finding({ id, criterion, status: 'SATISFIED_INDICATED', fact: value, stage, severity: 'info', confidence: 'MEDIUM', consequence: 'The answer indicates this requirement may be met, subject to review of supporting documents.', evidence, recommendation: 'Verify the document and keep it on the client file before lodgement action.' });
  }
  return finding({ id, criterion, status: 'UNCONFIRMED', fact: value, stage, severity: critical ? 'critical' : 'review', confidence: 'MEDIUM', consequence: consequenceIfMissing, evidence, recommendation });
}

function evaluate190(flat) {
  const findings = [];
  const invitation = pick(flat, ['invitation', 'skillselect invitation', 'invitation held', 'invited to apply']);
  const nomination = pick(flat, ['nomination', 'state nomination', 'territory nomination', 'nomination status']);
  const occupation = pick(flat, ['occupation', 'nominated occupation', 'anzsco', 'occupation list']);
  const skills = pick(flat, ['skills assessment', 'skills assessment held', 'assessment authority', 'suitable skills']);
  const english = pick(flat, ['english', 'competent english', 'english test', 'passport evidence']);
  const pointsRaw = pick(flat, ['points', 'points score', 'points breakdown', 'pass mark']);
  const dobRaw = pick(flat, ['date of birth', 'dob']);
  const invitationDateRaw = pick(flat, ['invitation date', 'date of invitation']);
  const section48 = pick(flat, ['section 48', 's48', 'no further stay', '8503', 'condition 8503']);
  const health = pick(flat, ['health', 'medical', 'pic4005', 'pic4007']);
  const character = pick(flat, ['character', 'criminal', 'police', 'pic4001']);
  const integrity = pick(flat, ['pic4020', 'integrity', 'bogus', 'false document', 'misleading']);
  const family = pick(flat, ['family included', 'secondary applicants', 'dependent child', 'custody']);

  findings.push(assessPresence({
    id: '190_invitation', criterion: 'Valid SkillSelect invitation', value: invitation, stage: 'validity', critical: true,
    consequenceIfMissing: 'A subclass 190 application should not proceed unless a valid SkillSelect invitation is confirmed.',
    evidence: ['SkillSelect invitation letter showing invitation date, nominated occupation and points score'],
    recommendation: 'Obtain the invitation letter and confirm the invitation details before lodgement action.'
  }));
  findings.push(assessPresence({
    id: '190_nomination', criterion: 'Current state or territory nomination', value: nomination, stage: 'validity', critical: true,
    consequenceIfMissing: 'A current state or territory nomination is central to the subclass 190 pathway and a missing, expired or withdrawn nomination is a potentially blocking issue.',
    evidence: ['State or territory nomination approval letter', 'Evidence nomination is current and matches the nominated occupation'],
    recommendation: 'Do not proceed until current nomination is verified.'
  }));
  findings.push(assessPresence({
    id: '190_skills_assessment', criterion: 'Suitable skills assessment for nominated occupation', value: skills, stage: 'validity/grant', critical: true,
    consequenceIfMissing: 'The applicant must be able to demonstrate a suitable skills assessment for the nominated occupation. If not available at the required time, prospects are poor.',
    evidence: ['Skills assessment outcome letter', 'Assessment authority details', 'Assessment date and reference number'],
    recommendation: 'Verify the skills assessment outcome and validity against the invitation date before relying on it.'
  }));
  findings.push(assessPresence({
    id: '190_occupation', criterion: 'Nominated occupation on relevant skilled list / nomination list', value: occupation, stage: 'validity/grant', critical: true,
    consequenceIfMissing: 'The nominated occupation must align with the relevant skilled list and the state or territory nomination requirements.',
    evidence: ['Nominated occupation/ANZSCO', 'State/territory occupation list evidence at relevant time'],
    recommendation: 'Confirm occupation list eligibility and nomination alignment.'
  }));
  findings.push(assessPresence({
    id: '190_english', criterion: 'Competent English', value: english, stage: 'validity/grant', critical: true,
    consequenceIfMissing: 'Competent English must be evidenced unless passport-based evidence applies. Without evidence, this criterion cannot be safely treated as met.',
    evidence: ['English test result or eligible passport evidence'],
    recommendation: 'Collect and verify English evidence before final advice.'
  }));
  const points = parseNumber(pointsRaw);
  if (pointsRaw && points !== null) {
    findings.push(finding({
      id: '190_points', criterion: 'Points test threshold', status: points >= 65 ? 'SATISFIED_INDICATED' : 'NOT_SATISFIED', fact: pointsRaw, stage: 'validity/grant', severity: points >= 65 ? 'info' : 'critical', confidence: 'HIGH',
      consequence: points >= 65 ? 'The indicated score meets the minimum threshold, subject to evidence for each points claim.' : 'The indicated score is below 65 and the matter should not proceed on the current information.',
      evidence: ['Full points breakdown and evidence for each claimed points category'],
      recommendation: points >= 65 ? 'Verify every claimed points component against documents.' : 'Recalculate points and identify whether additional points can lawfully be claimed.'
    }));
  } else {
    findings.push(finding({ id: '190_points', criterion: 'Points test threshold', status: 'UNCONFIRMED', stage: 'validity/grant', severity: 'critical', confidence: 'HIGH', consequence: 'The points test cannot be confirmed. The matter should not proceed until a properly evidenced points calculation is completed.', evidence: ['Points calculation', 'Evidence for age, English, qualifications, employment, Australian study, partner points and nomination points as relevant'], recommendation: 'Complete a full points calculation before final advice.' }));
  }
  const dob = parseDate(dobRaw); const invitationDate = parseDate(invitationDateRaw); const age = ageAt(dob, invitationDate);
  if (age !== null) {
    findings.push(finding({ id: '190_age', criterion: 'Age under 45 at invitation', status: age < 45 ? 'SATISFIED_INDICATED' : 'NOT_SATISFIED', fact: `DOB ${dobRaw}; invitation date ${invitationDateRaw}; calculated age ${age}`, stage: 'validity/grant', severity: age < 45 ? 'info' : 'critical', confidence: 'HIGH', consequence: age < 45 ? 'The age criterion appears met, subject to verifying the invitation date and identity documents.' : 'If the applicant was 45 or older at invitation, the subclass 190 pathway is not viable on this fact pattern.', evidence: ['Passport biodata page', 'SkillSelect invitation letter'], recommendation: 'Verify identity and invitation date.' }));
  } else {
    findings.push(finding({ id: '190_age', criterion: 'Age under 45 at invitation', status: 'UNCONFIRMED', fact: dobRaw || invitationDateRaw, stage: 'validity/grant', severity: 'critical', confidence: 'MEDIUM', consequence: 'Age at invitation cannot be confirmed without both date of birth and invitation date.', evidence: ['Passport biodata page', 'SkillSelect invitation letter showing invitation date'], recommendation: 'Confirm age at invitation before final advice.' }));
  }
  findings.push(assessPresence({ id: '190_section48_8503', criterion: 'Section 48 / No Further Stay / onshore validity restrictions', value: section48, stage: 'validity', critical: true, consequenceIfMissing: 'If the applicant is affected by a relevant bar or condition while in Australia, lodgement may not be valid unless a lawful pathway or waiver applies.', evidence: ['Current visa grant notice', 'Refusal/cancellation notices', 'VEVO', 'Any waiver decision'], recommendation: 'Resolve any onshore bar or No Further Stay issue before lodgement action.' }));
  findings.push(assessPresence({ id: '190_health', criterion: 'Health requirement', value: health, stage: 'grant', critical: false, consequenceIfMissing: 'Health issues may affect grant and require further assessment or waiver analysis where available.', evidence: ['Health examination results', 'Medical reports if relevant'], recommendation: 'Review health position before final advice.' }));
  findings.push(assessPresence({ id: '190_character', criterion: 'Character requirement', value: character, stage: 'grant', critical: false, consequenceIfMissing: 'Character issues may affect grant and must be assessed before any application strategy is recommended.', evidence: ['Police certificates', 'Court documents', 'Character submissions if needed'], recommendation: 'Obtain police and court records for review.' }));
  findings.push(assessPresence({ id: '190_integrity', criterion: 'Integrity / PIC 4020 risk', value: integrity, stage: 'grant', critical: true, consequenceIfMissing: 'Integrity concerns may be a serious barrier and must be resolved before lodgement action.', evidence: ['Prior visa/application records', 'Department correspondence', 'Documents previously submitted'], recommendation: 'Conduct an integrity review before proceeding.' }));
  if (family) findings.push(assessPresence({ id: '190_family', criterion: 'Family members / secondary applicants', value: family, stage: 'grant', critical: false, consequenceIfMissing: 'Included family members require relationship, custody and dependency evidence as relevant.', evidence: ['Birth/marriage certificates', 'Custody documents', 'Dependency evidence'], recommendation: 'Verify family composition and documents before lodgement.' }));
  return findings;
}

function evaluate482(flat) {
  const findings = [];
  const stream = pick(flat, ['stream', '482 stream', 'sid stream', 'core skills', 'specialist skills', 'labour agreement']) || 'core/specialist/labour agreement not confirmed';
  const sponsor = pick(flat, ['sponsor approved', 'standard business sponsor', 'sponsorship status', 'sponsor']);
  const nomination = pick(flat, ['nomination', 'nomination lodged', 'nomination approved', 'nominated position']);
  const occupation = pick(flat, ['occupation', 'anzsco', 'nominated occupation', 'occupation list', 'core skills occupation list']);
  const genuinePosition = pick(flat, ['genuine position', 'genuine need', 'labour shortage', 'position genuine']);
  const salary = pick(flat, ['salary', 'annual market salary rate', 'amsr', 'tsmit', 'income threshold', 'core skills income threshold']);
  const lmt = pick(flat, ['labour market testing', 'lmt', 'advertising']);
  const skills = pick(flat, ['skills', 'qualifications', 'work experience', 'two years experience', 'relevant experience']);
  const english = pick(flat, ['english', 'english test', 'english requirement']);
  const registration = pick(flat, ['registration', 'licensing', 'licence', 'professional registration']);
  const health = pick(flat, ['health', 'medical']);
  const character = pick(flat, ['character', 'criminal', 'police']);
  const integrity = pick(flat, ['pic4020', 'integrity', 'bogus', 'false document', 'misleading']);
  const visaConditions = pick(flat, ['current visa status', 'visa condition', 'no further stay', '8503', 'work condition']);

  findings.push(finding({ id: '482_stream', criterion: 'Correct subclass 482 stream identified', status: /not confirmed/i.test(stream) ? 'UNCONFIRMED' : 'SATISFIED_INDICATED', fact: stream, stage: 'validity', severity: /not confirmed/i.test(stream) ? 'critical' : 'info', confidence: /not confirmed/i.test(stream) ? 'HIGH' : 'MEDIUM', consequence: 'The applicable 482 stream controls the nomination, occupation, salary and visa criteria. If the stream is wrong, the strategy may be invalid.', evidence: ['Stream selection and basis: Core Skills, Specialist Skills or Labour Agreement'], recommendation: 'Confirm the correct stream before final advice or payment-linked lodgement work.' }));
  findings.push(assessPresence({ id: '482_sponsor', criterion: 'Approved/eligible sponsor', value: sponsor, stage: 'validity/nomination', critical: true, consequenceIfMissing: 'A subclass 482 visa requires a valid sponsor pathway. If sponsorship is not approved or available, the visa pathway may not proceed.', evidence: ['SBS approval or labour agreement evidence', 'Sponsor ABN/ACN and identity details'], recommendation: 'Verify sponsorship status before relying on the employer pathway.' }));
  findings.push(assessPresence({ id: '482_nomination', criterion: 'Nomination for the applicant and position', value: nomination, stage: 'validity/nomination', critical: true, consequenceIfMissing: 'The visa application depends on a valid nomination. If no nomination is available, the application is not ready to proceed.', evidence: ['Nomination approval/lodgement evidence', 'Position description', 'Employment contract'], recommendation: 'Confirm nomination status and position details.' }));
  findings.push(assessPresence({ id: '482_occupation', criterion: 'Nominated occupation / stream occupation eligibility', value: occupation, stage: 'nomination/grant', critical: true, consequenceIfMissing: 'The nominated occupation must fit the selected stream and any applicable occupation list or labour agreement terms.', evidence: ['ANZSCO/occupation details', 'Occupation list or labour agreement clause'], recommendation: 'Verify occupation eligibility for the selected stream.' }));
  findings.push(assessPresence({ id: '482_genuine_position', criterion: 'Genuine position and business need', value: genuinePosition, stage: 'nomination', critical: true, consequenceIfMissing: 'If the position is not genuine or not supported by business need, the nomination may be refused.', evidence: ['Business case', 'Organisation chart', 'Position description', 'Financial/business activity evidence'], recommendation: 'Prepare evidence showing the role is genuine and required.' }));
  findings.push(assessPresence({ id: '482_salary', criterion: 'Salary / market salary / income threshold compliance', value: salary, stage: 'nomination', critical: true, consequenceIfMissing: 'Salary must satisfy the applicable market salary and income threshold rules for the selected stream. If not evidenced, nomination risk is high.', evidence: ['Employment contract', 'Salary evidence', 'Market salary comparison', 'Applicable income threshold check'], recommendation: 'Verify salary compliance before nomination or visa lodgement.' }));
  findings.push(assessPresence({ id: '482_lmt', criterion: 'Labour Market Testing or exemption', value: lmt, stage: 'nomination', critical: false, consequenceIfMissing: 'Labour Market Testing may be required unless an exemption applies. Missing LMT evidence can create nomination risk.', evidence: ['Advertisements', 'LMT report', 'Exemption basis if applicable'], recommendation: 'Confirm whether LMT applies and keep evidence on file.' }));
  findings.push(assessPresence({ id: '482_skills_experience', criterion: 'Applicant skills, qualifications and experience', value: skills, stage: 'grant', critical: true, consequenceIfMissing: 'The applicant must have the skills, qualifications and experience required for the nominated occupation and stream.', evidence: ['CV', 'Qualifications', 'Employment references', 'Skills assessment if required'], recommendation: 'Verify skills and experience against the position requirements.' }));
  findings.push(assessPresence({ id: '482_english', criterion: 'English requirement', value: english, stage: 'grant', critical: false, consequenceIfMissing: 'English requirements must be confirmed unless an exemption applies.', evidence: ['English test result or exemption evidence'], recommendation: 'Confirm English evidence or exemption.' }));
  findings.push(assessPresence({ id: '482_registration', criterion: 'Registration/licensing where required', value: registration, stage: 'grant', critical: false, consequenceIfMissing: 'Where licensing or registration is required to perform the occupation in Australia, lack of evidence may affect grant or lawful work.', evidence: ['Registration/licence evidence or confirmation not required'], recommendation: 'Confirm licensing requirements for the occupation and state/territory.' }));
  findings.push(assessPresence({ id: '482_health', criterion: 'Health requirement', value: health, stage: 'grant', critical: false, consequenceIfMissing: 'Health issues may affect grant and require further assessment.', evidence: ['Health examination results', 'Medical reports if relevant'], recommendation: 'Review health evidence before final advice.' }));
  findings.push(assessPresence({ id: '482_character', criterion: 'Character requirement', value: character, stage: 'grant', critical: false, consequenceIfMissing: 'Character issues may affect grant and must be reviewed before lodgement strategy is confirmed.', evidence: ['Police certificates', 'Court documents if relevant'], recommendation: 'Obtain and review character evidence.' }));
  findings.push(assessPresence({ id: '482_integrity', criterion: 'Integrity / PIC 4020 risk', value: integrity, stage: 'grant', critical: true, consequenceIfMissing: 'Integrity concerns may create serious visa risk and should be reviewed before lodgement action.', evidence: ['Prior application records', 'Department correspondence', 'Previously submitted documents'], recommendation: 'Conduct integrity review before proceeding.' }));
  if (visaConditions) findings.push(assessPresence({ id: '482_current_visa_conditions', criterion: 'Current visa status and conditions', value: visaConditions, stage: 'validity', critical: false, consequenceIfMissing: 'Current visa conditions may affect timing, work rights and lodgement strategy.', evidence: ['VEVO', 'Current visa grant notice', 'Condition waiver evidence if relevant'], recommendation: 'Review current visa and conditions before final advice.' }));
  return findings;
}

function classify(findings) {
  const criticalNotMet = findings.filter(f => f.severity === 'critical' && f.status === 'NOT_SATISFIED');
  const criticalUnconfirmed = findings.filter(f => f.severity === 'critical' && f.status === 'UNCONFIRMED');
  const adverse = findings.filter(f => f.status === 'NOT_SATISFIED');
  const unconfirmed = findings.filter(f => f.status === 'UNCONFIRMED');
  let risk_level = 'LOW';
  let lodgement_position = 'SUITABLE_TO_PROCEED';
  let classification = 'READY_SUBJECT_TO_DOCUMENT_REVIEW';
  let futile_assistance_risk = false;

  if (criticalNotMet.length) {
    risk_level = 'CRITICAL';
    lodgement_position = 'DO_NOT_LODGE_NOW';
    classification = 'NON_LODGEABLE_ON_CURRENT_INFORMATION';
    futile_assistance_risk = true;
  } else if (criticalUnconfirmed.length >= 2 || adverse.length >= 2) {
    risk_level = 'HIGH';
    lodgement_position = 'MANUAL_LEGAL_REVIEW_REQUIRED';
    classification = 'NOT_READY_HIGH_RISK';
  } else if (criticalUnconfirmed.length || unconfirmed.length >= 3 || adverse.length) {
    risk_level = 'MEDIUM';
    lodgement_position = 'PROCEED_AFTER_EVIDENCE_REVIEW';
    classification = 'LODGEABLE_ONLY_AFTER_EVIDENCE_REVIEW';
  }

  return { risk_level, lodgement_position, classification, futile_assistance_risk };
}

function toAdviceCompatibility(subclass, findings, classification) {
  const hard_fails = findings
    .filter(f => f.status === 'NOT_SATISFIED' && f.severity === 'critical')
    .map(f => ({ issue: f.criterion, observed_value: f.fact || f.basis, consequence: f.legal_consequence }));
  const review_flags = findings
    .filter(f => f.status !== 'SATISFIED_INDICATED')
    .map(f => `${f.criterion}: ${f.status} — ${f.fact || f.basis}`);
  return {
    subclass,
    risk_level: classification.risk_level,
    lodgement_position: classification.lodgement_position,
    classification: classification.classification,
    futile_assistance_risk: classification.futile_assistance_risk,
    deterministic_findings: findings.map(f => ({
      criterion: f.criterion,
      status: f.status,
      stage: f.stage,
      severity: f.severity,
      observed_value: f.fact,
      basis: f.basis,
      legal_consequence: f.legal_consequence,
      evidence_required: f.evidence_required,
      recommendation: f.recommendation,
      confidence: f.confidence
    })),
    hard_fails,
    review_flags,
    mara_controls: {
      no_success_promise: true,
      evidence_verification_required: true,
      agent_review_required: classification.risk_level !== 'LOW',
      futile_assistance_acknowledgement_required: classification.futile_assistance_risk
    }
  };
}

function evaluateDecisionEngine(subclass, input) {
  const code = String(subclass || '').replace(/[^0-9]/g, '');
  const flat = isPlainObject(input) && !input.form_payload ? input : flatFromAssessment(input);
  let findings;
  if (code === '190') findings = evaluate190(flat);
  else if (code === '482') findings = evaluate482(flat);
  else throw new Error(`No deterministic decision engine is implemented for subclass ${code || 'unknown'}.`);
  const classification = classify(findings);
  return toAdviceCompatibility(code, findings, classification);
}

module.exports = {
  evaluateDecisionEngine,
  evaluate190,
  evaluate482,
  helpers: { flatFromAssessment, flatten, pick, cleanText, normKey }
};
