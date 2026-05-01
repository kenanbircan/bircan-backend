'use strict';

const { normalise190Input } = require('./190.normaliser');
const { run190Rules } = require('./190.rules');
const { aggregate190Decision } = require('./190.decision-aggregator');
const { build190AdviceBundle, build190GptSystemPrompt } = require('./190.advice-bundle-builder');

function assessSubclass190(rawInput, ctx = {}) {
  const input = normalise190Input(rawInput);
  const findings = run190Rules(input, ctx);
  const aggregate = aggregate190Decision(findings);
  const adviceBundle = build190AdviceBundle(input, findings, aggregate);

  return {
    ok: true,
    engine: 'subclass-190-decision-engine',
    version: '1.0.0',
    input,
    findings,
    ...aggregate,
    adviceBundle,
    gptSystemPrompt: build190GptSystemPrompt()
  };
}

module.exports = { assessSubclass190 };
