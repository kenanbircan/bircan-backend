'use strict';

const { loadLegalFrame, listSupportedLegalFrameSubclasses } = require('./legalFrameLoader');
const { buildSeniorAdviceModel } = require('./seniorAdviceEngine');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const subclasses = listSupportedLegalFrameSubclasses();
assert(subclasses.length >= 1, 'No supported subclasses found.');

const sample = {
  client_email: 'test@example.com',
  applicant_name: 'Test Applicant',
  visa_type: '186',
  selected_stream: 'Labour Agreement',
  form_payload: {
    answers: {
      employer: 'Test employer',
      occupation: 'Registered Nurse',
      salary: 'Not verified',
      english: 'Not verified',
      currentVisa: 'Not confirmed'
    }
  }
};

for (const subclass of subclasses.slice(0, 8)) {
  const stream = subclass === '186' ? 'Labour Agreement' : subclass === '300' ? 'Prospective Marriage' : '';
  const frame = loadLegalFrame(subclass, stream);
  assert(frame.validation && frame.validation.ok, `Legal frame failed for ${subclass}`);
  assert(frame.criteriaFrames && frame.criteriaFrames.length, `No criteriaFrames for ${subclass}`);
  assert(frame.criteriaFrames.every(f => f.legalTest && f.knowledgebaseReferences && f.knowledgebaseReferences.length), `Incomplete criterion legal frame for ${subclass}`);
  const model = buildSeniorAdviceModel({
    assessment: { ...sample, visa_type: subclass, selected_stream: stream },
    registry: frame.registry,
    stream,
    legalFrame: frame,
    adviceBundle: { subclass, stream, legalFrame: frame, genericFallbackAllowed: false }
  });
  assert(model.criteriaFindings.length === frame.criteriaFrames.length, `Senior model criteria count mismatch for ${subclass}`);
  assert(model.coverage.legalFrameApplied === true, `Legal frame not marked applied for ${subclass}`);
  assert(model.coverage.genericFallbackUsed === false, `Generic fallback used for ${subclass}`);
}

console.log(`Knowledgebase legal-frame engine check passed for ${Math.min(subclasses.length, 8)} sampled subclasses.`);
