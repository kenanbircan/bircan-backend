'use strict';

/**
 * Bircan Migration pdf.js — clean advice renderer
 * Rebuilt from scratch as a rendering-only module.
 *
 * Contract preserved:
 *   module.exports = {
 *     buildAssessmentPdfBuffer,
 *     buildAppealAdvicePdfBuffer,
 *     sha256
 *   }
 *
 * Important architectural rule:
 *   This file does not create legal advice. It renders a validated advice model.
 *   If the model still contains internal/fallback labels or wrong-subclass text,
 *   PDF generation is blocked before release.
 */

const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const BRAND = {
  name: 'Bircan Migration & Education',
  subtitle: 'Professional Migration Assessment',
  agent: 'Kenan Bircan JP',
  marn: '1463685'
};

const FORBIDDEN_CLIENT_PHRASES = [
  'Registry-controlled pathway',
  'Registry controlled pathway',
  'Grant Criterion Control',
  'Subclass Specific Grant Criterion',
  'Map the original evidence to the clause',
  'Primary pathway',
  'quality_flags',
  'source hash',
  'internalLegalAudit'
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function text(value, fallback = '—') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.map((item) => text(item, '')).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_err) { return fallback; }
  }
  return String(value);
}

function cleanClientText(value) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return value;

  return value
    .replace(/\bGrant Criterion Control\b/gi, 'Grant criterion requirement')
    .replace(/\bSubclass Specific Grant Criterion\b/gi, 'Subclass-specific requirement')
    .replace(/\bRegistry-controlled pathway Stream\b/gi, 'stream/pathway')
    .replace(/\bRegistry-controlled pathway\b/gi, 'stream/pathway')
    .replace(/\bRegistry controlled pathway\b/gi, 'stream/pathway')
    .replace(/\bPrimary pathway\b/gi, 'stream/pathway')
    .replace(/Map the original evidence to the clause and record any unresolved gap before final advice\.?/gi,
      'Review the original evidence against this requirement and resolve any evidentiary gap before final lodgement advice is finalised.')
    .replace(/This criterion remains subject to verification against original evidence, current legal settings and any applicable instrument or transitional control\.?/gi,
      'This requirement must be assessed against the original evidence, current legal settings and any applicable instrument before final lodgement advice is issued.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function deepClean(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return cleanClientText(value);
  if (Array.isArray(value)) return value.map((item) => deepClean(item, seen));
  if (isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = deepClean(val, seen);
    return out;
  }
  return value;
}

function flattenStrings(value, out = [], seen = new WeakSet()) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, out, seen);
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return out;
    seen.add(value);
    for (const val of Object.values(value)) flattenStrings(val, out, seen);
  }
  return out;
}

function assertNoForbiddenClientText(model, stage = 'PDF') {
  const all = flattenStrings(model).join('\n');
  for (const phrase of FORBIDDEN_CLIENT_PHRASES) {
    if (all.includes(phrase)) {
      throw new Error(`${stage} blocked: forbidden fallback wording leaked into advice letter: ${phrase}`);
    }
  }
}

function assertNoWrongSubclassLeak(model, subclass) {
  const subclassText = String(subclass || '').trim();
  if (!/^\d{3}$/.test(subclassText)) return;
  const all = flattenStrings(model).join('\n');
  const matches = all.match(/\bSubclass\s+(\d{3})\b/gi) || [];
  for (const match of matches) {
    const n = (match.match(/\d{3}/) || [])[0];
    if (n && n !== subclassText) {
      throw new Error(`PDF blocked: wrong subclass legal frame leaked into Subclass ${subclassText}: ${match}`);
    }
  }
}

function normaliseArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  return [value];
}

function getAssessmentSubclass(assessment, bundle, model) {
  return String(pick(
    assessment && (assessment.subclass || assessment.visa_subclass || assessment.visaSubclass),
    model && (model.subclass || model.visaSubclass),
    bundle && (bundle.subclass || bundle.visaSubclass),
    bundle && bundle.advice && (bundle.advice.subclass || bundle.advice.visaSubclass)
  ) || '').replace(/[^\d]/g, '').slice(0, 3);
}

function getRawStream(assessment, bundle, model) {
  return pick(
    model && (model.streamLabel || model.stream || model.pathway || model.clientFacingStream),
    bundle && (bundle.streamLabel || bundle.stream || bundle.pathway || bundle.clientFacingStream),
    bundle && bundle.advice && (bundle.advice.streamLabel || bundle.advice.stream || bundle.advice.pathway),
    assessment && (assessment.streamLabel || assessment.stream || assessment.pathway || assessment.selected_stream || assessment.selectedStream || assessment.visa_stream)
  );
}

function isUnresolvedStream(value) {
  return /registry-controlled|registry controlled|primary pathway|generic pathway|stream\/pathway|not confirmed/i.test(String(value || ''));
}

function getAdviceModel(adviceBundle) {
  const bundle = adviceBundle || {};
  return deepClean(pick(
    bundle.universalAdviceModel,
    bundle.seniorAdviceModel,
    bundle.adviceModel,
    bundle.advice && bundle.advice.universalAdviceModel,
    bundle.advice && bundle.advice.seniorAdviceModel,
    bundle.advice,
    bundle
  ));
}

function collectFindings(model, bundle) {
  const candidates = [
    model && model.criteriaFindings,
    model && model.seniorCriteriaFindings,
    model && model.grantCriteriaFindings,
    model && model.criterion_findings,
    model && model.legalIssues,
    model && model.issues,
    bundle && bundle.seniorCriteriaFindings,
    bundle && bundle.grantCriteriaFindings,
    bundle && bundle.criterion_findings,
    bundle && bundle.advice && bundle.advice.grantCriteriaFindings,
    bundle && bundle.advice && bundle.advice.criterion_findings
  ];
  for (const candidate of candidates) {
    const arr = normaliseArray(candidate);
    if (arr.length) return deepClean(arr);
  }
  return [];
}

function collectEvidenceGaps(model) {
  return normaliseArray(pick(
    model && model.evidenceGaps,
    model && model.requiredEvidence,
    model && model.evidencePlan,
    model && model.documentRequests
  ));
}

function collectActionPlan(model) {
  return normaliseArray(pick(
    model && model.actionPlan,
    model && model.lodgementReadinessActionPlan,
    model && model.nextSteps,
    model && model.recommendedActions
  ));
}

function findingTitle(finding) {
  if (!isPlainObject(finding)) return text(finding, '');
  return cleanClientText(pick(
    finding.issue,
    finding.title,
    finding.label,
    finding.criterionLabel,
    finding.criterionName,
    finding.name,
    finding.criterion,
    finding.criterionId
  ) || 'Legal requirement');
}

function findingRequirement(finding) {
  if (!isPlainObject(finding)) return '';
  return cleanClientText(pick(
    finding.legalRequirement,
    finding.requirement,
    finding.legalTest,
    finding.rule,
    finding.whatMustBeEstablished,
    finding.assessmentRequired
  ));
}

function findingFacts(finding) {
  if (!isPlainObject(finding)) return '';
  return cleanClientText(pick(
    finding.clientFacts,
    finding.factsApplied,
    finding.currentPosition,
    finding.presentInformation,
    finding.evidenceHeld,
    finding.filePosition
  ));
}

function findingGap(finding) {
  if (!isPlainObject(finding)) return '';
  return cleanClientText(pick(
    finding.evidenceGap,
    finding.evidenceMissing,
    finding.gap,
    finding.requiredEvidence,
    finding.documentsRequired
  ));
}

function findingConsequence(finding) {
  if (!isPlainObject(finding)) return '';
  return cleanClientText(pick(
    finding.consequence,
    finding.legalConsequence,
    finding.consequenceOfFailure,
    finding.riskIfMissing,
    finding.whyItMatters
  ));
}

function findingAction(finding) {
  if (!isPlainObject(finding)) return '';
  return cleanClientText(pick(
    finding.requiredAction,
    finding.action,
    finding.recommendation,
    finding.seniorOpinion,
    finding.agentOpinion,
    finding.professionalPosition
  ));
}

function findingRisk(finding) {
  if (!isPlainObject(finding)) return 'Not verified';
  return cleanClientText(pick(finding.riskLevel, finding.risk, finding.status, finding.evidenceStatus, 'Not verified'));
}

function assertAdviceModelReady(assessment, adviceBundle, model, subclass, stream, findings) {
  if (!adviceBundle) throw new Error('Advice-grade PDF generation requires adviceBundle.');
  if (!subclass) throw new Error('Advice-grade PDF blocked: subclass could not be identified.');

  if (!stream || isUnresolvedStream(stream)) {
    throw new Error(`Advice-grade PDF blocked: valid stream/pathway not confirmed for Subclass ${subclass}.`);
  }

  if (!findings.length) {
    throw new Error(`Advice-grade PDF blocked: no criterion-level senior advice findings were supplied for Subclass ${subclass}.`);
  }

  // At least some legal substance must be present. If every row only has a title/risk, release is unsafe.
  const substantive = findings.filter((f) => {
    if (!isPlainObject(f)) return false;
    return !!(findingRequirement(f) || findingFacts(f) || findingGap(f) || findingConsequence(f) || findingAction(f));
  });

  if (!substantive.length) {
    throw new Error(`Advice-grade PDF blocked: criterion findings for Subclass ${subclass} do not contain legal-frame or fact-application content.`);
  }

  assertNoForbiddenClientText({ assessment, model, findings, subclass, stream }, 'PDF');
  assertNoWrongSubclassLeak({ model, findings, stream }, subclass);
}

function createDoc(resolve, reject) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    bufferPages: true,
    info: {
      Title: 'Professional Migration Advice Letter',
      Author: BRAND.name,
      Subject: 'Migration advice letter',
      Creator: BRAND.name
    }
  });

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  doc.on('end', () => {
    try {
      const range = doc.bufferedPageRange();
      resolve(Buffer.concat(chunks));
    } catch (_err) {
      resolve(Buffer.concat(chunks));
    }
  });
  doc.on('error', reject);
  return doc;
}

function pageWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, height = 80) {
  if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function rule(doc) {
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#d5dce8').lineWidth(0.7).stroke();
  doc.moveDown(0.7);
}

function h1(doc, value) {
  ensureSpace(doc, 60);
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#0b2545').text(cleanClientText(value), { lineGap: 2 });
  doc.moveDown(0.4);
  rule(doc);
}

function h2(doc, value) {
  ensureSpace(doc, 48);
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor('#12355b').text(cleanClientText(value), { lineGap: 2 });
  doc.moveDown(0.35);
}

function p(doc, value, options = {}) {
  const body = cleanClientText(text(value, ''));
  if (!body) return;
  ensureSpace(doc, 38);
  doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(options.size || 9.5).fillColor(options.color || '#182334')
    .text(body, { width: pageWidth(doc), lineGap: options.lineGap || 2.8, align: options.align || 'left' });
  doc.moveDown(options.after === undefined ? 0.45 : options.after);
}

function small(doc, value) {
  p(doc, value, { size: 8.2, color: '#4a5568', lineGap: 2, after: 0.25 });
}

function keyValueTable(doc, rows, widths) {
  const usable = pageWidth(doc);
  const w1 = widths && widths[0] ? widths[0] : Math.round(usable * 0.32);
  const w2 = usable - w1;
  for (const row of rows) {
    const k = cleanClientText(text(row[0], ''));
    const v = cleanClientText(text(row[1], '—'));
    const h = Math.max(doc.heightOfString(k, { width: w1 - 8 }), doc.heightOfString(v, { width: w2 - 8 })) + 10;
    ensureSpace(doc, h + 4);
    const y = doc.y;
    doc.rect(doc.page.margins.left, y, usable, h).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#26364a').font('Helvetica-Bold').fontSize(8.5).text(k, doc.page.margins.left + 6, y + 6, { width: w1 - 8 });
    doc.fillColor('#152033').font('Helvetica').fontSize(8.5).text(v, doc.page.margins.left + w1 + 6, y + 6, { width: w2 - 8, lineGap: 1.8 });
    doc.y = y + h + 3;
  }
  doc.moveDown(0.3);
}

function table(doc, headers, rows, widths) {
  const usable = pageWidth(doc);
  const cols = headers.length;
  const resolved = widths && widths.length === cols ? widths : new Array(cols).fill(usable / cols);
  const x0 = doc.page.margins.left;

  function drawRow(cells, header) {
    const cleanCells = cells.map((c) => cleanClientText(text(c, '—')));
    const heights = cleanCells.map((c, i) => doc.heightOfString(c, { width: resolved[i] - 8, lineGap: 1.6 }) + 10);
    const h = Math.max(...heights, header ? 24 : 26);
    ensureSpace(doc, h + 6);
    const y = doc.y;
    let x = x0;
    for (let i = 0; i < cols; i++) {
      doc.rect(x, y, resolved[i], h).fillAndStroke(header ? '#eaf1fb' : '#ffffff', '#d6dee9');
      doc.fillColor('#172033').font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(header ? 8.4 : 8.1)
        .text(cleanCells[i], x + 5, y + 6, { width: resolved[i] - 10, lineGap: 1.5 });
      x += resolved[i];
    }
    doc.y = y + h;
  }

  drawRow(headers, true);
  for (const row of rows) drawRow(row, false);
  doc.moveDown(0.5);
}

function bullet(doc, value) {
  const body = cleanClientText(text(value, ''));
  if (!body) return;
  ensureSpace(doc, 36);
  const x = doc.page.margins.left;
  const y = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor('#182334').text('•', x, y, { width: 12 });
  doc.text(body, x + 14, y, { width: pageWidth(doc) - 14, lineGap: 2.4 });
  doc.moveDown(0.35);
}

function findingStatusLabel(finding) {
  if (!isPlainObject(finding)) return 'Unclear - evidence required';
  return cleanClientText(pick(
    finding.displayStatus,
    finding.riskLevel,
    finding.status,
    finding.risk,
    finding.evidenceStatus,
    'Unclear - evidence required'
  ));
}

function statusBadge(doc, value) {
  const label = cleanClientText(text(value, 'Unclear - evidence required'));
  const x = doc.x;
  const y = doc.y;
  const w = Math.min(pageWidth(doc), Math.max(120, doc.widthOfString(label) + 18));
  doc.roundedRect(x, y, w, 18, 9).fillAndStroke('#eef5ff', '#d7e7ff');
  doc.fillColor('#174cc8').font('Helvetica-Bold').fontSize(8.2).text(label, x + 9, y + 5, { width: w - 18 });
  doc.y = y + 24;
}

function adviceBlock(doc, label, body) {
  const value = cleanClientText(text(body, ''));
  if (!value) return;
  ensureSpace(doc, 45);
  doc.font('Helvetica-Bold').fontSize(8.4).fillColor('#344054').text(cleanClientText(label), { width: pageWidth(doc), lineGap: 1.6 });
  doc.font('Helvetica').fontSize(9.0).fillColor('#182334').text(value, { width: pageWidth(doc), lineGap: 2.4 });
  doc.moveDown(0.45);
}

function findingCard(doc, index, finding) {
  ensureSpace(doc, 125);
  h2(doc, `${index}. ${findingTitle(finding)}`);
  statusBadge(doc, findingStatusLabel(finding));
  adviceBlock(doc, 'Legal requirement', findingRequirement(finding) || 'The requirement must be confirmed from the applicable legal framework before final advice.');
  adviceBlock(doc, 'Application to current instructions', findingFacts(finding) || finding.body || finding.finding || 'The current instructions require reconciliation against original evidence.');
  adviceBlock(doc, 'Evidence still required', findingGap(finding) || 'Original evidence must be reviewed before final lodgement advice.');
  adviceBlock(doc, 'Consequence if unresolved', findingConsequence(finding) || 'If unresolved, this issue may affect validity, eligibility, prospects or lodgement strategy.');
  adviceBlock(doc, 'Required action', findingAction(finding) || 'Resolve before final lodgement advice is issued.');
  rule(doc);
}

function coverPage(doc, { assessment, subclass, stream, model }) {
  doc.rect(0, 0, doc.page.width, 118).fill('#0b2545');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('Professional Migration', 54, 42);
  doc.fontSize(26).text('Advice Letter', 54, 68);
  doc.fillColor('#dbeafe').font('Helvetica').fontSize(10).text(`${BRAND.name} | ${BRAND.subtitle}`, 54, 24);

  doc.y = 154;
  h1(doc, `Subclass ${subclass} — ${stream}`);

  keyValueTable(doc, [
    ['Reference', pick(assessment.reference, assessment.assessment_id, assessment.id, assessment.assessmentId)],
    ["Applicant's name", pick(assessment.applicant_name, assessment.applicantName, assessment.name, model.applicantName)],
    ['Applicant email', pick(assessment.applicant_email, assessment.applicantEmail, assessment.email)],
    ['Client email', pick(assessment.client_email, assessment.clientEmail, assessment.account_email, assessment.email)],
    ['Subclass', subclass],
    ['Stream/pathway', stream],
    ['Generated', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })]
  ]);

  doc.moveDown(1.2);
  p(doc, 'Confidential professional advice', { bold: true, size: 11.5 });
  p(doc, 'This advice letter is prepared from the information presently available and is subject to review of original evidence, current law, Departmental records, conflict checks and final migration-agent review before lodgement action.');
  p(doc, 'No guarantee of visa grant is given. This document records a professional preliminary position and the evidence work required before any final lodgement recommendation is made.', { color: '#344054' });
  doc.addPage();
}

function writeExecutive(doc, model, subclass, stream) {
  h1(doc, '1. Executive professional advice');
  const applicant = cleanClientText(pick(model.applicantName, model.clientName, 'the applicant'));
  p(doc, `Dear ${applicant},`);
  p(doc, pick(
    model.executiveAdvice,
    model.seniorOpinion && model.seniorOpinion.shortOpinion,
    model.summary,
    `I have reviewed the information presently available for the proposed Subclass ${subclass} — ${stream} pathway.`
  ));

  const recommendation = pick(
    model.finalRecommendation && model.finalRecommendation.summary,
    model.recommendation,
    model.lodgementPosition,
    'On the present information, immediate lodgement is not recommended unless and until the legal criteria, evidence gaps and public-interest matters identified in this advice are resolved.'
  );
  p(doc, recommendation);

  keyValueTable(doc, [
    ['Pathway assessed', `Subclass ${subclass} — ${stream}`],
    ['Current professional position', pick(model.lodgementPosition, model.finalRecommendation && model.finalRecommendation.position, 'Not lodgement-ready on the present evidence position')],
    ['Overall risk', pick(model.overallRisk, model.riskLevel, model.finalRecommendation && model.finalRecommendation.overallRisk, 'Not verified')],
    ['Required next step', pick(model.nextStep, model.finalRecommendation && model.finalRecommendation.nextStep, 'Evidence review and lodgement-readiness assessment before filing')]
  ]);
}

function writeFacts(doc, assessment, model) {
  h1(doc, '2. Facts, assumptions and evidence status');
  p(doc, 'The following matters are treated as preliminary unless confirmed by original evidence. The advice separates the current file position from the issues that must be verified before a final lodgement recommendation is made.');

  const rows = [
    ['Applicant identity', pick(assessment.applicant_name, assessment.applicantName, model.applicantName, 'Not confirmed')],
    ['Current location / visa status', pick(assessment.current_location, assessment.location, assessment.currentVisaStatus, model.currentVisaStatus, 'Not confirmed')],
    ['Stream/pathway evidence', pick(model.streamEvidenceStatus, model.pathwayEvidenceStatus, 'Not verified')],
    ['Public-interest criteria', pick(model.publicInterestStatus, 'Health, character, integrity and immigration-history issues require review')],
    ['Evidence status', pick(model.evidenceStatus, model.fileStatus, 'Original evidence not yet fully reviewed')]
  ];

  keyValueTable(doc, rows);
}

function writeLegalFramework(doc, model, subclass, stream) {
  h1(doc, '3. Legal framework applied');
  const frame = pick(
    model.legalFrameworkSummary,
    model.legalFrameSummary,
    model.legalFramework && model.legalFramework.summary,
    `The assessment is controlled by the legal criteria applicable to Subclass ${subclass} — ${stream}, including validity requirements, Schedule 2 grant criteria, public-interest criteria, any applicable legislative instruments and relevant Departmental policy guidance.`
  );
  p(doc, frame);

  const legalSources = normaliseArray(pick(
    model.legalSources,
    model.legalFramework && model.legalFramework.sources,
    model.knowledgebaseSources
  ));

  if (legalSources.length) {
    h2(doc, 'Legal source control');
    for (const source of legalSources.slice(0, 12)) {
      if (isPlainObject(source)) {
        bullet(doc, pick(source.title, source.name, source.source, source.reference, source.path));
      } else {
        bullet(doc, source);
      }
    }
  }
}

function writeFindings(doc, findings) {
  h1(doc, '4. Application of law to the client’s facts');
  p(doc, 'The following findings apply the identified legal requirements to the information currently available. The status labels separate matters that appear supportable from matters that remain unclear or higher risk. A final lodgement recommendation should not be issued until the listed evidence is reconciled.');

  const maxMain = Math.min(findings.length, 12);
  for (let i = 0; i < maxMain; i++) {
    findingCard(doc, i + 1, findings[i]);
  }
}

function writeEvidence(doc, model) {
  h1(doc, '5. Evidence gaps and document request');
  const gaps = collectEvidenceGaps(model);
  if (!gaps.length) {
    p(doc, 'A formal evidence request should be prepared from the criterion-by-criterion findings before final lodgement advice is issued.');
    return;
  }
  for (const gap of gaps.slice(0, 18)) {
    if (isPlainObject(gap)) {
      bullet(doc, `${pick(gap.issue, gap.label, gap.category, 'Evidence item')}: ${pick(gap.requiredEvidence, gap.documents, gap.action, gap.description, gap.gap)}`);
    } else {
      bullet(doc, gap);
    }
  }
}

function writeRisk(doc, model, findings) {
  h1(doc, '6. Risk assessment');
  const riskSummary = pick(
    model.riskAnalysis && model.riskAnalysis.summary,
    model.riskSummary,
    'The matter should be treated as not lodgement-ready until the identified legal criteria, evidence gaps and public-interest matters have been reconciled.'
  );
  p(doc, riskSummary);

  const rows = [];
  for (const f of findings.slice(0, 16)) {
    rows.push([
      findingRisk(f),
      findingTitle(f),
      findingConsequence(f) || findingAction(f) || 'Resolve before final advice.'
    ]);
  }
  if (rows.length) table(doc, ['Risk/status', 'Issue', 'Professional consequence'], rows, [90, 180, pageWidth(doc) - 270]);
}

function writeActionPlan(doc, model) {
  h1(doc, '7. Lodgement-readiness action plan');
  const actions = collectActionPlan(model);
  const defaultActions = [
    'Confirm the selected subclass and stream/pathway against the applicable registry and legal frame.',
    'Review original evidence and Departmental records for each material criterion.',
    'Resolve all critical and high-risk evidence gaps before any positive lodgement recommendation.',
    'Prepare a final criterion-by-criterion evidence brief.',
    'Issue final migration-agent advice only after law, facts and evidence are reconciled.'
  ];
  for (const action of (actions.length ? actions : defaultActions).slice(0, 12)) {
    if (isPlainObject(action)) bullet(doc, pick(action.action, action.title, action.description, action.requiredAction));
    else bullet(doc, action);
  }
}

function writeRecommendation(doc, model, subclass, stream) {
  h1(doc, '8. Final professional recommendation');
  const rec = pick(
    model.finalRecommendation && model.finalRecommendation.fullText,
    model.finalRecommendation && model.finalRecommendation.summary,
    model.finalRecommendation,
    model.recommendation,
    `Based on the information presently available, I do not recommend immediate lodgement of the Subclass ${subclass} — ${stream} application until the identified legal requirements, evidence gaps and public-interest matters have been reviewed and reconciled.`
  );
  p(doc, rec);
  p(doc, 'This position protects the client from avoidable refusal risk, unnecessary cost and a weaker future migration record. The matter should proceed to formal evidence review and lodgement-readiness assessment before filing.');
}

function writeLimitations(doc) {
  h1(doc, '9. Important limitations');
  p(doc, 'This advice is preliminary and based on the information presently available. It is subject to review of original documents, current law and policy, Departmental records, conflict checks and final professional review before lodgement. No guarantee of visa grant is given.');
  p(doc, 'The Department may request further information, apply policy differently, identify adverse information, or reach a different view after assessing the complete application record.');
  doc.moveDown(1);
  p(doc, 'Yours faithfully,');
  p(doc, `${BRAND.agent}\nRegistered Migration Agent | MARN: ${BRAND.marn}\n${BRAND.name}`, { bold: true });
}

function writeAppendix(doc, findings) {
  doc.addPage();
  h1(doc, 'Appendix A — Criterion-by-criterion lodgement-readiness matrix');
  p(doc, 'This appendix records the issue, status, requirement, evidence gap and action for file control. It is not a guarantee that each criterion is satisfied. Dense table formatting is deliberately avoided so that criterion content remains readable and is not split across pages.');

  for (let i = 0; i < Math.min(findings.length, 18); i++) {
    const f = findings[i];
    ensureSpace(doc, 100);
    doc.font('Helvetica-Bold').fontSize(9.4).fillColor('#0b2545').text(`${i + 1}. ${findingTitle(f)}`, { width: pageWidth(doc), lineGap: 1.6 });
    doc.moveDown(0.2);
    adviceBlock(doc, 'Status', findingStatusLabel(f));
    adviceBlock(doc, 'Requirement', findingRequirement(f) || 'Requirement to be verified against legal frame.');
    adviceBlock(doc, 'Gap/action', `${findingGap(f) || 'Evidence gap to be resolved.'} ${findingAction(f) || 'Resolve before final lodgement advice.'}`);
    rule(doc);
  }
}

function addPageNumbers(bufferPromise) {
  return bufferPromise;
}

function buildAssessmentPdfBuffer(assessment = {}, adviceBundle = {}) {
  return new Promise((resolve, reject) => {
    try {
      const model = getAdviceModel(adviceBundle);
      const cleanBundle = deepClean(adviceBundle);
      const cleanAssessment = deepClean(assessment);
      const subclass = getAssessmentSubclass(cleanAssessment, cleanBundle, model);
      const stream = cleanClientText(getRawStream(cleanAssessment, cleanBundle, model));
      const findings = collectFindings(model, cleanBundle);

      assertAdviceModelReady(cleanAssessment, cleanBundle, model, subclass, stream, findings);

      const doc = createDoc(resolve, reject);

      coverPage(doc, { assessment: cleanAssessment, subclass, stream, model });
      writeExecutive(doc, model, subclass, stream);
      writeFacts(doc, cleanAssessment, model);
      writeLegalFramework(doc, model, subclass, stream);
      writeFindings(doc, findings);
      writeEvidence(doc, model);
      writeRisk(doc, model, findings);
      writeActionPlan(doc, model);
      writeRecommendation(doc, model, subclass, stream);
      writeLimitations(doc);
      writeAppendix(doc, findings);

      // Final safety check against the exact material rendered.
      assertNoForbiddenClientText({ model, cleanAssessment, subclass, stream, findings }, 'PDF');
      assertNoWrongSubclassLeak({ model, findings, stream }, subclass);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function buildAppealAdvicePdfBuffer(assessment = {}, adviceBundle = {}) {
  return new Promise((resolve, reject) => {
    try {
      const model = deepClean(pick(adviceBundle.appealAdviceModel, adviceBundle.advice, adviceBundle));
      const doc = createDoc(resolve, reject);
      const title = cleanClientText(pick(model.title, 'Visa refusal review advice'));
      const ref = pick(assessment.reference, assessment.assessment_id, assessment.id, '—');

      h1(doc, title);
      keyValueTable(doc, [
        ['Reference', ref],
        ['Applicant', pick(assessment.applicant_name, assessment.applicantName, model.applicantName, '—')],
        ['Generated', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })]
      ]);
      p(doc, pick(model.executiveAdvice, model.summary, 'This appeal assessment is prepared from the information presently available and requires review of the decision record, application file and relevant time limits.'));
      h1(doc, 'Issues for review');
      for (const item of normaliseArray(pick(model.issues, model.findings, model.reviewIssues)).slice(0, 20)) {
        if (isPlainObject(item)) bullet(doc, pick(item.issue, item.title, item.finding, item.summary));
        else bullet(doc, item);
      }
      h1(doc, 'Recommendation');
      p(doc, pick(model.recommendation, model.finalRecommendation, 'A final appeal recommendation should be issued only after the decision record, reasons, evidence and time limits are reviewed.'));
      writeLimitations(doc);
      assertNoForbiddenClientText(model, 'Appeal PDF');
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  buildAssessmentPdfBuffer,
  buildAppealAdvicePdfBuffer,
  sha256
};
