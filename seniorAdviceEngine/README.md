# Senior Australian Immigration Advice Engine

This layer converts the existing `criteriaRegistry` and `knowledgebase` output into a senior migration-agent / solicitor-level advice model for every subclass already present in the backend registry.

It is intentionally registry-driven: when a new `criteriaRegistry/subclassXXX.json` file exists, the engine can build a clause-by-clause advice model for that subclass without hard-coding only Subclass 186 or 300.

## Server flow

```text
server.js / adviceEngine.js
  -> loads knowledgebase
  -> loads criteriaRegistry
  -> validates grant criteria coverage
  -> seniorAdviceEngine.attachSeniorAdviceModel()
  -> pdf.js renders seniorCriteriaFindings / seniorAdviceModel
```

## Standard enforced

Each criterion row receives:

- legal requirement;
- facts applied;
- evidence gap;
- risk level;
- legal consequence;
- required action; and
- senior practitioner opinion.

This prevents the old PDF problem where the document merely said: “This criterion remains subject to verification”.
