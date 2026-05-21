'use strict';

function buildAdviceLetter({ assessment, registry, findings }) {
  return {
    version: 'universal-paid-advice-pipeline-v1',
    generatedAt: new Date().toISOString(),
    assessment: {
      id: assessment.id,
      subclass: assessment.subclass,
      pathway: assessment.pathway,
      applicantName: assessment.applicantName,
      applicantEmail: assessment.applicantEmail,
      clientEmail: assessment.clientEmail
    },
    registrySummary: {
      subclass: registry.subclass || assessment.subclass,
      title: registry.title || registry.name || `Subclass ${assessment.subclass}`
    },
    findings,
    sections: [
      'Scope of advice',
      'Client summary',
      'Visa subclass and pathway assessed',
      'Key eligibility findings',
      'Risk assessment',
      'Evidence checklist',
      'Required action plan',
      'Agent review position',
      'Limitations'
    ]
  };
}

module.exports = { buildAdviceLetter };
