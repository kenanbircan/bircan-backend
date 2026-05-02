'use strict';

/**
 * pdf.js
 * Bircan Migration — Delegate-grade client advice PDF generator
 *
 * Drop-in replacement for existing pdf.js.
 * Requires: pdfkit
 * Exports used by server.js:
 *   - buildAssessmentPdfBuffer(assessment, adviceBundle)
 *   - sha256(buffer)
 *
 * Design rules:
 * - Client-facing PDF must read as senior registered migration-agent advice.
 * - No GPT / AI / engine / simulator / internal-system language is exposed.
 * - Hard-fail matters remain firm and are not positively reframed.
 * - Provisional matters are framed as capable of being satisfied, subject to verification.
 * - Evidence is deduplicated and presented cleanly.
 */

const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const PAGE = {
  width: 595.28,
  height: 841.89,
  margin: 50,
  bottom: 755,
  headerHeight: 86,
};

const COLOUR = {
  navy: '#061936',
  navy2: '#0b274d',
  text: '#1f2937',
  muted: '#667085',
  line: '#d8e2f0',
  soft: '#f3f7fb',
  warning: '#8a4b08',
  danger: '#8b1e1e',
  green: '#14532d',
};

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function text(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function normaliseSpaces(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleCaseFromCode(value) {
  return text(value, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function safeClientText(value, fallback = '—') {
  let s = text(value, fallback);
  if (!s || s === '—') return s;

  // Remove or translate internal/system language. Do not leave traces of automation.
  s = s
    .replace(/Bircan Migration Enterprise Decision Engine assessed/gi, 'I have assessed')
    .replace(/Enterprise Decision Engine/gi, 'professional assessment')
    .replace(/Decision Engine/gi, 'professional assessment')
    .replace(/Delegate[- ]simulator outcome/gi, 'Professional assessment outcome')
    .replace(/delegate[- ]simulator/gi, 'professional assessment')
    .replace(/GPT drafting boundary/gi, 'Professional drafting safeguard')
    .replace(/\bGPT\b|\bAI\b|artificial intelligence|model output|prompt|quality flags?/gi, 'professional review')
    .replace(/internal assessment systems?/gi, 'Bircan Migration')
    .replace(/system detected/gi, 'the information indicates')
    .replace(/Unable to determine because the questionnaire answer and evidence position are insufficient\.?/gi, 'I am unable to confirm this requirement based on the information currently available.')
    .replace(/Unable to determine because required evidence has not been verified\.?/gi, 'I am unable to confirm this requirement until supporting evidence is verified.')
    .replace(/Not satisfied on the current information or evidence\.?/gi, 'Based on the information provided, this requirement does not appear to be satisfied.')
    .replace(/Provisionally satisfied on the declared information, subject to documentary verification before lodgement\.?/gi, 'This requirement appears capable of being satisfied, subject to documentary verification before lodgement.')
    .replace(/will be refused/gi, 'may result in refusal if not addressed')
    .replace(/will result in refusal/gi, 'may result in refusal if not addressed')
    .replace(/cannot succeed/gi, 'is unlikely to succeed unless the issue is resolved')
    .replace(/hard[- ]fail/gi, 'potentially blocking issue')
    .replace(/do not lodge/gi, 'lodgement is not recommended')
    .replace(/known issue\.?/gi, 'a matter requiring further review')
    .replace(/weak\/generic professional review wording detected[^\n.]*[\n.]?/gi, '')
    .replace(/weak\/generic gpt wording detected[^\n.]*[\n.]?/gi, '')
    .replace(/matrix coverage warning[^\n.]*[\n.]?/gi, '')
    .replace(/criterion reasoning warning[^\n.]*[\n.]?/gi, '');

  return normaliseSpaces(s) || fallback;
}

function splitParagraphs(value) {
  const cleaned = safeClientText(value, '');
  return cleaned.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
}

function uniq(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items || []) {
    const s = safeClientText(raw, '').replace(/^[-•]\s*/, '').trim();
    if (!s) continue;
    const key = s.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function getAdvice(adviceBundle) {
  if (!adviceBundle || !isPlainObject(adviceBundle)) return null;
  if (adviceBundle.advice && isPlainObject(adviceBundle.advice)) return adviceBundle.advice;
  return null;
}

function getDecision(adviceBundle) {
  return adviceBundle?.rawDecision || adviceBundle?.decision || adviceBundle?.advice?.rawDecision || adviceBundle || {};
}

function getFindings(advice, adviceBundle) {
  if (Array.isArray(advice?.criterion_findings)) return advice.criterion_findings;
  if (Array.isArray(adviceBundle?.criterionFindings)) return adviceBundle.criterionFindings;
  if (Array.isArray(adviceBundle?.rawDecision?.findings)) return adviceBundle.rawDecision.findings;
  return [];
}

function statusOf(item) {
  return text(item.status || item.legalSatisfaction || item.legal_satisfaction || item.finding, '').toUpperCase();
}

function isFailFinding(item) {
  const s = statusOf(item);
  const f = text(item.finding, '').toLowerCase();
  return s.includes('FAIL') || s.includes('NOT SATISFIED') || f.includes('does not appear to be satisfied') || f.includes('not satisfied');
}

function isRiskFinding(item) {
  const s = statusOf(item);
  const f = text(item.finding, '').toLowerCase();
  return s.includes('RISK') || f.includes('adverse issue');
}

function isProvisionalFinding(item) {
  const s = statusOf(item);
  const f = text(item.finding, '').toLowerCase();
  return s.includes('PROVISION') || f.includes('provisionally') || f.includes('capable of being satisfied');
}

function isUnknownFinding(item) {
  const s = statusOf(item);
  const f = text(item.finding, '').toLowerCase();
  return s.includes('UNKNOWN') || f.includes('unable to determine') || f.includes('unable to confirm');
}

function isHardStop(decision, findings) {
  const status = text(decision.decisionStatus || decision.decision_status || '', '').toUpperCase();
  const legal = text(decision.legalStatus || decision.legal_status || '', '').toUpperCase();
  const lodge = text(decision.lodgementPosition || decision.lodgement_position || '', '').toUpperCase().replace(/\s+/g, '_');
  const reason = text(decision.primaryReason || decision.primary_reason || '', '').toLowerCase();

  if (lodge.includes('NOT_LODGEABLE')) return true;
  if (status.includes('INVALID')) return true;
  if (legal.includes('INVALID')) return true;
  if (reason.includes('pic 4020') || reason.includes('character') || reason.includes('age requirement')) return true;
  return (findings || []).some(f => isFailFinding(f) && /age|character|pic 4020|integrity|s48|section 48|no further stay/i.test(text(f.criterion || f.title || '')));
}

function riskColour(risk) {
  const r = text(risk, '').toUpperCase();
  if (r.includes('CRITICAL') || r.includes('HIGH')) return COLOUR.danger;
  if (r.includes('MEDIUM')) return COLOUR.warning;
  if (r.includes('LOW')) return COLOUR.green;
  return COLOUR.navy;
}

function ensureRoom(doc, needed = 60) {
  if (doc.y + needed > PAGE.bottom) doc.addPage();
}

function drawHeader(doc, title) {
  doc.rect(0, 0, PAGE.width, PAGE.headerHeight).fill(COLOUR.navy);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('Bircan Migration', PAGE.margin, 27);
  doc.font('Helvetica').fontSize(10).text('Preliminary migration advice letter', PAGE.margin, 54);
  doc.fillColor(COLOUR.navy).font('Helvetica-Bold').fontSize(17).text(safeClientText(title), PAGE.margin, 112, {
    width: PAGE.width - (PAGE.margin * 2),
    align: 'center',
  });
  doc.moveDown(2.1);
}

function heading(doc, value) {
  ensureRoom(doc, 70);
  doc.moveDown(0.8);
  doc.fontSize(13).fillColor(COLOUR.navy).font('Helvetica-Bold').text(safeClientText(value));
  doc.moveDown(0.25);
  doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.width - PAGE.margin, doc.y).strokeColor(COLOUR.line).stroke();
  doc.moveDown(0.45);
  doc.fillColor(COLOUR.text).font('Helvetica');
}

function subheading(doc, value) {
  ensureRoom(doc, 45);
  doc.fontSize(10.6).fillColor(COLOUR.navy).font('Helvetica-Bold').text(safeClientText(value));
  doc.moveDown(0.25);
  doc.fillColor(COLOUR.text).font('Helvetica');
}

function paragraph(doc, value, options = {}) {
  const paras = splitParagraphs(value);
  const list = paras.length ? paras : ['—'];
  for (const p of list) {
    ensureRoom(doc, 40);
    doc.fontSize(options.size || 10.2)
      .fillColor(options.color || COLOUR.text)
      .font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(p, { align: options.align || 'justify', lineGap: options.lineGap || 3 });
    doc.moveDown(options.after ?? 0.45);
  }
}

function bullet(doc, value) {
  const s = safeClientText(value, '');
  if (!s) return;
  ensureRoom(doc, 24);
  doc.fontSize(10).fillColor(COLOUR.text).font('Helvetica').text(`• ${s}`, {
    indent: 14,
    lineGap: 2,
  });
}

function pair(doc, label, value) {
  ensureRoom(doc, 18);
  doc.fontSize(9).fillColor('#475467').font('Helvetica-Bold').text(label, { continued: true });
  doc.fillColor('#101828').font('Helvetica').text(` ${safeClientText(value)}`);
}

function outcomeBox(doc, advice, decision) {
  const risk = advice.risk_level || decision.riskLevel || decision.risk_level || '—';
  const lodge = titleCaseFromCode(advice.lodgement_position || decision.lodgementPosition || decision.lodgement_position || '—');
  const primary = decision.primaryReason || decision.primary_reason || advice.primary_reason || 'Evidence and legal position require review';

  ensureRoom(doc, 95);
  const y = doc.y;
  doc.roundedRect(PAGE.margin, y, PAGE.width - PAGE.margin * 2, 82, 8).fillAndStroke(COLOUR.soft, COLOUR.line);
  doc.fillColor(COLOUR.navy).font('Helvetica-Bold').fontSize(10).text('Current assessment position', PAGE.margin + 14, y + 12);
  doc.fillColor(riskColour(risk)).font('Helvetica-Bold').fontSize(10).text(`Risk level: ${safeClientText(risk)}`, PAGE.margin + 14, y + 31);
  doc.fillColor(COLOUR.text).font('Helvetica').fontSize(9.5).text(`Lodgement position: ${safeClientText(lodge)}`, PAGE.margin + 14, y + 47, { width: 470 });
  doc.fillColor(COLOUR.text).font('Helvetica').fontSize(9.5).text(`Primary issue: ${safeClientText(primary)}`, PAGE.margin + 14, y + 62, { width: 470 });
  doc.y = y + 91;
}

function professionalScopeText(advice, decision, assessment) {
  const subclass = advice.subclass || decision.subclass || assessment.visa_type || 'the relevant';
  return `I have prepared this preliminary migration advice based on the information provided in relation to a Subclass ${subclass} visa pathway. This advice is subject to verification of identity, review of original supporting documents, conflict checks, and confirmation that any required service agreement, Consumer Guide and fee disclosure requirements have been completed before further immigration assistance or lodgement action is undertaken.`;
}

function buildExecutiveSummary(advice, decision, findings, assessment) {
  const subclass = advice.subclass || decision.subclass || assessment.visa_type || 'the relevant';
  const risk = text(advice.risk_level || decision.riskLevel || decision.risk_level || 'the identified', 'the identified').toLowerCase();
  const lodgeRaw = advice.lodgement_position || decision.lodgementPosition || decision.lodgement_position || '';
  const lodge = titleCaseFromCode(lodgeRaw || 'requires further review');
  const primary = safeClientText(decision.primaryReason || decision.primary_reason || advice.primary_reason || 'the evidence and eligibility position');
  const hardStop = isHardStop(decision, findings);
  const hasFail = findings.some(isFailFinding);
  const hasUnknown = findings.some(isUnknownFinding);
  const hasProv = findings.some(isProvisionalFinding);

  if (hardStop || hasFail) {
    return `I have considered the information provided in relation to a Subclass ${subclass} visa pathway.

Based on the current information, the matter presents a ${risk} level of risk. In my view, the primary issue affecting this pathway is ${primary}.

At this stage, this pathway should not be progressed to lodgement unless the identified issue can be clarified, resolved and supported by evidence. If the issue cannot be resolved, the application may be exposed to a significant refusal risk.

Current lodgement position: ${lodge}.`;
  }

  if (hasUnknown) {
    return `I have considered the information provided in relation to a Subclass ${subclass} visa pathway.

Based on the current information, the matter is not yet ready for lodgement because further instructions and supporting evidence are required before a final professional view can be formed.

The pathway may still be available, however the outstanding matters must be clarified and verified before any application strategy is confirmed.

Current lodgement position: ${lodge}.`;
  }

  if (hasProv) {
    return `I have considered the information provided in relation to a Subclass ${subclass} visa pathway.

Based on your instructions, the pathway appears capable of being progressed, subject to verification of supporting documentation and final professional review.

In my view, the risks currently identified are primarily evidence and preparation issues rather than a concluded absence of eligibility. Those risks should be addressed before any application is lodged.

Current lodgement position: ${lodge}.`;
  }

  return `I have considered the information provided in relation to a Subclass ${subclass} visa pathway.

Based on the current information, the pathway appears suitable for further progression, subject to verification of original documents and review of the law and policy in force at the time of application.

Current lodgement position: ${lodge}.`;
}

function legalPositionText(advice, decision, assessment) {
  const subclass = advice.subclass || decision.subclass || assessment.visa_type || 'the relevant';
  return `This assessment has been conducted with reference to the relevant provisions of the Migration Act 1958 and the Migration Regulations 1994 as they apply to the Subclass ${subclass} visa pathway.

The comments below are based on the information currently available. Final advice requires verification of original documents, consideration of any further information provided, and confirmation of the law, instruments, policy and Department requirements applicable at the relevant time.`;
}

function toAgentFinding(item) {
  if (isFailFinding(item)) {
    return 'Based on the information provided, this requirement does not appear to be satisfied at this stage.';
  }
  if (isRiskFinding(item)) {
    return 'An adverse issue has been identified and this matter requires detailed legal assessment before any further step is taken.';
  }
  if (isProvisionalFinding(item)) {
    return 'In my view, this requirement appears capable of being satisfied, subject to verification of supporting documentation before lodgement.';
  }
  if (isUnknownFinding(item)) {
    return 'I am unable to confirm this requirement based on the information currently available.';
  }
  const raw = item.finding || item.status || '';
  return safeClientText(raw, 'This requirement requires further review before a final view can be formed.');
}

function toAgentConsequence(item) {
  const c = safeClientText(item.legal_consequence || item.legalConsequence || item.legalEffect || 'This requirement must be addressed before a final application strategy is confirmed.');
  return c;
}

function toAgentRecommendation(item) {
  if (isFailFinding(item)) {
    return 'This issue should be clarified and resolved before this pathway is progressed. If it cannot be resolved, an alternative migration strategy should be considered.';
  }
  if (isRiskFinding(item)) {
    return 'Obtain all relevant documents and conduct a detailed legal review before proceeding.';
  }
  if (isProvisionalFinding(item)) {
    return 'Obtain and verify the supporting documents before lodgement. This should not be treated as final advice until the evidence has been reviewed.';
  }
  if (isUnknownFinding(item)) {
    return 'Request further instructions and supporting evidence before forming a final view.';
  }
  return safeClientText(item.recommendation || 'Retain supporting evidence and confirm this requirement before lodgement.');
}

function buildRiskPerspective(decision, findings) {
  const risk = text(decision.riskLevel || decision.risk_level || 'medium', 'medium').toLowerCase();
  const primary = safeClientText(decision.primaryReason || decision.primary_reason || 'the outstanding eligibility and evidence position');
  if (isHardStop(decision, findings) || findings.some(isFailFinding)) {
    return `Based on the current information, the matter presents a ${risk} level of risk. The principal concern is ${primary}.

This is not merely an administrative evidence issue. It may affect whether the pathway is legally available or whether the application could satisfy the relevant criteria. For that reason, I recommend that the matter not proceed until this issue has been resolved or an alternative pathway has been considered.`;
  }
  if (findings.some(isUnknownFinding)) {
    return `Based on the current information, the matter presents a ${risk} level of risk because further instructions and supporting documents are required before a final view can be formed.

The immediate priority is to clarify the outstanding matters and verify the evidence position. Once this has occurred, the pathway can be reassessed more confidently.`;
  }
  return `Based on the current information, the matter presents a ${risk} level of risk. The identified risks appear to relate primarily to evidence verification and careful preparation rather than a concluded absence of eligibility.

Those risks can usually be managed by obtaining the required documents, checking consistency across the evidence, and conducting a final pre-lodgement review.`;
}

function buildStrategyText(decision, findings) {
  if (isHardStop(decision, findings) || findings.some(isFailFinding)) {
    return `In my view, the appropriate course is to pause this pathway until the identified adverse issue is clarified.

The next step should be to obtain the relevant evidence and confirm whether the issue can be resolved. If it cannot be resolved, the client should be advised on alternative migration options rather than proceeding with an application that carries a significant refusal risk.`;
  }
  if (findings.some(isUnknownFinding)) {
    return `The appropriate course is to obtain the missing instructions and supporting evidence before any lodgement strategy is confirmed.

Once the outstanding matters are clarified, the matter should be reassessed to determine whether it can safely progress to application stage.`;
  }
  return `The appropriate course is to continue preparing the matter in a structured way.

The client should first obtain and verify the outstanding documents. The evidence should then be reviewed for consistency against the visa criteria before any application is lodged. Once those steps are completed, the matter may be suitable for progression to application stage, subject to final professional review.`;
}

function collectEvidence(advice, findings) {
  const direct = advice.evidence_required || advice.evidenceRequired || [];
  const fromFindings = [];
  for (const f of findings || []) {
    if (Array.isArray(f.evidenceMissing)) fromFindings.push(...f.evidenceMissing);
    if (f.evidence_gap || f.evidenceGap) {
      String(f.evidence_gap || f.evidenceGap)
        .split(/;|\n|,/)
        .map(s => s.trim())
        .filter(Boolean)
        .forEach(s => fromFindings.push(s));
    }
  }
  return uniq([...direct, ...fromFindings]);
}

function collectNextSteps(advice, decision, findings) {
  const supplied = advice.client_next_steps || advice.nextSteps || advice.recommendedNextSteps || [];
  const base = [];

  if (isHardStop(decision, findings) || findings.some(isFailFinding)) {
    base.push('Clarify the adverse issue before progressing this pathway.');
    base.push('Consider alternative visa pathways if the issue cannot be resolved.');
    base.push('Do not lodge an application until a final professional review has been completed.');
  } else if (findings.some(isUnknownFinding)) {
    base.push('Obtain the missing client instructions and supporting documents.');
    base.push('Review the evidence for consistency before final advice is issued.');
    base.push('Reassess the matter once the evidence position changes.');
  } else {
    base.push('Collect and verify all supporting documents.');
    base.push('Review the evidence against each relevant visa criterion.');
    base.push('Conduct a final pre-lodgement review before any application is submitted.');
  }

  return uniq([...base, ...supplied]).slice(0, 10);
}

function shouldPrintSection(section) {
  const headingText = text(section?.heading || section?.title || '', '').toLowerCase();
  const bodyText = text(section?.body || section?.text || '', '').toLowerCase();
  const combined = `${headingText} ${bodyText}`;
  const blocked = [
    'delegate-simulator',
    'delegate simulator',
    'gpt drafting boundary',
    'gpt',
    'ai ',
    'model output',
    'prompt',
    'engine assessed',
    'enterprise decision engine',
    'internal assessment may only',
    'prepared by bircan migration internal assessment systems',
  ];
  return !blocked.some(x => combined.includes(x));
}

function writeExistingSafeSections(doc, advice) {
  const sections = Array.isArray(advice.sections) ? advice.sections : [];
  for (const section of sections) {
    if (!shouldPrintSection(section)) continue;
    const h = section.heading || section.title;
    const b = section.body || section.text || section.content;
    if (!h || !b) continue;
    // Avoid duplicating sections we rebuild ourselves.
    if (/executive summary|legal position|scope|evidence and document verification/i.test(h)) continue;
    heading(doc, h);
    paragraph(doc, b);
  }
}

function writeCriterionFindings(doc, findings) {
  heading(doc, 'Criterion-by-criterion findings');
  if (!findings.length) {
    paragraph(doc, 'No criterion findings were available in the assessment bundle. Further professional review is required.');
    return;
  }

  for (const item of findings) {
    ensureRoom(doc, 105);
    const criterion = item.criterion || item.title || item.heading || 'Criterion';
    subheading(doc, criterion);
    paragraph(doc, toAgentFinding(item));

    doc.fontSize(9.8).fillColor(COLOUR.navy).font('Helvetica-Bold').text('Legal consequence:', { continued: false });
    paragraph(doc, toAgentConsequence(item), { size: 9.8, after: 0.3 });

    doc.fontSize(9.8).fillColor(COLOUR.navy).font('Helvetica-Bold').text('Recommendation:', { continued: false });
    paragraph(doc, toAgentRecommendation(item), { size: 9.8, after: 0.65 });
  }
}

function writeEvidence(doc, evidence) {
  heading(doc, 'Evidence required before final advice or lodgement');
  if (!evidence.length) {
    paragraph(doc, 'No specific additional documents have been identified from the current information. Original documents should still be reviewed before final advice or lodgement.');
    return;
  }
  for (const item of evidence) bullet(doc, item);
}

function writeNextSteps(doc, steps) {
  heading(doc, 'Recommended next steps');
  for (const item of steps.length ? steps : ['Conduct professional review before lodgement.']) bullet(doc, item);
}

function writeClosing(doc, advice, decision, findings) {
  heading(doc, 'Conclusion');
  if (isHardStop(decision, findings) || findings.some(isFailFinding)) {
    paragraph(doc, 'On balance, this pathway should not be progressed until the identified issue has been clarified and resolved. If the issue cannot be resolved, the client should consider alternative migration options before any further application action is taken.');
  } else if (findings.some(isUnknownFinding)) {
    paragraph(doc, 'On balance, the matter requires further information before a final professional view can be formed. The pathway should be reassessed once the outstanding instructions and supporting documents have been provided.');
  } else {
    paragraph(doc, 'On balance, the pathway appears capable of being progressed, subject to verification of supporting documents and final professional review before lodgement.');
  }

  heading(doc, 'Important notice');
  paragraph(doc, advice.disclaimer || 'This advice is preliminary and based solely on the information provided. Final migration advice requires review of original documentation and consideration of the law and policy in force at the time of application. No application should be lodged without professional review.');
}

function writeSignature(doc) {
  doc.moveDown(0.6);
  ensureRoom(doc, 90);
  doc.fontSize(10).fillColor('#101828').font('Helvetica').text('Yours faithfully,');
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').text('Kenan Bircan JP');
  doc.font('Helvetica').text('Registered Migration Agent | MARN: 1463685');
  doc.text('Bircan Migration & Education');
  doc.moveDown(0.8);
  doc.fontSize(8).fillColor(COLOUR.muted).text('This document is preliminary migration advice and is subject to professional review, verification of original documents and confirmation of current law and policy.', { align: 'center' });
}

function buildAssessmentPdfBuffer(assessment, adviceBundle) {
  const advice = getAdvice(adviceBundle);
  if (!advice) {
    throw new Error('Advice-grade PDF generation requires a structured adviceBundle.advice object. Weak template PDF generation is disabled.');
  }

  return new Promise((resolve, reject) => {
    const decision = getDecision(adviceBundle);
    const facts = adviceBundle.facts || {};
    const findings = getFindings(advice, adviceBundle);
    const generatedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
    const title = advice.title || `Subclass ${advice.subclass || assessment.visa_type || ''} Preliminary Migration Advice`;

    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE.margin,
      info: {
        Title: `Bircan Migration - ${title}`,
        Author: 'Bircan Migration',
        Subject: `Preliminary migration advice for assessment ${assessment.id || ''}`,
      },
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    drawHeader(doc, title);

    pair(doc, 'Reference:', assessment.id);
    pair(doc, 'Client email:', assessment.client_email);
    pair(doc, 'Applicant:', facts.applicant?.name || assessment.applicant_name);
    pair(doc, 'Applicant email:', facts.applicant?.email || assessment.applicant_email);
    pair(doc, 'Subclass:', advice.subclass || assessment.visa_type);
    pair(doc, 'Risk level:', advice.risk_level || decision.riskLevel || decision.risk_level);
    pair(doc, 'Lodgement position:', titleCaseFromCode(advice.lodgement_position || decision.lodgementPosition || decision.lodgement_position));
    pair(doc, 'Generated:', generatedAt);

    doc.moveDown(0.8);
    outcomeBox(doc, advice, decision);

    heading(doc, 'Executive summary');
    paragraph(doc, buildExecutiveSummary(advice, decision, findings, assessment));

    heading(doc, 'Scope of advice');
    paragraph(doc, professionalScopeText(advice, decision, assessment));

    heading(doc, 'Legal position');
    paragraph(doc, legalPositionText(advice, decision, assessment));

    heading(doc, 'Risk assessment');
    paragraph(doc, buildRiskPerspective(decision, findings));

    heading(doc, 'Strategy and next steps');
    paragraph(doc, buildStrategyText(decision, findings));

    // Print only safe custom sections, never internal simulator/GPT/system sections.
    writeExistingSafeSections(doc, advice);

    writeCriterionFindings(doc, findings);
    writeEvidence(doc, collectEvidence(advice, findings));
    writeNextSteps(doc, collectNextSteps(advice, decision, findings));
    writeClosing(doc, advice, decision, findings);
    writeSignature(doc);

    doc.end();
  });
}

module.exports = { buildAssessmentPdfBuffer, sha256 };
