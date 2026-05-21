'use strict';

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return '';
}

function cleanSubclass(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  try { return JSON.parse(payload); } catch (_) { return {}; }
}

function normaliseAssessment(assessment = {}) {
  const payload = parsePayload(assessment.form_payload || assessment.raw_answers || assessment.answers || assessment.payload);
  const subclass = cleanSubclass(firstNonEmpty(
    assessment.visa_type,
    assessment.subclass,
    payload.subclass,
    payload.visaSubclass,
    payload.visa_type,
    payload.visaType
  ));
  const pathway = String(firstNonEmpty(
    assessment.pathway,
    assessment.stream,
    assessment.selected_stream,
    payload.pathway,
    payload.stream,
    payload.selectedStream,
    payload.nominationStream,
    payload.visaStream
  ) || '').trim();

  return {
    id: assessment.id || payload.id || '',
    subclass,
    pathway,
    plan: firstNonEmpty(assessment.active_plan, assessment.selected_plan, payload.plan, 'instant'),
    clientEmail: String(firstNonEmpty(assessment.client_email, payload.clientEmail, payload.email)).trim().toLowerCase(),
    applicantEmail: String(firstNonEmpty(assessment.applicant_email, payload.applicantEmail, payload.email)).trim().toLowerCase(),
    applicantName: String(firstNonEmpty(assessment.applicant_name, payload.applicantName, payload.fullName, payload.name)).trim(),
    raw: payload,
    evidence: payload.evidence || payload.documents || payload.uploads || {},
    declarations: payload.declarations || payload.integrity || {},
    migrationHistory: payload.migrationHistory || payload.visaHistory || {},
    health: payload.health || {},
    character: payload.character || {}
  };
}

function assessmentPayloadLooksUsable(assessment = {}) {
  const normalised = normaliseAssessment(assessment);
  const rawKeys = Object.keys(normalised.raw || {});
  return Boolean(normalised.subclass && rawKeys.length >= 3);
}

module.exports = {
  normaliseAssessment,
  assessmentPayloadLooksUsable
};
