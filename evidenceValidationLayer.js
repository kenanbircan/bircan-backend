/**
 * evidenceValidationLayer.js
 * Bircan Migration — Evidence Validation Layer
 * Single-file, dependency-free, Render-safe.
 */

const EVIDENCE_STATUS = Object.freeze({
  VERIFIED: 'VERIFIED',
  MISSING: 'MISSING',
  EXPIRED: 'EXPIRED',
  UNVERIFIED: 'UNVERIFIED',
  INCONSISTENT: 'INCONSISTENT',
  NOT_APPLICABLE: 'NOT_APPLICABLE'
});

const SEVERITY = Object.freeze({
  BLOCKER: 'BLOCKER',
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW'
});

function req(id, label, docTypes, answerKeys, severity) {
  return { id, label, docTypes, answerKeys, severity };
}

const REQUIREMENTS = Object.freeze({
  skilled: [
    req('IDENTITY', 'Passport / identity evidence', ['passport', 'identity', 'biodata'], ['passport', 'identityDocument'], SEVERITY.CRITICAL),
    req('INVITATION', 'SkillSelect invitation', ['invitation', 'skillselect'], ['invitation', 'skillSelectInvitation', 'invitationReceived', 'invitationDate'], SEVERITY.BLOCKER),
    req('SKILLS', 'Skills assessment', ['skills assessment', 'assessing authority'], ['skillsAssessment', 'positiveSkillsAssessment', 'skillsAssessmentDate'], SEVERITY.CRITICAL),
    req('ENGLISH', 'English evidence', ['english', 'ielts', 'pte', 'toefl', 'oet', 'passport'], ['english', 'englishLevel', 'englishTest', 'competentEnglish'], SEVERITY.CRITICAL),
    req('POINTS', 'Points claim evidence', ['points', 'employment', 'qualification', 'degree', 'work reference'], ['points', 'claimedPoints', 'totalPoints'], SEVERITY.CRITICAL),
    req('VISA_STATUS', 'Current visa status / VEVO', ['vevo', 'visa grant', 'visa status'], ['currentVisa', 'visaStatus', 'section48', 'noFurtherStay'], SEVERITY.BLOCKER)
  ],
  skilled190: [
    req('NOMINATION', 'State or territory nomination', ['nomination', 'state nomination', 'territory nomination'], ['nomination', 'stateNomination', 'nominationApproved', 'nominationDate'], SEVERITY.BLOCKER)
  ],
  employer: [
    req('SPONSOR', 'Sponsor approval', ['sponsor approval', 'standard business sponsor', 'approved sponsor'], ['sponsorApproved', 'approvedSponsor'], SEVERITY.BLOCKER),
    req('NOMINATION', 'Nomination approval', ['nomination approval', 'nomination'], ['nominationApproved', 'approvedNomination'], SEVERITY.BLOCKER),
    req('POSITION', 'Position / genuine role evidence', ['position description', 'organisation chart', 'genuine position'], ['genuinePosition', 'positionGenuine'], SEVERITY.CRITICAL),
    req('SALARY', 'Salary / market salary evidence', ['salary', 'market salary', 'employment contract'], ['salary', 'annualSalary', 'marketSalary'], SEVERITY.CRITICAL),
    req('SKILLS_EXPERIENCE', 'Skills and experience evidence', ['employment reference', 'cv', 'resume', 'qualification', 'skills'], ['workExperienceYears', 'experience', 'skillsAssessment'], SEVERITY.CRITICAL),
    req('ENGLISH', 'English evidence', ['english', 'ielts', 'pte', 'passport'], ['english', 'englishLevel', 'englishMet'], SEVERITY.CRITICAL)
  ],
  partner: [
    req('SPONSOR', 'Sponsor eligibility evidence', ['sponsor', 'citizenship', 'permanent residence'], ['sponsorEligible', 'australianSponsor'], SEVERITY.BLOCKER),
    req('RELATIONSHIP', 'Relationship evidence', ['relationship', 'marriage', 'de facto', 'joint account', 'lease', 'photos'], ['relationshipEvidence', 'genuineRelationship', 'spouse', 'deFacto'], SEVERITY.CRITICAL),
    req('IDENTITY', 'Identity evidence', ['passport', 'identity', 'birth certificate'], ['passport', 'identityDocument'], SEVERITY.CRITICAL)
  ],
  studentVisitor: [
    req('PURPOSE', 'Purpose / genuine temporary stay evidence', ['statement', 'purpose', 'itinerary', 'course'], ['purpose', 'genuineTemporaryEntrant', 'genuineStudent', 'genuineVisitor'], SEVERITY.CRITICAL),
    req('FUNDS', 'Financial capacity evidence', ['bank', 'funds', 'income', 'financial'], ['financialCapacity', 'funds', 'bankBalance'], SEVERITY.CRITICAL),
    req('IDENTITY', 'Identity evidence', ['passport', 'identity'], ['passport', 'identityDocument'], SEVERITY.CRITICAL)
  ],
  student500: [
    req('COE', 'Confirmation of Enrolment', ['coe', 'confirmation of enrolment'], ['coe', 'confirmationOfEnrolment', 'course'], SEVERITY.BLOCKER),
    req('OSHC', 'OSHC / health insurance', ['oshc', 'health insurance'], ['oshc', 'healthInsurance'], SEVERITY.HIGH)
  ],
  protection: [
    req('IDENTITY', 'Identity and nationality evidence', ['passport', 'identity', 'national id', 'birth certificate'], ['passport', 'identityDocument', 'nationalId'], SEVERITY.CRITICAL),
    req('CLAIMS', 'Protection claims evidence', ['protection', 'statement', 'country information', 'threat'], ['protectionClaim', 'fearOfHarm', 'refugeeClaim'], SEVERITY.CRITICAL),
    req('STATUS', 'Current immigration status', ['vevo', 'visa status', 'arrival', 'immigration'], ['inAustralia', 'onshore', 'visaStatus'], SEVERITY.BLOCKER)
  ],
  family: [
    req('RELATIONSHIP', 'Family relationship evidence', ['birth certificate', 'relationship', 'family', 'marriage'], ['relationshipEvidence', 'parentRelationship', 'childRelationship'], SEVERITY.BLOCKER),
    req('SPONSOR', 'Sponsor evidence', ['sponsor', 'citizenship', 'permanent residence'], ['sponsorEligible', 'eligibleSponsor'], SEVERITY.BLOCKER),
    req('DEPENDENCY_CUSTODY', 'Dependency / custody evidence if relevant', ['dependency', 'custody', 'court order'], ['dependency', 'custody'], SEVERITY.HIGH)
  ],
  business: [
    req('INVITATION_NOMINATION', 'Invitation / nomination evidence', ['invitation', 'nomination'], ['invitation', 'nomination', 'stateNomination'], SEVERITY.BLOCKER),
    req('BUSINESS_FINANCIALS', 'Business / investment financial evidence', ['business', 'investment', 'assets', 'turnover', 'financial'], ['businessAssets', 'investment', 'turnover'], SEVERITY.CRITICAL)
  ]
});

function validateEvidenceForAssessment(assessment) {
  const ctx = normalise(assessment || {});
  const checks = requirementsForSubclass(ctx.subclass).map(r => validateRequirement(r, ctx));
  const summary = summarise(checks);
  return {
    ok: true,
    source: 'evidenceValidationLayer',
    version: '1.0.0',
    subclass: ctx.subclass,
    group: ctx.group,
    checks,
    summary,
    qualityFlags: buildQualityFlags(checks),
    decisionHints: buildDecisionHints(checks)
  };
}

function attachEvidenceValidation(assessment) {
  const report = validateEvidenceForAssessment(assessment);
  const cloned = { ...(assessment || {}) };
  const payload = cloned.form_payload && typeof cloned.form_payload === 'object' ? { ...cloned.form_payload } : {};
  payload.evidenceValidation = report;
  cloned.form_payload = payload;
  return cloned;
}

function normalise(assessment) {
  const payload = assessment.form_payload || {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload.formData || payload.data || payload || {};
  const flat = flatten(answers);
  const subclass = String(assessment.visa_type || pick(flat, ['visaType', 'subclass', 'visaSubclass']) || 'unknown').replace(/\D/g, '') || 'unknown';
  const group = groupForSubclass(subclass);
  const documents = collectDocuments(assessment, payload);
  return { assessment, payload, answers, flat, subclass, group, documents };
}

function groupForSubclass(subclass) {
  if (['189', '190', '491', '489'].includes(subclass)) return 'skilled';
  if (['482', '186', '187', '494'].includes(subclass)) return 'employer';
  if (['820', '309', '300'].includes(subclass)) return 'partner';
  if (['500', '590', '600', '602', '407', '408', '417', '462', '485'].includes(subclass)) return 'studentVisitor';
  if (['866', '785', '790'].includes(subclass)) return 'protection';
  if (['101', '103', '115', '116', '173', '836', '870', '461', '444'].includes(subclass)) return 'family';
  if (['188', '888'].includes(subclass)) return 'business';
  return 'generic';
}

function requirementsForSubclass(subclass) {
  const group = groupForSubclass(subclass);
  let list = [];
  if (group === 'skilled') {
    list = list.concat(REQUIREMENTS.skilled);
    if (subclass === '190') list = list.concat(REQUIREMENTS.skilled190);
  } else if (group === 'employer') list = list.concat(REQUIREMENTS.employer);
  else if (group === 'partner') list = list.concat(REQUIREMENTS.partner);
  else if (group === 'studentVisitor') {
    list = list.concat(REQUIREMENTS.studentVisitor);
    if (subclass === '500') list = list.concat(REQUIREMENTS.student500);
  } else if (group === 'protection') list = list.concat(REQUIREMENTS.protection);
  else if (group === 'family') list = list.concat(REQUIREMENTS.family);
  else if (group === 'business') list = list.concat(REQUIREMENTS.business);
  else list = [req('GENERIC', 'Subclass-specific evidence', ['evidence', 'document'], [], SEVERITY.CRITICAL)];
  return dedupeRequirements(list);
}

function validateRequirement(requirement, ctx) {
  const doc = findDocument(ctx.documents, requirement.docTypes);
  const answer = pick(ctx.flat, requirement.answerKeys);
  const answerValue = boolish(answer);

  if (doc) {
    if (doc.expiryDate && doc.expiryDate < new Date()) return result(requirement, EVIDENCE_STATUS.EXPIRED, doc, answer, 'Document appears expired.');
    if (doc.verified === false) return result(requirement, EVIDENCE_STATUS.UNVERIFIED, doc, answer, 'Document exists but is not verified.');
    const inconsistency = detectInconsistency(requirement, doc, answer);
    if (inconsistency) return result(requirement, EVIDENCE_STATUS.INCONSISTENT, doc, answer, inconsistency);
    return result(requirement, EVIDENCE_STATUS.VERIFIED, doc, answer, 'Document available.');
  }
  if (answerValue === false) return result(requirement, EVIDENCE_STATUS.MISSING, null, answer, 'Questionnaire answer indicates this evidence/criterion is not held.');
  if (answerValue === true) return result(requirement, EVIDENCE_STATUS.UNVERIFIED, null, answer, 'Questionnaire says yes, but no matching document was found.');
  return result(requirement, EVIDENCE_STATUS.MISSING, null, answer, 'No matching evidence found.');
}

function result(requirement, status, doc, answer, reason) {
  return {
    id: requirement.id,
    label: requirement.label,
    status,
    severity: requirement.severity,
    document: doc ? {
      id: doc.id,
      name: doc.name,
      type: doc.type,
      issueDate: doc.issueDate ? doc.issueDate.toISOString() : null,
      expiryDate: doc.expiryDate ? doc.expiryDate.toISOString() : null,
      verified: doc.verified
    } : null,
    questionnaireAnswer: answer === undefined || answer === null ? null : String(answer),
    reason,
    engineSignal: mapToEngineSignal(status, requirement.severity)
  };
}

function mapToEngineSignal(status, severity) {
  if (status === EVIDENCE_STATUS.VERIFIED) return 'PASS';
  if (status === EVIDENCE_STATUS.EXPIRED || status === EVIDENCE_STATUS.INCONSISTENT) return 'FAIL';
  if (status === EVIDENCE_STATUS.UNVERIFIED || status === EVIDENCE_STATUS.MISSING) return severity === SEVERITY.BLOCKER ? 'UNKNOWN_BLOCKER' : 'UNKNOWN';
  return 'UNKNOWN';
}

function summarise(checks) {
  const counts = checks.reduce((acc, c) => {
    acc[c.status] = (acc[c.status] || 0) + 1;
    return acc;
  }, {});
  const blockers = checks.filter(c => c.severity === SEVERITY.BLOCKER && c.status !== EVIDENCE_STATUS.VERIFIED);
  const critical = checks.filter(c => c.severity === SEVERITY.CRITICAL && c.status !== EVIDENCE_STATUS.VERIFIED);
  return {
    total: checks.length,
    counts,
    verified: counts[EVIDENCE_STATUS.VERIFIED] || 0,
    missing: counts[EVIDENCE_STATUS.MISSING] || 0,
    expired: counts[EVIDENCE_STATUS.EXPIRED] || 0,
    unverified: counts[EVIDENCE_STATUS.UNVERIFIED] || 0,
    inconsistent: counts[EVIDENCE_STATUS.INCONSISTENT] || 0,
    blockerIssues: blockers.map(c => c.label),
    criticalIssues: critical.map(c => c.label),
    evidenceReady: blockers.length === 0 && critical.length === 0,
    autoIssueAllowed: blockers.length === 0 && critical.length === 0 && checks.every(c => c.status === EVIDENCE_STATUS.VERIFIED)
  };
}

function buildQualityFlags(checks) {
  const flags = [];
  if (checks.some(c => c.severity === SEVERITY.BLOCKER && c.status !== EVIDENCE_STATUS.VERIFIED)) flags.push('One or more validity/blocker evidence items are missing, expired, unverified or inconsistent.');
  if (checks.some(c => c.status === EVIDENCE_STATUS.EXPIRED)) flags.push('Expired evidence detected.');
  if (checks.some(c => c.status === EVIDENCE_STATUS.INCONSISTENT)) flags.push('Inconsistent evidence detected.');
  if (checks.some(c => c.status === EVIDENCE_STATUS.UNVERIFIED)) flags.push('Positive questionnaire answer has not been supported by verified evidence.');
  return flags;
}

function buildDecisionHints(checks) {
  return checks.map(c => ({ evidenceId: c.id, criterion: c.label, signal: c.engineSignal, severity: c.severity, status: c.status, reason: c.reason }));
}

function collectDocuments(assessment, payload) {
  const raw = [];
  if (Array.isArray(payload.evidence)) raw.push(...payload.evidence);
  if (Array.isArray(payload.documents)) raw.push(...payload.documents);
  if (Array.isArray(payload.uploads)) raw.push(...payload.uploads);
  if (Array.isArray(payload.attachments)) raw.push(...payload.attachments);
  if (Array.isArray(assessment.documents)) raw.push(...assessment.documents);
  if (Array.isArray(assessment.evidence)) raw.push(...assessment.evidence);
  if (Array.isArray(assessment.attachments)) raw.push(...assessment.attachments);
  return raw.map((d, i) => {
    const name = String(d.name || d.filename || d.label || d.type || `Document ${i + 1}`);
    const type = String(d.type || d.category || d.documentType || d.label || name);
    return {
      id: d.id || d.documentId || d.attachment_id || name,
      name,
      type: normaliseText(type + ' ' + name),
      issueDate: toDate(d.issueDate || d.issued || d.date || d.documentDate),
      expiryDate: toDate(d.expiryDate || d.expires || d.validUntil || d.expiry),
      verified: boolish(d.verified ?? d.isVerified ?? d.accepted ?? d.reviewed),
      raw: d
    };
  });
}

function findDocument(documents, wantedTypes) {
  const wanted = wantedTypes.map(normaliseText);
  return documents.find(doc => wanted.some(w => doc.type.includes(w))) || null;
}

function detectInconsistency(requirement, doc, answer) {
  if (!doc || answer === undefined || answer === null) return null;
  const a = normaliseText(String(answer));
  if (!a) return null;
  if (requirement.id === 'ENGLISH' && a.includes('passport') && !(doc.type.includes('passport') || doc.type.includes('english'))) return 'Questionnaire indicates passport/English basis but uploaded document type does not clearly match.';
  if (requirement.id === 'INVITATION' && !(doc.type.includes('invitation') || doc.type.includes('skillselect'))) return 'Uploaded document does not clearly appear to be a SkillSelect invitation.';
  if (requirement.id === 'NOMINATION' && !doc.type.includes('nomination')) return 'Uploaded document does not clearly appear to be a nomination document.';
  return null;
}

function dedupeRequirements(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.id + '::' + item.label;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
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

function pick(flat, keys) {
  const entries = Object.entries(flat || {});
  const exact = new Map(entries.map(([k, v]) => [String(k).toLowerCase(), v]));
  for (const key of keys) {
    if (flat[key] !== undefined && flat[key] !== null && String(flat[key]).trim() !== '') return flat[key];
    const v = exact.get(String(key).toLowerCase());
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  const cleaned = entries.map(([k, v]) => [normaliseText(k), v]);
  for (const key of keys) {
    const want = normaliseText(key);
    for (const [ck, v] of cleaned) if (ck.includes(want) && v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

function boolish(v) {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null) return null;
  const s = normaliseText(String(v));
  if (['yes', 'y', 'true', '1', 'valid', 'current', 'approved', 'positive', 'held', 'met', 'satisfied', 'verified'].includes(s)) return true;
  if (['no', 'n', 'false', '0', 'invalid', 'expired', 'withdrawn', 'refused', 'notheld', 'notmet', 'missing'].includes(s)) return false;
  return null;
}

function normaliseText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

module.exports = { validateEvidenceForAssessment, attachEvidenceValidation, EVIDENCE_STATUS };
