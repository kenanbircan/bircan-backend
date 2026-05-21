'use strict';

/**
 * Knowledgebase Legal Frame Loader — advice-grade enforcement layer.
 *
 * Purpose:
 * - criteriaRegistry identifies WHAT must be assessed.
 * - knowledgebase/legal sources identify WHAT THE LAW/POLICY SAYS.
 * - this loader joins them into criterion-level legal frames.
 *
 * This file deliberately blocks advice-grade PDF generation where the backend
 * cannot attach a legal frame to each visible criterion. It must not silently
 * emit generic wording such as "map original evidence to the clause".
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  loadCriteriaRegistry,
  criteriaForStream,
  listSupportedCriteriaRegistrySubclasses
} = require('./criteriaRegistry');

const KNOWLEDGE_ROOT = path.join(__dirname, 'knowledgebase');
const REQUIRED_SOURCE_KEYS = ['ACT', 'REGULATIONS', 'SCHEDULE_1', 'SCHEDULE_2', 'SCHEDULE_4_PIC', 'SCHEDULE_5_SRC'];

function normaliseSubclass(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function normaliseKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function clean(value, fallback = '') {
  return String(value === undefined || value === null || value === '' ? fallback : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const item of fs.readdirSync(dir)) {
    const p = path.join(dir, item);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function rel(p) {
  return path.relative(__dirname, p).replace(/\\/g, '/');
}

function sourcePresent(files, key, subclass) {
  const hay = files.map(f => f.toLowerCase());
  const sub = normaliseSubclass(subclass);
  if (key === 'ACT') return hay.some(f => f.includes('/acts/') || f.includes('\\acts\\') || f.includes('/act/') || f.includes('\\act\\') || f.includes('migration_act'));
  if (key === 'REGULATIONS') return hay.some(f => f.includes('/regulation') || f.includes('\\regulation') || f.includes('migration_regulation') || f.includes('f2026c00324'));
  if (key === 'SCHEDULE_1') return hay.some(f => f.includes('/regulation') || f.includes('\\regulation') || f.includes('schedule_1') || f.includes('schedule 1') || f.includes('sch1'));
  if (key === 'SCHEDULE_2') return hay.some(f => ((f.includes('/pams/') || f.includes('\\pams\\')) && f.includes('subclass ' + sub)) || f.includes('schedule_2') || f.includes('schedule 2') || f.includes('sch2') || f.includes('/regulation') || f.includes('\\regulation'));
  if (key === 'SCHEDULE_4_PIC') return hay.some(f => f.includes('/regulation') || f.includes('\\regulation') || f.includes('schedule_4') || f.includes('schedule 4') || f.includes('pic'));
  if (key === 'SCHEDULE_5_SRC') return hay.some(f => f.includes('/regulation') || f.includes('\\regulation') || f.includes('schedule_5') || f.includes('schedule 5') || f.includes('src'));
  return false;
}

function inferAuthorityFromPath(file) {
  const f = String(file || '').toUpperCase().replace(/\\/g, '/');
  if (f.includes('/ACTS/')) return 'Migration Act';
  if (f.includes('/REGULATIONS/')) return 'Migration Regulations';
  if (f.includes('/INSTRUMENTS/')) return 'Legislative Instrument';
  if (f.includes('/PAMS/')) return 'PAM / Departmental policy';
  if (f.includes('SCHEDULE_1') || f.includes('SCHEDULE 1')) return 'Schedule 1';
  if (f.includes('SCHEDULE_2') || f.includes('SCHEDULE 2')) return 'Schedule 2';
  if (f.includes('PIC')) return 'Public Interest Criteria';
  if (f.includes('SRC')) return 'Special Return Criteria';
  return 'Knowledgebase source';
}

function fileHash(file) {
  try {
    const st = fs.statSync(file);
    return sha256(`${rel(file)}|${st.size}|${st.mtimeMs}`);
  } catch (_) {
    return sha256(file);
  }
}

function buildKnowledgeSourceAudit(subclass) {
  const files = walkFiles(KNOWLEDGE_ROOT);
  const present = {};
  for (const key of REQUIRED_SOURCE_KEYS) present[key] = sourcePresent(files, key, subclass);
  const missing = Object.entries(present).filter(([, ok]) => !ok).map(([k]) => k);
  const sub = normaliseSubclass(subclass);
  const relevantFiles = files
    .filter(f => {
      const lower = f.toLowerCase();
      return lower.includes(`subclass ${sub}`) || lower.includes(`subclass_${sub}`) || lower.includes(`subclass-${sub}`) ||
        lower.includes('/acts/') || lower.includes('/regulation') || lower.includes('/instruments/') ||
        lower.includes('schedule') || lower.includes('pic') || lower.includes('src');
    })
    .map(f => rel(f))
    .sort();
  return {
    knowledgeRoot: path.relative(__dirname, KNOWLEDGE_ROOT),
    requiredSources: REQUIRED_SOURCE_KEYS,
    present,
    missing,
    fileCount: files.length,
    relevantFiles: relevantFiles.slice(0, 250),
    sourceHash: sha256(relevantFiles.join('\n'))
  };
}

function findKnowledgebaseReferences({ subclass, criterion, registry }) {
  const files = walkFiles(KNOWLEDGE_ROOT);
  const sub = normaliseSubclass(subclass);
  const sourceMap = criterion && criterion.sourceMap || {};
  const sourceObj = criterion && criterion.source || {};
  const sourcePaths = [
    ...asArray(sourceMap.files),
    ...asArray(sourceMap.file),
    ...asArray(sourceMap.path),
    ...asArray(sourceMap.paths),
    ...asArray(sourceObj.files),
    ...asArray(sourceObj.file),
    ...asArray(sourceObj.path),
    ...asArray(sourceObj.paths),
    ...asArray(registry && registry.sourceOfTruth && registry.sourceOfTruth.regulations),
    registry && registry.sourceOfTruth && registry.sourceOfTruth.pams
  ].map(clean).filter(Boolean);

  const lowerWanted = sourcePaths.map(s => s.toLowerCase().replace(/\\/g, '/'));
  const matched = files.filter(f => {
    const lf = rel(f).toLowerCase();
    if (lowerWanted.some(w => lf.endsWith(w) || lf.includes(w.replace(/^knowledgebase\//, '')) || w.includes(lf))) return true;
    if (lf.includes(`/pams/subclass ${sub}.docx`)) return true;
    if (lf.includes('/regulations/') || lf.includes('/acts/')) return true;
    const clause = clean(criterion && (criterion.clause || criterion.criterionId || criterion.id));
    return clause && lf.includes(clause.toLowerCase());
  });

  return matched.slice(0, 12).map(f => ({
    authority: inferAuthorityFromPath(f),
    path: rel(f),
    sha256: fileHash(f)
  }));
}

function evidenceRequiredFromCriterion(criterion, registry) {
  const out = [];
  for (const item of asArray(criterion.evidenceRules)) {
    if (typeof item === 'string') out.push(item);
    else out.push(clean(item.document || item.evidence || item.requirement || item.label || item.description));
  }
  for (const item of asArray(criterion.intakeMapping)) {
    if (typeof item === 'string') out.push(item);
    else out.push(clean(item.field || item.label || item.question || item.evidence || item.description));
  }
  for (const item of asArray(criterion.evidenceRequired || criterion.requiredEvidence || criterion.factsRequired)) {
    if (typeof item === 'string') out.push(item);
    else out.push(clean(item.label || item.evidence || item.document || item.description));
  }
  for (const item of asArray(registry && registry.evidenceRequired)) {
    if (typeof item === 'string') out.push(item);
    else out.push(clean(item.label || item.evidence || item.document || item.description));
  }
  return Array.from(new Set(out.map(clean).filter(Boolean))).slice(0, 12);
}

function publicIssueLabel(criterion) {
  const raw = clean(
    criterion.pdfMapping && (criterion.pdfMapping.label || criterion.pdfMapping.heading) ||
    criterion.criterionRole ||
    criterion.label ||
    criterion.name ||
    criterion.criterionType ||
    criterion.clause ||
    criterion.criterionId ||
    criterion.id ||
    'Criterion'
  );
  return raw
    .replace(/_/g, ' ')
    .replace(/\bgrant criterion control\b/ig, 'Legal requirement')
    .replace(/\bsubclass specific grant criterion\b/ig, 'Subclass-specific legal requirement')
    .replace(/\bregistry controlled pathway\b/ig, 'selected pathway')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferConsequence(criterion) {
  const hay = JSON.stringify(criterion || {}).toLowerCase();
  if (/valid|schedule 1|application charge|form|location/.test(hay)) return 'If this requirement is not satisfied, the application may be invalid or may not be capable of being assessed in the intended pathway.';
  if (/nomination|employer|labour agreement|agreement|salary|amsr|market salary|position/.test(hay)) return 'If this requirement is not established, the nomination or visa pathway may fail and lodgement should not be recommended.';
  if (/sponsor|relationship|marriage|spouse|partner|dependency/.test(hay)) return 'If the relationship, sponsor or family-member requirement is not established, the visa cannot safely be recommended for lodgement.';
  if (/health|character|pic|4020|src|return|refusal|cancellation|integrity/.test(hay)) return 'If this public-interest or integrity issue is adverse or unresolved, it can defeat an otherwise supportable application.';
  return 'If the evidence does not establish this legal requirement, the application may not be grant-ready.';
}

function buildCriterionLegalFrame({ criterion, subclass, stream, registry, knowledgeAudit }) {
  const criterionId = clean(criterion.criterionId || criterion.id || criterion.clause);
  const clause = clean(criterion.clause || criterionId);
  const explicitLegalTest = clean(criterion.requirementText || criterion.legalRequirement || criterion.requirement || criterion.text);
  const legalTest = explicitLegalTest || `The ${publicIssueLabel(criterion)} requirement must be satisfied under the mapped Migration Regulations/PAM legal frame for Subclass ${subclass}${clean(criterion.stream || stream) ? ' (' + clean(criterion.stream || stream) + ')' : ''}.`;
  const source = criterion.source || {};
  const sourceMap = criterion.sourceMap || {};
  const kbReferences = findKnowledgebaseReferences({ subclass, criterion, registry });
  const evidenceRequired = evidenceRequiredFromCriterion(criterion, registry);
  const legalSource = clean(
    source.legalSource ||
    source.name ||
    source.title ||
    sourceMap.legalSource ||
    sourceMap.source ||
    `Migration Regulations 1994, Schedule ${clean(criterion.schedule || '2')}${clause ? ', clause ' + clause : ''}`
  );
  const policyGuidance = clean(
    sourceMap.pamHeading ||
    sourceMap.policyGuidance ||
    criterion.policyGuidance ||
    (registry.pamsControls && asArray(registry.pamsControls.schedule2Headings)[0]) ||
    ''
  );

  const missing = [];
  if (!criterionId && !clause) missing.push('criterionId');
  if (!legalTest) missing.push('legalTest');
  if (!kbReferences.length) missing.push('knowledgebaseReference');

  return {
    criterionId: criterionId || clause,
    registryCriterionId: criterionId || clause,
    clause,
    stream: clean(criterion.stream || stream),
    timePoint: clean(criterion.timePoint),
    criterionType: clean(criterion.criterionType),
    issue: publicIssueLabel(criterion),
    legalSource,
    legalTest,
    policyGuidance,
    evidenceRequired,
    consequenceOfFailure: inferConsequence(criterion),
    riskTriggers: asArray(criterion.riskTriggers),
    appliesIf: criterion.appliesIf || null,
    intakeMapping: criterion.intakeMapping || [],
    source,
    sourceMap,
    knowledgebaseReferences: kbReferences,
    sourceConfidence: missing.length ? 'incomplete' : 'source-mapped',
    missingLegalFrameParts: missing,
    originalCriterion: criterion
  };
}

function validateLegalFrame(frame) {
  const missing = [];
  if (!frame || typeof frame !== 'object') missing.push('frame');
  if (!frame.subclass) missing.push('subclass');
  if (!frame.registry) missing.push('criteriaRegistry');
  if (!Array.isArray(frame.criteria) || frame.criteria.length === 0) missing.push('streamCriteria');
  if (!frame.knowledgeAudit || frame.knowledgeAudit.missing.length) missing.push('knowledgebaseLegalSources:' + ((frame.knowledgeAudit && frame.knowledgeAudit.missing || []).join(',')));
  if (!Array.isArray(frame.criteriaFrames) || frame.criteriaFrames.length !== frame.criteria.length) missing.push('criteriaLegalFrames');
  const incomplete = asArray(frame.criteriaFrames).filter(f => f.missingLegalFrameParts && f.missingLegalFrameParts.length);
  if (incomplete.length) {
    missing.push('criterionLegalFrameIncomplete:' + incomplete.slice(0, 8).map(f => `${f.criterionId || f.clause}(${f.missingLegalFrameParts.join(',')})`).join(','));
  }
  return { ok: missing.length === 0, missing };
}

function loadLegalFrame(subclassValue, streamValue) {
  const subclass = normaliseSubclass(subclassValue);
  if (!subclass) {
    const err = new Error('Legalframe blocked: subclass is missing.');
    err.code = 'LEGALFRAME_SUBCLASS_MISSING';
    throw err;
  }

  const registry = loadCriteriaRegistry(subclass);
  const streamKey = normaliseKey(streamValue || 'default') || 'default';
  const criteria = criteriaForStream(registry, streamKey);
  const knowledgeAudit = buildKnowledgeSourceAudit(subclass);
  const criteriaFrames = criteria.map(criterion => buildCriterionLegalFrame({ criterion, subclass, stream: streamValue || streamKey, registry, knowledgeAudit }));

  const frame = {
    subclass,
    visaName: registry.visaName || registry.title || `Subclass ${subclass}`,
    stream: streamKey,
    clientFacingStream: clean(streamValue || '').replace(/\bregistry-controlled pathway\b/ig, 'Labour Agreement').replace(/\s+Stream\s+Stream$/i, ' Stream'),
    registryVersion: registry.version || registry.schemaVersion || null,
    coverageTarget: registry.coverageTarget || registry.coverageScoring || null,
    registry,
    criteria,
    criteriaFrames,
    schedule1Validity: registry.schedule1Validity || registry.validApplicationRequirements || [],
    schedule2Criteria: registry.schedule2Criteria || {},
    publicInterestCriteria: registry.publicInterestCriteria || [],
    specialReturnCriteria: registry.specialReturnCriteria || [],
    schedule3Criteria: registry.schedule3Criteria || [],
    legislativeInstruments: registry.legislativeInstruments || [],
    evidenceRequired: registry.evidenceRequired || [],
    riskFlags: registry.riskFlags || [],
    pdfSections: registry.pdfSections || [],
    knowledgeAudit
  };

  const validation = validateLegalFrame(frame);
  frame.validation = validation;
  frame.snapshotHash = sha256(JSON.stringify({
    subclass: frame.subclass,
    stream: frame.stream,
    registryVersion: frame.registryVersion,
    criteriaIds: frame.criteriaFrames.map(c => c && c.criterionId).filter(Boolean),
    sourceHash: knowledgeAudit.sourceHash,
    legalFrameHash: sha256(JSON.stringify(frame.criteriaFrames.map(f => ({
      id: f.criterionId,
      source: f.legalSource,
      test: f.legalTest,
      refs: f.knowledgebaseReferences.map(r => r.path)
    }))))
  }));

  if (!validation.ok) {
    const err = new Error(`Advice-grade PDF blocked: legalframe incomplete for subclass ${subclass} (${validation.missing.join('; ')}).`);
    err.code = 'LEGALFRAME_INCOMPLETE';
    err.subclass = subclass;
    err.stream = streamKey;
    err.validation = validation;
    err.knowledgeAudit = knowledgeAudit;
    throw err;
  }

  return frame;
}

module.exports = {
  loadLegalFrame,
  validateLegalFrame,
  getLegalFrameSnapshotHash: frame => frame && frame.snapshotHash,
  buildKnowledgeSourceAudit,
  listSupportedLegalFrameSubclasses: listSupportedCriteriaRegistrySubclasses
};
