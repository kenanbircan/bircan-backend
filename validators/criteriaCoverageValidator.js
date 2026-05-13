'use strict';

const path = require('path');

function norm(v) {
  return String(v === undefined || v === null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function clean(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(clean).filter(Boolean).join('; ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).replace(/\s+/g, ' ').trim();
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function flattenObject(input, prefix = '', out = {}) {
  if (!isPlainObject(input)) return out;
  for (const [k, v] of Object.entries(input)) {
    if (/password|token|authorization|auth|session/i.test(k)) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flattenObject(v, key, out);
    else if (Array.isArray(v)) out[key] = v.map(clean).filter(Boolean).join('; ');
    else if (v !== undefined && v !== null && String(v).trim() !== '') out[key] = clean(v);
  }
  return out;
}

function loadCriteriaRegistry(subclass) {
  const code = String(subclass || '').replace(/[^0-9]/g, '');
  if (!code) throw Object.assign(new Error('Grant criteria registry blocked: subclass is missing.'), { code: 'REGISTRY_SUBCLASS_MISSING' });
  const registryMap = require(path.join(process.cwd(), 'criteriaRegistry'));
  const registry = registryMap[code];
  if (!registry) throw Object.assign(new Error(`Grant criteria registry blocked: no registry for subclass ${code}.`), { code: 'REGISTRY_NOT_FOUND', subclass: code });
  return registry;
}

function streamMatches(streamName, selected) {
  const a = norm(streamName || 'default');
  const b = norm(selected || 'default');
  if (!a || a === 'default') return true;
  if (!b || b === 'default' || b === 'to_be_confirmed') return false;
  return a === b || a.includes(b) || b.includes(a);
}

function flattenCriteria(registry, stream) {
  const streams = registry && registry.streams;
  if (!streams || typeof streams !== 'object') return Array.isArray(registry?.criteria) ? registry.criteria : [];
  let selected = [];
  if (streams[stream] && Array.isArray(streams[stream].criteria)) selected = streams[stream].criteria;
  if (!selected.length) {
    for (const [name, cfg] of Object.entries(streams)) {
      if (streamMatches(name, stream) && Array.isArray(cfg.criteria)) { selected = cfg.criteria; break; }
    }
  }
  if (!selected.length && streams.default && Array.isArray(streams.default.criteria)) selected = streams.default.criteria;
  return selected.map((c, index) => ({ ...c, id: c.id || norm(c.label || `criterion_${index + 1}`) }));
}

function getByPath(obj, dotted) {
  if (!dotted) return undefined;
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function triggerSatisfied(trigger, facts) {
  if (!trigger) return false;
  const flat = flattenObject(facts || {});
  const expected = trigger.equals;
  const field = trigger.field || trigger.path || trigger.key;
  let actual = getByPath(facts, field);
  if (actual === undefined && field) {
    const nf = norm(field);
    for (const [k, v] of Object.entries(flat)) {
      if (norm(k) === nf || norm(k).includes(nf) || nf.includes(norm(k))) { actual = v; break; }
    }
  }
  if (Array.isArray(trigger.anyOf)) return trigger.anyOf.some(t => triggerSatisfied(t, facts));
  if (trigger.exists && actual !== undefined && actual !== null && String(actual).trim() !== '') return true;
  if (expected === undefined) return !!actual;
  return norm(actual) === norm(expected);
}

function isRequiredCriterion(c, facts) {
  if (c.mandatory === true) return true;
  if (triggerSatisfied(c.trigger, facts) && c.whenTriggered === 'mandatory') return true;
  return false;
}

function availableSourceTypes(legalPack) {
  const out = new Set();
  const sources = [];
  if (Array.isArray(legalPack?.sources)) sources.push(...legalPack.sources);
  if (Array.isArray(legalPack?.legalSources)) sources.push(...legalPack.legalSources);
  if (Array.isArray(legalPack?.sourcePack)) sources.push(...legalPack.sourcePack);
  for (const s of sources) {
    const joined = [s.authority, s.type, s.sourceType, s.category, s.sourceCategory, s.file, s.path, s.name, s.title].filter(Boolean).join(' ').toUpperCase();
    if (joined.includes('ACT')) out.add('ACT');
    if (joined.includes('REGULATION') || joined.includes('SCHEDULE')) out.add('REGULATIONS');
    if (joined.includes('PAM') || joined.includes('POLICY')) out.add('PAMS');
    if (joined.includes('INSTRUMENT')) out.add('INSTRUMENTS');
    if (joined.includes('PIC')) out.add('PIC');
    if (joined.includes('SRC')) out.add('SRC');
  }
  for (const key of Object.keys(legalPack || {})) {
    const k = key.toUpperCase();
    if (!legalPack[key]) continue;
    if (k.includes('ACT')) out.add('ACT');
    if (k.includes('REGULATION') || k.includes('SCHEDULE')) out.add('REGULATIONS');
    if (k.includes('PAM') || k.includes('POLICY')) out.add('PAMS');
    if (k.includes('INSTRUMENT')) out.add('INSTRUMENTS');
  }
  return out;
}

function sourceRequirements(c) {
  if (Array.isArray(c?.sourceSupport)) return c.sourceSupport.map(s => String(s).toUpperCase());
  if (Array.isArray(c?.requiredSourceSupport)) return c.requiredSourceSupport.map(s => String(s).toUpperCase());
  if (Array.isArray(c?.sourceSupport?.required)) return c.sourceSupport.required.map(s => String(s).toUpperCase());
  return [];
}

function hasSourceSupport(c, legalPack) {
  const required = sourceRequirements(c);
  if (!required.length) return true;
  const available = availableSourceTypes(legalPack);
  return required.every(r => available.has(r));
}

function extractFacts(assessment, adviceBundle) {
  const p = assessment && isPlainObject(assessment.form_payload) ? assessment.form_payload : {};
  const answers = isPlainObject(p.answers) ? p.answers : isPlainObject(p.formPayload) ? p.formPayload : isPlainObject(p.rawSubmission) ? p.rawSubmission : p;
  return {
    ...(isPlainObject(answers) ? answers : {}),
    ...(isPlainObject(p.flatAnswers) ? p.flatAnswers : {}),
    ...(isPlainObject(adviceBundle?.facts) ? adviceBundle.facts : {}),
    subclass: String(adviceBundle?.subclass || adviceBundle?.advice?.subclass || assessment?.visa_type || '').replace(/[^0-9]/g, ''),
    stream: adviceBundle?.stream || adviceBundle?.selectedStream || adviceBundle?.advice?.stream || assessment?.stream || assessment?.selected_stream || assessment?.visa_stream || ''
  };
}

function extractFindings(adviceBundle) {
  const candidates = [
    adviceBundle?.grantCriteriaFindings,
    adviceBundle?.criterion_findings,
    adviceBundle?.criteriaFindings,
    adviceBundle?.advice?.grantCriteriaFindings,
    adviceBundle?.advice?.criterion_findings,
    adviceBundle?.advice?.criteriaFindings,
    adviceBundle?.decisionFindings,
    adviceBundle?.findings
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

function findingKey(f) { return norm(f?.criterion_id || f?.criterionId || f?.registryCriterionId || f?.id || f?.key || f?.criterion || f?.label || f?.heading); }

function answerSupportForCriterion(criterion, facts) {
  const flat = flattenObject(facts || {});
  const hay = Object.entries(flat).map(([k, v]) => `${k}: ${v}`).join(' | ').toLowerCase();
  const terms = [criterion.id, criterion.label, ...(criterion.factsRequired || []), ...(criterion.evidenceRequired || [])]
    .map(x => String(x || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 4))
    .flat();
  const matched = [...new Set(terms.filter(t => hay.includes(t)))].slice(0, 5);
  return matched;
}

function buildFindingFromCriterion(criterion, existing, facts) {
  const matchedFacts = answerSupportForCriterion(criterion, facts);
  const label = clean(criterion.label || criterion.id || 'Grant criterion');
  const presentAssessment = existing ? clean(existing.finding || existing.position || existing.outcome || existing.assessment || existing.professionalFinding || '') : '';
  const finding = presentAssessment || (matchedFacts.length
    ? `This criterion has been assessed against the questionnaire answers. The presently available instructions indicate potentially relevant facts, but original evidence must be verified before lodgement-ready advice is issued.`
    : `This criterion has been assessed as part of the selected pathway. The questionnaire does not, by itself, finally prove this requirement. It must be verified against original evidence before lodgement-ready advice is issued.`);
  return {
    criterion_id: criterion.id,
    registryCriterionId: criterion.id,
    criterion: label,
    label,
    timing: criterion.timing || 'time_of_decision',
    sourceCategory: criterion.sourceCategory || '',
    mandatory: criterion.mandatory === true,
    triggeredMandatory: criterion.mandatory !== true && triggerSatisfied(criterion.trigger, facts) && criterion.whenTriggered === 'mandatory',
    pdfSection: criterion.pdfSection || 'Grant criteria assessment',
    factsRequired: criterion.factsRequired || [],
    evidenceRequired: criterion.evidenceRequired || [],
    riskFlags: criterion.riskFlags || [],
    finding,
    legal_consequence: existing?.legal_consequence || existing?.legalConsequence || 'If this requirement is not met or cannot be evidenced, lodgement should be delayed or the strategy revised before filing.',
    recommendation: existing?.recommendation || existing?.actionRequired || `Verify ${label.toLowerCase()} against original documents and current legal settings before lodgement.`,
    evidence_gap: existing?.evidence_gap || existing?.evidenceGap || (criterion.evidenceRequired || []).slice(0, 5).join('; '),
    risk_level: existing?.risk_level || existing?.riskLevel || 'Verification required',
    sourceSupported: true
  };
}

function buildRegistryBackedFindings({ registry, adviceBundle, legalPack, assessment, facts: suppliedFacts }) {
  const facts = suppliedFacts || extractFacts(assessment || {}, adviceBundle || {});
  const stream = facts.stream || adviceBundle?.stream || adviceBundle?.selectedStream || adviceBundle?.advice?.stream || 'default';
  const criteria = flattenCriteria(registry, stream);
  const required = criteria.filter(c => isRequiredCriterion(c, facts));
  const existing = extractFindings(adviceBundle || {});
  const existingByKey = new Map();
  for (const f of existing) {
    const key = findingKey(f);
    if (key && !existingByKey.has(key)) existingByKey.set(key, f);
  }
  const unsupported = [];
  const findings = required.map(c => {
    if (!hasSourceSupport(c, legalPack)) unsupported.push(c);
    const existingFinding = existingByKey.get(norm(c.id)) || existingByKey.get(norm(c.label));
    const built = buildFindingFromCriterion(c, existingFinding, facts);
    built.sourceSupported = !unsupported.includes(c);
    return built;
  });
  const audit = {
    ok: unsupported.length === 0,
    subclass: registry?.subclass || facts.subclass,
    stream,
    coverageTarget: registry?.coverageTarget || 'grant_criteria',
    totalRegistryCriteria: criteria.length,
    mandatoryOrTriggeredRequired: required.length,
    mandatoryOrTriggeredAssessed: findings.length,
    registryCoverageRate: required.length ? Math.round((findings.length / required.length) * 100) : 0,
    unsupportedSourceCriteria: unsupported.map(c => ({ id: c.id, label: c.label, requiredSources: sourceRequirements(c) })),
    missingAssessment: [],
    generatedAt: new Date().toISOString(),
    enforcement: 'registry-backed-deterministic-coverage-v1'
  };
  return { findings, audit, criteria, required };
}

function validateCriteriaCoverage(registry, adviceBundle, legalPack, facts = {}) {
  const result = buildRegistryBackedFindings({ registry, adviceBundle, legalPack, facts });
  const audit = result.audit;
  if (!audit.ok || audit.registryCoverageRate < 100) {
    const err = new Error('PDF blocked: grant criteria coverage validation failed.');
    err.code = 'GRANT_CRITERIA_COVERAGE_FAILED';
    err.audit = audit;
    throw err;
  }
  return audit;
}

module.exports = {
  loadCriteriaRegistry,
  validateCriteriaCoverage,
  buildRegistryBackedFindings,
  flattenCriteria,
  isRequiredCriterion,
  availableSourceTypes,
  hasSourceSupport,
  extractFacts
};
