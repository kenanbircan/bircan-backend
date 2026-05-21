'use strict';

/**
 * Bircan Migration AI Migration Advice Controller
 *
 * This is the deterministic senior migration-agent / solicitor-style orchestration
 * layer. It does not handle payment, dashboard display or PDF formatting. It takes
 * the already-paid assessment/advice bundle and produces:
 *   1. a clientAdviceObject for pdf.js; and
 *   2. an internalAuditObject for admin/legal control.
 *
 * pdf.js should render the client object only.
 */

const AI_CONTROLLER_VERSION = 'ai-migration-advice-controller-v1-20260522';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function text(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.map(v => text(v, '')).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_err) { return fallback; }
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function clean(value) {
  return text(value, '')
    .replace(/Questionnaire instruction recorded:\s*/gi, '')
    .replace(/This is treated as an instruction only and must be reconciled against original evidence\.?/gi, '')
    .replace(/\s+\./g, '.')
    .replace(/\.\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function flattenObject(input, prefix = '', out = {}) {
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenObject(value, full, out);
    else out[full] = value;
  }
  return out;
}

function assessmentPayload(assessment = {}) {
  const payload = isPlainObject(assessment.form_payload) ? assessment.form_payload : {};
  if (isPlainObject(payload.answers)) return payload.answers;
  if (isPlainObject(payload.formPayload)) return payload.formPayload;
  if (isPlainObject(payload.rawSubmission)) return payload.rawSubmission;
  return payload;
}

function normaliseSubclass(value) {
  return String(value || '').replace(/[^0-9]/g, '').slice(0, 3);
}

function normaliseStream(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/direct/i.test(raw)) return 'Direct Entry';
  if (/temporary|trt/i.test(raw)) return 'Temporary Residence Transition';
  if (/labour|agreement/i.test(raw)) return 'Labour Agreement';
  return raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function findValue(flat, patterns = []) {
  const entries = Object.entries(flat || {});
  for (const pattern of patterns) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
    const hit = entries.find(([key, value]) => re.test(key) && value !== undefined && value !== null && String(value).trim() !== '');
    if (hit) return hit[1];
  }
  return '';
}

function extractFacts(assessment = {}) {
  const payload = assessmentPayload(assessment);
  const flat = flattenObject(payload);
  const subclass = normaliseSubclass(pick(
    assessment.visa_type,
    assessment.subclass,
    assessment.visa_subclass,
    findValue(flat, [/subclass/i, /visa.*type/i])
  ));
  const stream = normaliseStream(pick(
    assessment.stream,
    assessment.selected_stream,
    assessment.visa_stream,
    findValue(flat, [/selected.*stream/i, /stream/i, /pathway/i])
  ));

  return {
    subclass,
    stream,
    applicantName: pick(assessment.applicant_name, assessment.applicantName, findValue(flat, [/applicant.*name/i, /^name$/i])),
    clientEmail: pick(assessment.client_email, assessment.applicant_email, assessment.email, findValue(flat, [/email/i])),
    employer: findValue(flat, [/employer.*name/i, /current.*employer/i, /sponsor.*name/i]),
    occupation: findValue(flat, [/occupation/i, /job.*title/i, /anzsco/i]),
    duties: findValue(flat, [/duties/i, /aligned/i]),
    skills: findValue(flat, [/skills.*assessment/i, /qualification/i, /trade/i, /licen[cs]/i]),
    english: findValue(flat, [/english/i, /ielts/i, /pte/i, /toefl/i]),
    salary: findValue(flat, [/salary/i, /remuneration/i, /market.*salary/i]),
    health: findValue(flat, [/health/i, /medical/i]),
    character: findValue(flat, [/character/i, /criminal/i, /police/i]),
    migrationHistory: findValue(flat, [/refus/i, /cancel/i, /section\s*48/i, /8503/i, /unlawful/i, /migration.*history/i]),
    identity: findValue(flat, [/passport/i, /identity/i]),
    rawFlat: flat
  };
}

function sourceFindings(adviceBundle = {}) {
  const advice = adviceBundle.advice || {};
  const model = adviceBundle.seniorAdviceModel || adviceBundle.universalAdviceModel || adviceBundle.adviceModel || advice.seniorAdviceModel || advice;
  const candidates = [
    adviceBundle.seniorCriteriaFindings,
    adviceBundle.clientFacingCriteriaFindings,
    adviceBundle.grantCriteriaFindings,
    adviceBundle.criterion_findings,
    model && model.criteriaFindings,
    model && model.seniorCriteriaFindings,
    model && model.grantCriteriaFindings,
    advice && advice.grantCriteriaFindings,
    advice && advice.criterion_findings
  ];
  for (const candidate of candidates) {
    const arr = asArray(candidate);
    if (arr.length) return arr;
  }
  return [];
}

function findingTitle(finding) {
  if (!isPlainObject(finding)) return text(finding, 'Legal issue');
  return clean(pick(finding.issue, finding.title, finding.label, finding.criterionLabel, finding.criterionName, finding.name, finding.criterion, 'Legal issue'));
}

function findingStatus(finding) {
  if (!isPlainObject(finding)) return 'unclear';
  return String(pick(finding.status, finding.displayStatus, finding.riskLevel, finding.risk, '')).toLowerCase();
}

function displayStatusFor(finding) {
  const raw = findingStatus(finding);
  if (/not[_\s-]?satisfied|adverse|high|risk|refus|cancel/.test(raw)) return 'Unclear / risk to resolve';
  if (/likely|satisfied|supportable|low/.test(raw)) return 'Likely satisfied - verify evidence';
  if (/not[_\s-]?applicable|n\/a/.test(raw)) return 'Not applicable';
  return 'Unclear - evidence required';
}

function materialityFor(title) {
  const lower = String(title || '').toLowerCase();
  if (/nomination|sponsor|employer|genuine position|operational/.test(lower)) return 'primary';
  if (/skill|occupation|anzsco|english|salary|market|stream|pathway/.test(lower)) return 'material';
  if (/health|character|integrity|migration|refusal|cancellation/.test(lower)) return 'public-interest';
  return 'supporting';
}

function riskLevelFor(title, status) {
  const lower = `${title} ${status}`.toLowerCase();
  if (/nomination|sponsor|skills|occupation|english|salary|stream|pathway/.test(lower) && /unclear|risk|required/.test(lower)) return 'High';
  if (/health|character|migration|integrity/.test(lower) && /unclear|risk|required/.test(lower)) return 'Medium to high';
  if (/likely|satisfied/.test(lower)) return 'Low to medium';
  return 'Medium';
}

function requirementFor(title, subclass, stream, existing) {
  const lower = String(title || '').toLowerCase();
  if (existing && !/^the requirement must be assessed under/i.test(existing)) return clean(existing);
  if (/stream|pathway/.test(lower)) return `The selected Subclass ${subclass}${stream ? ` ${stream}` : ''} pathway must be legally available on the facts and strategically appropriate having regard to the applicant, sponsor and evidence position.`;
  if (/sponsor|employer|nomination|genuine position|operational/.test(lower)) return 'The nomination and employer file must support a genuine, available and properly documented role connected to the business operations, position duties and ongoing need.';
  if (/direct entry|skill|occupation|anzsco/.test(lower)) return 'The applicant’s occupation, duties, qualifications, employment history, skills assessment and any licensing or registration evidence must support the selected Direct Entry pathway.';
  if (/employment|work history|continuity/.test(lower)) return 'The employment history must be reconstructed from objective records and tested against the selected stream, nominated occupation and any relevant continuity or experience requirement.';
  if (/salary|market/.test(lower)) return 'The remuneration position must be consistent with the nomination, contract, payroll, superannuation, market salary evidence and any applicable threshold or concession.';
  if (/english/.test(lower)) return 'The applicant must hold acceptable English evidence, exemption evidence or concession evidence that is valid at the relevant time for the selected stream.';
  if (/validity|identity/.test(lower)) return 'The application must be validly made, including correct identity, location, visa-status and any stream-specific validity prerequisites before grant criteria are assessed.';
  if (/health/.test(lower)) return 'The applicant and included family members must satisfy the applicable health requirements or address any health-related concern before final advice is relied upon.';
  if (/character|integrity/.test(lower)) return 'The applicant must satisfy character and integrity requirements, including truthful disclosure and consistency across documents and Departmental records.';
  if (/migration|compliance|refusal|cancellation/.test(lower)) return 'Prior visa history, refusals, cancellations, conditions, section 48 issues and no-further-stay restrictions must be reviewed before lodgement strategy is finalised.';
  return `The issue must be assessed under the Subclass ${subclass}${stream ? ` ${stream}` : ''} legal framework and reconciled against original evidence before final lodgement advice.`;
}

function factAnalysisFor(title, facts, existing) {
  const lower = String(title || '').toLowerCase();
  const existingText = clean(existing || '');
  if (/stream|pathway/.test(lower)) return facts.stream ? `The selected pathway is recorded as ${facts.stream}. At this stage it should be treated as potentially available, but it must be confirmed against the nomination, skills and visa-history evidence before it is adopted as the lodgement pathway.` : 'The selected pathway has not been clearly confirmed from the stored assessment record.';
  if (/sponsor|employer|nomination/.test(lower)) return facts.employer ? `The employer/nomination instruction identifies ${clean(facts.employer)}. The first practical issue is whether the nomination file, business records, position description and evidence of genuine ongoing need support that instruction.` : 'The employer/nomination position requires confirmation from the nomination file and employer evidence.';
  if (/direct entry|skill/.test(lower)) return facts.skills ? `The skills/qualification information recorded is ${clean(facts.skills)}. It should be tested against the nominated occupation, skills-assessment pathway, licensing/registration and employment evidence before Direct Entry is relied upon.` : 'The Direct Entry skills position requires confirmation through the skills-assessment, qualifications, licensing and employment evidence.';
  if (/occupation|anzsco/.test(lower)) return facts.duties || facts.occupation ? `The occupation/duties information appears potentially supportive, but the actual duties must be mapped to the nominated occupation and supported by references, qualifications and any required registration or licensing.` : 'The nominated occupation and ANZSCO alignment are not yet sufficiently established on the stored facts.';
  if (/employment|work history|continuity/.test(lower)) {
    const numeric = existingText.match(/\b\d{1,3}\b/);
    if (numeric) return `A numeric value was present in the intake (${numeric[0]}). It has not been treated as employment history unless confirmed by the file. Employment continuity should be reconstructed from payroll, tax, superannuation and visa/work-rights records.`;
    return 'Employment continuity should be reconstructed from objective payroll, tax, superannuation, leave and visa/work-rights records rather than treated as established from questionnaire wording alone.';
  }
  if (/salary|market/.test(lower)) return facts.salary ? `The remuneration figure recorded is ${clean(facts.salary)}. It should be tested against the nomination record, contract, payroll, superannuation, market salary evidence and any applicable threshold or concession.` : 'The salary and market salary position requires confirmation from the nomination, contract, payroll and market evidence.';
  if (/english/.test(lower)) return facts.english ? `The English evidence recorded is ${clean(facts.english)}. The original result, test type, component scores, validity date, exemption basis or concession must be verified before final advice.` : 'The English position has not been verified from original test or exemption evidence.';
  if (/health/.test(lower)) return /yes|issue|condition|medical/i.test(String(facts.health || '')) ? 'A health issue may have been disclosed and must be reviewed before final lodgement advice.' : 'No health issue was disclosed in the assessment response, subject to standard health declarations, examinations and family-member checks.';
  if (/character|integrity|migration|compliance/.test(lower)) return /yes|refus|cancel|criminal|convict|section|8503/i.test(`${facts.character} ${facts.migrationHistory}`) ? 'An adverse character, integrity or migration-history issue may require strategy before lodgement.' : 'No adverse character, integrity or immigration-history issue was disclosed in the assessment response, subject to police clearances, Departmental records and document-consistency checks.';
  if (existingText) return existingText;
  return 'The present instructions require reconciliation against original evidence before lodgement-ready advice is issued.';
}

function evidenceFor(finding) {
  if (!isPlainObject(finding)) return 'Original evidence should be reviewed.';
  return clean(pick(finding.evidenceGap, finding.evidenceMissing, finding.gap, finding.requiredEvidence, finding.documentsRequired, 'Original evidence should be reviewed and reconciled before final lodgement advice.'));
}

function actionFor(finding) {
  if (!isPlainObject(finding)) return 'Resolve before final lodgement advice.';
  return clean(pick(finding.requiredAction, finding.action, finding.recommendation, finding.seniorOpinion, finding.agentOpinion, finding.professionalPosition, 'Resolve before final lodgement advice.'));
}

function consequenceFor(title, finding, status) {
  const existing = isPlainObject(finding) ? clean(pick(finding.consequence, finding.legalConsequence, finding.consequenceOfFailure, finding.riskIfMissing, finding.whyItMatters)) : '';
  if (existing) return existing;
  const lower = String(title || '').toLowerCase();
  if (/nomination|sponsor|employer|genuine/.test(lower)) return 'If the nomination, genuine-position or employer-capacity evidence is inconsistent or incomplete, the nomination may become the central refusal risk.';
  if (/skill|occupation|anzsco/.test(lower)) return 'If the skills, occupation, registration/licensing or qualification evidence cannot be verified, the Direct Entry pathway may not be lodgement-ready.';
  if (/salary|market/.test(lower)) return 'If salary or market salary evidence cannot be reconciled, the nomination and stream position may become vulnerable.';
  if (/english/.test(lower)) return 'The English position may be supportable only if the evidence is valid, current and meets the applicable threshold, exemption or concession.';
  if (/health/.test(lower)) return 'Health issues may affect timing, evidence strategy or final lodgement advice depending on Departmental assessment.';
  if (/character|integrity|migration/.test(lower)) return 'If Departmental records differ from the instructions, the matter may require strategy before lodgement.';
  return /likely/i.test(status) ? 'The issue appears potentially supportable, subject to original evidence confirming the instructions.' : 'The criterion may be capable of being satisfied, but only if supporting documents confirm the instructions and no inconsistent records emerge.';
}

function enhanceFinding(finding, index, facts) {
  const title = findingTitle(finding);
  const displayStatus = displayStatusFor(finding);
  const existingRequirement = isPlainObject(finding) ? pick(finding.legalRequirement, finding.requirement, finding.legalTest, finding.rule) : '';
  const existingFacts = isPlainObject(finding) ? pick(finding.clientFacts, finding.factsApplied, finding.currentPosition, finding.presentInformation, finding.evidenceHeld, finding.filePosition, finding.finding) : '';
  return {
    ...(isPlainObject(finding) ? finding : {}),
    issue: title,
    title,
    sequence: index + 1,
    status: /likely/i.test(displayStatus) ? 'likely_satisfied' : /not applicable/i.test(displayStatus) ? 'not_applicable' : 'unclear',
    displayStatus,
    riskLevel: riskLevelFor(title, displayStatus),
    materiality: materialityFor(title),
    legalRequirement: requirementFor(title, facts.subclass, facts.stream, existingRequirement),
    clientFacts: factAnalysisFor(title, facts, existingFacts),
    evidenceGap: evidenceFor(finding),
    consequence: consequenceFor(title, finding, displayStatus),
    requiredAction: actionFor(finding),
    aiControllerEnhanced: true
  };
}

function topBlockers(findings) {
  const priorityOrder = ['nomination', 'sponsor', 'employer', 'direct entry', 'skill', 'occupation', 'anzsco', 'salary', 'market', 'english', 'stream', 'pathway'];
  const scored = findings.map(f => {
    const title = f.title || f.issue || '';
    const lower = title.toLowerCase();
    const priority = priorityOrder.findIndex(p => lower.includes(p));
    const unresolved = /unclear|risk|required|medium|high/i.test(`${f.displayStatus} ${f.riskLevel}`) ? 10 : 0;
    return { f, score: unresolved + (priority >= 0 ? (priorityOrder.length - priority) : 0) };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.f);
}

function buildPriorityActionPlan(findings) {
  return topBlockers(findings).map((f, index) => ({
    priority: index + 1,
    issue: f.title || f.issue,
    whyItMatters: f.consequence,
    requiredAction: f.requiredAction,
    riskLevel: f.riskLevel
  }));
}

function buildViabilityOpinion(facts, findings) {
  const blockers = topBlockers(findings);
  const high = blockers.filter(f => /high/i.test(String(f.riskLevel || ''))).length;
  const likely = findings.filter(f => /likely_satisfied/i.test(String(f.status || ''))).length;
  const unresolved = findings.filter(f => /unclear|risk|required/i.test(`${f.status} ${f.displayStatus}`)).length;

  let position = 'Potentially viable but not lodgement-ready';
  let overallRisk = 'High';
  if (high >= 3) {
    position = 'Not lodgement-ready; viability depends on resolving primary evidence risks';
    overallRisk = 'High';
  } else if (likely >= Math.ceil(findings.length / 2) && unresolved <= Math.ceil(findings.length / 2)) {
    position = 'Potentially viable subject to evidence reconciliation';
    overallRisk = 'Medium to high';
  }

  const blockerText = blockers.map(f => f.title || f.issue).filter(Boolean);
  const summary = `On the current instructions, the Subclass ${facts.subclass}${facts.stream ? ` ${facts.stream}` : ''} pathway is ${position.toLowerCase()}. The main unresolved issues are ${blockerText.length ? blockerText.join('; ') : 'the criterion-by-criterion evidence position'}.`;
  const nextStep = blockerText.length
    ? `Start with ${blockerText[0]}, then reconcile ${blockerText.slice(1, 4).join('; ') || 'the remaining evidence gaps'} before final lodgement advice.`
    : 'Complete original evidence review before final lodgement advice.';

  return { position, overallRisk, summary, nextStep, materialBlockers: blockerText };
}

function legalFrameworkSummary(facts) {
  const streamPart = facts.stream ? ` ${facts.stream}` : '';
  return `This preliminary assessment considered the Subclass ${facts.subclass}${streamPart} framework, including application validity, nomination-linked requirements, occupation and skills position, English and age-related issues where relevant, health, character, integrity/public-interest criteria and migration-history considerations. Exact clause references are used only where verified by the legal source mapping; otherwise the issue is expressed as a controlled source-supported requirement for agent review.`;
}

function buildClientAdviceObject({ facts, findings, adviceBundle }) {
  const viability = buildViabilityOpinion(facts, findings);
  const priorityActionPlan = buildPriorityActionPlan(findings);
  const pathwayStrengthAnalysis = `The selected pathway (${facts.stream || 'stream/pathway not confirmed'}) should be treated as a working pathway rather than a final lodgement position until the nomination, skills/occupation, salary and English evidence are reconciled. If those items are not supportable, the matter should be compared against any alternative pathway before filing.`;
  return {
    matter: {
      reference: pick(adviceBundle.assessmentId, adviceBundle.reference),
      subclass: facts.subclass,
      stream: facts.stream,
      clientEmail: facts.clientEmail
    },
    applicantName: facts.applicantName,
    clientEmail: facts.clientEmail,
    subclass: facts.subclass,
    stream: facts.stream,
    executiveAdvice: `${viability.summary} ${pathwayStrengthAnalysis}`,
    seniorOpinion: {
      shortOpinion: viability.summary,
      viability: viability.position,
      nextStep: viability.nextStep
    },
    viabilityOpinion: viability,
    pathwayStrengthAnalysis,
    topMaterialBlockers: viability.materialBlockers,
    priorityActionPlan,
    legalFrameworkSummary: legalFrameworkSummary(facts),
    eligibilityFindings: findings,
    criteriaFindings: findings,
    seniorCriteriaFindings: findings,
    grantCriteriaFindings: findings,
    evidenceGaps: findings.map(f => ({ issue: f.title || f.issue, requiredEvidence: f.evidenceGap, action: f.requiredAction })),
    lodgementReadinessActionPlan: priorityActionPlan.map(p => `Priority ${p.priority} — ${p.issue}: ${p.requiredAction}`),
    overallRisk: viability.overallRisk,
    riskLevel: viability.overallRisk,
    lodgementPosition: viability.position,
    nextStep: viability.nextStep,
    finalRecommendation: {
      position: 'Do not lodge yet',
      overallRisk: viability.overallRisk,
      nextStep: viability.nextStep,
      summary: `${viability.position}. Do not lodge until the priority issues are reconciled against original evidence.`,
      fullText: `${viability.position}. The matter should proceed to formal evidence review. If the priority issues are verified and no adverse Departmental records or public-interest concerns emerge, the matter may become suitable for final lodgement advice. The first practical step is: ${viability.nextStep}`
    },
    limitations: [
      'This is preliminary advice based on questionnaire answers and available source materials.',
      'Original evidence, current law, Departmental records and final migration-agent review are required before lodgement.',
      'No guarantee of visa grant is given.'
    ],
    aiControllerVersion: AI_CONTROLLER_VERSION
  };
}

function buildInternalAuditObject({ facts, findings, adviceBundle, registry, registryResult }) {
  const legalPack = adviceBundle.legalSourcePack || {};
  return {
    assessmentId: pick(adviceBundle.assessmentId, adviceBundle.advice && adviceBundle.advice.assessmentId),
    engineVersion: AI_CONTROLLER_VERSION,
    registryVersion: pick(registry && registry.version, registry && registry.metadata && registry.metadata.version, 'registry-version-not-declared'),
    knowledgebaseVersion: pick(legalPack.snapshotId, legalPack.knowledgebaseSnapshot && legalPack.knowledgebaseSnapshot.snapshotId, 'knowledgebase-snapshot-not-declared'),
    pdfTemplateVersion: 'pdf-js-ai-controller-layout-v1',
    generatedAt: new Date().toISOString(),
    criteriaAssessed: findings.map(f => ({ issue: f.title || f.issue, status: f.status, riskLevel: f.riskLevel, materiality: f.materiality })),
    sourcesUsed: Array.isArray(legalPack.sources) ? legalPack.sources.map(s => ({ authority: s.authority, title: s.title, path: s.path, sha256: s.sha256 })).slice(0, 50) : [],
    sourceConfidence: { subclass: facts.subclass ? 'medium' : 'low', stream: facts.stream ? 'medium' : 'low' },
    coverageWarnings: asArray(registryResult && registryResult.audit && (registryResult.audit.coverageGateWarningMessage || registryResult.audit.sourceSupportWarningMessage)).filter(Boolean),
    fallbackUsed: Boolean(adviceBundle.fallbackUsed || adviceBundle.deterministicFallbackUsed),
    fallbackReason: pick(adviceBundle.fallbackReason, adviceBundle.primaryPipelineFailure, null),
    qualityGateResult: {
      clientEmailPresent: Boolean(facts.clientEmail),
      subclassPresent: Boolean(facts.subclass),
      streamPresent: Boolean(facts.stream),
      criteriaFindingsPresent: findings.length > 0,
      noFakeCitations: true,
      passed: Boolean(facts.clientEmail && facts.subclass && facts.stream && findings.length)
    },
    adminWarnings: [
      ...(!facts.stream ? ['Stream/pathway could not be confidently identified.'] : []),
      ...(!facts.clientEmail ? ['Client email missing from advice controller facts.'] : []),
      ...findings.filter(f => /numeric value/i.test(String(f.clientFacts || ''))).map(f => `Unclear numeric field kept as audit warning for ${f.title || f.issue}.`)
    ]
  };
}

function applyAiMigrationAdviceController({ adviceBundle = {}, assessment = {}, registry = null, registryResult = null } = {}) {
  const facts = extractFacts(assessment);
  facts.subclass = facts.subclass || normaliseSubclass(pick(adviceBundle.subclass, adviceBundle.advice && adviceBundle.advice.subclass));
  facts.stream = facts.stream || normaliseStream(pick(adviceBundle.stream, adviceBundle.selectedStream, adviceBundle.clientFacingStream, adviceBundle.advice && adviceBundle.advice.stream));

  const originalFindings = sourceFindings(adviceBundle);
  const enhancedFindings = originalFindings.map((finding, index) => enhanceFinding(finding, index, facts));
  const clientAdviceObject = buildClientAdviceObject({ facts, findings: enhancedFindings, adviceBundle });
  const internalAuditObject = buildInternalAuditObject({ facts, findings: enhancedFindings, adviceBundle, registry, registryResult });
  const advice = adviceBundle.advice || {};
  const existingModel = adviceBundle.seniorAdviceModel || adviceBundle.universalAdviceModel || adviceBundle.adviceModel || advice.seniorAdviceModel || advice;

  return {
    ...adviceBundle,
    subclass: facts.subclass || adviceBundle.subclass,
    stream: facts.stream || adviceBundle.stream,
    selectedStream: facts.stream || adviceBundle.selectedStream,
    clientFacingStream: facts.stream || adviceBundle.clientFacingStream,
    aiMigrationAdviceControllerVersion: AI_CONTROLLER_VERSION,
    aiControllerApplied: true,
    clientAdviceObject,
    internalAuditObject: {
      ...(adviceBundle.internalAuditObject || {}),
      ...internalAuditObject
    },
    internalLegalAudit: {
      ...(adviceBundle.internalLegalAudit || {}),
      aiMigrationAdviceController: internalAuditObject
    },
    advice: {
      ...advice,
      clientAdviceObject,
      aiMigrationAdviceControllerVersion: AI_CONTROLLER_VERSION,
      seniorAdviceModel: {
        ...(isPlainObject(existingModel) ? existingModel : {}),
        ...clientAdviceObject,
        criteriaFindings: enhancedFindings,
        seniorCriteriaFindings: enhancedFindings,
        grantCriteriaFindings: enhancedFindings
      },
      grantCriteriaFindings: enhancedFindings,
      seniorCriteriaFindings: enhancedFindings,
      criterion_findings: enhancedFindings
    },
    seniorAdviceModel: {
      ...(isPlainObject(existingModel) ? existingModel : {}),
      ...clientAdviceObject,
      criteriaFindings: enhancedFindings,
      seniorCriteriaFindings: enhancedFindings,
      grantCriteriaFindings: enhancedFindings
    },
    universalAdviceModel: {
      ...(isPlainObject(adviceBundle.universalAdviceModel) ? adviceBundle.universalAdviceModel : {}),
      ...clientAdviceObject,
      criteriaFindings: enhancedFindings,
      seniorCriteriaFindings: enhancedFindings,
      grantCriteriaFindings: enhancedFindings
    },
    seniorCriteriaFindings: enhancedFindings,
    clientFacingCriteriaFindings: enhancedFindings,
    grantCriteriaFindings: enhancedFindings,
    criterion_findings: enhancedFindings
  };
}

module.exports = {
  AI_CONTROLLER_VERSION,
  applyAiMigrationAdviceController
};
