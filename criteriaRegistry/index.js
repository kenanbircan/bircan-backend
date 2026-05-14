'use strict';

// Criteria Registry public API.
// This file intentionally exports BOTH:
// 1) numeric subclass keys for legacy code: require('./criteriaRegistry')['186']
// 2) named functions for the patched grant-criteria pipeline: loadCriteriaRegistry(), listSupportedCriteriaRegistrySubclasses()

const registryMap = {
  '100': require('./subclass100.json'),
  '101': require('./subclass101.json'),
  '103': require('./subclass103.json'),
  '115': require('./subclass115.json'),
  '116': require('./subclass116.json'),
  '173': require('./subclass173.json'),
  '186': require('./subclass186.json'),
  '187': require('./subclass187.json'),
  '188': require('./subclass188.json'),
  '189': require('./subclass189.json'),
  '190': require('./subclass190.json'),
  '300': require('./subclass300.json'),
  '309': require('./subclass309.json'),
  '407': require('./subclass407.json'),
  '408': require('./subclass408.json'),
  '417': require('./subclass417.json'),
  '461': require('./subclass461.json'),
  '462': require('./subclass462.json'),
  '482': require('./subclass482.json'),
  '485': require('./subclass485.json'),
  '489': require('./subclass489.json'),
  '491': require('./subclass491.json'),
  '494': require('./subclass494.json'),
  '500': require('./subclass500.json'),
  '590': require('./subclass590.json'),
  '600': require('./subclass600.json'),
  '602': require('./subclass602.json'),
  '785': require('./subclass785.json'),
  '790': require('./subclass790.json'),
  '801': require('./subclass801.json'),
  '820': require('./subclass820.json'),
  '836': require('./subclass836.json'),
  '866': require('./subclass866.json'),
  '888': require('./subclass888.json')
};

function normaliseSubclass(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function listSupportedCriteriaRegistrySubclasses() {
  return Object.keys(registryMap).sort((a, b) => Number(a) - Number(b));
}

function loadCriteriaRegistry(subclass) {
  const code = normaliseSubclass(subclass);
  if (!code) {
    const err = new Error('Grant criteria registry blocked: subclass is missing.');
    err.code = 'REGISTRY_SUBCLASS_MISSING';
    throw err;
  }
  const registry = registryMap[code];
  if (!registry) {
    const err = new Error(`Grant criteria registry blocked: no registry for subclass ${code}.`);
    err.code = 'REGISTRY_NOT_FOUND';
    err.subclass = code;
    err.supportedSubclasses = listSupportedCriteriaRegistrySubclasses();
    throw err;
  }
  return registry;
}

function criteriaForStream(registry, stream = 'default') {
  if (!registry) return [];
  if (Array.isArray(registry.criteria)) return registry.criteria;
  const streams = registry.streams || {};
  const selected = String(stream || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  if (streams[stream] && Array.isArray(streams[stream].criteria)) return streams[stream].criteria;
  for (const [name, cfg] of Object.entries(streams)) {
    const key = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if ((key === selected || key.includes(selected) || selected.includes(key)) && Array.isArray(cfg.criteria)) {
      return cfg.criteria;
    }
  }
  if (streams.default && Array.isArray(streams.default.criteria)) return streams.default.criteria;
  return [];
}

module.exports = Object.assign({}, registryMap, {
  registryMap,
  normaliseSubclass,
  loadCriteriaRegistry,
  listSupportedCriteriaRegistrySubclasses,
  supportedCriteriaRegistrySubclasses: listSupportedCriteriaRegistrySubclasses,
  supportedSubclasses: listSupportedCriteriaRegistrySubclasses,
  criteriaForStream
});
