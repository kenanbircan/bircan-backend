'use strict';

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

function sourcePresent(files, key, subclass) {
  const hay = files.map(f => f.toLowerCase());
  const sub = normaliseSubclass(subclass);
  if (key === 'ACT') return hay.some(f => f.includes('/acts/') || f.includes('\\acts\\') || f.includes('/act/') || f.includes('\\act\\') || f.includes('migration_act'));
  if (key === 'REGULATIONS') return hay.some(f => f.includes('/regulation') || f.includes('\\regulation') || f.includes('migration_regulation'));
  // The consolidated Migration Regulations PDFs contain Schedules 1, 2, 4 and 5.
  // Subclass PAM files provide subclass-specific operational Schedule 2 support.
  if (key === 'SCHEDULE_1') return hay.some(f => f.includes('/regulation') || f.includes('\\regulation') || f.includes('schedule_1') || f.includes('schedule 1') || f.includes('sch1'));
  if (key === 'SCHEDULE_2') return hay.some(f => ((f.includes('/pams/') || f.includes('\\pams\\')) && f.includes('subclass ' + sub)) || f.includes('schedule_2') || f.includes('schedule 2') || f.includes('sch2'));
  if (key === 'SCHEDULE_4_PIC') return hay.some(f => f.includes('/regulation') || f.includes('\\regulation') || f.includes('schedule_4') || f.includes('schedule 4') || f.includes('pic'));
  if (key === 'SCHEDULE_5_SRC') return hay.some(f => f.includes('/regulation') || f.includes('\\regulation') || f.includes('schedule_5') || f.includes('schedule 5') || f.includes('src'));
  return false;
}

function buildKnowledgeSourceAudit(subclass) {
  const files = walkFiles(KNOWLEDGE_ROOT);
  const present = {};
  for (const key of REQUIRED_SOURCE_KEYS) present[key] = sourcePresent(files, key, subclass);
  const missing = Object.entries(present).filter(([, ok]) => !ok).map(([k]) => k);
  const relevantFiles = files
    .filter(f => {
      const lower = f.toLowerCase();
      const sub = normaliseSubclass(subclass);
      return lower.includes(sub) || lower.includes('migration') || lower.includes('schedule') || lower.includes('pic') || lower.includes('src');
    })
    .map(f => path.relative(__dirname, f).replace(/\\/g, '/'))
    .sort();
  return {
    knowledgeRoot: path.relative(__dirname, KNOWLEDGE_ROOT),
    requiredSources: REQUIRED_SOURCE_KEYS,
    present,
    missing,
    fileCount: files.length,
    relevantFiles: relevantFiles.slice(0, 200),
    sourceHash: sha256(relevantFiles.join('\n'))
  };
}

function validateLegalFrame(frame) {
  const missing = [];
  if (!frame || typeof frame !== 'object') missing.push('frame');
  if (!frame.subclass) missing.push('subclass');
  if (!frame.registry) missing.push('criteriaRegistry');
  if (!Array.isArray(frame.criteria) || frame.criteria.length === 0) missing.push('streamCriteria');
  if (!frame.knowledgeAudit || frame.knowledgeAudit.missing.length) missing.push('knowledgebaseLegalSources:' + ((frame.knowledgeAudit && frame.knowledgeAudit.missing || []).join(',')));
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

  const frame = {
    subclass,
    visaName: registry.visaName || registry.title || `Subclass ${subclass}`,
    stream: streamKey,
    registryVersion: registry.version || null,
    coverageTarget: registry.coverageTarget || null,
    registry,
    criteria,
    schedule1Validity: registry.schedule1Validity || [],
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
    criteriaIds: frame.criteria.map(c => c && c.id).filter(Boolean),
    sourceHash: knowledgeAudit.sourceHash
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
