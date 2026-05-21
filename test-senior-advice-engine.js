'use strict';
const assert = require('assert');
const { buildSeniorAdviceModel, supportedSubclasses } = require('./seniorAdviceEngine');
const { loadLegalFrame } = require('./legalFrameLoader');

for (const subclass of supportedSubclasses()) {
  const stream = subclass === '186' ? 'Labour Agreement' : subclass === '300' ? 'Prospective Marriage' : '';
  const legalFrame = loadLegalFrame(subclass, stream);
  const model = buildSeniorAdviceModel({
    assessment: { visa_type: subclass, selected_stream: stream, form_payload: { answers: { passport: 'provided for review' } } },
    adviceBundle: { subclass, stream, legalFrame, advice: { subclass, stream }, genericFallbackAllowed: false },
    registry: legalFrame.registry,
    stream,
    legalFrame
  });
  assert.strictEqual(model.subclass, subclass);
  assert.ok(model.criteriaFindings.length > 0, `No criteria for ${subclass}`);
  assert.ok(model.criteriaFindings[0].legalRequirement, `No legal requirement for ${subclass}`);
  assert.ok(model.criteriaFindings[0].factsApplied, `No factsApplied for ${subclass}`);
  assert.ok(model.criteriaFindings[0].legalConsequence, `No legal consequence for ${subclass}`);
  assert.ok(model.coverage.legalFrameApplied, `Legal frame not applied for ${subclass}`);
}
console.log(`Senior advice engine OK for ${supportedSubclasses().length} subclasses.`);
