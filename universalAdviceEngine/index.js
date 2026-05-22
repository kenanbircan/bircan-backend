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

function cleanForbiddenClientLabel(value) {
  return /grant criterion control|subclass specific grant criterion|registry[- ]controlled pathway|primary pathway|map the original evidence/i.test(clean(value));
}

function classifyCriterionFrame(frame = {}) {
  const hay = JSON.stringify(frame || {}).toLowerCase();
  if (/schedule\s*1|valid application|validity|application charge|time of application|time of decision/.test(hay)) return 'Valid application requirement';
  if (/nomination|sponsor|sponsorship|employer|approved sponsor/.test(hay)) return 'Sponsorship or nomination requirement';
  if (/labou?r market testing|\blmt\b/.test(hay)) return 'Labour market testing requirement';
  if (/labou?r agreement|dama|agreement terms|concession/.test(hay)) return 'Labour agreement or concession requirement';
  if (/salary|amsr|market salary|guaranteed earnings|employment condition|contract/.test(hay)) return 'Salary and employment conditions requirement';
  if (/occupation|anzsco|duties|genuine position|position/.test(hay)) return 'Occupation and genuine position requirement';
  if (/skills assessment|qualification|experience|registration|licen[cs]ing|professional membership/.test(hay)) return 'Skills, qualification and registration requirement';
  if (/english/.test(hay)) return 'English language requirement';
  if (/age/.test(hay)) return 'Age requirement or lawful exemption';
  if (/relationship|partner|spouse|de facto|prospective marriage|marriage|dependency/.test(hay)) return 'Relationship or family composition requirement';
  if (/student|enrolment|coe|guardian|course|oshc/.test(hay)) return 'Student or guardian pathway requirement';
  if (/visitor|temporary stay|genuine temporary|funds|tourist|business visitor/.test(hay)) return 'Temporary stay and visit purpose requirement';
  if (/protection|refugee|complementary|persecution|harm|claims/.test(hay)) return 'Protection claims and credibility requirement';
  if (/health|pic 4005|pic4005|pic 4007|pic4007/.test(hay)) return 'Health and public-interest requirement';
  if (/character|police|security|pic 4001|pic4001/.test(hay)) return 'Character and security requirement';
  if (/4020|integrity|bogus|false|misleading|document/.test(hay)) return 'PIC 4020 and document integrity requirement';
  if (/special return|src|exclusion|re-entry/.test(hay)) return 'Special Return Criteria and exclusion requirement';
  if (/family|secondary|member of family unit/.test(hay)) return 'Secondary applicant and family-member requirement';
  if (/location|visa status|lawful status|jurisdiction|bridging/.test(hay)) return 'Location, visa status and jurisdiction requirement';
  return 'Visa grant criterion';
}

function clientFacingIssueLabel(frame = {}) {
  const raw = clean(frame.issue || frame.label || frame.criterion || frame.criterionId || frame.clause || '');
  if (!raw || cleanForbiddenClientLabel(raw)) return classifyCriterionFrame(frame);
  const titled = title(raw);
  return cleanForbiddenClientLabel(titled) ? classifyCriterionFrame(frame) : titled;
}

function clientFacingRequiredAction(frame = {}, evidenceMissing = []) {
  const raw = clean(frame.requiredAction || frame.action || frame.recommendation || '');
  if (raw && !cleanForbiddenClientLabel(raw)) return raw;
  const issue = clientFacingIssueLabel(frame).toLowerCase();
  const evidence = evidenceMissing.length ? evidenceMissing.slice(0, 5).join('; ') : 'the original evidence required for this legal requirement';
  return `Review ${evidence} and record a criterion-specific finding for the ${issue} before lodgement advice is finalised.`;
}

function inferRisk(frame) {
  const hay = JSON.stringify(frame || {}).toLowerCase();
  if (/valid|schedule 1|nomination|sponsor|labour agreement|salary|amsr|pic ?4020|character|health|refusal|cancellation/.test(hay)) return 'HIGH';
  return 'MANAGED';
}
function buildFinding({ frame, assessment, subclass, stream }) {
  const issue = clientFacingIssueLabel(frame);
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
    requiredAction: clientFacingRequiredAction(frame, evidenceMissing),
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
  const family = (() => {
    const employer = ['186','187','407','482','494'];
    const partner = ['100','300','309','801','820'];
    const skilled = ['188','189','190','485','489','491','888'];
    if (employer.includes(sc)) return 'employer';
    if (partner.includes(sc)) return 'partner';
    if (skilled.includes(sc)) return 'skilled';
    return 'other';
  })();
  if (family !== 'employer') {
    const employerLeak = /Direct Entry skills|salary and market|market salary|AMSR|genuine position|nominated occupation|ANZSCO|sponsoring employer|Labour Market Testing/i.exec(text);
    if (employerLeak) {
      const err = new Error(`Advice-grade PDF blocked: employer-sponsored criterion leaked into Subclass ${sc}: ${employerLeak[0]}.`);
      err.code = 'UNIVERSAL_SUBCLASS_CONTAMINATION';
      throw err;
    }
  }
  if (family === 'partner') {
    const mustNot = /occupation eligibility|skills assessment|salary\/AMSR|nomination validity|labour agreement/i.exec(text);
    if (mustNot) {
      const err = new Error(`Advice-grade PDF blocked: non-partner criterion leaked into Subclass ${sc}: ${mustNot[0]}.`);
      err.code = 'UNIVERSAL_PARTNER_CONTAMINATION';
      throw err;
    }
  }
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
    version: '1.0.1-v38-subclass-isolation-design-gated',
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
  clientFacingStream,
  clientFacingIssueLabel,
  classifyCriterionFrame
};
