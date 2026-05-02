/**
 * migrationPersuasionLayer.js
 * Bircan Migration — Persuasion Layer V1
 * Conversion-grade advisory wording for PDF/client dashboard.
 *
 * Purpose:
 * - Adds senior migration-agent style confidence, pathway, risk and next-step language.
 * - Does NOT override legal outcome, risk level, evidence status or decision engine findings.
 * - Blocks persuasive/positive framing for hard fail, not-lodgeable, PIC 4020, serious character,
 *   fraud/integrity, or adverse risk cases.
 *
 * Upload beside server.js and import where your PDF/advice bundle is built.
 */

const VERSION = '1.0.0-conversion-grade-advisory';

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function upper(v) {
  return str(v).toUpperCase();
}

function lower(v) {
  return str(v).toLowerCase();
}

function cleanStatus(v) {
  return str(v).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function sentence(v) {
  const s = str(v);
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function includesAny(text, words) {
  const t = lower(text);
  return words.some(w => t.includes(lower(w)));
}

function getFindings(decisionOrBundle) {
  if (!decisionOrBundle || typeof decisionOrBundle !== 'object') return [];
  if (Array.isArray(decisionOrBundle.findings)) return decisionOrBundle.findings;
  if (Array.isArray(decisionOrBundle.criterionFindings)) return decisionOrBundle.criterionFindings;
  if (decisionOrBundle.rawDecision && Array.isArray(decisionOrBundle.rawDecision.findings)) return decisionOrBundle.rawDecision.findings;
  if (decisionOrBundle.advice && Array.isArray(decisionOrBundle.advice.criterion_findings)) return decisionOrBundle.advice.criterion_findings;
  return [];
}

function getSubclass(decisionOrBundle, assessment) {
  return str(
    decisionOrBundle?.subclass ||
    decisionOrBundle?.rawDecision?.subclass ||
    decisionOrBundle?.advice?.subclass ||
    assessment?.visa_type ||
    assessment?.subclass ||
    'the relevant'
  );
}

function getTitle(decisionOrBundle, assessment) {
  const subclass = getSubclass(decisionOrBundle, assessment);
  const rawTitle = str(decisionOrBundle?.subclassTitle || decisionOrBundle?.rawDecision?.subclassTitle || '');
  return rawTitle || `Subclass ${subclass}`;
}

function normaliseDecision(decisionOrBundle = {}, assessment = {}) {
  const raw = decisionOrBundle.rawDecision || decisionOrBundle;
  return {
    subclass: getSubclass(decisionOrBundle, assessment),
    subclassTitle: getTitle(decisionOrBundle, assessment),
    decisionStatus: str(decisionOrBundle.decisionStatus || raw.decisionStatus || decisionOrBundle.advice?.decisionStatus || ''),
    lodgementPosition: str(decisionOrBundle.lodgementPosition || raw.lodgementPosition || decisionOrBundle.advice?.lodgement_position || ''),
    riskLevel: str(decisionOrBundle.riskLevel || raw.riskLevel || decisionOrBundle.advice?.risk_level || ''),
    legalStatus: str(decisionOrBundle.legalStatus || raw.legalStatus || ''),
    primaryReason: str(decisionOrBundle.primaryReason || raw.primaryReason || ''),
    evidenceRequired: Array.from(new Set([].concat(decisionOrBundle.evidenceRequired || [], raw.evidenceRequired || [], decisionOrBundle.advice?.evidence_required || []).filter(Boolean).map(String))),
    nextSteps: Array.from(new Set([].concat(decisionOrBundle.nextSteps || [], raw.nextSteps || [], decisionOrBundle.advice?.client_next_steps || []).filter(Boolean).map(String))),
    findings: getFindings(decisionOrBundle),
    raw
  };
}

function isHardStop(decision) {
  const combined = [
    decision.decisionStatus,
    decision.lodgementPosition,
    decision.legalStatus,
    decision.primaryReason,
    ...decision.findings.map(f => [f.criterion, f.status, f.legalEffect, f.legalConsequence, f.finding].filter(Boolean).join(' '))
  ].join(' ');

  if (includesAny(combined, [
    'NOT_LODGEABLE',
    'INVALID_OR_NOT_LODGEABLE',
    'INVALID APPLICATION',
    'NOT LODGEABLE',
    'PIC 4020',
    'FALSE DOCUMENT',
    'MISLEADING',
    'FRAUD',
    'CHARACTER ISSUE',
    'CRIMINAL',
    'CANCELLATION',
    'SECTION 48',
    'NO FURTHER STAY',
    '8503',
    '8534',
    '8535'
  ])) return true;

  return decision.findings.some(f => {
    const status = upper(f.status || f.legalSatisfaction);
    const sev = upper(f.severity);
    const txt = [f.criterion, f.legalEffect, f.legalConsequence, f.finding].filter(Boolean).join(' ');
    return (status === 'FAIL' && (sev === 'BLOCKER' || sev === 'CRITICAL')) || includesAny(txt, ['PIC 4020', 'false document', 'misleading', 'serious character']);
  });
}

function isPositiveButConditional(decision) {
  const txt = upper([decision.decisionStatus, decision.lodgementPosition, decision.legalStatus].join(' '));
  return txt.includes('POTENTIALLY_LODGEABLE') || txt.includes('PROVISIONALLY') || txt.includes('SUBJECT_TO_EVIDENCE') || txt.includes('SUBJECT TO EVIDENCE');
}

function isLowRiskClean(decision) {
  const risk = upper(decision.riskLevel);
  const txt = upper([decision.decisionStatus, decision.lodgementPosition].join(' '));
  return risk === 'LOW' && txt.includes('POTENTIALLY_LODGEABLE') && !isHardStop(decision);
}

function keyIssue(decision) {
  return decision.primaryReason || (decision.findings.find(f => upper(f.status) !== 'PASS') || {}).criterion || 'the outstanding evidence and eligibility requirements';
}

function buildSafePersuasionLayer(decisionOrBundle, assessment, options = {}) {
  const decision = normaliseDecision(decisionOrBundle, assessment);
  const subclass = decision.subclass;
  const subclassTitle = decision.subclassTitle;
  const issue = keyIssue(decision);
  const signedName = options.agentName || 'Kenan Bircan';

  if (isHardStop(decision)) {
    return buildHardStopLayer(decision, signedName);
  }

  if (isLowRiskClean(decision)) {
    return buildLowRiskLayer(decision, signedName);
  }

  if (isPositiveButConditional(decision)) {
    return {
      version: VERSION,
      mode: 'conversion_safe_conditional',
      allowed: true,
      complianceBoundary: 'Persuasive wording is permitted only because the legal engine indicates a potentially viable/provisional pathway. This layer does not alter legal outcome.',
      title: 'Professional assessment and pathway strategy',
      confidenceFraming: `I have considered the information provided in relation to the ${subclassTitle} pathway. Based on your current instructions, this pathway appears capable of progressing, provided the outstanding evidence and sponsorship or eligibility requirements are properly confirmed before any lodgement action is taken.`,
      pathwayViability: `The Subclass ${subclass} pathway appears to align with the circumstances described, subject to verification of the matters identified in this advice. The current position should be treated as potentially viable, not final, until the required documents are reviewed.`,
      riskReframing: `The current risk appears to arise mainly from matters that require confirmation and documentary support, rather than from an identified fundamental ineligibility finding. In my view, those risks can be managed through structured preparation and pre-lodgement review.`,
      momentumPathway: [
        'Confirm the core eligibility and sponsorship or nomination position.',
        'Collect and review the supporting documents identified in this advice.',
        'Resolve any inconsistency or missing information before lodgement.',
        'Conduct a final registered migration agent review before proceeding.'
      ],
      authorityPositioning: `Applications of this nature should not be rushed. In my experience, matters that proceed without first resolving evidence and eligibility issues carry an avoidable refusal risk. The safer approach is to address the identified issues before any application is lodged.`,
      conversionNextStep: `If you wish to proceed, the next practical step is a detailed review of your documents and confirmation of the outstanding requirements, so the matter can be prepared in a structured and compliant way.`,
      closingConfidence: `Overall, there appears to be a pathway forward, however the matter is not yet ready to be treated as final or lodgeable until the evidence position is verified. With proper preparation, the identified issues can be addressed in a controlled manner.`,
      agentVoice: `${signedName} has assessed the matter on a preliminary basis using the information currently available.`,
      primaryIssue: issue,
      pdfSections: buildPdfSections('conditional', decision, signedName),
      dashboardCards: buildDashboardCards('conditional', decision)
    };
  }

  return buildInformationRequiredLayer(decision, signedName);
}

function buildLowRiskLayer(decision, signedName) {
  return {
    version: VERSION,
    mode: 'conversion_safe_low_risk',
    allowed: true,
    complianceBoundary: 'Positive pathway wording is permitted because no hard stop is indicated. Final advice remains subject to professional review.',
    title: 'Professional assessment and pathway strategy',
    confidenceFraming: `I have reviewed the information provided and, on the current material, the pathway appears favourable subject to final document verification and professional review.`,
    pathwayViability: `The selected pathway appears to align with the circumstances described and no immediate blocker has been identified on the information currently available.`,
    riskReframing: `The current risk profile appears low, provided the supporting documents are consistent with the instructions provided.`,
    momentumPathway: [
      'Complete final document verification.',
      'Confirm that all information remains accurate and current.',
      'Prepare the matter for final review before lodgement.',
      'Proceed only after all professional safeguards have been completed.'
    ],
    authorityPositioning: `Even where a matter appears favourable, careful pre-lodgement review remains essential to avoid errors, inconsistencies or unsupported claims.`,
    conversionNextStep: `The next step is to finalise document review and prepare the matter for compliant progression.`,
    closingConfidence: `Subject to the above checks, the matter appears capable of progressing in a structured and compliant manner.`,
    agentVoice: `${signedName} has assessed the matter on a preliminary basis using the information currently available.`,
    primaryIssue: decision.primaryReason || 'final verification before progression',
    pdfSections: buildPdfSections('low', decision, signedName),
    dashboardCards: buildDashboardCards('low', decision)
  };
}

function buildHardStopLayer(decision, signedName) {
  const issue = keyIssue(decision);
  return {
    version: VERSION,
    mode: 'hard_stop_no_persuasion',
    allowed: false,
    complianceBoundary: 'Persuasive pathway wording has been blocked because the legal engine indicates a hard-stop or serious adverse risk.',
    title: 'Professional assessment and risk position',
    confidenceFraming: `I have considered the information provided. At this stage, I cannot recommend progression toward lodgement until the identified legal or evidentiary issue is resolved.`,
    pathwayViability: `The matter should not be framed as viable at this stage. The primary concern is ${issue}.`,
    riskReframing: `This is not merely a presentation or evidence issue. It requires substantive legal review before any further application action is considered.`,
    momentumPathway: [
      'Do not lodge an application at this stage.',
      'Obtain full instructions and documents relevant to the adverse issue.',
      'Conduct detailed registered migration agent review.',
      'Only reconsider strategy after the legal position is clarified.'
    ],
    authorityPositioning: `Proceeding without resolving this issue may expose the applicant to refusal, invalidity or other adverse immigration consequences.`,
    conversionNextStep: `The next step is not lodgement preparation. The next step is a detailed legal review of the adverse issue and any available remedy or alternative pathway.`,
    closingConfidence: `Further advice can only be given after the issue has been reviewed and the relevant documents have been assessed.`,
    agentVoice: `${signedName} has assessed the matter on a preliminary basis using the information currently available.`,
    primaryIssue: issue,
    pdfSections: buildPdfSections('hard_stop', decision, signedName),
    dashboardCards: buildDashboardCards('hard_stop', decision)
  };
}

function buildInformationRequiredLayer(decision, signedName) {
  const issue = keyIssue(decision);
  return {
    version: VERSION,
    mode: 'information_required',
    allowed: false,
    complianceBoundary: 'Conversion wording has been limited because instructions are insufficient to form a reliable pathway view.',
    title: 'Professional assessment and information required',
    confidenceFraming: `I have reviewed the information provided, however further information is required before I can responsibly express a pathway view.`,
    pathwayViability: `At this stage, the pathway should be treated as unconfirmed rather than viable or non-viable.`,
    riskReframing: `The main risk is the absence of sufficient instructions or documents to assess ${issue}.`,
    momentumPathway: [
      'Provide the missing instructions identified in this advice.',
      'Upload or supply the supporting documents requested.',
      'Reassess the matter once the information position is complete.',
      'Proceed only after a registered migration agent review.'
    ],
    authorityPositioning: `A migration application should not be progressed on assumptions. The missing information must be obtained before any reliable advice can be finalised.`,
    conversionNextStep: `The next step is to complete the information and evidence position so a proper legal assessment can be made.`,
    closingConfidence: `Once the missing information is provided, the matter can be reassessed and a clearer pathway recommendation can be given.`,
    agentVoice: `${signedName} has assessed the matter on a preliminary basis using the information currently available.`,
    primaryIssue: issue,
    pdfSections: buildPdfSections('information_required', decision, signedName),
    dashboardCards: buildDashboardCards('information_required', decision)
  };
}

function buildPdfSections(mode, decision, signedName) {
  const title = decision.subclassTitle;
  if (mode === 'hard_stop') {
    return [
      { heading: 'Professional assessment', body: `I have reviewed the information provided in relation to the ${title} pathway. At this stage, I cannot recommend progression toward lodgement until the identified issue is resolved.` },
      { heading: 'Risk position', body: `The primary concern is ${keyIssue(decision)}. This requires detailed legal review before further application action is taken.` },
      { heading: 'Recommended next step', body: 'The next step is a detailed review of the adverse issue and any documents relevant to that issue. Lodgement preparation should not commence until that review is complete.' }
    ];
  }
  if (mode === 'information_required') {
    return [
      { heading: 'Professional assessment', body: `I have reviewed the information provided in relation to the ${title} pathway. Further instructions and evidence are required before a reliable pathway view can be given.` },
      { heading: 'Information required', body: `The key unresolved issue is ${keyIssue(decision)}. This should be clarified before the matter is progressed.` },
      { heading: 'Recommended next step', body: 'The next step is to complete the missing information and document position, then reassess the matter before any lodgement decision is made.' }
    ];
  }
  if (mode === 'low') {
    return [
      { heading: 'Professional assessment', body: `I have reviewed the information provided in relation to the ${title} pathway. On the current material, the pathway appears favourable, subject to final document verification and professional review.` },
      { heading: 'Risk perspective', body: 'The current risk profile appears low, provided the supporting documents are consistent with the instructions provided.' },
      { heading: 'Progression pathway', body: 'The matter should now move to final document verification, pre-lodgement review and structured preparation.' }
    ];
  }
  return [
    { heading: 'Professional assessment', body: `I have reviewed the information provided in relation to the ${title} pathway. Based on your current instructions, the pathway appears capable of progressing, subject to documentary verification and professional review.` },
    { heading: 'Risk perspective', body: `The identified risks appear to relate mainly to evidence and confirmation issues rather than an identified fundamental ineligibility finding. The key issue is ${keyIssue(decision)}.` },
    { heading: 'Progression pathway', body: 'The matter should be progressed in stages: confirm eligibility, verify documents, resolve any inconsistencies, and conduct final pre-lodgement review before any application is lodged.' }
  ];
}

function buildDashboardCards(mode, decision) {
  if (mode === 'hard_stop') {
    return [
      { label: 'Current position', value: 'Do not lodge yet', tone: 'critical' },
      { label: 'Primary issue', value: keyIssue(decision), tone: 'critical' },
      { label: 'Next step', value: 'Legal review required', tone: 'warning' }
    ];
  }
  if (mode === 'information_required') {
    return [
      { label: 'Current position', value: 'More information required', tone: 'warning' },
      { label: 'Primary issue', value: keyIssue(decision), tone: 'warning' },
      { label: 'Next step', value: 'Complete instructions and evidence', tone: 'neutral' }
    ];
  }
  return [
    { label: 'Current position', value: cleanStatus(decision.lodgementPosition || 'Potential pathway'), tone: 'positive' },
    { label: 'Primary issue', value: keyIssue(decision), tone: 'neutral' },
    { label: 'Next step', value: 'Document review and strategy confirmation', tone: 'positive' }
  ];
}

function attachPersuasionLayerToAdviceBundle(adviceBundle, assessment, options = {}) {
  const layer = buildSafePersuasionLayer(adviceBundle, assessment, options);
  const out = { ...(adviceBundle || {}) };
  out.persuasionLayer = layer;
  out.conversionAdvisory = layer;

  if (out.advice && typeof out.advice === 'object') {
    const existing = Array.isArray(out.advice.sections) ? out.advice.sections : [];
    out.advice.sections = [
      ...existing,
      ...layer.pdfSections.map(s => ({ heading: s.heading, body: s.body }))
    ];
    out.advice.client_next_steps = Array.from(new Set([].concat(out.advice.client_next_steps || [], layer.momentumPathway || []).filter(Boolean)));
  }
  return out;
}

module.exports = {
  VERSION,
  buildSafePersuasionLayer,
  attachPersuasionLayerToAdviceBundle
};
