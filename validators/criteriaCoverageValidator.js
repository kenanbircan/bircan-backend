"use strict";

/**
 * Bircan Migration - Grant Criteria Coverage Validator v4
 * Enforces subclass registry coverage before advice/PDF release.
 * Supports:
 * - mandatory criteria
 * - conditional / triggered mandatory criteria
 * - source-support checks against the live knowledgebase legal pack
 * - contamination term checks where present in registry metadata
 */

function norm(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

function upper(v) {
  return String(v == null ? "" : v).trim().toUpperCase();
}

function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  return String(path).split(".").reduce((acc, key) => (acc && Object.prototype.hasOwnProperty.call(acc, key) ? acc[key] : undefined), obj);
}

function flattenCriteria(registry, stream) {
  if (!registry) return [];
  if (Array.isArray(registry.criteria)) return registry.criteria;
  const streams = registry.streams || {};
  if (stream && streams[stream] && Array.isArray(streams[stream].criteria)) return streams[stream].criteria;
  const first = Object.values(streams).find(s => s && Array.isArray(s.criteria));
  return first ? first.criteria : [];
}

function isTriggered(criterion, facts) {
  const trigger = criterion && criterion.trigger;
  if (!trigger) return false;
  const actual = getByPath(facts || {}, trigger.field);
  if (Object.prototype.hasOwnProperty.call(trigger, "equals")) return actual === trigger.equals;
  if (Array.isArray(trigger.in)) return trigger.in.includes(actual);
  if (trigger.exists === true) return actual !== undefined && actual !== null && actual !== "";
  if (trigger.truthy === true) return !!actual;
  return false;
}

function isRequired(criterion, facts) {
  if (!criterion) return false;
  if (criterion.mandatory === true) return true;
  if (isTriggered(criterion, facts) && criterion.whenTriggered === "mandatory") return true;
  return false;
}

function availableSourceTypes(legalPack) {
  const out = new Set();
  const sources = [];
  if (Array.isArray(legalPack?.sources)) sources.push(...legalPack.sources);
  if (Array.isArray(legalPack?.legalSources)) sources.push(...legalPack.legalSources);
  if (Array.isArray(legalPack?.sourcePack)) sources.push(...legalPack.sourcePack);
  for (const s of sources) {
    const joined = [s.type, s.sourceType, s.category, s.sourceCategory, s.file, s.path, s.name, s.title].filter(Boolean).join(" ").toUpperCase();
    if (joined.includes("ACT")) out.add("ACT");
    if (joined.includes("REGULATION") || joined.includes("SCHEDULE")) out.add("REGULATIONS");
    if (joined.includes("PAM") || joined.includes("POLICY")) out.add("PAMS");
    if (joined.includes("INSTRUMENT")) out.add("INSTRUMENTS");
    if (joined.includes("PIC")) out.add("PIC");
    if (joined.includes("SRC")) out.add("SRC");
  }
  // Fallback flags used by existing backend packs.
  for (const k of Object.keys(legalPack || {})) {
    const key = upper(k);
    if (legalPack[k]) {
      if (key.includes("ACT")) out.add("ACT");
      if (key.includes("REGULATION") || key.includes("SCHEDULE")) out.add("REGULATIONS");
      if (key.includes("PAM") || key.includes("POLICY")) out.add("PAMS");
      if (key.includes("INSTRUMENT")) out.add("INSTRUMENTS");
    }
  }
  return out;
}

function sourceRequirements(criterion) {
  if (Array.isArray(criterion.sourceSupport)) return criterion.sourceSupport.map(upper);
  if (Array.isArray(criterion.requiredSourceSupport)) return criterion.requiredSourceSupport.map(upper);
  if (Array.isArray(criterion.sourceSupport?.required)) return criterion.sourceSupport.required.map(upper);
  return [];
}

function hasSourceSupport(criterion, legalPack) {
  const required = sourceRequirements(criterion);
  if (!required.length) return true;
  const available = availableSourceTypes(legalPack);
  return required.every(r => available.has(r));
}

function extractFindings(adviceBundle) {
  const candidates = [
    adviceBundle?.criterion_findings,
    adviceBundle?.criteriaFindings,
    adviceBundle?.grantCriteriaFindings,
    adviceBundle?.advice?.criterion_findings,
    adviceBundle?.advice?.criteriaFindings,
    adviceBundle?.advice?.grantCriteriaFindings,
    adviceBundle?.decision?.criterion_findings,
    adviceBundle?.decisionFindings
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

function findingId(f) {
  return norm(f?.criterion_id || f?.criterionId || f?.id || f?.key || f?.criterion);
}

function validateCriteriaCoverage(registry, adviceBundle, legalPack, facts = {}) {
  const stream = facts.stream || facts.pathway || facts.selectedStream || adviceBundle?.stream || adviceBundle?.advice?.stream;
  const criteria = flattenCriteria(registry, stream);
  const required = criteria.filter(c => isRequired(c, facts));
  const findings = extractFindings(adviceBundle);
  const findingIds = new Set(findings.map(findingId).filter(Boolean));

  const missingAssessment = required.filter(c => !findingIds.has(norm(c.id)));
  const unsupported = required.filter(c => !hasSourceSupport(c, legalPack));

  const registryCoverageRate = required.length ? Math.round(((required.length - missingAssessment.length) / required.length) * 100) : 0;

  const audit = {
    ok: missingAssessment.length === 0 && unsupported.length === 0,
    subclass: registry?.subclass || facts.subclass || adviceBundle?.subclass,
    stream: stream || "default",
    totalCriteria: criteria.length,
    mandatoryOrTriggeredRequired: required.length,
    mandatoryOrTriggeredAssessed: required.length - missingAssessment.length,
    registryCoverageRate,
    missingAssessment: missingAssessment.map(c => ({ id: c.id, label: c.label })),
    unsupportedSourceCriteria: unsupported.map(c => ({ id: c.id, label: c.label, requiredSources: sourceRequirements(c) }))
  };

  if (!audit.ok) {
    const err = new Error("PDF blocked: grant criteria coverage validation failed.");
    err.code = "GRANT_CRITERIA_COVERAGE_FAILED";
    err.audit = audit;
    throw err;
  }
  return audit;
}

module.exports = {
  validateCriteriaCoverage,
  flattenCriteria,
  isRequired,
  isTriggered,
  hasSourceSupport,
  availableSourceTypes
};
