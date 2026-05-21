'use strict';
const assert = require('assert');
const { buildSeniorAdviceModel, supportedSubclasses } = require('./seniorAdviceEngine');

for (const subclass of supportedSubclasses()) {
  const model = buildSeniorAdviceModel({
    assessment: { visa_type: subclass, form_payload: { answers: { passport: 'provided for review' } } },
    adviceBundle: { subclass, advice: { subclass } }
  });
  assert.strictEqual(model.subclass, subclass);
  assert.ok(model.criteriaFindings.length > 0, `No criteria for ${subclass}`);
  assert.ok(model.criteriaFindings[0].legalRequirement, `No legal requirement for ${subclass}`);
  assert.ok(model.criteriaFindings[0].factsApplied, `No factsApplied for ${subclass}`);
  assert.ok(model.criteriaFindings[0].legalConsequence, `No legal consequence for ${subclass}`);
}
console.log(`Senior advice engine OK for ${supportedSubclasses().length} subclasses.`);
