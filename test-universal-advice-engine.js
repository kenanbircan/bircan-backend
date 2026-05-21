'use strict';

const { buildUniversalAdviceModel, resolveUniversalStream } = require('./universalAdviceEngine');
const { loadCriteriaRegistry, listSupportedCriteriaRegistrySubclasses } = require('./criteriaRegistry');

(async () => {
  const subclasses = listSupportedCriteriaRegistrySubclasses();
  if (!subclasses.length) throw new Error('No criteriaRegistry subclasses found.');

  // Single-stream subclasses should resolve without generic client labels.
  for (const subclass of subclasses.slice(0, 12)) {
    const registry = loadCriteriaRegistry(subclass);
    const allowed = Object.keys(registry.streams || {});
    const rawStream = allowed[0] || 'default';
    const model = await buildUniversalAdviceModel({
      subclass,
      rawStream,
      assessment: { visa_type: subclass, selected_stream: rawStream, form_payload: { answers: { subclass, stream: rawStream } } }
    });
    if (!model.criteriaFindings.length) throw new Error(`No findings for subclass ${subclass}`);
    const text = JSON.stringify(model);
    for (const phrase of ['Registry-controlled pathway', 'Grant Criterion Control', 'Map the original evidence to the clause', 'Primary pathway']) {
      if (text.includes(phrase)) throw new Error(`Forbidden phrase leaked for ${subclass}: ${phrase}`);
    }
  }

  // Generic stream must not pass where multiple streams exist.
  const multi = subclasses.find(sc => Object.keys(loadCriteriaRegistry(sc).streams || {}).length > 1);
  if (multi) {
    let blocked = false;
    try {
      await buildUniversalAdviceModel({ subclass: multi, rawStream: 'Primary pathway', assessment: { visa_type: multi } });
    } catch (e) {
      blocked = /valid stream|invalid stream|not selected/i.test(e.message);
    }
    if (!blocked) throw new Error(`Generic stream was not blocked for multi-stream subclass ${multi}`);
  }

  console.log('Universal advice engine quality gate passed.');
})().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
