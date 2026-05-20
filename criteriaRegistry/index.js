'use strict';

// Criteria Registry public API — v9 loader compatibility fix.
// Exports BOTH legacy numeric keys and named loader functions required by server.js/pdf validators.

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
  '444': require('./subclass444.json'),
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
  '870': require('./subclass870.json'),
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

function getCriteriaListFromStreamConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  if (Array.isArray(cfg.criteria)) return cfg.criteria;
  if (Array.isArray(cfg.grantCriteria)) return cfg.grantCriteria;
  if (Array.isArray(cfg.schedule2GrantCriteria)) return cfg.schedule2GrantCriteria;
  if (cfg.grantCriteria && Array.isArray(cfg.grantCriteria.items)) return cfg.grantCriteria.items;
  if (cfg.schedule2 && Array.isArray(cfg.schedule2.items)) return cfg.schedule2.items;
  return [];
}

function criteriaForStream(registry, stream = 'default') {
  if (!registry) return [];
  if (Array.isArray(registry.criteria)) return registry.criteria;
  if (Array.isArray(registry.grantCriteria)) return registry.grantCriteria;
  if (registry.grantCriteria && Array.isArray(registry.grantCriteria.items)) return registry.grantCriteria.items;

  const streams = registry.streams || {};
  const selectedRaw = String(stream || 'default');
  const selected = selectedRaw.toLowerCase().replace(/[^a-z0-9]+/g, '_');

  // Exact/default first. Some v9 registries do not use a literal `default` stream.
  const direct = getCriteriaListFromStreamConfig(streams[selectedRaw] || streams[selected] || streams.default);
  if (direct.length) return direct;

  // Match against normalised stream names.
  for (const [name, cfg] of Object.entries(streams)) {
    const key = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (key === selected || key.includes(selected) || selected.includes(key)) {
      const found = getCriteriaListFromStreamConfig(cfg);
      if (found.length) return found;
    }
  }

  // If a subclass has only one active stream, use it as the safe default. This fixes
  // Subclass 300 and other single-stream registries that use names such as
  // `common_or_secondary` instead of `default`.
  const streamEntries = Object.entries(streams);
  if (streamEntries.length === 1) {
    const only = getCriteriaListFromStreamConfig(streamEntries[0][1]);
    if (only.length) return only;
  }

  // Final compatibility fallback for registries carrying enriched criteria under
  // legacyOriginalRegistry.streams.default.criteria.
  const legacyStreams = registry.legacyOriginalRegistry && registry.legacyOriginalRegistry.streams || {};
  const legacyDirect = getCriteriaListFromStreamConfig(legacyStreams[selectedRaw] || legacyStreams[selected] || legacyStreams.default);
  if (legacyDirect.length) return legacyDirect;
  for (const [name, cfg] of Object.entries(legacyStreams)) {
    const key = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    if (key === selected || key.includes(selected) || selected.includes(key)) {
      const found = getCriteriaListFromStreamConfig(cfg);
      if (found.length) return found;
    }
  }
  const legacyEntries = Object.entries(legacyStreams);
  if (legacyEntries.length === 1) {
    const only = getCriteriaListFromStreamConfig(legacyEntries[0][1]);
    if (only.length) return only;
  }

  return [];
}

// Legacy sXXX aliases are retained for compatibility with older scripts.
const s100 = registryMap['100'];
const s101 = registryMap['101'];
const s103 = registryMap['103'];
const s115 = registryMap['115'];
const s116 = registryMap['116'];
const s173 = registryMap['173'];
const s186 = registryMap['186'];
const s187 = registryMap['187'];
const s188 = registryMap['188'];
const s189 = registryMap['189'];
const s190 = registryMap['190'];
const s300 = registryMap['300'];
const s309 = registryMap['309'];
const s407 = registryMap['407'];
const s408 = registryMap['408'];
const s417 = registryMap['417'];
const s444 = registryMap['444'];
const s461 = registryMap['461'];
const s462 = registryMap['462'];
const s482 = registryMap['482'];
const s485 = registryMap['485'];
const s489 = registryMap['489'];
const s491 = registryMap['491'];
const s494 = registryMap['494'];
const s500 = registryMap['500'];
const s590 = registryMap['590'];
const s600 = registryMap['600'];
const s602 = registryMap['602'];
const s785 = registryMap['785'];
const s790 = registryMap['790'];
const s801 = registryMap['801'];
const s820 = registryMap['820'];
const s836 = registryMap['836'];
const s866 = registryMap['866'];
const s870 = registryMap['870'];
const s888 = registryMap['888'];

module.exports = Object.assign({}, registryMap, {
  registryMap,
  s100,
  s101,
  s103,
  s115,
  s116,
  s173,
  s186,
  s187,
  s188,
  s189,
  s190,
  s300,
  s309,
  s407,
  s408,
  s417,
  s444,
  s461,
  s462,
  s482,
  s485,
  s489,
  s491,
  s494,
  s500,
  s590,
  s600,
  s602,
  s785,
  s790,
  s801,
  s820,
  s836,
  s866,
  s870,
  s888,
  normaliseSubclass,
  loadCriteriaRegistry,
  listSupportedCriteriaRegistrySubclasses,
  supportedCriteriaRegistrySubclasses: listSupportedCriteriaRegistrySubclasses,
  supportedSubclasses: listSupportedCriteriaRegistrySubclasses,
  criteriaForStream
});
