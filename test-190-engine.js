'use strict';

const { assessSubclass190 } = require('./engines/190');

const sample = {
  reference: 'sub_test_190',
  applicant: {
    fullName: 'Carlos Mendes',
    dateOfBirth: '1978-03-17',
    currentLocation: 'Australia',
    section48BarRisk: true,
    noFurtherStayCondition: null
  },
  skillselect: {
    invitationReceived: false,
    invitationSubclass: '190',
    invitationDate: null,
    invitationPoints: null
  },
  nomination: {
    nominatedByStateOrTerritory: true,
    nominationStatus: 'withdrawn'
  },
  occupation: {
    nominatedOccupation: 'Marketing Specialist',
    occupationListStatus: 'unknown'
  },
  skillsAssessment: {
    hasPositiveSkillsAssessment: null,
    assessedOccupation: 'Marketing Specialist',
    validAtInvitationDate: null
  },
  english: {
    claimedLevel: 'unknown',
    evidenceProvided: false
  },
  points: { claimedTotal: null, breakdown: {} },
  healthCharacterIntegrity: {
    healthIssueDisclosed: true,
    characterIssueDisclosed: true,
    pic4020IssueDisclosed: true,
    previousFalseDocumentConcern: true
  },
  familyMembers: [
    { name: 'Child', relationship: 'child', includedInApplication: true, custodyIssue: true, dependencyEvidenceProvided: false }
  ]
};

const result = assessSubclass190(sample);
console.log(JSON.stringify({
  ok: result.ok,
  lodgementPosition: result.finalPosition.lodgementPosition,
  riskLevel: result.finalPosition.riskLevel,
  primaryReason: result.finalPosition.primaryReason,
  metrics: result.metrics,
  validityAssessment: result.validityAssessment
}, null, 2));
