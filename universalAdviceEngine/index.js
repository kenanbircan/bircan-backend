'use strict';

/**
 * Universal Advice Engine — single gate for every visa subclass.
 *
 * Permanent rule:
 * criteriaRegistry = what must be assessed
 * knowledgebase/legalFrame = what the law/policy/instrument says
 * senior advice model = fact-to-law application
 * pdf.js = renderer only
 */

const { loadCriteriaRegistry, criteriaForStream, listSupportedCriteriaRegistrySubclasses } = require('../criteriaRegistry');
const { loadLegalFrame } = require('../legalFrameLoader');

function clean(v, fallback = '') {
  return String(v === undefined || v === null || v === '' ? fallback : v).replace(/\s+/g, ' ').trim();
}
function subclassOf(v) { return clean(v).replace(/[^0-9]/g, ''); }
function key(v) { return clean(v).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
function asArray(v) { if (!v) return []; return Array.isArray(v) ? v : [v]; }
function title(v) {
  return clean(v).replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase())
    .replace(/\bPic\b/g, 'PIC').replace(/\bAmsr\b/g, 'AMSR').replace(/\bAnzsco\b/g, 'ANZSCO')
    .replace(/\bDama\b/g, 'DAMA').replace(/\bTrt\b/g, 'TRT');
}
function flatten(input, out = {}) {
  if (!input || typeof input !== 'object') return out;
  if (Array.isArray(input)) { input.forEach(v => flatten(v, out)); return out; }
  for (const [k, v] of Object.entries(input)) {
    if (/password|token|authorization|session/i.test(k)) continue;
    if (v && typeof v === 'object') flatten(v, out);
    else out[k] = v;
  }
  return out;
}
function answerText(assessment = {}) {
  const p = assessment.form_payload || assessment.formPayload || assessment.answers || assessment.rawSubmission || assessment;
  const flat = flatten(p, {});
  return Object.entries(flat).map(([k,v]) => `${k}: ${clean(v)}`).join(' | ');
}
function registryStreamNames(registry) {
  const streams = registry && registry.streams && typeof registry.streams === 'object' ? Object.keys(registry.streams) : [];
  return streams.filter(Boolean);
}
function streamHasCriteria(registry, streamName) {
  return criteriaForStream(registry, streamName).length > 0;
}
function isGenericStream(v) {
  return /^(primary|primary pathway|default|generic|selected pathway|registry controlled pathway|registry-controlled pathway|common|main pathway)$/i.test(clean(v));
}
function resolveUniversalStream({ subclass, rawStream, assessment = {}, registry }) {
  const allowed = registryStreamNames(registry).filter(s => streamHasCriteria(registry, s));
  const corpus = `${clean(rawStream)} | ${answerText(assessment)}`.toLowerCase();
  const raw = clean(rawStream);

  // Exact or fuzzy match to registry stream names.
  for (const s of allowed) {
    const ks = key(s);
    const kr = key(raw);
    if (kr && (kr === ks || kr.includes(ks) || ks.includes(kr))) return { stream: s, allowed, source: 'raw-stream' };
  }

  // Match stream names from answer corpus.
  for (const s of allowed) {
    const readable = clean(s).toLowerCase();
    const ks = key(s).replace(/_/g, ' ');
    if (readable && corpus.includes(readable)) return { stream: s, allowed, source: 'answers' };
    if (ks && corpus.includes(ks)) return { stream: s, allowed, source: 'answers-key' };
  }

  // Common universal aliases, but only if the registry contains a matching real stream.
  const aliasRules = [
    [/labou?r agreement|dama/, /labou?r|agreement|dama/],
    [/short.?term|short term/, /short/],
    [/medium.?term|medium term/, /medium/],
    [/subsequent entrant|secondary applicant|family member/, /subsequent|secondary|family/],
    [/direct entry|\bde\b/, /direct|entry/],
    [/temporary residence transition|\btrt\b/, /temporary|transition|trt/],
    [/prospective marriage|fiance|fiancé/, /prospective|marriage/],
    [/partner|spouse|de facto|defacto/, /partner|spouse|de.?facto/],
    [/student/, /student/],
    [/visitor|tourist|business visitor/, /visitor|tourist|business/],
    [/protection|refugee|complementary/, /protection|refugee|complementary/]
  ];
  for (const [hayRule, streamRule] of aliasRules) {
    if (hayRule.test(corpus)) {
      const match = allowed.find(s => streamRule.test(clean(s).toLowerCase()));
      if (match) return { stream: match, allowed, source: 'alias' };
    }
  }

  // If registry genuinely has one stream, use it. This is universal and safe.
  if (allowed.length === 1) return { stream: allowed[0], allowed, source: 'single-registry-stream' };

  if (isGenericStream(raw) || !raw) {
    const err = new Error(`Advice-grade PDF blocked: valid stream/pathway not selected for Subclass ${subclass}. Allowed streams: ${allowed.join(', ') || 'none found'}.`);
    err.code = 'UNIVERSAL_STREAM_NOT_CONFIRMED';
    err.subclass = subclass;
    err.rawStream = raw;
    err.allowedStreams = allowed;
    throw err;
  }

  const err = new Error(`Advice-grade PDF blocked: invalid stream/pathway for Subclass ${subclass}: ${raw}. Allowed streams: ${allowed.join(', ') || 'none found'}.`);
  err.code = 'UNIVERSAL_INVALID_STREAM';
  err.subclass = subclass;
  err.rawStream = raw;
  err.allowedStreams = allowed;
  throw err;
}
function clientFacingStream(stream) {
  return clean(stream).replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase()).replace(/\s+Stream\s+Stream$/i, ' Stream');
}
function inferRisk(frame) {
  const hay = JSON.stringify(frame || {}).toLowerCase();
  if (/valid|schedule 1|nomination|sponsor|labour agreement|salary|amsr|pic ?4020|character|health|refusal|cancellation/.test(hay)) return 'HIGH';
  return 'MANAGED';
}
function buildFinding({ frame, assessment, subclass, stream }) {
  const issue = title(frame.issue || frame.criterionId || frame.clause || 'Legal requirement');
  const legalRequirement = clean(frame.legalTest || frame.legalRequirement || frame.requirement);
  if (!legalRequirement || /mapped migration regulations\/pam legal frame/i.test(legalRequirement)) {
    const err = new Error(`Advice-grade PDF blocked: missing criterion-level legal test for Subclass ${subclass} / ${frame.criterionId || frame.clause || issue}.`);
    err.code = 'UNIVERSAL_LEGAL_TEST_MISSING';
    throw err;
  }
  const evidenceRequired = asArray(frame.evidenceRequired).map(clean).filter(Boolean);
  const evidenceMissing = evidenceRequired.length ? evidenceRequired : ['Original evidence mapped to this legal requirement has not yet been verified.'];
  const riskLevel = inferRisk(frame);
  const consequence = clean(frame.consequenceOfFailure || 'If this legal requirement is not satisfied, the application may not be grant-ready.');
  const seniorOpinion = `On the information presently available, ${issue.toLowerCase()} is not yet verified against original evidence. This is a ${riskLevel.toLowerCase()} issue because ${consequence}`;
  return {
    criterion: clean(frame.criterionId || frame.clause || issue),
    criterionId: clean(frame.criterionId || frame.clause || issue),
    clause: clean(frame.clause || frame.criterionId),
    issue,
    label: issue,
    legalSource: clean(frame.legalSource || 'Migration Regulations 1994 / applicable legislative framework'),
    legalRequirement,
    policyGuidance: clean(frame.policyGuidance),
    knowledgebaseReferences: asArray(frame.knowledgebaseReferences),
    clientFacts: 'The intake answers are preliminary and must be reconciled with original documents and Departmental records.',
    evidenceHeld: 'Not verified at advice-generation stage.',
    evidenceMissing,
    factsApplied: seniorOpinion,
    professionalFinding: seniorOpinion,
    riskLevel,
    legalConsequence: consequence,
    consequenceOfFailure: consequence,
    requiredAction: evidenceMissing.length ? `Obtain and review: ${evidenceMissing.slice(0, 5).join('; ')}.` : 'Obtain and review original evidence before final lodgement advice.',
    seniorOpinion,
    sourceConfidence: frame.sourceConfidence || 'source-mapped'
  };
}
function qualityGate(model) {
  const text = JSON.stringify({
    subclass: model && model.subclass,
    stream: model && model.stream,
    executiveAdvice: model && model.executiveAdvice,
    legalIssues: model && model.legalIssues,
    criteriaFindings: model && model.criteriaFindings,
    evidenceGaps: model && model.evidenceGaps,
    riskAnalysis: model && model.riskAnalysis,
    finalRecommendation: model && model.finalRecommendation
  });
  const forbidden = [
    'Registry-controlled pathway',
    'Registry controlled pathway',
    'Grant Criterion Control',
    'Subclass Specific Grant Criterion',
    'Map the original evidence to the clause',
    'Primary pathway'
  ];
  for (const phrase of forbidden) {
    if (text.includes(phrase)) {
      const err = new Error(`Advice-grade PDF blocked: forbidden fallback wording leaked: ${phrase}.`);
      err.code = 'UNIVERSAL_QUALITY_GATE_FAILED';
      throw err;
    }
  }
  const sc = subclassOf(model.subclass);
  const wrongFrame = text.match(/(?:controlled by|proposed|reviewed for|advice letter for)\s+(?:the\s+)?Subclass\s+(\d{3})/gi) || [];
  for (const m of wrongFrame) {
    const n = subclassOf(m);
    if (n && n !== sc) {
      const err = new Error(`Advice-grade PDF blocked: wrong subclass legal frame leaked into Subclass ${sc}: ${m}.`);
      err.code = 'UNIVERSAL_WRONG_SUBCLASS_LEAK';
      throw err;
    }
  }
  return true;
}
async function buildUniversalAdviceModel({ assessment = {}, subclass: subclassValue, rawStream }) {
  const subclass = subclassOf(subclassValue || assessment.visa_type || assessment.subclass || assessment.visaSubclass || assessment.visa_subclass);
  if (!subclass) throw new Error('Advice-grade PDF blocked: subclass could not be identified.');
  if (!listSupportedCriteriaRegistrySubclasses().includes(subclass)) {
    throw new Error(`Advice-grade PDF blocked: criteriaRegistry has no supported registry for Subclass ${subclass}.`);
  }
  const registry = loadCriteriaRegistry(subclass);
  const resolved = resolveUniversalStream({ subclass, rawStream, assessment, registry });
  const legalFrame = loadLegalFrame(subclass, resolved.stream);
  const frames = asArray(legalFrame.criteriaFrames);
  if (!frames.length) throw new Error(`Advice-grade PDF blocked: no criterion legal frames for Subclass ${subclass} / ${resolved.stream}.`);
  const criteriaFindings = frames.map(frame => buildFinding({ frame, assessment, subclass, stream: resolved.stream }));
  const stream = clientFacingStream(resolved.stream);
  const model = {
    engine: 'universalAdviceEngine',
    version: '1.0.0-universal-legal-frame-gated',
    subclass,
    stream,
    rawStream: clean(rawStream),
    streamResolution: resolved,
    registryVersion: registry.version || registry.schemaVersion || null,
    legalFrameSnapshotHash: legalFrame.snapshotHash,
    legalFrame,
    executiveAdvice: {
      pathwayLabel: `Subclass ${subclass}${stream ? ' — ' + stream : ''}`,
      recommendation: 'Do not lodge until the legal frame, stream, applicant evidence, public-interest position and pathway-specific requirements are verified against original evidence.',
      reason: 'The advice-grade model is based on criteriaRegistry plus knowledgebase legal frames. Any unverified criterion remains a lodgement-readiness issue, not a positive grant opinion.'
    },
    legalIssues: criteriaFindings.slice(0, 12),
    criteriaFindings,
    evidenceGaps: criteriaFindings.map(f => ({ issue: f.issue, evidenceMissing: f.evidenceMissing, requiredAction: f.requiredAction, riskLevel: f.riskLevel })),
    riskAnalysis: {
      overallRisk: criteriaFindings.some(f => f.riskLevel === 'CRITICAL') ? 'CRITICAL' : 'HIGH',
      reason: 'At least one material criterion remains unverified against original evidence.'
    },
    finalRecommendation: {
      proceedNow: false,
      lodgementPosition: 'Lodgement is not recommended until the evidence brief satisfies each applicable legal frame.',
      requiredBeforeLodgement: criteriaFindings.slice(0, 10).map(f => f.requiredAction)
    },
    genericFallbackAllowed: false,
    knowledgebaseLegalFrameApplied: true,
    universalQualityGatePassed: false
  };
  qualityGate(model);
  model.universalQualityGatePassed = true;
  return model;
}

module.exports = {
  buildUniversalAdviceModel,
  resolveUniversalStream,
  qualityGate,
  clientFacingStream
};
