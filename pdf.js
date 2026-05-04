'use strict';

const crypto = require('crypto');
const PDFDocument = require('pdfkit');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeText(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') {
    try { return JSON.stringify(value, null, 2); } catch (_err) { return fallback; }
  }
  return String(value);
}

function cleanText(value, fallback = '—') {
  let s = safeText(value, fallback);
  if (!s || s === '—') return s;

  s = String(s)
    .replace(/\bGPT\b|\bAI\b|artificial intelligence|model output|prompt|quality flags?|delegate-simulator|decision engine|internal assessment systems?/gi, '')
    .replace(/Bircan Migration Enterprise Decision Engine assessed[^\n.]*[\n.]?/gi, '')
    .replace(/This classification is produced by[^\n.]*[\n.]?/gi, '')
    .replace(/must not be overridden by[^\n.]*[\n.]?/gi, '')
    .replace(/Unable to determine/gi, 'I am unable to confirm this requirement based on the information currently available')
    .replace(/No matching evidence found/gi, 'Supporting evidence has not yet been verified')
    .replace(/System detected/gi, 'The information provided indicates')
    .replace(/will be refused/gi, 'may be refused if the issue is not resolved')
    .replace(/will result in refusal/gi, 'may result in refusal if the issue is not resolved')
    .replace(/cannot succeed/gi, 'is unlikely to succeed unless the issue is resolved')
    .replace(/hard[- ]fail/gi, 'potentially blocking issue')
    .replace(/do not lodge/gi, 'lodgement is not recommended')
    .replace(/\s+\./g, '.')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return s || fallback;
}

function titleCaseWords(s) {
  return String(s || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function displayLodgement(value) {
  return titleCaseWords(value || 'Not Ready Information Required');
}

function ensureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(ensureArray);
  if (typeof value === 'string' && value.includes(';')) {
    return value.split(';').map(s => s.trim()).filter(Boolean);
  }
  return [value];
}

function uniqueClean(values) {
  const seen = new Set();
  const out = [];
  for (const raw of ensureArray(values)) {
    const item = cleanText(raw, '').replace(/^[-•]\s*/, '').trim();
    if (!item || item === '—') continue;
    const key = item.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function groupEvidence(items) {
  const groups = [
    ['Identity', /passport|identity|birth certificate|national id|biodata/i],
    ['Relationship', /relationship|spouse|de facto|partner|financial evidence|social evidence|household|commitment|statements/i],
    ['Sponsor / Nomination', /sponsor|nomination|skillselect|invitation|state|territory/i],
    ['Skills and Employment', /skill|assessment|assessing authority|employment|work|cv|occupation|anzsco|salary|contract|position/i],
    ['English', /english|ielts|pte|toefl|passport country/i],
    ['Financial / Study / Visitor', /funds|financial|coe|enrolment|course|visitor|genuine temporary|genuine student/i],
    ['Health and Character', /health|medical|character|police|court/i],
    ['Immigration Records', /vevo|visa grant|refusal|cancellation|waiver|department|prior visa|application records|pic 4020|integrity|documents previously submitted/i]
  ];

  const buckets = Object.fromEntries(groups.map(([name]) => [name, []]));
  buckets.Other = [];

  for (const item of uniqueClean(items)) {
    let placed = false;
    for (const [name, rx] of groups) {
      if (rx.test(item)) {
        buckets[name].push(item);
        placed = true;
        break;
      }
    }
    if (!placed) buckets.Other.push(item);
  }

  return Object.entries(buckets).filter(([, list]) => list.length);
}

function normaliseNextSteps(items, advice) {
  const raw = uniqueClean(items);
  const joined = raw.join(' ').toLowerCase();

  const steps = [];
  const add = (s) => { if (!steps.includes(s)) steps.push(s); };

  if (/missing|instruction|information|required|unable|not ready/i.test(joined) || /information required|not ready/i.test(String(advice?.lodgement_position || ''))) {
    add('Obtain complete instructions and supporting documents.');
  }

  if (/sponsor|nomination|eligible|relationship|english|age|points|skill|evidence/i.test(joined + ' ' + JSON.stringify(advice || {}))) {
    add('Clarify and verify the primary eligibility issue identified in this assessment.');
  }

  add('Review all evidence for consistency before final advice is issued.');
  add('Reassess the matter once the information and evidence position is complete.');
  add('Conduct professional legal review before any lodgement action.');

  return steps;
}

function writeHeading(doc, text) {
  if (doc.y > 690) doc.addPage();
  doc.moveDown(0.8);
  doc.fontSize(13).fillColor('#061936').font('Helvetica-Bold').text(cleanText(text));
  doc.moveDown(0.25);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#d8e2f0').stroke();
  doc.moveDown(0.45);
  doc.font('Helvetica').fillColor('#1f2937');
}

function writeParagraph(doc, text) {
  const paras = cleanText(text || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  for (const p of paras.length ? paras : ['—']) {
    if (doc.y > 735) doc.addPage();
    doc.fontSize(10.2).fillColor('#1f2937').font('Helvetica').text(p, { align: 'justify', lineGap: 3 });
    doc.moveDown(0.45);
  }
}

function writeBullet(doc, text) {
  if (doc.y > 735) doc.addPage();
  doc.fontSize(10).fillColor('#1f2937').font('Helvetica').text(`• ${cleanText(text)}`, { indent: 14, lineGap: 2 });
}

function writePair(doc, label, value) {
  if (doc.y > 735) doc.addPage();
  doc.fontSize(9).fillColor('#475467').font('Helvetica-Bold').text(label, { continued: true });
  doc.fillColor('#101828').font('Helvetica').text(` ${cleanText(value)}`);
}

function drawHeader(doc, title) {
  doc.rect(0, 0, 595.28, 84).fill('#061936');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('Bircan Migration', 50, 28);
  doc.font('Helvetica').fontSize(10).text('Preliminary migration advice letter', 50, 54);
  doc.fillColor('#061936').font('Helvetica-Bold').fontSize(17).text(cleanText(title), 50, 112, { align: 'center' });
  doc.moveDown(2.2);
}

function getAdvice(adviceBundle) {
  return adviceBundle && adviceBundle.advice ? adviceBundle.advice : (adviceBundle || {});
}

function getFinalPosition(adviceBundle, advice) {
  return adviceBundle?.finalPosition || adviceBundle?.rawDecision || advice?.finalPosition || {};
}

function isHardNegative(adviceBundle, advice) {
  const joined = [
    advice?.lodgement_position,
    advice?.risk_level,
    adviceBundle?.decisionStatus,
    adviceBundle?.legalStatus,
    adviceBundle?.finalPosition?.lodgementPosition,
    adviceBundle?.finalPosition?.primaryReason,
    JSON.stringify(advice?.criterion_findings || [])
  ].join(' ').toLowerCase();

  return /not lodgeable|invalid|refusal likely|not satisfied|pic 4020|character issue|integrity/i.test(joined);
}

function buildExecutiveSummary(assessment, adviceBundle, advice) {
  const subclass = advice.subclass || assessment.visa_type || 'the relevant';
  const risk = advice.risk_level || adviceBundle.riskLevel || 'HIGH';
  const lodgement = displayLodgement(advice.lodgement_position || adviceBundle.lodgementPosition || 'Not Ready Information Required');
  const finalPosition = getFinalPosition(adviceBundle, advice);
  const primary = finalPosition.primaryReason || adviceBundle.primaryReason || advice.primaryReason || 'the outstanding eligibility and evidence position';

  if (isHardNegative(adviceBundle, advice)) {
    return `I have considered the information provided in relation to a Subclass ${subclass} visa pathway.

Based on the current information, the matter presents a ${String(risk).toLowerCase()} level of risk. In my view, the primary issue affecting this pathway is ${cleanText(primary)}.

At this stage, this pathway should not be progressed to lodgement unless the identified issue can be clarified, resolved and supported by evidence. If the issue cannot be resolved, the application may be exposed to a significant refusal risk.

Current lodgement position: ${lodgement}.`;
  }

  return `I have considered the information provided in relation to a Subclass ${subclass} visa pathway.

Based on the current information, the matter is not yet ready for lodgement because further instructions and supporting evidence are required before a final professional view can be formed.

The pathway may still be available, however the outstanding matters must be clarified and verified before any application strategy is confirmed.

Current lodgement position: ${lodgement}.`;
}

function toAgentFinding(item) {
  const raw = cleanText(item.finding || item.status || item.evidenceStatus || '');
  const combined = `${raw} ${item.status || ''} ${item.legalEffect || ''} ${item.legal_consequence || item.legalConsequence || ''}`.toLowerCase();

  if (/not satisfied|fail|refusal likely|invalid|not lodgeable/.test(combined)) {
    return 'Based on the information provided, this requirement does not appear to be satisfied at this stage.';
  }
  if (/provisional|capable|pass|satisfied/.test(combined)) {
    return 'In my view, this requirement appears capable of being satisfied, subject to verification of supporting documentation before lodgement.';
  }
  if (/risk|pic|character|integrity/.test(combined)) {
    return 'This requirement raises a matter requiring careful legal review before any lodgement action is taken.';
  }
  return 'I am unable to confirm this requirement based on the information currently available.';
}

function blockedSection(heading) {
  const h = String(heading || '').toLowerCase();
  return /delegate|gpt|ai|system|engine|quality flag|drafting boundary|internal/.test(h);
}

function normaliseCriterionFinding(item) {
  return {
    criterion: item.criterion || item.heading || item.title || 'Criterion',
    finding: item.finding || item.status || item.evidenceStatus || '',
    legal_consequence: item.legal_consequence || item.legalConsequence || item.legalEffect || 'Further legal review is required before lodgement.',
    recommendation: item.recommendation || 'Request further instructions and supporting evidence before forming a final view.'
  };
}

function buildAssessmentPdfBuffer(assessment, adviceBundle) {
  if (!adviceBundle) {
    throw new Error('Advice-grade PDF generation requires adviceBundle.');
  }

  return new Promise((resolve, reject) => {
    const advice = getAdvice(adviceBundle);
    if (!advice) return reject(new Error('Advice-grade PDF generation requires adviceBundle.advice.'));

    const facts = adviceBundle.facts || {};
    const generatedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
    const title = advice.title || `Subclass ${advice.subclass || assessment.visa_type || ''} preliminary migration advice`;

    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `Bircan Migration - ${title}`,
        Author: 'Bircan Migration',
        Subject: `Advice letter for assessment ${assessment.id || ''}`
      }
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    drawHeader(doc, title);

    writePair(doc, 'Reference:', assessment.id);
    writePair(doc, 'Client email:', assessment.client_email);
    writePair(doc, 'Applicant:', facts.applicant?.name || assessment.applicant_name || '—');
    writePair(doc, 'Applicant email:', facts.applicant?.email || assessment.applicant_email);
    writePair(doc, 'Subclass:', advice.subclass || assessment.visa_type);
    writePair(doc, 'Risk level:', advice.risk_level || adviceBundle.riskLevel || '—');
    writePair(doc, 'Lodgement position:', displayLodgement(advice.lodgement_position || adviceBundle.lodgementPosition || '—'));
    writePair(doc, 'Generated:', generatedAt);

    writeHeading(doc, 'Current assessment position');
    const finalPosition = getFinalPosition(adviceBundle, advice);
    writeParagraph(doc, `Risk level: ${advice.risk_level || finalPosition.riskLevel || '—'}
Lodgement position: ${displayLodgement(advice.lodgement_position || finalPosition.lodgementPositionLabel || finalPosition.lodgementPosition || '—')}
Primary issue: ${finalPosition.primaryReason || adviceBundle.primaryReason || advice.primaryReason || 'Further information required'}`);

    writeHeading(doc, 'Executive summary');
    writeParagraph(doc, buildExecutiveSummary(assessment, adviceBundle, advice));

    writeHeading(doc, 'Scope of advice');
    writeParagraph(doc, `I have prepared this preliminary migration advice based on the information provided in relation to a Subclass ${advice.subclass || assessment.visa_type || ''} visa pathway. This advice is subject to verification of identity, review of original supporting documents, conflict checks, and confirmation that any required service agreement, Consumer Guide and fee disclosure requirements have been completed before further immigration assistance or lodgement action is undertaken.`);

    writeHeading(doc, 'Legal position');
    writeParagraph(doc, `This assessment has been conducted with reference to the relevant provisions of the Migration Act 1958 and the Migration Regulations 1994 as they apply to the Subclass ${advice.subclass || assessment.visa_type || ''} visa pathway.

The comments below are based on the information currently available. Final advice requires verification of original documents, consideration of any further information provided, and confirmation of the law, instruments, policy and Department requirements applicable at the relevant time.`);

    writeHeading(doc, 'Risk assessment');
    if (isHardNegative(adviceBundle, advice)) {
      writeParagraph(doc, `Based on the current information, the matter presents a ${String(advice.risk_level || 'high').toLowerCase()} level of risk. This is not merely an administrative evidence issue. It may affect whether the pathway is legally available or whether the application could satisfy the relevant criteria. For that reason, I recommend that the matter not proceed until the identified issue has been resolved or an alternative pathway has been considered.`);
    } else {
      writeParagraph(doc, `Based on the current information, the matter presents a ${String(advice.risk_level || 'high').toLowerCase()} level of risk because further instructions and supporting documents are required before a final view can be formed. The immediate priority is to clarify the outstanding matters and verify the evidence position.`);
    }

    writeHeading(doc, 'Strategy and next steps');
    writeParagraph(doc, `The appropriate course is to obtain the missing instructions and supporting evidence before any lodgement strategy is confirmed.

Once the outstanding matters are clarified, the matter should be reassessed to determine whether it can safely progress to application stage.`);

    const sections = Array.isArray(advice.sections) ? advice.sections : [];
    for (const section of sections) {
      const heading = section.heading || section.title || '';
      if (!heading || blockedSection(heading)) continue;
      if (/scope|legal position|risk assessment|strategy|executive summary|current assessment/i.test(heading)) continue;
      writeHeading(doc, heading);
      writeParagraph(doc, section.body || section.text || section.content || '');
    }

    const comparison = adviceBundle.pathwayComparison;
    if (comparison && comparison.pdfSection) {
      writeHeading(doc, comparison.pdfSection.heading || 'Alternative pathway assessment');
      writeParagraph(doc, comparison.pdfSection.body || comparison.narrative || '');
      for (const b of uniqueClean(comparison.pdfSection.bullets || [])) writeBullet(doc, b);
    }

    const findings = (advice.criterion_findings || adviceBundle.criterionFindings || adviceBundle.findings || []).map(normaliseCriterionFinding);
    if (findings.length) {
      writeHeading(doc, 'Criterion-by-criterion findings');
      for (const item of findings) {
        if (doc.y > 690) doc.addPage();
        doc.fontSize(10.5).fillColor('#061936').font('Helvetica-Bold').text(cleanText(item.criterion || 'Criterion'));
        writeParagraph(doc, `${toAgentFinding(item)}

Legal consequence:
${cleanText(item.legal_consequence)}

Recommendation:
${cleanText(item.recommendation)}`);
      }
    }

    writeHeading(doc, 'Evidence required before final advice or lodgement');
    const evidenceItems = uniqueClean(advice.evidence_required || adviceBundle.evidenceRequired || []);
    const grouped = groupEvidence(evidenceItems);
    if (grouped.length) {
      for (const [group, items] of grouped) {
        if (doc.y > 715) doc.addPage();
        doc.fontSize(10.4).fillColor('#061936').font('Helvetica-Bold').text(group);
        doc.moveDown(0.15);
        items.forEach(item => writeBullet(doc, item));
        doc.moveDown(0.25);
      }
    } else {
      writeParagraph(doc, 'Further supporting evidence is required before final advice or lodgement action.');
    }

    writeHeading(doc, 'Recommended next steps');
    normaliseNextSteps(advice.client_next_steps || adviceBundle.recommendedNextSteps || adviceBundle.nextSteps || [], advice).forEach(step => writeBullet(doc, step));

    writeHeading(doc, 'Conclusion');
    if (isHardNegative(adviceBundle, advice)) {
      writeParagraph(doc, 'On balance, this pathway should not be progressed until the identified issue has been clarified and resolved. If the issue cannot be resolved, the client should consider alternative migration options before any further application action is taken.');
    } else {
      writeParagraph(doc, 'On balance, the matter requires further information before a final professional view can be formed. The pathway should be reassessed once the outstanding instructions and supporting documents have been provided.');
    }

    writeHeading(doc, 'Important notice');
    writeParagraph(doc, advice.disclaimer || 'This preliminary advice is based only on questionnaire answers and available evidence metadata. Final advice requires review of original documents and confirmation of current law, instruments, policy and Department requirements at the relevant time.');

    doc.moveDown(0.6);
    doc.fontSize(10).fillColor('#101828').font('Helvetica').text('Yours faithfully,');
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').text('Kenan Bircan JP');
    doc.font('Helvetica').text('Registered Migration Agent | MARN: 1463685');
    doc.text('Bircan Migration & Education');
    doc.moveDown(0.8);
    doc.fontSize(8).fillColor('#667085').text('This document is preliminary migration advice and is subject to professional review, verification of original documents and confirmation of current law and policy.', { align: 'center' });

    doc.end();
  });
}


function buildAppealAdvicePdfBuffer(assessment, adviceBundle) {
  if (!adviceBundle) throw new Error('Appeals advice PDF generation requires adviceBundle.');
  return new Promise((resolve, reject) => {
    const advice = adviceBundle.advice || adviceBundle || {};
    const generatedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
    const title = advice.title || `Visa refusal review advice — Subclass ${assessment.visa_subclass || ''}`;
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `Bircan Migration - ${title}`,
        Author: 'Bircan Migration & Education',
        Subject: `Appeals advice letter for ${assessment.id || ''}`
      }
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    drawHeader(doc, title);
    writePair(doc, 'Reference:', assessment.id);
    writePair(doc, 'Client email:', assessment.client_email);
    writePair(doc, 'Applicant:', assessment.applicant_name || '—');
    writePair(doc, 'Applicant email:', assessment.applicant_email || assessment.client_email);
    writePair(doc, 'Visa subclass:', assessment.visa_subclass || '—');
    writePair(doc, 'Decision type:', assessment.decision_type || '—');
    writePair(doc, 'Decision date:', assessment.decision_date || '—');
    writePair(doc, 'Review deadline:', assessment.tribunal_deadline || '—');
    writePair(doc, 'Risk level:', advice.risk_level || 'High');
    writePair(doc, 'Generated:', generatedAt);

    writeHeading(doc, 'Executive advice');
    writeParagraph(doc, advice.executive_summary || 'I have reviewed the information and uploaded decision material provided for this refusal review assessment. The matter requires careful review of the refusal grounds, evidence position, review deadline and prospects before any review strategy is confirmed.');

    writeHeading(doc, 'Refusal reasons extracted from the decision');
    const refusalReasons = uniqueClean(advice.refusal_reasons || advice.refusalReasons || advice.refusal_grounds || advice.refusalGrounds || []);
    if (refusalReasons.length) refusalReasons.forEach(g => writeBullet(doc, g));
    else writeParagraph(doc, 'The uploaded decision material should be reviewed against the Department’s stated reasons for refusal. The currently extracted material did not clearly isolate each refusal reason.');

    writeHeading(doc, 'Legal issues for review');
    const legalIssues = uniqueClean(advice.legal_issues || advice.legalIssues || []);
    if (legalIssues.length) legalIssues.forEach(issue => writeBullet(doc, issue));
    else writeParagraph(doc, 'The legal issues must be mapped from the decision letter by identifying the criteria considered, the Department’s adverse findings, and the review questions that must now be answered.');

    writeHeading(doc, 'Evidence gaps and document weaknesses');
    const evidenceGaps = uniqueClean(advice.evidence_gaps || advice.evidenceGaps || advice.evidence_position || advice.evidencePosition || []);
    if (evidenceGaps.length) evidenceGaps.forEach(e => writeBullet(doc, e));
    else writeParagraph(doc, 'Further evidence review is required. Any new evidence should directly respond to the refusal reasons, address inconsistencies, and be organised by issue.');

    writeHeading(doc, 'Appeal and review strategy');
    const strategyItems = uniqueClean(advice.appeal_strategy || advice.appealStrategy || []);
    if (strategyItems.length) strategyItems.forEach(item => writeBullet(doc, item));
    else writeParagraph(doc, advice.strategy || 'The review strategy should focus on answering each refusal reason directly, identifying any error or weakness in the Department’s reasoning, and preparing further evidence that was missing, unclear or insufficient at the time of decision.');

    if (advice.strategy && strategyItems.length) {
      writeHeading(doc, 'Overall strategy position');
      writeParagraph(doc, advice.strategy);
    }

    writeHeading(doc, 'Prospects and risk assessment');
    writeParagraph(doc, advice.risk_assessment || 'The prospects of success depend on whether the refusal grounds can be answered with credible, consistent and relevant evidence. The matter should not be treated as ready until the evidence position has been checked against each refusal reason.');

    writeHeading(doc, 'Recommended next steps');
    const steps = uniqueClean(advice.next_steps || advice.nextSteps || [
      'Confirm the review deadline and lodge any review application within time.',
      'Prepare an indexed evidence schedule responding to each refusal ground.',
      'Obtain further documents or statements addressing the Department’s concerns.',
      'Arrange professional review before lodging submissions or further evidence.'
    ]);
    steps.forEach(step => writeBullet(doc, step));

    if (advice.deadline_warning) {
      writeHeading(doc, 'Deadline warning');
      writeParagraph(doc, advice.deadline_warning);
    }

    writeHeading(doc, 'Important notice');
    writeParagraph(doc, advice.disclaimer || 'This advice is based on the documents and information uploaded through the Bircan Migration & Education online assessment system. It is preliminary advice only and must be verified against the complete Department record, current law, policy, review jurisdiction and original evidence before any final legal strategy is adopted.');

    doc.moveDown(0.6);
    doc.fontSize(10).fillColor('#101828').font('Helvetica').text('Yours faithfully,');
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').text('Kenan Bircan JP');
    doc.font('Helvetica').text('Registered Migration Agent | MARN: 1463685');
    doc.text('Bircan Migration & Education');
    doc.moveDown(0.8);
    doc.fontSize(8).fillColor('#667085').text('www.bircanmigration.com.au', { align: 'center' });
    doc.end();
  });
}

module.exports = {
  buildAssessmentPdfBuffer,
  buildAppealAdvicePdfBuffer,
  sha256
};
