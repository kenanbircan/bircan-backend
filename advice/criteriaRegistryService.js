'use strict';

const { loadCriteriaRegistry } = require('../criteriaRegistry');

function loadSubclassRegistry(subclass) {
  const clean = String(subclass || '').replace(/[^0-9]/g, '');
  if (!clean) throw new Error('Advice registry load failed: visa subclass is missing.');
  const registry = loadCriteriaRegistry(clean);
  if (!registry || typeof registry !== 'object') {
    throw new Error(`Advice registry load failed: subclass ${clean} registry was not found.`);
  }
  return registry;
}

function registryPathways(registry) {
  const pathways = registry.pathways || registry.streams || registry.allowedPathways || registry.allowed_pathways || [];
  if (Array.isArray(pathways)) return pathways.map(String).filter(Boolean);
  if (pathways && typeof pathways === 'object') return Object.keys(pathways);
  return [];
}

function validateAssessmentPathway(normalised, registry) {
  const pathways = registryPathways(registry);
  if (!pathways.length) return { ok: true, pathways: [] };
  const selected = String(normalised.pathway || '').trim().toLowerCase();
  const strictPathwayGate = String(process.env.STRICT_ADVICE_PATHWAY_GATE || 'false').toLowerCase() === 'true';
  if (!selected) {
    const warning = `Subclass ${normalised.subclass} requires a selected stream/pathway before final agent review.`;
    if (strictPathwayGate) throw new Error(`Advice letter cannot be issued because ${warning}`);
    return { ok: true, warning, pathways, selected: '' };
  }
  const matched = pathways.some(p => String(p).trim().toLowerCase() === selected);
  if (!matched) {
    const warning = `Selected pathway "${normalised.pathway}" was not recognised for subclass ${normalised.subclass}; recorded for agent review.`;
    if (strictPathwayGate) throw new Error(`Advice letter cannot be issued because the selected pathway "${normalised.pathway}" is not recognised for subclass ${normalised.subclass}.`);
    return { ok: true, warning, pathways, selected: normalised.pathway };
  }
  return { ok: true, pathways, selected: normalised.pathway };
}

module.exports = {
  loadSubclassRegistry,
  registryPathways,
  validateAssessmentPathway
};
