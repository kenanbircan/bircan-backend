'use strict';

/**
 * Bircan Migration — Senior Australian Immigration Advice Engine
 * v1.0.0-all-subclasses-registry-driven
 *
 * Purpose: convert the existing criteriaRegistry + knowledgebase-backed advice bundle
 * into a client-facing, senior migration-agent / solicitor-level advice model.
 *
 * This layer does NOT replace the legal-source/coverage gates. It sits between
 * server.js/adviceEngine.js and pdf.js. It transforms clause records into:
 *  - legal issue spotting;
 *  - fact-to-law application;
 *  - evidence-gap findings;
 *  - legal consequence statements;
 *  - senior practitioner recommendations; and
 *  - PDF-ready criterion matrix rows.
 */

const {
  loadCriteriaRegistry,
  criteriaForStream,
  listSupportedCriteriaRegistrySubclasses
} = require('../criteriaRegistry');

function clean(value, fallback = '') {
  return String(value === undefined || value === null || value === '' ? fallback : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function normSubclass(value) {
  return clean(value).replace(/[^0-9]/g, '');
}

function normKey(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(v => v !== undefined && v !== null && v !== '');
  return [value];
}

function titleCase(value) {
  const s = clean(value);
  if (!s) return '';
  return s
    .replace(/_/g, ' ')
    .replace(/\b\w/g, m => m.toUpperCase())
    .replace(/\bPic\b/g, 'PIC')
    .replace(/\bAnzsco\b/g, 'ANZSCO')
    .replace(/\bAmsr\b/g, 'AMSR')
    .replace(/\bDama\b/g, 'DAMA')
    .replace(/\bTrt\b/g, 'TRT')
    .replace(/\bEns\b/g, 'ENS')
    .replace(/\bNz\b/g, 'NZ');
}

function flattenObject(obj, prefix = '', out = {}) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenObject(v, `${prefix}_${i}`, out));
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flattenObject(v, key, out);
    else out[key] = v;
  }
  return out;
}

function extractAssessmentAnswers(assessment = {}) {
  const payload = assessment.form_payload || assessment.payload || assessment.answers || {};
  const answers = payload.answers || payload.formPayload || payload.rawSubmission || payload;
  return answers && typeof answers === 'object' ? answers : {};
}

function answerCorpus(assessment = {}) {
  const answers = extractAssessmentAnswers(assessment);
  const flat = flattenObject(answers);
  const pairs = Object.entries(flat).map(([k, v]) => `${k}: ${clean(v)}`).filter(Boolean);
  return {
    answers,
    flat,
    text: pairs.join(' | ').toLowerCase()
  };
}

function pickAnswer(flat, patterns) {
  const wanted = asArray(patterns).map(p => String(p).toLowerCase());
  for (const [k, v] of Object.entries(flat || {})) {
    const hay = `${k} ${clean(v)}`.toLowerCase();
    if (wanted.some(p => hay.includes(p))) return clean(v);
  }
  return '';
}

const FAMILY_BY_SUBCLASS = {
  partner: ['100', '300', '309', '801', '820'],
  childOrFamily: ['101', '102', '103', '115', '116', '173', '836', '870'],
  employer: ['186', '187', '407', '482', '494'],
  skilled: ['188', '189', '190', '485', '489', '491', '888'],
  visitor: ['600', '602'],
  student: ['500', '590'],
  workingHoliday: ['417', '462'],
  protection: ['785', '790', '866'],
  special: ['444', '461']
};

function visaFamily(subclass) {
  const code = normSubclass(subclass);
  for (const [family, list] of Object.entries(FAMILY_BY_SUBCLASS)) {
    if (list.includes(code)) return family;
  }
  return 'general';
}

const FAMILY_PROFILES = {
  partner: {
    label: 'Partner / prospective marriage pathway',
    centralIssues: ['relationship genuineness', 'sponsor eligibility', 'legal capacity', 'shared commitment', 'public-interest requirements'],
    evidence: ['relationship statements', 'sponsor status evidence', 'identity documents', 'communication records', 'visit/travel records', 'marriage/divorce evidence where relevant', 'Form 888 or supporting statements where relevant'],
    warning: 'The relationship case should not be assessed from labels alone. The file must prove the relationship narrative, legal capacity, sponsor position and consistency of all declarations.'
  },
  childOrFamily: {
    label: 'Family migration pathway',
    centralIssues: ['qualifying family relationship', 'sponsor/proposer position', 'age/dependency where applicable', 'balance of family or assurance issues where applicable', 'public-interest requirements'],
    evidence: ['birth/adoption records', 'sponsor status evidence', 'dependency evidence', 'family composition records', 'identity documents', 'police/health records'],
    warning: 'Family relationship and dependency questions must be proved by primary records and not merely by family statements.'
  },
  employer: {
    label: 'Employer-sponsored pathway',
    centralIssues: ['nomination validity', 'occupation alignment', 'genuine position', 'salary/AMSR or agreement terms', 'skills/English/registration', 'public-interest requirements'],
    evidence: ['nomination records', 'employment contract', 'position description', 'organisation chart', 'salary/AMSR evidence', 'skills and qualification evidence', 'registration evidence where relevant'],
    warning: 'Employer-sponsored matters fail when nomination, business need, occupation, salary and applicant evidence do not tell one consistent story.'
  },
  skilled: {
    label: 'Skilled / points or nomination pathway',
    centralIssues: ['invitation/nomination basis', 'occupation and skills assessment', 'points or eligibility settings', 'English', 'age', 'public-interest requirements'],
    evidence: ['skills assessment', 'English test', 'EOI/invitation or nomination records', 'employment references', 'qualification records', 'identity documents'],
    warning: 'Skilled matters require exact reconciliation between claimed points, occupation evidence, invitation/nomination conditions and the documents held.'
  },
  visitor: {
    label: 'Visitor / medical treatment pathway',
    centralIssues: ['genuine temporary stay', 'purpose of visit or treatment', 'funds', 'incentive to return', 'health/character'],
    evidence: ['travel itinerary', 'funds evidence', 'employment/family ties', 'treatment records where relevant', 'health insurance where relevant'],
    warning: 'Temporary-entry intention must be positively evidenced; generic travel plans are usually not enough where risk factors exist.'
  },
  student: {
    label: 'Student / guardian pathway',
    centralIssues: ['genuine student or guardian purpose', 'enrolment', 'financial capacity', 'English and welfare arrangements where applicable', 'public-interest requirements'],
    evidence: ['CoE/enrolment', 'financial evidence', 'English evidence', 'GTE/GS material', 'welfare arrangements', 'OSHC where relevant'],
    warning: 'Student and guardian matters require purpose, course/welfare and financial evidence to align with the declared temporary pathway.'
  },
  workingHoliday: {
    label: 'Working holiday pathway',
    centralIssues: ['eligible passport', 'age', 'first/second/third visa conditions', 'specified work where applicable', 'funds and health/character'],
    evidence: ['passport', 'specified work records where relevant', 'funds evidence', 'visa history', 'health/character records'],
    warning: 'Specified-work and visa-history records should be checked before treating repeat working holiday eligibility as safe.'
  },
  protection: {
    label: 'Protection / humanitarian pathway',
    centralIssues: ['claims to protection', 'country information', 'credibility', 'third-country protection/residence issues', 'exclusion/public-interest risks'],
    evidence: ['personal statement', 'identity and nationality records', 'country information', 'threat evidence', 'travel/residence history', 'family composition records'],
    warning: 'Protection matters require careful credibility, chronology, third-country and exclusion analysis. A generic merits summary is not sufficient.'
  },
  special: {
    label: 'Special category / related pathway',
    centralIssues: ['eligible status', 'family relationship where applicable', 'location/status', 'character and health where relevant'],
    evidence: ['passport/status records', 'relationship evidence where relevant', 'visa history', 'health/character material'],
    warning: 'Special-category status and related family rights must be checked against current status and relationship evidence.'
  },
  general: {
    label: 'Australian migration pathway',
    centralIssues: ['validity', 'pathway threshold', 'applicant eligibility', 'public-interest requirements', 'evidence consistency'],
    evidence: ['identity documents', 'current visa records', 'pathway-specific evidence', 'health/character records', 'prior visa history'],
    warning: 'The matter should not proceed on pathway labels alone; each criterion must be mapped to original evidence.'
  }
};

const TYPE_RULES = [
  {
    keys: ['validity', 'schedule_1', 'item', 'application'],
    label: 'Valid application and pathway control',
    requirement: 'The application must be validly made under the correct subclass, stream, form, charge, location and pathway settings before Schedule 2 merits criteria can safely be considered.',
    evidence: ['Application settings', 'visa application charge record', 'identity documents', 'current location/status evidence', 'nomination/sponsorship/invitation linkage where relevant'],
    consequence: 'A validity defect can prevent the application from being considered or can make the selected pathway unavailable.',
    action: 'Confirm the exact subclass, stream, location, application method, charge, and pathway linkage before lodgement.'
  },
  {
    keys: ['nomination', 'sponsor', 'employer', 'genuine_position', 'position'],
    label: 'Sponsorship, nomination and position control',
    requirement: 'The sponsor, nominator or employer-side foundation must legally support this applicant, role, relationship or activity and must be consistent with the selected subclass and stream.',
    evidence: ['Sponsorship/nomination approval or draft', 'sponsor status evidence', 'business evidence', 'position description', 'organisation chart', 'relationship/activity records where relevant'],
    consequence: 'If the sponsor or nomination foundation is missing or inconsistent, the visa application may fail even if the applicant appears personally suitable.',
    action: 'Prepare a sponsor/nomination evidence brief and reconcile it with the applicant’s own evidence.'
  },
  {
    keys: ['labour_agreement', 'dama', 'concession'],
    label: 'Labour Agreement and concession control',
    requirement: 'The executed agreement must cover the employer, occupation, location, salary arrangement and any concession relied upon.',
    evidence: ['Executed Labour Agreement', 'occupation schedule', 'concession schedule', 'location/ceiling records', 'nomination record'],
    consequence: 'If the agreement does not authorise the role or concession, the strategy may be unavailable or exposed to refusal.',
    action: 'Map every proposed concession and nomination setting to the executed agreement before final advice.'
  },
  {
    keys: ['relationship_family', 'partner', 'marriage', 'dependent', 'child', 'parent', 'family'],
    label: 'Relationship, family composition and dependency',
    requirement: 'The claimed family, partner, prospective marriage or dependency relationship must be legally recognised and supported by consistent evidence.',
    evidence: ['Birth/marriage/divorce/adoption records', 'relationship statements', 'communication and travel records', 'dependency records', 'sponsor status evidence', 'supporting statements'],
    consequence: 'If the relationship or dependency evidence is weak or inconsistent, the central pathway basis may fail.',
    action: 'Prepare a relationship/dependency chronology and reconcile primary records with statements and application answers.'
  },
  {
    keys: ['skills_occupation', 'occupation', 'anzsco', 'skills', 'qualification', 'work_experience', 'registration', 'licensing'],
    label: 'Occupation, skills, qualifications and registration',
    requirement: 'The applicant’s occupation, duties, qualifications, experience, skills assessment and registration/licensing evidence must satisfy the selected pathway.',
    evidence: ['Skills assessment', 'qualifications', 'employment references', 'CV', 'duties statement', 'registration/licensing records', 'payslips/tax records where relevant'],
    consequence: 'A mismatch between claimed occupation, duties and evidence can defeat eligibility or undermine credibility.',
    action: 'Build a duties/skills matrix and check each claimed period and qualification against objective records.'
  },
  {
    keys: ['salary_employment', 'salary', 'amsr', 'income', 'employment', 'market_salary', 'tsmit'],
    label: 'Salary, employment conditions and market evidence',
    requirement: 'Salary and employment conditions must be consistent with the nomination, contract, payroll evidence and any market salary, income threshold or agreement framework.',
    evidence: ['Employment contract', 'salary evidence', 'AMSR/market salary material', 'payslips', 'PAYG/tax records', 'superannuation records', 'award/enterprise agreement records'],
    consequence: 'Unreconciled salary or employment-condition evidence can undermine the nomination and expose the matter to refusal.',
    action: 'Reconcile contract, nomination, salary, payroll and market evidence before any positive lodgement recommendation.'
  },
  {
    keys: ['english'],
    label: 'English-language requirement',
    requirement: 'The applicant must satisfy the applicable English requirement, exemption or concession at the relevant time.',
    evidence: ['English test report', 'passport exemption evidence', 'education evidence', 'agreement/instrument concession evidence'],
    consequence: 'If English is not met or the evidence is invalid, the application may fail unless a lawful exemption or concession applies.',
    action: 'Verify the original English evidence, test validity dates and any exemption/concession basis.'
  },
  {
    keys: ['age'],
    label: 'Age requirement or age concession',
    requirement: 'The applicant must satisfy the relevant age requirement or fall within a lawful exemption or concession.',
    evidence: ['Passport', 'birth record', 'concession/exemption evidence', 'agreement or instrument material where relevant'],
    consequence: 'An age issue is often a threshold blocker unless a precise statutory exemption or concession applies.',
    action: 'Calculate age at the correct time and retain the legal basis for any concession relied upon.'
  },
  {
    keys: ['health', 'pic_4005', 'pic_4007'],
    label: 'Health and medical-risk control',
    requirement: 'The applicant and relevant family members must satisfy the applicable health requirement or have any health issue managed under the available legal framework.',
    evidence: ['Health examination records', 'medical reports', 'specialist letters', 'family-member health disclosures'],
    consequence: 'Unaddressed health issues can delay or defeat the application and may require specialist evidence.',
    action: 'Screen health disclosures early and obtain medical material before final lodgement advice.'
  },
  {
    keys: ['character', 'integrity', 'pic_4020', '4020', 'police', 'adverse', 'compliance'],
    label: 'Character, integrity and PIC risk',
    requirement: 'The applicant must satisfy character and integrity requirements and provide truthful, consistent information across present and prior dealings with the Department.',
    evidence: ['Police certificates', 'court records', 'prior visa decisions', 'previous application forms', 'Department correspondence', 'document-history records'],
    consequence: 'Character, false-document or misleading-information issues can lead to refusal and may affect future applications.',
    action: 'Review all prior applications, refusals, cancellations, police/court records and document consistency before filing.'
  },
  {
    keys: ['location_status', 'visa_status', 'bridging', 'section_48', '8503', 'unlawful', 'special_return'],
    label: 'Location, visa status and application bars',
    requirement: 'The applicant must be in the required location/status and must not be prevented from lodging or satisfying the pathway by a visa condition, application bar or return criterion.',
    evidence: ['VEVO', 'visa grant notices', 'bridging visa records', 'condition records', 'travel movement records', 'prior refusal/cancellation records'],
    consequence: 'A location/status bar can require offshore strategy, waiver analysis or a different pathway.',
    action: 'Confirm current location, visa status, conditions and prior decision history before lodgement strategy is settled.'
  },
  {
    keys: ['financial', 'funds', 'assurance', 'welfare'],
    label: 'Financial capacity, support and welfare arrangements',
    requirement: 'Where the subclass requires funds, assurance, welfare, support or capacity evidence, that evidence must be real, available and consistent with the declared purpose.',
    evidence: ['Bank records', 'support declarations', 'assurance documents', 'welfare arrangements', 'employment/income records'],
    consequence: 'Weak financial or welfare evidence may undermine genuine purpose or subclass-specific eligibility.',
    action: 'Verify source, availability and consistency of support/funds/welfare evidence.'
  }
];

function ruleForCriterion(criterion = {}) {
  const hay = [criterion.criterionType, criterion.pdfMapping, criterion.criterionRole, criterion.requirementText, criterion.clause, criterion.criterionId]
    .flat(Infinity)
    .map(clean)
    .join(' ')
    .toLowerCase();
  return TYPE_RULES.find(rule => rule.keys.some(k => hay.includes(k))) || {
    label: 'Subclass-specific grant criterion',
    requirement: 'The criterion must be assessed against the applicable Migration Act, Migration Regulations, legislative instruments, policy guidance and the original evidence supplied for this matter.',
    evidence: ['Original supporting documents', 'Department records', 'subclass-specific evidence', 'current visa records'],
    consequence: 'If the evidence does not establish this criterion, the application may not be grant-ready.',
    action: 'Legal frame incomplete — manual RMA/legal review is required before advice-grade PDF issue.'
  };
}

function summariseRequirementText(text) {
  const s = clean(text);
  if (!s) return '';
  if (s.length <= 450) return s;
  const cut = s.slice(0, 450);
  return `${cut.slice(0, Math.max(cut.lastIndexOf('.'), cut.lastIndexOf(';'), 280)).trim()}.`;
}

function evidenceFromCriterion(criterion, fallback) {
  const rules = asArray(criterion.evidenceRules).map(x => typeof x === 'string' ? x : clean(x && (x.document || x.evidence || x.requirement || x.label || JSON.stringify(x))));
  const mapped = asArray(criterion.intakeMapping).map(x => typeof x === 'string' ? x : clean(x && (x.field || x.label || x.question || x.evidence || JSON.stringify(x))));
  return Array.from(new Set([...rules, ...mapped, ...asArray(fallback)].map(clean).filter(Boolean))).slice(0, 8);
}

function criterionLabel(criterion) {
  const rule = ruleForCriterion(criterion);
  const clause = clean(criterion.clause || criterion.criterionId || criterion.id);
  const role = clean(criterion.criterionRole || criterion.pdfMapping?.label || criterion.label || criterion.name);
  if (role && !/^mandatory|primary|secondary$/i.test(role)) return `${clause ? clause + ' — ' : ''}${titleCase(role)}`;
  return `${clause ? clause + ' — ' : ''}${rule.label}`;
}

function factsAppliedForCriterion({ criterion, assessment, corpus, familyProfile }) {
  const rule = ruleForCriterion(criterion);
  const text = corpus.text || '';
  const flat = corpus.flat || {};
  const positives = [];
  const gaps = [];

  function has(...needles) { return needles.some(n => text.includes(String(n).toLowerCase())); }

  if (/passport|identity|name|date of birth/.test(rule.label.toLowerCase()) || has('passport')) {
    const pass = pickAnswer(flat, ['passport', 'identity', 'date of birth', 'dob']);
    if (pass) positives.push('identity information has been supplied for review');
    else gaps.push('passport/identity evidence is not clearly identified in the supplied answers');
  }
  if (/english/.test(rule.label.toLowerCase())) {
    if (has('english', 'ielts', 'pte', 'toefl', 'cae', 'competent english', 'proficient english')) positives.push('English evidence or an English claim is disclosed');
    else gaps.push('English evidence or exemption basis is not clearly confirmed');
  }
  if (/sponsor|nomination|employer/.test(rule.label.toLowerCase())) {
    if (has('nomination', 'sponsor', 'employer', 'abn', 'business')) positives.push('sponsor/nomination information appears in the intake');
    else gaps.push('sponsor/nomination foundation is not evidenced in the supplied answers');
  }
  if (/relationship|family|dependency|marriage/.test(rule.label.toLowerCase())) {
    if (has('relationship', 'partner', 'marriage', 'spouse', 'de facto', 'child', 'parent', 'dependent')) positives.push('relationship/family facts are disclosed for review');
    else gaps.push('relationship/family evidence is not sufficiently identified');
  }
  if (/skills|occupation|registration|qualification/.test(rule.label.toLowerCase())) {
    if (has('skill', 'qualification', 'occupation', 'anzsco', 'registration', 'licence', 'license')) positives.push('occupation, skills or qualification information has been provided');
    else gaps.push('skills/occupation evidence is not clearly identified');
  }
  if (/salary|employment/.test(rule.label.toLowerCase())) {
    if (has('salary', 'contract', 'payslip', 'payroll', 'amsr', 'market salary')) positives.push('salary or employment-condition material is referenced');
    else gaps.push('salary/employment-condition evidence is not clearly identified');
  }
  if (/health/.test(rule.label.toLowerCase())) {
    if (has('health', 'medical')) positives.push('health information is disclosed for screening');
    else gaps.push('health position remains unverified');
  }
  if (/character|integrity|pic/.test(rule.label.toLowerCase())) {
    if (has('police', 'character', 'criminal', 'conviction', '4020', 'false', 'misleading')) positives.push('character/integrity disclosures require review');
    else gaps.push('character and document-integrity position remains unverified');
  }
  if (/location|visa status|bars/.test(rule.label.toLowerCase())) {
    if (has('visa', 'vevo', 'bridging', 'onshore', 'offshore', '8503', 'section 48', 'refusal', 'cancellation')) positives.push('visa/status or immigration-history information is disclosed');
    else gaps.push('current visa status, location and application-bar position are not fully evidenced');
  }

  if (!positives.length && !gaps.length) gaps.push(`the file has not yet been mapped to this ${clean(criterion.clause, 'criterion')} requirement`);

  const positiveText = positives.length ? `The intake suggests that ${positives.join('; ')}.` : '';
  const gapText = gaps.length ? `However, ${gaps.join('; ')}.` : '';
  return clean(`${positiveText} ${gapText}`, `The file should be tested against ${familyProfile.label.toLowerCase()} requirements and original evidence.`);
}

function riskForCriterion({ criterion, factsApplied }) {
  const rule = ruleForCriterion(criterion);
  const hay = `${rule.label} ${factsApplied} ${clean(criterion.requirementText)} ${JSON.stringify(criterion.riskTriggers || [])}`.toLowerCase();
  if (/invalid|bar|section 48|8503|refus|cancel|character|pic 4020|false|misleading|labour agreement|nomination|salary|sponsor|relationship|protection|exclusion/.test(hay)) return 'High';
  if (/not clearly|unverified|not evidenced|gap|health|english|skills|occupation|location|status/.test(hay)) return 'Moderate';
  return 'Managed';
}

function statusForFacts(factsApplied) {
  const s = clean(factsApplied).toLowerCase();
  if (/not clearly|not evidenced|unverified|not fully|does not yet|however/.test(s)) return 'Not verified';
  if (/disclosed|provided|appears|supplied/.test(s)) return 'Partly evidenced — verify originals';
  return 'Requires evidence mapping';
}


function isLegalFrameCriterion(criterion = {}) {
  return Boolean(criterion.legalTest || criterion.legalSource || criterion.knowledgebaseReferences || criterion.consequenceOfFailure);
}

function requireLegalFrameCriterion(criterion = {}) {
  const id = clean(criterion.criterionId || criterion.registryCriterionId || criterion.id || criterion.clause, 'unknown criterion');
  const missing = [];
  if (!clean(criterion.legalTest || criterion.requirementText || criterion.legalRequirement || criterion.requirement)) missing.push('legal test');
  if (!clean(criterion.legalSource) && !criterion.source && !criterion.sourceMap) missing.push('legal source');
  if (criterion.missingLegalFrameParts && criterion.missingLegalFrameParts.length) missing.push(...criterion.missingLegalFrameParts);
  if (missing.length) {
    const err = new Error(`Senior advice engine blocked: missing knowledgebase legal frame for ${id} (${Array.from(new Set(missing)).join(', ')}).`);
    err.code = 'SENIOR_LEGAL_FRAME_INCOMPLETE';
    err.criterionId = id;
    throw err;
  }
}

function kbSourceSummary(criterion = {}) {
  const refs = asArray(criterion.knowledgebaseReferences);
  if (!refs.length) return clean(criterion.legalSource || 'knowledgebase legal sources');
  const authorities = Array.from(new Set(refs.map(r => clean(r.authority)).filter(Boolean)));
  return authorities.length ? authorities.join(', ') : clean(criterion.legalSource || 'knowledgebase legal sources');
}

function publicSafeStreamLabel(subclass, stream, registry) {
  let s = clean(stream || registry?.defaultStream || registry?.selectedStream || '');
  const sc = normSubclass(subclass);
  if (/registry-controlled/i.test(s)) {
    const keys = Object.keys(registry?.streams || {});
    const preferred = keys.find(k => /labou?r agreement/i.test(k)) || keys[0];
    s = preferred || (sc === '186' ? 'Labour Agreement' : 'Selected pathway');
  }
  if (sc === '186' && /labou?r agreement/i.test(s) && !/stream/i.test(s)) return 'Labour Agreement Stream';
  return s;
}

function buildCriterionFinding({ criterion, assessment, corpus, familyProfile }) {
  requireLegalFrameCriterion(criterion);
  const rule = ruleForCriterion(criterion);
  const legalFrameMode = isLegalFrameCriterion(criterion);
  const legalTest = summariseRequirementText(criterion.legalTest || criterion.requirementText || criterion.legalRequirement || criterion.requirement);
  const factsApplied = factsAppliedForCriterion({ criterion: criterion.originalCriterion || criterion, assessment, corpus, familyProfile });
  const risk = riskForCriterion({ criterion: criterion.originalCriterion || criterion, factsApplied });
  const label = criterionLabel(criterion.originalCriterion || criterion);
  const evidence = evidenceFromCriterion(criterion.originalCriterion || criterion, criterion.evidenceRequired || rule.evidence);
  const sourceSummary = kbSourceSummary(criterion);
  const legalRequirement = legalFrameMode
    ? `${legalTest} Source control: ${clean(criterion.legalSource || sourceSummary)}.`
    : `${rule.requirement}${legalTest ? ' The registry text for this clause records: ' + legalTest : ''}`;
  const legalConsequence = clean(criterion.consequenceOfFailure || rule.consequence);
  const actionRequired = clean(
    criterion.requiredAction ||
    criterion.actionRequired ||
    criterion.clientAction ||
    (risk === 'High'
      ? `Resolve this issue against original evidence and the mapped legal frame before any positive lodgement recommendation.`
      : `Obtain and reconcile the required evidence against the mapped legal frame before filing.`)
  );
  const agentOpinion = risk === 'High'
    ? `This is a senior-review issue. I would not give a final positive lodgement opinion until the legal frame, original evidence and Departmental record position all support this requirement.`
    : risk === 'Moderate'
      ? `This is manageable only if the missing evidence is obtained, reconciled and checked against the mapped legal frame before filing.`
      : `This should be controlled through evidence indexing and final lodgement review against the mapped legal frame.`;

  const policyGuidance = clean(criterion.policyGuidance);
  const sourceRefs = asArray(criterion.knowledgebaseReferences).map(r => clean(`${r.authority || 'Source'}: ${r.path || ''}`)).filter(Boolean);

  return {
    criterionId: clean(criterion.criterionId || criterion.id || criterion.clause),
    registryCriterionId: clean(criterion.registryCriterionId || criterion.criterionId || criterion.id || criterion.clause),
    criterion_id: clean(criterion.criterionId || criterion.id || criterion.clause),
    clause: clean(criterion.clause),
    criterion: label,
    heading: label,
    label,
    category: clean(criterion.issue || rule.label),
    pdfSection: clean(criterion.issue || rule.label),
    timePoint: clean(criterion.timePoint),
    status: statusForFacts(factsApplied),
    position: statusForFacts(factsApplied),
    risk,
    riskLevel: risk,
    legalRequirement,
    legislativeRequirement: legalRequirement,
    requirement: legalRequirement,
    legalSource: clean(criterion.legalSource || sourceSummary),
    sourceSummary,
    policyGuidance,
    sourceReferences: sourceRefs,
    knowledgebaseReferences: criterion.knowledgebaseReferences || [],
    factsApplied,
    finding: `${factsApplied} ${agentOpinion}`,
    professionalFinding: `${factsApplied} ${agentOpinion}`,
    delegateScrutiny: `A delegate is likely to test this issue by comparing the application answers with original records, prior Departmental information and the mapped legal/policy frame (${sourceSummary}).`,
    legalConsequence,
    legal_consequence: legalConsequence,
    actionRequired,
    requiredAction: actionRequired,
    recommendation: actionRequired,
    evidenceRequired: evidence,
    evidence_required: evidence,
    requiredEvidence: evidence,
    clientAction: actionRequired,
    source: criterion.source || {},
    sourceMap: criterion.sourceMap || {},
    originalCriterion: criterion.originalCriterion || criterion,
    legalFrameApplied: true,
    genericFallbackUsed: false
  };
}

function resolveRegistryAndCriteria({ subclass, stream }) {
  const code = normSubclass(subclass);
  const registry = loadCriteriaRegistry(code);
  let criteria = criteriaForStream(registry, stream);
  if (!criteria.length) {
    const streams = registry.streams || {};
    criteria = Object.values(streams).flatMap(s => asArray(s.criteria || s.grantCriteria || s.schedule2GrantCriteria || s.items));
  }
  if (!criteria.length && Array.isArray(registry.criteria)) criteria = registry.criteria;
  return { registry, criteria };
}

function streamLabelFromRegistry(registry, stream) {
  const requested = clean(stream || registry.defaultStream || registry.selectedStream || '');
  if (!requested) {
    const keys = Object.keys(registry.streams || {});
    return keys.length === 1 ? keys[0] : 'Selected pathway';
  }
  if (/registry-controlled/i.test(requested)) {
    const keys = Object.keys(registry.streams || {});
    const preferred = keys.find(k => /labour agreement/i.test(k)) || keys[0];
    return preferred || requested;
  }
  return requested;
}

function buildLegalIssues({ findings, familyProfile }) {
  const grouped = new Map();
  for (const f of findings) {
    const key = f.category || 'Subclass-specific grant criterion';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(f);
  }
  return Array.from(grouped.entries()).map(([issue, rows]) => {
    const high = rows.filter(r => r.risk === 'High').length;
    const moderate = rows.filter(r => r.risk === 'Moderate').length;
    const lead = rows[0];
    return {
      issue,
      risk: high ? 'High' : moderate ? 'Moderate' : 'Managed',
      legalRequirement: lead.legalRequirement,
      currentFilePosition: rows.slice(0, 3).map(r => r.factsApplied).join(' '),
      evidenceGap: rows.flatMap(r => r.evidenceRequired || []).slice(0, 8),
      consequence: lead.legalConsequence,
      requiredAction: lead.actionRequired,
      seniorOpinion: high
        ? `This issue should be resolved before lodgement advice is finalised.`
        : `This issue can be managed through targeted evidence review and file indexing.`
    };
  });
}

function finalRecommendation({ subclass, stream, familyProfile, findings, corpus }) {
  const high = findings.filter(f => f.risk === 'High');
  const moderate = findings.filter(f => f.risk === 'Moderate');
  const risk = high.length ? 'High' : moderate.length >= 3 ? 'Moderate to High' : moderate.length ? 'Moderate' : 'Managed';
  const proceedNow = false;
  const decisive = high.slice(0, 4).map(f => f.category).filter(Boolean);
  const reason = decisive.length
    ? `The file is not presently lodgement-ready because ${Array.from(new Set(decisive)).join(', ')} must be resolved against original evidence.`
    : `The file should move to evidence verification before any final positive lodgement recommendation.`;
  return {
    proceedNow,
    overallRisk: risk,
    lodgementPosition: 'Do not lodge yet — proceed to senior evidence review first',
    reason,
    seniorConclusion: `Based on the information presently available for Subclass ${subclass}${stream ? ' — ' + stream : ''}, the pathway may be capable of assessment, but I would not recommend immediate lodgement. ${reason} The next professional step is a criterion-by-criterion evidence brief and final lodgement-readiness review.`,
    conditionsBeforeLodgement: Array.from(new Set(findings.filter(f => f.risk !== 'Managed').slice(0, 10).map(f => f.actionRequired)))
  };
}


function assertSubclassIsolation({ subclass, family, selectedStream, findings }) {
  const text = JSON.stringify({ subclass, family, selectedStream, findings });
  if (family !== 'employer') {
    const employerLeak = /Direct Entry skills|salary and market|market salary|AMSR|genuine position|nominated occupation|ANZSCO|sponsoring employer|Labour Market Testing/i.exec(text);
    if (employerLeak) {
      const err = new Error(`Senior advice engine blocked: employer-sponsored criterion leaked into Subclass ${subclass}: ${employerLeak[0]}.`);
      err.code = 'SENIOR_SUBCLASS_CONTAMINATION';
      throw err;
    }
  }
  if (family === 'partner') {
    const nonPartnerLeak = /occupation eligibility|skills assessment|labour agreement|nomination validity|salary\/AMSR/i.exec(text);
    if (nonPartnerLeak) {
      const err = new Error(`Senior advice engine blocked: non-partner criterion leaked into Subclass ${subclass}: ${nonPartnerLeak[0]}.`);
      err.code = 'SENIOR_PARTNER_CONTAMINATION';
      throw err;
    }
  }
  if (/stream\/pathway|registry-controlled pathway|primary pathway/i.test(String(selectedStream || ''))) {
    const err = new Error(`Senior advice engine blocked: unresolved stream/pathway for Subclass ${subclass}.`);
    err.code = 'SENIOR_STREAM_NOT_CONFIRMED';
    throw err;
  }
}

function buildSeniorAdviceModel({ assessment = {}, adviceBundle = {}, registry = null, stream = '', legalFrame = null } = {}) {
  const subclass = normSubclass(adviceBundle.subclass || adviceBundle.advice?.subclass || assessment.visa_type || assessment.subclass || assessment.visaSubclass);
  if (!subclass) throw new Error('Senior advice engine blocked: subclass is missing.');
  const loaded = registry ? { registry, criteria: criteriaForStream(registry, stream || adviceBundle.stream || adviceBundle.selectedStream || adviceBundle.advice?.stream) } : resolveRegistryAndCriteria({ subclass, stream: stream || adviceBundle.stream || adviceBundle.selectedStream || adviceBundle.advice?.stream });
  const activeRegistry = loaded.registry;
  const selectedStream = publicSafeStreamLabel(subclass, stream || legalFrame?.clientFacingStream || adviceBundle.stream || adviceBundle.selectedStream || adviceBundle.advice?.stream || assessment.selected_stream, activeRegistry);
  const family = visaFamily(subclass);
  const familyProfile = FAMILY_PROFILES[family] || FAMILY_PROFILES.general;
  const corpus = answerCorpus(assessment);
  const legalFrameFromBundle = legalFrame || adviceBundle.legalFrame || adviceBundle.internalLegalAudit?.legalFrame || null;
  const criteria = legalFrameFromBundle && Array.isArray(legalFrameFromBundle.criteriaFrames) && legalFrameFromBundle.criteriaFrames.length
    ? legalFrameFromBundle.criteriaFrames
    : (loaded.criteria && loaded.criteria.length ? loaded.criteria : []);
  if (!criteria.length) throw new Error(`Senior advice engine blocked: no criteria/legal frames loaded for subclass ${subclass}.`);
  const findings = criteria.map(criterion => buildCriterionFinding({ criterion, assessment, corpus, familyProfile }));
  assertSubclassIsolation({ subclass, family, selectedStream, findings });
  const legalIssues = buildLegalIssues({ findings, familyProfile });
  const recommendation = finalRecommendation({ subclass, stream: selectedStream, familyProfile, findings, corpus });

  return {
    engine: 'senior-australian-immigration-advice-engine',
    version: '1.0.1-v38-engine-design-subclass-isolation',
    generatedAt: new Date().toISOString(),
    subclass,
    stream: selectedStream,
    title: `Professional Migration Advice — Subclass ${subclass}${selectedStream ? ' — ' + selectedStream : ''}`,
    visaFamily: family,
    familyProfile,
    matterSummary: {
      subclass,
      stream: selectedStream,
      pathwayLabel: `Subclass ${subclass}${selectedStream ? ' — ' + selectedStream : ''}`,
      overallRisk: recommendation.overallRisk,
      lodgementPosition: recommendation.lodgementPosition,
      centralIssues: familyProfile.centralIssues,
      evidenceTheme: familyProfile.warning
    },
    executiveOpinion: {
      opinion: recommendation.seniorConclusion,
      proceedNow: recommendation.proceedNow,
      mainReason: recommendation.reason,
      nextStep: 'Prepare a criterion-by-criterion evidence brief, resolve high-risk gaps, then issue final lodgement advice.'
    },
    legalIssues,
    criteriaFindings: findings,
    seniorCriteriaFindings: findings,
    grantCriteriaFindings: findings,
    fullCriteriaRegistryMatrix: findings,
    evidencePlan: Array.from(new Set([...familyProfile.evidence, ...findings.flatMap(f => f.evidenceRequired || [])])).slice(0, 30),
    finalRecommendation: recommendation,
    coverage: {
      criteriaLoaded: criteria.length,
      criteriaRendered: findings.length,
      supportedSubclassCount: listSupportedCriteriaRegistrySubclasses().length,
      registrySource: activeRegistry.sourceOfTruth || activeRegistry.registryFingerprint || 'criteriaRegistry',
      legalFrameApplied: Boolean(legalFrameFromBundle && legalFrameFromBundle.criteriaFrames && legalFrameFromBundle.criteriaFrames.length),
      genericFallbackUsed: false
    },
    clientSafety: {
      noGuarantee: true,
      preliminaryUntilOriginalEvidenceReviewed: true,
      noInternalRegistryLabels: true,
      seniorReviewRequired: true
    }
  };
}

function attachSeniorAdviceModel(adviceBundle, assessment, registryResult, registry) {
  const source = adviceBundle || {};
  const model = buildSeniorAdviceModel({
    assessment,
    adviceBundle: source,
    registry,
    stream: source.stream || source.selectedStream || source.advice?.stream || assessment?.selected_stream,
    legalFrame: source.legalFrame || null
  });
  source.seniorAdviceModel = model;
  source.seniorCriteriaFindings = model.seniorCriteriaFindings;
  source.fullCriteriaRegistryMatrix = model.fullCriteriaRegistryMatrix;
  source.grantCriteriaFindings = model.grantCriteriaFindings;
  source.criteriaRegistryFindings = model.criteriaFindings;
  source.seniorLegalIssues = model.legalIssues;
  source.seniorFinalRecommendation = model.finalRecommendation;
  source.advice = source.advice || {};
  source.advice.seniorAdviceModel = model;
  source.advice.criterion_findings = model.criteriaFindings;
  source.advice.grantCriteriaFindings = model.grantCriteriaFindings;
  source.advice.fullCriteriaRegistryMatrix = model.fullCriteriaRegistryMatrix;
  source.advice.executive_summary = model.executiveOpinion.opinion;
  source.advice.recommendation = model.finalRecommendation.lodgementPosition;
  source.advice.risk_level = model.finalRecommendation.overallRisk;
  source.advice.lodgement_position = model.finalRecommendation.lodgementPosition;
  source.advice.disclaimer = 'This advice is preliminary and subject to review of original documents, current law, policy, Departmental records, conflict checks and final review by a registered migration agent before lodgement. No guarantee of visa grant is given.';
  source.seniorAdviceEngineApplied = true;
  source.genericFallbackAllowed = false;
  source.subclassSpecificAdviceRequired = true;
  source.knowledgebaseFirstAdvice = true;
  if (source.internalLegalAudit) {
    source.internalLegalAudit.seniorAdviceEngine = {
      applied: true,
      version: model.version,
      criteriaRendered: model.coverage.criteriaRendered,
      generatedAt: model.generatedAt
    };
  }
  return source;
}

module.exports = {
  buildSeniorAdviceModel,
  attachSeniorAdviceModel,
  visaFamily,
  FAMILY_PROFILES,
  TYPE_RULES,
  supportedSubclasses: listSupportedCriteriaRegistrySubclasses
};
