'use strict';

/**
 * Bircan Migration pdf.js — premium advice-letter renderer v36
 *
 * Server contract preserved:
 *   - buildAssessmentPdfBuffer(assessment, adviceBundle)
 *   - buildAppealAdvicePdfBuffer(assessment, adviceBundle)
 *   - sha256(buffer)
 *
 * This renderer intentionally merges the stronger current advice logic with the
 * premium visual standard of the earlier Bircan advice letter. It renders through
 * Playwright/Chromium so long legal text wraps like a browser document rather
 * than as fragile PDF coordinate drawing.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RENDERER_VERSION = 'pdf-js-premium-legal-advice-renderer-v36-20260523';

const BRAND = {
  name: 'Bircan Migration & Education',
  shortName: 'Bircan Migration',
  subtitle: 'Professional Migration Assessment',
  agent: 'Kenan Bircan JP',
  marn: '1463685'
};

const INTERNAL_KEYS = new Set([
  'internalLegalAudit', 'internalAuditObject', 'criteriaRegistryAudit', 'rawRegistryFindings',
  'criteriaRegistryFindings', 'debug', 'rawDebug', 'sourceHash', 'sourceHashes', 'quality_flags',
  'prompt', 'systemPrompt', 'developerPrompt', 'chainOfThought', 'rawPrompt', 'openAiMessages'
]);

const FORBIDDEN_CLIENT_PHRASES = [
  'criteria registry', 'knowledgebase source mapping', 'saved assessment answers', 'engine output',
  'risk controls', 'internalLegalAudit', 'rawRegistryFindings', 'criteriaRegistryAudit', 'quality_flags',
  'source hash', 'Grant Criterion Control', 'Registry-controlled pathway', 'Registry controlled pathway',
  'Map the original evidence to the clause'
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(v => v !== undefined && v !== null && v !== '') : [value];
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function stripInternalKeys(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map(v => stripInternalKeys(v, seen)).filter(v => v !== undefined && v !== null && v !== '');
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return {};
  seen.add(value);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (INTERNAL_KEYS.has(key)) continue;
    out[key] = stripInternalKeys(val, seen);
  }
  return out;
}

function cleanText(value) {
  if (value === undefined || value === null) return '';
  let out = String(value)
    .normalize('NFKC')
    .replace(/[\uFFFC-\uFFFF]/g, ' ')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\u00AD/g, '')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\bcriteria registry\b/gi, 'legal criteria framework')
    .replace(/\bsubclass criteria registry\b/gi, 'subclass legal criteria framework')
    .replace(/\bknowledgebase source mapping\b/gi, 'source review')
    .replace(/\bsource-mapped registry\b/gi, 'verified legal sources')
    .replace(/\bsaved assessment answers\b/gi, 'current instructions')
    .replace(/\bengine output\b/gi, 'assessment findings')
    .replace(/\brisk controls\b/gi, 'professional review controls')
    .replace(/\bGrant Criterion Control\b/gi, 'Grant criterion requirement')
    .replace(/\bRegistry-controlled pathway Stream\b/gi, 'selected stream')
    .replace(/\bRegistry-controlled pathway\b/gi, 'selected stream')
    .replace(/\bRegistry controlled pathway\b/gi, 'selected stream')
    .replace(/\bPrimary pathway\b/gi, 'selected pathway')
    .replace(/Map the original evidence to the clause and record any unresolved gap before final advice\.?/gi,
      'Review the original evidence against this requirement and resolve any evidentiary gap before final lodgement advice.')
    .replace(/Final clause-level references should be confirmed against the current legislation and instruments before lodgement advice is issued\.?/gi,
      'The final lodgement position must be checked against current legislation, instruments and Departmental records before filing.')
    .replace(/This preliminary assessment considered the Subclass ([0-9]+)\s*([^.]*) framework using the current instructions, subclass legal criteria framework, source review, evidence validation and professional review controls\./gi,
      'This assessment considered the Subclass $1 $2 framework, including stream eligibility, nomination-related issues, applicant eligibility, evidence requirements and relevant public interest considerations.')
    .replace(/\bdocument\s+consistency\b/gi, 'document consistency')
    .replace(/\bpublic\s+interest\b/gi, 'public interest')
    .replace(/\bhealth\s+related\b/gi, 'health related')
    .replace(/\bpathway\s+specific\b/gi, 'pathway specific')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (/\bIELTS\b/i.test(out)) {
    out = out.replace(/\b(listening|reading|writing|speaking)\s+([0-9]{2})(\b|[,;)])/gi, (m, comp, raw, end) => {
      const n = Number(raw);
      if (n >= 10 && n <= 90) return `${comp} ${(n / 10).toFixed(1)}${end}`;
      return m;
    });
  }
  return out;
}

function html(value) {
  return cleanText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sentence(value) {
  const s = cleanText(value);
  if (!s) return '';
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function humanizeObject(value) {
  if (!isPlainObject(value)) return cleanText(value);
  const issue = pick(value.issue, value.title, value.area, value.criterion, value.criterionLabel, value.criterionName);
  const position = pick(value.position, value.summary, value.fullText, value.finding, value.professionalPosition);
  const risk = pick(value.overallRisk, value.risk, value.riskLevel, value.status, value.statusLabel);
  const evidence = pick(value.requiredEvidence, value.evidenceRequired, value.evidence, value.documentsRequired, value.evidenceGap);
  const action = pick(value.requiredAction, value.action, value.recommendation, value.nextStep);
  const parts = [];
  if (issue) parts.push(cleanText(issue));
  if (position) parts.push(cleanText(position));
  if (risk) parts.push(`Risk/status: ${cleanText(risk)}`);
  if (evidence) parts.push(`Evidence required: ${Array.isArray(evidence) ? evidence.map(cleanText).join(', ') : cleanText(evidence)}`);
  if (action) parts.push(`Action: ${cleanText(action)}`);
  if (parts.length) return cleanText(parts.join(' - '));
  return Object.entries(value)
    .filter(([k, v]) => !INTERNAL_KEYS.has(k) && v !== undefined && v !== null && v !== '')
    .slice(0, 6)
    .map(([k, v]) => `${cleanText(k).replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}: ${Array.isArray(v) ? v.map(cleanText).join(', ') : (isPlainObject(v) ? humanizeObject(v) : cleanText(v))}`)
    .join('; ');
}

function toText(value, fallback = '—') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.map(v => toText(v, '')).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') return humanizeObject(value) || fallback;
  return cleanText(value) || fallback;
}

function body(value) { return cleanText(toText(value, '')); }

function professionalStatus(value) {
  const s = cleanText(value).toLowerCase();
  if (!s) return 'Not verified';
  if (/likely[_\s-]*satisfied|appears supportable|supportable|satisfied/.test(s)) return 'Appears supportable, subject to evidence';
  if (/not[_\s-]*satisfied|adverse|not supportable|refusal|fatal/.test(s)) return 'Presently adverse on current information';
  if (/not[_\s-]*applicable|n\/a/.test(s)) return 'Not presently applicable';
  if (/unclear|unknown|review|required|verify|reconcil|manual|pending/.test(s)) return 'Requires evidence reconciliation';
  return cleanText(value);
}

function getAdviceModel(bundle) {
  const b = stripInternalKeys(bundle || {});
  return stripInternalKeys(pick(
    b.clientAdviceObject,
    b.universalAdviceModel,
    b.seniorAdviceModel,
    b.adviceModel,
    b.clientAdvice,
    b.advice && b.advice.clientAdviceObject,
    b.advice && b.advice.universalAdviceModel,
    b.advice && b.advice.seniorAdviceModel,
    b.advice,
    b.adviceBundle,
    b.professionalAdvice,
    b
  )) || {};
}

function getSubclass(assessment, bundle, model) {
  return cleanText(pick(
    assessment.subclass, assessment.visa_type, assessment.visa_subclass, assessment.visaSubclass, assessment.selectedSubclass,
    bundle.subclass, bundle.visaSubclass,
    bundle.advice && (bundle.advice.subclass || bundle.advice.visaSubclass),
    model.subclass, model.visaSubclass, '186'
  )).replace(/[^0-9]/g, '').slice(0, 3) || '186';
}

function getStream(assessment, bundle, model) {
  let stream = cleanText(pick(
    model.streamLabel, model.clientFacingStream, model.stream, model.pathway, model.selectedStream,
    bundle.streamLabel, bundle.clientFacingStream, bundle.stream, bundle.pathway,
    bundle.advice && (bundle.advice.streamLabel || bundle.advice.clientFacingStream || bundle.advice.stream || bundle.advice.pathway),
    assessment.streamLabel, assessment.stream, assessment.pathway, assessment.selected_stream, assessment.selectedStream, assessment.visa_stream
  ));
  if (!stream || /registry|primary pathway|selected stream|stream\/pathway/i.test(stream)) stream = 'Direct Entry';
  if (/direct/i.test(stream)) return 'Direct Entry';
  if (/trt|temporary residence transition/i.test(stream)) return 'Temporary Residence Transition';
  if (/labou?r agreement|dama/i.test(stream)) return 'Labour Agreement';
  return stream;
}

function issueKey(value) {
  const text = body(isPlainObject(value) ? pick(value.issue, value.title, value.area, value.criterion, value.criterionLabel, value.criterionName, humanizeObject(value)) : value).toLowerCase();
  if (/english|186\.232/.test(text)) return 'english';
  if (/age|186\.212a/.test(text)) return 'age';
  if (/salary|market|remuneration|amsr|186\.233/.test(text)) return 'salary-market';
  if (/direct entry|skill|skills assessment|qualification|capability|186\.234/.test(text)) return 'direct-entry-skills';
  if (/occupation|anzsco|duties/.test(text)) return 'occupation-anzsco';
  if (/sponsor|employer|nomination|genuine|operational need|relationship|186\.211|186\.222|186\.223|186\.224|186\.231/.test(text)) return 'employer-nomination';
  if (/employment continuity|work history|experience/.test(text)) return 'employment-history';
  if (/health/.test(text)) return 'health';
  if (/character|integrity|public interest|pic/.test(text)) return 'character-integrity';
  if (/migration history|compliance|refusal|cancellation|section 48|8503/.test(text)) return 'migration-history';
  if (/valid|identity|application|location|status|186\.411/.test(text)) return 'validity-identity';
  if (/stream|pathway/.test(text)) return 'stream-pathway';
  return text.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'issue';
}

function findingTitle(f) {
  const raw = body(isPlainObject(f) ? pick(f.issue, f.title, f.area, f.criterionLabel, f.criterionName, f.criterion, f.criterionId, 'Assessment issue') : f);
  return professionalIssueTitle(raw);
}
function findingStatus(f) { return professionalStatus(isPlainObject(f) ? pick(f.professionalStatus, f.statusLabel, f.status, f.riskStatus, f.result, f.position, f.finding, f.riskLevel) : 'Requires evidence reconciliation'); }
function findingRequirement(f) { return body(isPlainObject(f) ? pick(f.legalRequirement, f.requirement, f.requirementSummary, f.criterionText, f.legalTest, f.rule, f.whatMustBeEstablished, f.assessmentRequired, f.legislativeRequirement) : ''); }
function findingFacts(f) { return body(isPlainObject(f) ? pick(f.applicationToFacts, f.factsApplication, f.analysis, f.reasoning, f.finding, f.summary, f.clientFacts, f.presentInformation, f.filePosition) : ''); }
function findingGap(f) { return body(isPlainObject(f) ? pick(f.evidenceStillRequired, f.evidenceGap, f.requiredEvidence, f.evidenceRequired, f.documentsRequired, f.evidenceMissing, f.gap) : ''); }
function findingAction(f) { return body(isPlainObject(f) ? pick(f.requiredAction, f.action, f.nextStep, f.recommendation, f.seniorOpinion, f.agentOpinion, f.strategy) : ''); }
function findingConsequence(f) { return body(isPlainObject(f) ? pick(f.consequenceIfUnresolved, f.consequence, f.riskConsequence, f.professionalConsequence, f.whyItMatters, f.riskIfMissing, f.delegateRisk) : ''); }

function professionalIssueTitle(raw) {
  const lower = cleanText(raw).toLowerCase();
  if (/stream|pathway|correct subclass/.test(lower)) return 'Subclass 186 stream selection and pathway control';
  if (/relationship|sponsor|employer|nomination|genuine|operational need|186\.211|186\.222|186\.223|186\.224|186\.231/.test(lower)) return 'Approved nomination, sponsoring employer and genuine position';
  if (/direct entry|skill|skills assessment|qualification|capability|186\.234/.test(lower)) return 'Direct Entry skills assessment, qualifications and occupation eligibility';
  if (/occupation|anzsco|duties/.test(lower)) return 'Occupation, ANZSCO alignment and actual duties';
  if (/employment continuity|work history|experience/.test(lower)) return 'Employment history, work experience and continuity';
  if (/salary|market|remuneration|amsr/.test(lower)) return 'Salary, market salary and employment terms';
  if (/english|186\.232/.test(lower)) return 'English language requirement or available concession';
  if (/age|186\.212a/.test(lower)) return 'Age requirement and available exemption';
  if (/valid|identity|application|location|status|186\.411/.test(lower)) return 'Application validity, identity and current visa status';
  if (/health/.test(lower)) return 'Health requirements and health-related public interest criteria';
  if (/character|integrity|public interest|pic/.test(lower)) return 'Character, integrity and public interest criteria';
  if (/migration history|compliance|refusal|cancellation|section 48|8503/.test(lower)) return 'Migration history, compliance and prior adverse records';
  return cleanText(raw || 'Assessment issue');
}

function specificRequirement(title, existing, subclass = '186', stream = 'Direct Entry') {
  const lower = cleanText(title).toLowerCase();
  const generic = !existing || /selected stream must be legally available|nominated position and employer material must demonstrate|relationship and sponsorship|pathway specific capability/i.test(existing);
  if (!generic) return existing;
  if (/stream selection|pathway control/.test(lower)) return `The selected Subclass ${subclass} ${stream} stream must be legally available on the facts and must align with the nomination, applicant eligibility and timing requirements before it is adopted as the lodgement pathway.`;
  if (/direct entry|skill|qualification|occupation eligibility/.test(lower)) return 'For the Direct Entry stream, the applicant must support the nominated occupation through the required skills assessment or alternative accepted basis, qualifications, employment history and any registration or licensing requirements.';
  if (/salary|market|employment terms/.test(lower)) return 'The remuneration and employment-terms position must be consistent with the nomination, employment contract, payroll records, market salary evidence and any applicable threshold, concession or instrument setting.';
  if (/occupation|anzsco|duties/.test(lower)) return 'The applicant’s actual duties, qualifications, employment history and registration or licensing evidence must align with the nominated occupation and relevant ANZSCO profile.';
  if (/nomination|sponsoring employer|genuine position/.test(lower)) return 'The nomination must be supported by a genuine, available and properly documented position connected to the sponsoring employer’s business operations and ongoing workforce need.';
  if (/employment history|work experience|continuity/.test(lower)) return 'The employment history and experience claim must be reconstructed from objective records and tested against the selected stream, nominated occupation and any relevant experience requirement.';
  if (/english/.test(lower)) return 'The applicant must hold acceptable English evidence, exemption evidence or concession evidence that is valid for the selected stream at the relevant time.';
  if (/age/.test(lower)) return 'The applicant must satisfy the applicable age requirement for the selected stream or establish a valid exemption, concession or alternative pathway.';
  if (/health/.test(lower)) return 'The applicant and any included family members must satisfy the applicable health requirements or address any health related issue before final advice is relied upon.';
  if (/character|integrity|public interest/.test(lower)) return 'The applicant must satisfy character and integrity requirements, including truthful disclosure, document consistency and any relevant public interest criterion.';
  if (/migration history|compliance|refusal|cancellation|section 48|8503/.test(lower)) return 'Prior visa history, refusals, cancellations, visa conditions, section 48 issues and no-further-stay restrictions must be reviewed before lodgement strategy is finalised.';
  if (/validity|identity|visa status|location/.test(lower)) return 'The visa application must first be validly made, including correct form, charge, applicant identity, location, visa status and stream-specific validity prerequisites.';
  return existing || 'This requirement must be verified against the applicable subclass framework before final lodgement advice is issued.';
}

function collectFindings(model, bundle) {
  const candidates = [
    model.clientFacingCriteriaFindings, model.seniorCriteriaFindings, model.grantCriteriaFindings,
    model.criteriaFindings, model.findings, model.legalFindings, model.issueFindings, model.criterionMatrix,
    model.lodgementReadinessMatrix, model.riskFindings, model.clientFindings, model.legalIssues, model.issues,
    bundle.clientFacingCriteriaFindings, bundle.seniorCriteriaFindings, bundle.grantCriteriaFindings,
    bundle.criteriaFindings, bundle.findings, bundle.legalFindings,
    bundle.advice && bundle.advice.clientFacingCriteriaFindings,
    bundle.advice && bundle.advice.seniorCriteriaFindings,
    bundle.advice && bundle.advice.grantCriteriaFindings,
    bundle.advice && bundle.advice.criteriaFindings
  ].flatMap(asArray).filter(Boolean).map(stripInternalKeys);
  return dedupeFindings(candidates, 40);
}

function findingScore(f) {
  return [findingRequirement(f), findingFacts(f), findingGap(f), findingConsequence(f), findingAction(f)].filter(Boolean).join(' ').length;
}

function dedupeFindings(items, limit = 40) {
  const map = new Map();
  for (const item of asArray(items)) {
    const key = issueKey(item);
    if (!key) continue;
    const previous = map.get(key);
    if (!previous || findingScore(item) > findingScore(previous)) map.set(key, item);
  }
  return Array.from(map.values()).slice(0, limit);
}

function findByKey(findings, key) {
  return findings.find(f => issueKey(f) === key) || null;
}

function standardFinding(key, issue, status, facts, evidence, action, consequence = '') {
  return {
    issue,
    status,
    applicationToFacts: facts,
    evidenceStillRequired: evidence,
    requiredAction: action,
    consequenceIfUnresolved: consequence || 'This issue may affect lodgement readiness if unresolved.'
  };
}

function ensureMandatoryFindings(assessment, subclass, stream, findings) {
  const byKey = new Map(dedupeFindings(findings).map(f => [issueKey(f), f]));
  const put = (key, fallback) => {
    const existing = byKey.get(key);
    byKey.set(key, existing && findingScore(existing) >= findingScore(fallback) ? existing : { ...fallback, ...existing, issue: professionalIssueTitle(pick(existing && (existing.issue || existing.title || existing.criterion), fallback.issue)) });
  };

  put('stream-pathway', standardFinding(
    'stream-pathway', 'Subclass 186 stream selection and pathway control', 'Requires evidence reconciliation',
    `The selected pathway is recorded as ${stream || 'not confirmed'}. The selected stream must be confirmed against the nomination, applicant eligibility, visa history and timing before it is adopted for lodgement.`,
    'Visa history, stream selection record, nomination pathway material and any transitional or concession evidence.',
    'Confirm that the selected stream is legally available and strategically strongest before lodgement.'
  ));
  put('employer-nomination', standardFinding(
    'employer-nomination', 'Approved nomination, sponsoring employer and genuine position', 'Requires evidence reconciliation',
    'The employer and nomination instructions must be reconciled against objective business records, position evidence, organisational need and nomination material.',
    'Nomination record, position description, organisational chart, business activity evidence, contracts, pipeline/workload material, payroll capacity and evidence of ongoing operational need.',
    'Build a coherent nomination file connecting the sponsor, business need, position, duties and employment terms.',
    'If the nomination, genuine position or employer-capacity evidence is inconsistent or incomplete, the nomination may become a primary refusal risk.'
  ));
  put('direct-entry-skills', standardFinding(
    'direct-entry-skills', 'Direct Entry skills assessment, qualifications and occupation eligibility', 'Requires evidence reconciliation',
    'The Direct Entry pathway must be verified against skills assessment, nominated occupation eligibility, qualification history, employment history and any registration or licensing requirement.',
    'Skills assessment, qualifications, employment references, CV, licensing or registration evidence, duties evidence and occupation eligibility material.',
    'Verify the skills and occupation evidence before relying on Direct Entry.',
    'If skills, occupation eligibility, registration/licensing or qualification evidence cannot be verified, the Direct Entry pathway may not be lodgement ready.'
  ));
  put('occupation-anzsco', standardFinding(
    'occupation-anzsco', 'Occupation, ANZSCO alignment and actual duties', 'Requires evidence reconciliation',
    'The actual duties must be mapped to the nominated occupation and supported by employer records, references and qualification or registration evidence.',
    'Detailed duties statement, ANZSCO comparison, CV, references, qualifications, registration/licensing and skills evidence.',
    'Prepare a duties matrix showing why the nominated occupation accurately reflects the actual role.',
    'If duties and evidence do not align with the nominated occupation, the occupation or nomination position may become a refusal risk.'
  ));
  put('employment-history', standardFinding(
    'employment-history', 'Employment history, work experience and continuity', 'Requires evidence reconciliation',
    'Employment continuity and experience should be reconstructed from objective payroll, tax, superannuation, leave and work-rights records rather than accepted from questionnaire wording alone.',
    'Employment contract, payslips, PAYG/tax records, superannuation, leave records and visa/work-rights history.',
    'Reconstruct the employment chronology and reconcile it against payroll, tax and visa records.'
  ));
  put('salary-market', standardFinding(
    'salary-market', 'Salary, market salary and employment terms', 'Requires evidence reconciliation',
    'The remuneration position must be tested against the nomination record, contract, payroll, superannuation, market salary material and any applicable threshold or concession.',
    'Employment contract, payslips, superannuation records, market salary evidence, award/enterprise agreement material and nomination salary records.',
    'Confirm the salary position is internally consistent and defensible against market salary or concession settings.',
    'If salary, market salary or concession evidence cannot be reconciled, the nomination or stream position may become a primary refusal risk.'
  ));
  put('english', standardFinding(
    'english', 'English language requirement or available concession', 'Requires evidence reconciliation',
    'English evidence, passport evidence, exemption evidence or concession evidence must be verified against the selected stream and timing requirements.',
    'Original English test report showing test type, component scores and validity date, or exemption/concession evidence.',
    'Verify English component scores, validity and any exemption or concession before final lodgement advice.'
  ));
  put('age', standardFinding(
    'age', 'Age requirement and available exemption', 'Requires evidence reconciliation',
    'Age must be checked against passport/date of birth evidence and any applicable age exemption, high-income pathway, occupation-based exemption or concession.',
    'Passport/date of birth evidence and any age exemption, concession, high-income, occupation-based or pathway specific material.',
    'Verify age, timing and any exemption or concession before final advice.'
  ));
  put('validity-identity', standardFinding(
    'validity-identity', 'Application validity, identity and current visa status', 'Requires evidence reconciliation',
    'Identity, current location, visa status, form, charge and stream-specific validity prerequisites must be confirmed before lodgement action.',
    'Passport, identity documents, name-change records, VEVO/current visa evidence, location evidence and validity checklist.',
    'Confirm identity, current location, visa status and validity requirements before any lodgement action.'
  ));
  put('health', standardFinding(
    'health', 'Health requirements and health-related public interest criteria', 'Appears supportable, subject to evidence',
    'No health issue should be treated as finally cleared until declarations, examinations and family-member health checks are reviewed.',
    'Health declarations, medical reports and any health undertaking or further assessment material.',
    'Review health disclosures and obtain relevant health documents before final advice.'
  ));
  put('character-integrity', standardFinding(
    'character-integrity', 'Character, integrity and public interest criteria', 'Appears supportable, subject to evidence',
    'Character, integrity, police and document-consistency matters must be reviewed against Departmental records and original evidence.',
    'Police clearances, court records, Department correspondence, identity records and document-consistency review.',
    'Confirm character and integrity position and resolve any disclosure issue before lodgement.',
    'If character, integrity or immigration-history records are inconsistent with the instructions, the matter may require strategy before lodgement.'
  ));
  put('migration-history', standardFinding(
    'migration-history', 'Migration history, compliance and prior adverse records', 'Appears supportable, subject to evidence',
    'Prior visas, refusals, cancellations, visa conditions, section 48 issues, no-further-stay restrictions and compliance history must be reconciled before final strategy.',
    'VEVO, grant letters, refusal/cancellation decisions, bridging visa records, prior application records and compliance history.',
    'Reconcile all migration history before treating the matter as low risk.'
  ));

  const order = ['stream-pathway','employer-nomination','direct-entry-skills','occupation-anzsco','employment-history','salary-market','english','age','validity-identity','health','character-integrity','migration-history'];
  return order.map(k => byKey.get(k)).filter(Boolean);
}

function uniqueText(items, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const item of asArray(items)) {
    const text = body(item);
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function priorityCategory(title) {
  const lower = cleanText(title).toLowerCase();
  if (/stream selection|pathway control/.test(lower)) return 'Pathway and validity control';
  if (/sponsor|employer|nomination|genuine|position|salary|market|employment terms/.test(lower)) return 'Employer, nomination and salary evidence';
  if (/direct entry|skill|occupation|anzsco|qualification|licen|registration|employment history|work experience|continuity/.test(lower)) return 'Direct Entry skills, occupation and employment evidence';
  if (/english|age|identity|valid|passport|location|visa status/.test(lower)) return 'Applicant eligibility and identity evidence';
  if (/health|character|integrity|migration|compliance|refusal|cancellation|public interest/.test(lower)) return 'Health, character and immigration-history evidence';
  return 'Additional evidence';
}

function groupedEvidence(findings) {
  const groups = new Map();
  for (const f of findings) {
    const title = findingTitle(f);
    const gap = findingGap(f);
    const action = findingAction(f);
    if (!gap && !action) continue;
    const group = priorityCategory(title);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ category: title, documents: gap || 'Evidence to be verified.', purpose: action || 'Resolve before final lodgement advice.' });
  }
  const preferred = ['Pathway and validity control','Employer, nomination and salary evidence','Direct Entry skills, occupation and employment evidence','Applicant eligibility and identity evidence','Health, character and immigration-history evidence','Additional evidence'];
  return preferred.map(group => ({ group, rows: groups.get(group) || [] })).filter(g => g.rows.length);
}

function tryReadLogoDataUri() {
  const candidates = [
    path.join(__dirname, 'assets', 'branding', 'logo.png'),
    path.join(__dirname, 'assets', 'branding', 'bircan-logo.png'),
    path.join(__dirname, 'assets', 'branding', 'brand-logo.png'),
    path.join(__dirname, 'assets', 'branding', 'logo.jpg'),
    path.join(__dirname, 'assets', 'branding', 'logo.jpeg')
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const ext = path.extname(file).toLowerCase().replace('.', '') || 'png';
        const mime = ext === 'jpg' ? 'jpeg' : ext;
        return `data:image/${mime};base64,${fs.readFileSync(file).toString('base64')}`;
      }
    } catch (_) {}
  }
  return '';
}

function kv(rows, className = '') {
  return `<div class="kv ${className}">${rows.map(([k, v]) => `<div class="kv-row"><div class="kv-key">${html(k)}</div><div class="kv-val">${html(v || '—')}</div></div>`).join('')}</div>`;
}
function para(text, cls = '') { return body(text) ? `<p class="${cls}">${html(text)}</p>` : ''; }
function h1(text) { return `<h1>${html(text)}</h1>`; }
function h2(text) { return `<h2>${html(text)}</h2>`; }
function list(items) { return `<ul>${uniqueText(items, 30).map(item => `<li>${html(item)}</li>`).join('')}</ul>`; }
function block(label, value) { return body(value) ? `<div class="advice-block"><div class="block-label">${html(label)}</div><div class="block-value">${html(value)}</div></div>` : ''; }

function table(headers, rows, cls = '') {
  return `<table class="${cls}"><thead><tr>${headers.map(h => `<th>${html(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${html(cell || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function executiveNarrative(model, assessment, subclass, stream, findings) {
  const name = body(pick(assessment.applicant_name, model.applicantName, model.clientName, 'the applicant'));
  const risk = normaliseRisk(pick(model.overallRisk, model.riskLevel, model.agentPosition && model.agentPosition.risk, 'Medium - evidence review required'));
  const issues = findings.slice(0, 5).map(findingTitle);
  return [
    `Dear ${name},`,
    `I have reviewed the information presently available for the proposed Subclass ${subclass}${stream ? ` ${stream}` : ''} visa pathway.`,
    `My professional opinion is that the pathway may be available in principle, but the matter is not presently lodgement-ready. I do not recommend immediate lodgement until the selected pathway, nomination position, applicant evidence, public-interest criteria and evidence consistency have been verified against original documents.`,
    `The main issues requiring file control are ${issues.join('; ')}. The current risk position is ${risk.toLowerCase()}. The correct next step is evidence verification and lodgement-readiness assessment, not immediate filing.`
  ];
}

function normaliseRisk(value) {
  const s = body(value);
  if (!s || /evidence review required/i.test(s)) return 'Medium - evidence review required';
  if (/medium to high/i.test(s)) return 'Medium to high';
  return s;
}

function recommendationParagraphs(model, findings) {
  const rec = pick(model.finalRecommendation, model.recommendation, model.agentPosition && model.agentPosition.recommendation, {});
  const priority = findings.slice(0, 4).map(findingTitle).join('; ');
  if (isPlainObject(rec)) {
    const position = body(pick(rec.position, 'Do not lodge yet'));
    const risk = normaliseRisk(pick(rec.overallRisk, rec.risk, rec.riskLevel, model.overallRisk, 'Medium - evidence review required'));
    const summary = body(pick(rec.summary, rec.fullText, model.lodgementPosition, 'The pathway may remain available, but only if the priority criteria and evidence gaps are reconciled against original documents.'));
    const next = body(pick(rec.nextStep, rec.requiredAction, model.nextStep, `Start with ${priority || 'the priority evidence schedule'} before final lodgement advice.`));
    return [`${position}. On the present information, the matter should not be treated as lodgement-ready.`, summary, `Current risk position: ${risk}.`, `Next step: ${next}`];
  }
  return [
    'Do not lodge yet. On the present information, the matter should not be treated as lodgement-ready.',
    'The pathway may remain available in principle, but only if the threshold criteria, nomination evidence, applicant eligibility evidence and public-interest position can be verified and reconciled.',
    `Next step: Start with ${priority || 'the priority evidence schedule'} before final lodgement advice.`
  ];
}

function actionCards(findings) {
  return findings.slice(0, 8).map((f, i) => `<div class="action-card avoid-break"><div class="action-number">${i + 1}</div><div><h3>${html(findingTitle(f))}</h3><p>${html(findingAction(f) || 'Resolve this issue before final lodgement advice.')}</p></div></div>`).join('');
}

function buildAssessmentHtml(assessment = {}, adviceBundle = {}) {
  const cleanAssessment = stripInternalKeys(assessment || {});
  const cleanBundle = stripInternalKeys(adviceBundle || {});
  const model = getAdviceModel(cleanBundle);
  const subclass = getSubclass(cleanAssessment, cleanBundle, model);
  const stream = getStream(cleanAssessment, cleanBundle, model);
  let findings = collectFindings(model, cleanBundle);
  findings = ensureMandatoryFindings(cleanAssessment, subclass, stream, findings);

  const generated = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  const evidenceGroups = groupedEvidence(findings);
  const risk = normaliseRisk(pick(model.overallRisk, model.riskLevel, model.agentPosition && model.agentPosition.risk, 'Medium - evidence review required'));
  const logo = tryReadLogoDataUri();

  const findingsHtml = findings.map((f, i) => {
    const title = findingTitle(f);
    return `<section class="finding avoid-break">
      <div class="finding-head"><span class="finding-no">${i + 1}</span><h2>${html(title)}</h2><span class="status-pill">${html(findingStatus(f))}</span></div>
      <div class="finding-grid">
        ${block('Legal requirement', specificRequirement(title, findingRequirement(f), subclass, stream))}
        ${block('Application to current instructions', findingFacts(f) || 'The available instructions must be reconciled against original evidence before final advice.')}
        ${block('Evidence still required', findingGap(f) || 'Supporting evidence is required before final lodgement advice.')}
        ${block('Consequence if unresolved', findingConsequence(f) || 'This issue may affect lodgement readiness if unresolved.')}
      </div>
      ${block('Required action', findingAction(f) || 'Resolve before final lodgement advice.')}
    </section>`;
  }).join('');

  const evidenceHtml = evidenceGroups.map((g, i) => `<section class="evidence-group avoid-break">
    <h2>Priority ${i + 1} - ${html(g.group)}</h2>
    ${table(['Document category', 'Required documents', 'Purpose'], g.rows.map(r => [r.category, r.documents, r.purpose]), 'schedule-table')}
  </section>`).join('');

  const riskRows = findings.slice(0, 10).map(f => [findingTitle(f), findingStatus(f), findingConsequence(f) || 'Requires evidence review before final advice.', findingAction(f) || 'Resolve before lodgement.']);
  const appendixRows = findings.map(f => [findingTitle(f), findingStatus(f), specificRequirement(findingTitle(f), findingRequirement(f), subclass, stream), `${findingGap(f) || 'Evidence gap to be resolved.'} ${findingAction(f) || 'Resolve before final lodgement advice.'}`]);

  return htmlDocument(`${html(BRAND.name)} - Professional Migration Advice`, `
    <section class="cover premium-cover page-break-after">
      <div class="cover-band">
        <div class="logo-card">${logo ? `<img src="${logo}" alt="Bircan Migration"/>` : `<div class="logo-text">BIRCAN<br/><span>MIGRATION</span></div>`}</div>
        <div class="brand-line">${html(BRAND.name)} | ${html(BRAND.subtitle)}</div>
        <div class="gold-rule"></div>
        <h1 class="cover-title">Professional Migration<br/>Advice Letter</h1>
        <div class="cover-subtitle">Subclass ${html(subclass || '—')}${stream ? ' - ' + html(stream) : ''}</div>
        <div class="cover-circle circle-one"></div><div class="cover-circle circle-two"></div>
      </div>
      <div class="matter-card premium-card">
        <h2>Matter details</h2>
        ${kv([
          ['Reference', pick(cleanAssessment.id, cleanAssessment.reference, cleanAssessment.assessment_id, '—')],
          ["Applicant's name", pick(cleanAssessment.applicant_name, model.applicantName, model.clientName, '—')],
          ['Applicant email', pick(cleanAssessment.applicant_email, model.applicantEmail, '—')],
          ['Client email', pick(cleanAssessment.client_email, model.clientEmail, cleanAssessment.applicant_email, '—')],
          ['Subclass', subclass || '—'], ['Stream', stream || '—'], ['Generated', generated]
        ], 'matter-kv')}
      </div>
      <div class="confidential-card avoid-break"><h2>Confidential professional advice</h2>${para('This advice letter is prepared from the information presently available. It is subject to review of original evidence, current law, Departmental records, conflict checks and final migration-agent review before lodgement action. No guarantee of visa grant is given.')}</div>
    </section>

    <main>
      ${h1('1. Executive professional advice')}
      ${executiveNarrative(model, cleanAssessment, subclass, stream, findings).map((p, idx) => para(p, idx === 0 ? 'salutation' : 'lead')).join('')}
      ${table(['Client question', 'Professional answer'], [
        ['Is this pathway open?', 'Potentially, subject to verification of the nomination, applicant evidence and public-interest position.'],
        ['Should the application be lodged now?', 'No. Lodgement is not recommended on the current evidence position.'],
        ['What should happen next?', 'Proceed to a formal evidence review and lodgement-readiness assessment before filing.'],
        ['What is the main risk?', 'The matter may fail if the nomination, selected pathway and evidence do not support the same legal position.']
      ], 'qa-table')}
      ${kv([
        ['Pathway assessed', `Subclass ${subclass}${stream ? ' - ' + stream : ''}`],
        ['Current professional position', pick(model.currentProfessionalPosition, model.lodgementPosition, model.agentPosition && model.agentPosition.position, 'Potentially viable subject to evidence reconciliation')],
        ['Overall risk', risk],
        ['Lodgement-readiness position', 'Not lodgement-ready until priority evidence is reconciled and reviewed']
      ])}
      ${h2('Main issues to resolve')}${list(findings.slice(0, 6).map(findingTitle))}

      ${h1('2. Facts, assumptions and evidence status')}
      ${para('The following facts are treated as preliminary unless confirmed by original evidence. This section separates what is presently known from what must still be verified before final lodgement advice is issued.')}
      ${table(['Matter area','Present information','Evidence status','Professional consequence'], [
        ['Applicant identity', pick(cleanAssessment.applicant_name, model.applicantName, 'Not confirmed'), 'Not fully verified', 'Identity and Departmental records must be reconciled before filing.'],
        ['Visa subclass', `Subclass ${subclass}`, 'Identified', 'Assessment should remain within this subclass unless evidence shows another pathway is more appropriate.'],
        ['Stream', stream || 'Not confirmed', 'Identified', 'The stream controls nomination, applicant and timing analysis.'],
        ['Evidence status', pick(model.evidenceStatus, model.evidenceSummary, 'Original evidence not yet fully reviewed'), 'Not verified', 'No final positive lodgement advice should issue until original evidence is reviewed.']
      ], 'status-table')}

      ${h1('3. Legal framework applied')}
      ${para(`This assessment applies the Subclass ${subclass}${stream ? ` ${stream}` : ''} framework to the information currently available, including stream eligibility, nomination-related issues, applicant eligibility, evidence requirements, health, character, migration-history and public interest considerations.`)}
      ${table(['Control point','What must be established','Why it matters'], [
        ['Validity', 'The application can be validly made in the selected stream with correct application settings and pathway linkage.', 'A validity defect can prevent the application from being properly considered.'],
        ['Nomination and employer position', 'The nomination is consistent with employer evidence, role, salary, location, business need and duties.', 'The final advice must be based on verified criteria, not assumptions.'],
        ['Applicant eligibility', 'Skills, English, age, identity, visa status, health and character issues are clear or manageable.', 'Applicant-side criteria can defeat an otherwise supportable pathway.'],
        ['Evidence integrity', 'Forms, nomination, contract and supporting evidence are internally consistent and complete.', 'Inconsistency can create refusal or PIC 4020 risk.']
      ], 'framework-table')}

      ${h1('4. Application of law to the client’s facts')}
      ${para('The following findings apply the identified requirements to the information currently available. They separate matters that appear supportable from matters requiring evidence reconciliation before any final lodgement recommendation.')}
      ${findingsHtml}

      ${h1('5. Evidence plan and document request')}
      ${para('Before final lodgement advice can be issued, the following documents should be obtained and reviewed. The schedule is grouped by practical file-control priority.')}
      ${evidenceHtml}

      ${h1('6. Risk assessment')}
      ${para('The matter presents as potentially supportable but not presently lodgement-ready. The risk arises because multiple connected elements must be correct at the same time: stream selection, nomination, applicant eligibility, evidence consistency and public-interest matters.')}
      ${table(['Issue','Risk/status','Professional consequence','Required response'], riskRows, 'risk-table')}

      ${h1('7. Lodgement-readiness action plan')}
      ${para('Before this matter is treated as ready for lodgement, the following steps should be completed.')}
      <div class="action-list">${actionCards(findings)}</div>

      ${h1('8. Final professional recommendation')}
      ${recommendationParagraphs(model, findings).map((p, i) => para(p, i === 0 ? 'strong' : '')).join('')}
      ${para('This is the appropriate professional approach because it protects the client from avoidable refusal risk and ensures that any final lodgement advice is based on verified evidence, current legal settings and a defensible application record.')}

      ${h1('9. Important limitations')}
      ${para('This advice is preliminary and based on the information presently available. It is subject to review of original documents, current law and policy, Departmental records, conflict checks and final professional review before lodgement. No guarantee of visa grant is given.')}
      ${para('The Department may request further information, identify adverse information or reach a different view after assessing the complete application record.')}
      <div class="signature"><p><strong>Yours faithfully,</strong></p><p><strong>${html(BRAND.agent)}</strong><br/><strong>Registered Migration Agent | MARN: ${html(BRAND.marn)}</strong><br/><strong>${html(BRAND.name)}</strong></p></div>

      <section class="page-break-before appendix">
        ${h1('Appendix A - Full lodgement-readiness matrix')}
        ${para('This appendix is a professional lodgement-readiness schedule. It records the issue, status, requirement and required action for file control. It is not a guarantee that each criterion is satisfied.')}
        ${table(['Issue','Status','Requirement','Gap / required action'], appendixRows, 'appendix-table')}
      </section>
    </main>
  `);
}

function buildAppealHtml(assessment = {}, adviceBundle = {}) {
  const model = stripInternalKeys(pick(adviceBundle.appealAdviceModel, adviceBundle.advice, adviceBundle)) || {};
  const issues = asArray(pick(model.issues, model.findings, model.reviewIssues)).slice(0, 20);
  return htmlDocument(`${html(BRAND.name)} - Appeal Advice`, `
    <main>
      ${h1(pick(model.title, 'Visa refusal review advice'))}
      ${kv([
        ['Reference', pick(assessment.reference, assessment.assessment_id, assessment.id, '—')],
        ['Applicant', pick(assessment.applicant_name, assessment.applicantName, model.applicantName, '—')],
        ['Generated', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })]
      ])}
      ${para(pick(model.executiveAdvice, model.summary, 'This appeal assessment is prepared from the information presently available and requires review of the decision record, application file and relevant time limits.'), 'lead')}
      ${h1('Issues for review')}${list(issues.map(x => isPlainObject(x) ? pick(x.issue, x.title, x.finding, x.summary) : x))}
      ${h1('Recommendation')}${para(pick(model.recommendation, model.finalRecommendation, 'A final appeal recommendation should be issued only after the decision record, reasons, evidence and time limits are reviewed.'))}
      ${h1('Important limitations')}${para('This advice is preliminary and based on the information presently available. It is subject to review of original documents, current law and policy, Departmental records, conflict checks and final professional review before lodgement. No guarantee of visa grant is given.')}
    </main>
  `);
}

function htmlDocument(title, bodyContent) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>${title}</title><style>
  @page { size: A4; margin: 14mm 15mm 16mm 15mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #172033; font-family: Arial, Helvetica, sans-serif; font-size: 9.8pt; line-height: 1.48; overflow-wrap: anywhere; word-break: normal; background: #fff; }
  h1,h2,h3,p,li,div,td,th { max-width: 100%; }
  h1 { color: #082246; font-size: 17pt; line-height: 1.12; margin: 13pt 0 7pt 0; padding-bottom: 5pt; border-bottom: 1.5pt solid #d5a63f; page-break-after: avoid; }
  h2 { color: #102f55; font-size: 11.2pt; line-height: 1.2; margin: 9pt 0 5pt 0; page-break-after: avoid; }
  h3 { color: #102f55; font-size: 9.7pt; margin: 0 0 3pt 0; }
  p { margin: 0 0 7pt 0; } .lead { font-size: 10.2pt; } .strong { font-weight: 800; } .salutation { font-weight: 700; margin-bottom: 9pt; }
  ul { margin: 5pt 0 10pt 16pt; padding: 0; } li { margin: 0 0 4pt 0; }
  main { padding-top: 2mm; }
  .cover { page-break-after: always; }
  .cover-band { position: relative; height: 85mm; background: #061f41; margin: -14mm -15mm 18mm -15mm; padding: 16mm 20mm; overflow: hidden; color: #fff; }
  .logo-card { position: absolute; left: 20mm; top: 13mm; width: 54mm; height: 22mm; background: #fff; border-radius: 12pt; display: flex; align-items: center; justify-content: center; padding: 4mm; box-shadow: 0 1pt 3pt rgba(0,0,0,.18); }
  .logo-card img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .logo-text { color: #0b2545; font-weight: 900; font-size: 13pt; letter-spacing: 1.7pt; text-align: center; line-height: 1; } .logo-text span { font-size: 7.5pt; letter-spacing: 3pt; }
  .brand-line { position: absolute; left: 82mm; top: 21mm; color: rgba(255,255,255,.86); font-size: 9.2pt; }
  .gold-rule { position: absolute; left: 20mm; top: 44mm; width: 58mm; border-top: 2pt solid #d5a63f; }
  .cover-title { position: absolute; left: 20mm; top: 50mm; margin: 0; padding: 0; border: 0; color: #fff; font-size: 25pt; line-height: 1.16; }
  .cover-subtitle { position: absolute; left: 20mm; top: 75mm; color: rgba(255,255,255,.82); font-size: 10.6pt; }
  .cover-band:after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 4mm; background: #d5a63f; }
  .cover-circle { position: absolute; border-radius: 999px; background: rgba(55,95,160,.25); } .circle-one { width: 58mm; height: 58mm; right: 8mm; top: -8mm; } .circle-two { width: 28mm; height: 28mm; right: 45mm; top: 36mm; background: rgba(214,173,77,.18); }
  .premium-card { background: #f3f6fb; border: 1px solid #dbe3ee; border-radius: 16pt; padding: 10mm; margin: 0 0 13mm 0; page-break-inside: avoid; }
  .premium-card h2, .confidential-card h2 { margin-top: 0; color: #0b2545; }
  .confidential-card { border: 1px solid #eadba8; background: #fffaf0; border-radius: 14pt; padding: 8mm; page-break-inside: avoid; }
  .kv { width: 100%; border: 1px solid #dbe3ee; border-radius: 6pt; overflow: hidden; margin: 5pt 0 12pt 0; page-break-inside: avoid; }
  .kv-row { display: grid; grid-template-columns: 31% 69%; border-bottom: 1px solid #dbe3ee; min-height: 22pt; } .kv-row:last-child { border-bottom: 0; }
  .kv-key { background: #f1f5fa; color: #314258; font-weight: 800; padding: 6pt 8pt; } .kv-val { background: #fff; padding: 6pt 8pt; }
  table { width: 100%; border-collapse: collapse; margin: 6pt 0 12pt 0; page-break-inside: avoid; }
  th { background: #061f41; color: #fff; text-align: left; font-size: 8.3pt; padding: 6pt 7pt; }
  td { border: 1px solid #dbe3ee; padding: 6pt 7pt; vertical-align: top; font-size: 8.6pt; }
  tbody tr:nth-child(even) td { background: #fbfdff; } tbody tr:nth-child(odd) td { background: #fff; }
  .qa-table th:nth-child(1) { width: 30%; } .status-table th:nth-child(1) { width: 19%; } .schedule-table th:nth-child(1) { width: 25%; } .risk-table th:nth-child(1) { width: 24%; }
  .finding { border: 1px solid #dde6f2; border-radius: 9pt; padding: 8pt 9pt; margin: 9pt 0 11pt 0; page-break-inside: avoid; background: #fff; }
  .finding-head { display: grid; grid-template-columns: 22pt 1fr auto; gap: 6pt; align-items: center; margin-bottom: 5pt; }
  .finding-no { width: 20pt; height: 20pt; border-radius: 99px; background: #d5a63f; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 800; }
  .finding-head h2 { margin: 0; border: 0; padding: 0; }
  .status-pill { background: #eef4fb; color: #0b2545; border: 1px solid #dbe3ee; border-radius: 99px; padding: 3pt 7pt; font-weight: 800; font-size: 7.8pt; white-space: nowrap; }
  .finding-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6pt; }
  .advice-block { border: 1px solid #dbe3ee; border-radius: 7pt; background: #fbfdff; padding: 6pt 7pt; margin: 0 0 6pt 0; page-break-inside: avoid; }
  .block-label { color: #082246; font-size: 8pt; font-weight: 800; margin-bottom: 2pt; } .block-value { color: #172033; font-size: 8.9pt; }
  .evidence-group { page-break-inside: avoid; } .action-list { display: grid; gap: 7pt; }
  .action-card { display: grid; grid-template-columns: 24pt 1fr; gap: 8pt; border: 1px solid #dbe3ee; border-radius: 10pt; padding: 8pt; background: #fbfdff; page-break-inside: avoid; }
  .action-number { width: 23pt; height: 23pt; border-radius: 99px; background: #d5a63f; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 900; }
  .signature { margin-top: 18pt; }
  .avoid-break { page-break-inside: avoid; break-inside: avoid; } .page-break-after { page-break-after: always; } .page-break-before { page-break-before: always; }
  .appendix h1 { margin-top: 0; } .appendix-table td:nth-child(3), .appendix-table td:nth-child(4) { font-size: 8.1pt; }
  @media print { body:before { content: '${html(BRAND.shortName)}'; position: fixed; left: 15mm; bottom: 5mm; color: #0b2545; font-size: 7.5pt; font-weight: 800; } body:after { content: 'Professional Migration Advice Letter'; position: fixed; right: 15mm; bottom: 5mm; color: #8a96a8; font-size: 7.5pt; } }
</style></head><body>${bodyContent}</body></html>`;
}

function flattenStrings(value, out = [], seen = new WeakSet()) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { value.forEach(v => flattenStrings(v, out, seen)); return out; }
  if (isPlainObject(value)) {
    if (seen.has(value)) return out;
    seen.add(value);
    for (const [key, val] of Object.entries(value)) { out.push(String(key)); flattenStrings(val, out, seen); }
  }
  return out;
}

function assertNoForbiddenClientText(renderedHtml) {
  const lower = cleanText(renderedHtml).toLowerCase();
  const hit = FORBIDDEN_CLIENT_PHRASES.find(phrase => lower.includes(String(phrase).toLowerCase()));
  if (hit) throw new Error(`PDF blocked: client-facing advice contains internal phrase: ${hit}`);
}

async function renderHtmlToPdfBuffer(renderedHtml) {
  assertNoForbiddenClientText(renderedHtml);
  let playwright;
  try { playwright = require('playwright'); }
  catch (err) { throw new Error('Playwright is not installed. Add dependency "playwright" and run "npx playwright install chromium" during Render build.'); }
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.setContent(renderedHtml, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
  } finally { await browser.close().catch(() => {}); }
}

async function buildAssessmentPdfBuffer(assessment = {}, adviceBundle = {}) {
  const renderedHtml = buildAssessmentHtml(assessment, adviceBundle);
  return renderHtmlToPdfBuffer(renderedHtml);
}

async function buildAppealAdvicePdfBuffer(assessment = {}, adviceBundle = {}) {
  const renderedHtml = buildAppealHtml(assessment, adviceBundle);
  return renderHtmlToPdfBuffer(renderedHtml);
}

module.exports = { buildAssessmentPdfBuffer, buildAppealAdvicePdfBuffer, buildAssessmentHtml, buildAppealHtml, sha256, RENDERER_VERSION };
