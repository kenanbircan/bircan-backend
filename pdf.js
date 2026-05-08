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
  if (doc.y > 690 && !doc._ending) doc.addPage();
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
    if (doc.y > 735 && !doc._ending) doc.addPage();
    doc.fontSize(10.2).fillColor('#1f2937').font('Helvetica').text(p, { align: 'justify', lineGap: 3 });
    doc.moveDown(0.45);
  }
}

function writeBullet(doc, text) {
  if (doc.y > 735 && !doc._ending) doc.addPage();
  doc.fontSize(10).fillColor('#1f2937').font('Helvetica').text(`• ${cleanText(text)}`, { indent: 14, lineGap: 2 });
}

function writePair(doc, label, value) {
  if (doc.y > 735 && !doc._ending) doc.addPage();
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


const BRAND = {
  navy: '#061936',
  navy2: '#0b2f66',
  blue: '#1f5eff',
  gold: '#d6a845',
  goldDark: '#b98418',
  ink: '#101828',
  text: '#1f2937',
  muted: '#667085',
  line: '#d8e2f0',
  soft: '#f4f7fb',
  paleBlue: '#eef5ff',
  good: '#13795b',
  warn: '#9a6700'
};

function premiumPhrase(value, fallback = 'Further review required') {
  let s = cleanText(value, fallback);
  return String(s)
    .replace(/not_recommended/gi, 'further review required before progression')
    .replace(/further_review_required_before_progression/gi, 'further review required before progression')
    .replace(/threshold_issue_requiring_clarification/gi, 'threshold issue requiring clarification')
    .replace(/appears_capable/gi, 'appears capable, subject to verification')
    .replace(/hard blocker/gi, 'threshold issue requiring clarification')
    .replace(/not recommended/gi, 'further review required before progression')
    .replace(/0\s*\/\s*100/gi, 'not scored')
    .replace(/high risk/gi, 'enhanced verification required')
    .replace(/medium risk/gi, 'moderate verification required')
    .replace(/low risk/gi, 'standard verification required')
    .replace(/refusal risk/gi, 'criterion requiring careful assessment')
    .replace(/sham employment/gi, 'employment arrangement requiring clarification')
    .replace(/suspicious/gi, 'requiring verification')
    .replace(/weak evidence/gi, 'supporting evidence presently limited')
    .replace(/bogus documents?/gi, 'document authenticity concern requiring verification')
    .replace(/Score:\s*not scored\.?/gi, '')
    .replace(/Score:\s*\d+\s*\/\s*100\.?/gi, '')
    .replace(/_/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim() || fallback;
}

function commercialLabel(value, fallback = 'Further review required') {
  const raw = String(value || '').toLowerCase().trim();

  if (raw.includes('not_recommended')) return 'Further review required before progression';
  if (raw.includes('threshold_issue_requiring_clarification')) return 'Threshold issue requiring clarification';
  if (raw.includes('further_review_required_before_progression')) return 'Further review required before progression';
  if (raw.includes('appears_capable')) return 'Appears capable, subject to verification';

  const labelled = premiumPhrase(value, fallback)
    .replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bAnd\b/g, 'and')
    .replace(/\bOr\b/g, 'or')
    .replace(/\bTo\b/g, 'to')
    .trim();

  return labelled || fallback;
}

function recommendationByCriterion(name = '') {
  const key = String(name).toLowerCase();

  if (key.includes('occupation') || key.includes('anzsco')) {
    return 'Review duties, reporting structure and supporting occupation evidence.';
  }
  if (key.includes('genuine') || key.includes('position')) {
    return 'Prepare operational and organisational evidence supporting the nominated role.';
  }
  if (key.includes('salary') || key.includes('market')) {
    return 'Verify payroll, salary and market rate evidence before progression.';
  }
  if (key.includes('english')) {
    return 'Confirm English evidence validity and any applicable exemptions.';
  }
  if (key.includes('character') || key.includes('integrity') || key.includes('4020')) {
    return 'Review police, court, immigration and prior document records before final advice.';
  }
  if (key.includes('health')) {
    return 'Review health disclosures and any available medical information.';
  }
  if (key.includes('trt') || key.includes('qualifying employment') || key.includes('482') || key.includes('457')) {
    return 'Reconcile employment continuity against payroll and visa history records.';
  }
  if (key.includes('sponsor') || key.includes('employer')) {
    return 'Review sponsor identity, business operations and nomination-supporting records.';
  }
  if (key.includes('nomination')) {
    return 'Review nomination approval, position details and employer evidence.';
  }

  return 'Review supporting evidence and confirm the current information position before lodgement.';
}

function displayPosition(value) {
  const raw = String(value || '').toLowerCase();
  if (/ready|green|suitable/.test(raw) && !/not/.test(raw)) return 'Potentially viable subject to verification';
  if (/not ready|information|required|review|medium|moderate/.test(raw)) return 'Further evidence and professional review required';
  if (/not lodgeable|invalid|bar|critical|high/.test(raw)) return 'Threshold issue requiring clarification';
  return premiumPhrase(displayLodgement(value || 'Further Review Required'));
}

function inferStream(assessment, adviceBundle, advice) {
  const blob = JSON.stringify({ assessment, adviceBundle, advice }).toLowerCase();
  if (/labour agreement|labor agreement|la stream|agreement concession/.test(blob)) return 'Labour Agreement';
  if (/direct entry|de stream|skills assessment/.test(blob)) return 'Direct Entry';
  if (/temporary residence transition|trt|457|482/.test(blob)) return 'Temporary Residence Transition';
  return 'To be confirmed';
}

function extractFactsObject(assessment, adviceBundle) {
  const payload = assessment && assessment.form_payload ? assessment.form_payload : {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload || {};
  return {
    ...answers,
    ...(adviceBundle && adviceBundle.facts ? adviceBundle.facts : {})
  };
}

function pickFirst(obj, names, fallback = '—') {
  const stack = [obj];
  while (stack.length) {
    const current = stack.shift();
    if (!current || typeof current !== 'object') continue;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(current, name) && current[name] !== undefined && current[name] !== null && current[name] !== '') return current[name];
    }
    for (const value of Object.values(current)) if (value && typeof value === 'object') stack.push(value);
  }
  return fallback;
}

function collectEvidence(advice, adviceBundle) {
  const values = [];
  values.push(advice.evidence_required, adviceBundle.evidenceRequired, adviceBundle.requiredEvidence, adviceBundle.evidence);
  const sections = Array.isArray(advice.sections) ? advice.sections : [];
  for (const section of sections) values.push(section.evidence, section.evidenceRequired, section.bullets);
  const findings = advice.criterion_findings || adviceBundle.criterionFindings || adviceBundle.findings || [];
  for (const finding of ensureArray(findings)) values.push(finding.missingEvidence, finding.evidence);
  return uniqueClean(values).slice(0, 80);
}

function criterionTone(item) {
  const combined = JSON.stringify(item || {}).toLowerCase();
  if (/not satisfied|invalid|not lodgeable|bar|pic 4020|character|false|misleading|adverse/.test(combined)) return 'threshold';
  if (/requires|review|missing|unable|clarif|concern|limited|medium|moderate/.test(combined)) return 'review';
  if (/satisfied|capable|available|consistent|met|strong|verified/.test(combined)) return 'positive';
  return 'review';
}

function positionLabelFromTone(tone) {
  if (tone === 'positive') return 'Appears capable, subject to verification';
  if (tone === 'threshold') return 'Threshold issue requiring clarification';
  return 'Further review required';
}

function priorityFromText(text) {
  const s = String(text || '').toLowerCase();
  if (/nomination|sponsor|genuine|position|payroll|salary|market|employment continuity|pic 4020|character|health|licen|registration|skills assessment|work experience/.test(s)) return 'High';
  if (/english|qualification|cv|reference|tax|super|contract|organisation|business/.test(s)) return 'Medium';
  return 'Standard';
}

function niceCriterionName(name) {
  const s = titleCaseWords(name || 'Criterion')
    .replace(/Approved Sponsor \/ Sponsoring Employer/gi, 'Sponsor and Employer Position')
    .replace(/Approved Nomination \/ Nominated Position/gi, 'Nomination and Position Review')
    .replace(/Occupation Eligibility and Alignment/gi, 'Occupation Alignment Review');

  return s
    .replace(/Pic 4020/g, 'PIC 4020')
    .replace(/Anzsco/g, 'ANZSCO')
    .replace(/Trt/g, 'TRT')
    .replace(/Ens/g, 'ENS')
    .replace(/Vac/g, 'VAC');
}

function makeCriterionNarrative(item) {
  const criterion = niceCriterionName(item.criterion || item.heading || item.title || 'Criterion');
  const tone = criterionTone(item);
  const finding = premiumPhrase(item.finding || item.status || item.evidenceStatus || item.body || '', 'Further review is required based on the information presently available.');
  const consequence = premiumPhrase(item.legal_consequence || item.legalConsequence || item.legalEffect || '', 'The requirement should be checked against the relevant criterion before any lodgement strategy is finalised.');
  const recommendation = recommendationByCriterion(criterion);

  if (/genuine position|position/.test(criterion.toLowerCase())) {
    return {
      criterion,
      position: positionLabelFromTone(tone),
      body: 'The nominated position should be reviewed against the employer’s operating structure, business need, reporting lines and ongoing requirement for the role. The current information indicates that this area requires a focused evidence review before any lodgement strategy is confirmed.',
      consequence,
      recommendation: recommendation || 'Review organisational charts, payroll records, position description and business need evidence.'
    };
  }
  if (/occupation|anzsco|alignment|skills|work experience/.test(criterion.toLowerCase())) {
    return {
      criterion,
      position: positionLabelFromTone(tone),
      body: 'The occupation and skills position should be assessed by reference to the nominated occupation, day-to-day duties, seniority level, qualifications and employment history. The available information should be cross-checked against supporting documents before a final view is formed.',
      consequence,
      recommendation: recommendation || 'Review the position description, employment references, CV, qualifications and any skills assessment evidence.'
    };
  }
  if (/english/.test(criterion.toLowerCase())) {
    return {
      criterion,
      position: positionLabelFromTone(tone),
      body: 'The English requirement should be confirmed by reviewing the applicant’s test evidence or exemption position. Any time limits, passport-based exemptions or stream-specific concessions should be checked before final advice is issued.',
      consequence,
      recommendation: recommendation || 'Verify English test results, exemption evidence and validity dates.'
    };
  }
  if (/health/.test(criterion.toLowerCase())) {
    return {
      criterion,
      position: positionLabelFromTone(tone),
      body: 'The health position requires review of the applicant’s disclosures and any available medical information. Any potential health issue should be assessed carefully before lodgement or final advice.',
      consequence,
      recommendation: recommendation || 'Confirm health disclosures and obtain relevant medical evidence if required.'
    };
  }
  if (/character|integrity|4020/.test(criterion.toLowerCase())) {
    return {
      criterion,
      position: positionLabelFromTone(tone),
      body: 'The character and integrity position should be checked against police, court, immigration and document history. Any inconsistency or previous adverse immigration event should be clarified before the matter is progressed.',
      consequence,
      recommendation: recommendation || 'Review police certificates, court records, prior visa records and documents previously provided to the Department.'
    };
  }
  if (/trt|temporary residence|457|482|qualifying employment/.test(criterion.toLowerCase())) {
    return {
      criterion,
      position: positionLabelFromTone(tone),
      body: 'The TRT position should be reviewed against the applicant’s eligible visa history, employment continuity, occupation continuity and sponsor continuity. Payroll and tax records should be reconciled with claimed employment periods.',
      consequence,
      recommendation: recommendation || 'Verify 457/482 history, employment periods, payslips, tax records and any unpaid leave or stand-down periods.'
    };
  }

  return { criterion, position: positionLabelFromTone(tone), body: finding, consequence, recommendation };
}

function addPageFooter(doc) {
  // PERMANENT FOOTER FIX:
  // PDFKit's text() can trigger addPage() if footer text wraps near the bottom
  // margin. This renderer is intentionally page-safe: it temporarily disables
  // automatic page creation while drawing short, non-wrapping footer text.
  const range = doc.bufferedPageRange();
  const originalAddPage = doc.addPage.bind(doc);
  const originalY = doc.y;

  try {
    doc.addPage = function noFooterAutoPage() { return this; };

    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.save();

      const footerY = 752;
      doc.rect(0, footerY, 595.28, 30).fill(BRAND.navy);
      doc.font('Helvetica').fontSize(6.6).fillColor('#ffffff')
        .text('Bircan Migration & Education | Preliminary Migration Assessment Report | MARN: 1463685',
          50, footerY + 10, { width: 360, lineBreak: false, ellipsis: true });
      doc.font('Helvetica-Bold').fontSize(6.6).fillColor('#ffffff')
        .text(`Page ${i - range.start + 1}`, 500, footerY + 10, { width: 45, align: 'right', lineBreak: false });

      doc.restore();
    }
  } finally {
    doc.addPage = originalAddPage;
    const lastPageIndex = range.start + range.count - 1;
    if (lastPageIndex >= range.start) doc.switchToPage(lastPageIndex);
    doc.y = originalY;
  }
}

function ensurePremiumPage(doc, minY = 720) {
  if (doc.y > minY) doc.addPage();
}

function drawPremiumCover(doc, meta) {
  doc.rect(0, 0, 595.28, 841.89).fill('#ffffff');
  doc.rect(0, 0, 595.28, 250).fill(BRAND.navy);
  doc.rect(0, 250, 595.28, 9).fill(BRAND.gold);
  doc.circle(520, 86, 98).fillOpacity(0.12).fill(BRAND.blue).fillOpacity(1);
  doc.circle(470, 170, 48).fillOpacity(0.12).fill(BRAND.gold).fillOpacity(1);

  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(28).text('Bircan Migration', 50, 56);
  doc.font('Helvetica').fontSize(11).fillColor('#dce7f8').text('Migration & Education | Professional Migration Assessment', 50, 92);
  doc.moveTo(50, 126).lineTo(235, 126).strokeColor(BRAND.gold).lineWidth(1.5).stroke();

  doc.font('Helvetica-Bold').fontSize(31).fillColor('#ffffff').text('Preliminary Migration\nAssessment Report', 50, 142, { width: 410, lineGap: 5 });
  doc.font('Helvetica').fontSize(12).fillColor('#dce7f8').text(meta.title, 50, 220, { width: 450 });

  const y = 315;
  doc.roundedRect(50, y, 495, 250, 18).fillAndStroke(BRAND.soft, '#d8e2f0');
  doc.fillColor(BRAND.navy).font('Helvetica-Bold').fontSize(15).text('Matter details', 78, y + 30);
  const rows = [
    ['Reference', meta.reference],
    ['Applicant', meta.applicantName],
    ['Client email', meta.clientEmail],
    ['Subclass', meta.subclass],
    ['Stream', meta.stream],
    ['Generated', meta.generatedAt]
  ];
  let yy = y + 68;
  for (const [label, value] of rows) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND.muted).text(label.toUpperCase(), 78, yy, { width: 145 });
    doc.font('Helvetica').fontSize(10.5).fillColor(BRAND.ink).text(cleanText(value), 220, yy, { width: 285 });
    yy += 29;
  }

  doc.roundedRect(50, 610, 495, 95, 16).fillAndStroke('#fffaf0', '#f0d99b');
  doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.navy).text('Confidential preliminary advice', 78, 632);
  doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.text).text('This report is prepared for preliminary migration assessment purposes only. It is based on the information provided through the assessment system and remains subject to verification of original documents, conflict checks, current law and professional review before any lodgement action.', 78, 653, { width: 440, lineGap: 3 });
}

function drawPremiumPageHeader(doc, title) {
  doc.rect(0, 0, 595.28, 58).fill('#ffffff');
  doc.moveTo(50, 56).lineTo(545, 56).strokeColor(BRAND.line).lineWidth(1).stroke();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.navy).text('Bircan Migration', 50, 24, { width: 160 });
  doc.font('Helvetica').fontSize(8.5).fillColor(BRAND.muted).text(cleanText(title), 315, 24, { width: 230, align: 'right' });
  doc.y = 82;
}

function premiumHeading(doc, text, opts = {}) {
  ensurePremiumPage(doc, opts.minY || 705);
  doc.moveDown(opts.before || 0.4);
  doc.font('Helvetica-Bold').fontSize(opts.size || 15).fillColor(BRAND.navy).text(cleanText(text), { lineGap: 2 });
  doc.moveDown(0.25);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor(opts.gold ? BRAND.gold : BRAND.line).lineWidth(opts.gold ? 1.4 : 1).stroke();
  doc.moveDown(0.55);
}

function premiumSubheading(doc, text) {
  ensurePremiumPage(doc, 725);
  doc.font('Helvetica-Bold').fontSize(10.6).fillColor(BRAND.navy).text(cleanText(text));
  doc.moveDown(0.22);
}

function premiumParagraph(doc, text, options = {}) {
  const paras = cleanText(premiumPhrase(text || '')).split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  for (const p of paras.length ? paras : ['—']) {
    ensurePremiumPage(doc, 735);
    doc.font('Helvetica').fontSize(options.size || 10.1).fillColor(BRAND.text).text(p, {
      align: options.align || 'justify',
      lineGap: options.lineGap === undefined ? 3 : options.lineGap,
      width: options.width || 495
    });
    doc.moveDown(options.after === undefined ? 0.45 : options.after);
  }
}

function premiumBullet(doc, text) {
  ensurePremiumPage(doc, 733);
  doc.font('Helvetica').fontSize(9.8).fillColor(BRAND.text).text('•', { continued: true });
  doc.text(' ' + cleanText(premiumPhrase(text)), { indent: 12, lineGap: 2 });
}

function statusPill(doc, x, y, text, tone = 'review', width = 150) {
  const fill = tone === 'positive' ? '#eaf7f1' : tone === 'threshold' ? '#fff4e5' : BRAND.paleBlue;
  const stroke = tone === 'positive' ? '#b9e4d0' : tone === 'threshold' ? '#f2cf8f' : '#cfe0ff';
  const color = tone === 'positive' ? BRAND.good : tone === 'threshold' ? BRAND.warn : BRAND.blue;
  doc.roundedRect(x, y, width, 20, 10).fillAndStroke(fill, stroke);
  doc.font('Helvetica-Bold').fontSize(7.4).fillColor(color).text(cleanText(text).toUpperCase(), x + 8, y + 6, { width: width - 16, lineBreak: false });
}

function premiumInfoGrid(doc, rows) {
  const x = 50;
  let y = doc.y;
  const w = 495;
  const rowH = 30;
  ensurePremiumPage(doc, 680);
  y = doc.y;
  doc.roundedRect(x, y, w, rows.length * rowH + 12, 14).fillAndStroke(BRAND.soft, BRAND.line);
  let yy = y + 12;
  for (const [label, value] of rows) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(BRAND.muted).text(String(label).toUpperCase(), x + 18, yy + 2, { width: 150 });
    doc.font('Helvetica').fontSize(9.6).fillColor(BRAND.ink).text(cleanText(value), x + 180, yy + 1, { width: 290 });
    yy += rowH;
  }
  doc.y = y + rows.length * rowH + 24;
}

function premiumTable(doc, headers, rows, widths) {
  if (!rows || !rows.length) return;
  const x = 50;
  const pad = 7;
  const headerH = 28;
  const lineH = 13;
  const totalW = widths.reduce((a, b) => a + b, 0);
  ensurePremiumPage(doc, 685);
  let y = doc.y;
  doc.roundedRect(x, y, totalW, headerH, 9).fill(BRAND.navy);
  let xx = x;
  headers.forEach((h, i) => {
    doc.font('Helvetica-Bold').fontSize(7.7).fillColor('#ffffff').text(String(h).toUpperCase(), xx + pad, y + 9, { width: widths[i] - pad * 2, lineBreak: false });
    xx += widths[i];
  });
  y += headerH;
  rows.forEach((row, rowIndex) => {
    const cells = row.map(v => cleanText(premiumPhrase(v)));
    const heights = cells.map((cell, i) => Math.max(30, doc.heightOfString(cell, { width: widths[i] - pad * 2, lineGap: 2 }) + 16));
    const rowH = Math.max(...heights);
    if (y + rowH > 770) {
      doc.addPage();
      drawPremiumPageHeader(doc, 'Preliminary Migration Assessment Report');
      y = doc.y;
      doc.roundedRect(x, y, totalW, headerH, 9).fill(BRAND.navy);
      let hx = x;
      headers.forEach((h, i) => {
        doc.font('Helvetica-Bold').fontSize(7.7).fillColor('#ffffff').text(String(h).toUpperCase(), hx + pad, y + 9, { width: widths[i] - pad * 2, lineBreak: false });
        hx += widths[i];
      });
      y += headerH;
    }
    doc.rect(x, y, totalW, rowH).fill(rowIndex % 2 ? '#ffffff' : '#fbfdff');
    doc.rect(x, y, totalW, rowH).strokeColor(BRAND.line).stroke();
    xx = x;
    cells.forEach((cell, i) => {
      doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.7).fillColor(i === 0 ? BRAND.navy : BRAND.text).text(cell, xx + pad, y + 8, { width: widths[i] - pad * 2, lineGap: 2 });
      xx += widths[i];
    });
    y += rowH;
  });
  doc.y = y + 14;
}

function buildPremiumExecutive(assessment, adviceBundle, advice, stream) {
  const subclass = advice.subclass || assessment.visa_type || '186';
  const finalPosition = getFinalPosition(adviceBundle, advice);
  const issue = premiumPhrase(finalPosition.primaryReason || adviceBundle.primaryReason || advice.primaryReason || 'the evidence and eligibility position');
  const position = displayPosition(advice.lodgement_position || adviceBundle.lodgementPosition || finalPosition.lodgementPosition);
  return `The currently available information has been reviewed for a Subclass ${subclass} Employer Nomination Scheme pathway. The matter is best characterised at this stage as: ${position}.

The assessment material indicates that the primary professional review focus is ${issue}. The matter should be approached through a structured verification process, including review of the nomination connection, employer position evidence, occupation alignment, employment history, stream requirements and supporting documentation.

This preliminary report does not replace final legal advice. It identifies the present information position, the areas that require verification, and the professional evidence priorities before any lodgement strategy or final advice is confirmed. For the selected stream position, the current stream indicator is: ${stream}.`;
}

function buildStreamNarrative(stream) {
  if (stream === 'Temporary Residence Transition') {
    return 'The TRT pathway should be reviewed by reference to the applicant’s eligible 457/482 visa history, employment continuity, sponsor continuity, occupation continuity and any periods of unpaid leave, stand-down or concession reliance. Payroll, PAYG, tax and superannuation records should be reconciled against the claimed employment period before final pathway positioning is confirmed.';
  }
  if (stream === 'Direct Entry') {
    return 'The Direct Entry pathway should be reviewed by reference to the nominated occupation, skills assessment position, relevant employment history, qualification alignment and any mandatory registration or licensing requirement. The evidence should demonstrate that the applicant’s background aligns with the occupation and stream requirements.';
  }
  if (stream === 'Labour Agreement') {
    return 'The Labour Agreement pathway requires review of the applicable agreement terms, concessions, nominated occupation coverage, salary settings, English position, age position and employer compliance with agreement requirements. The agreement instrument should be checked before final advice is issued.';
  }
  return 'The stream position requires confirmation. Once the intended stream is confirmed, the matter should be assessed against the specific TRT, Direct Entry or Labour Agreement requirements and the evidence should be organised accordingly.';
}

function buildPathwayRows(_adviceBundle, stream) {
  // Commercial pathway matrix: intentionally avoids raw backend statuses such as
  // not_recommended, 0/100, hard blocker, or internal score labels.
  const isTRT = stream === 'Temporary Residence Transition';
  const isDE = stream === 'Direct Entry';
  const isLA = stream === 'Labour Agreement';

  return [
    [
      '186 TRT',
      isTRT ? 'Primary pathway for professional review' : 'Further review required before progression',
      'Employment continuity',
      'Payroll and sponsor continuity verification'
    ],
    [
      '186 Direct Entry',
      isDE ? 'Primary pathway for professional review' : 'Further review required before progression',
      'Occupation alignment',
      'Skills assessment and employment evidence'
    ],
    [
      '186 Labour Agreement',
      isLA ? 'Primary pathway for professional review' : 'Available only if agreement terms apply',
      'Agreement-based concessions may assist',
      'Agreement coverage and employer compliance'
    ],
    [
      '482 Employer Sponsored',
      'Alternative pathway potentially available',
      'Sponsorship structure',
      'Eligibility and occupation clarification'
    ],
    [
      '494 Regional',
      'Alternative pathway potentially available',
      'Regional sponsorship pathway',
      'Regional eligibility and employer location'
    ]
  ].map(row => row.map(cell => commercialLabel(cell)));
}

function buildTimelineRows(facts, assessment, adviceBundle) {
  const rows = [];
  const visa = pickFirst(facts, ['currentVisa', 'current_visa', 'visaHistory', 'visa_history'], 'Requires verification');
  const employer = pickFirst(facts, ['sponsorName', 'sponsor_name', 'employerName', 'employer_name', 'nominatingEmployer'], 'Requires verification');
  const occupation = pickFirst(facts, ['occupation', 'nominatedOccupation', 'nominated_occupation', 'anzsco'], 'Requires verification');
  const start = pickFirst(facts, ['employmentStartDate', 'employment_start_date', 'startDate', 'start_date'], 'Requires verification');
  const english = pickFirst(facts, ['english', 'englishStatus', 'english_status', 'englishTest'], 'Requires verification');
  rows.push(['Current visa / visa history', visa]);
  rows.push(['Nominating employer', employer]);
  rows.push(['Nominated occupation', occupation]);
  rows.push(['Employment commencement', start]);
  rows.push(['English evidence position', english]);
  const primary = getFinalPosition(adviceBundle, {}).primaryReason || adviceBundle.primaryReason;
  if (primary) rows.push(['Primary review focus', premiumPhrase(primary)]);
  return rows;
}

function buildVerificationAreas(advice, adviceBundle, findings) {
  const areas = [];
  const add = (s) => { const v = cleanText(premiumPhrase(s), ''); if (v && !areas.some(x => x.toLowerCase() === v.toLowerCase())) areas.push(v); };
  for (const f of findings) {
    const text = `${f.criterion || ''} ${f.recommendation || ''} ${f.legal_consequence || f.legalConsequence || ''}`;
    if (criterionTone(f) !== 'positive') add(f.criterion || text);
  }
  const evidence = collectEvidence(advice, adviceBundle);
  for (const item of evidence.slice(0, 15)) add(item);
  if (!areas.length) {
    add('Nomination and sponsor documentation');
    add('Employment continuity and payroll records');
    add('Occupation alignment and position description');
    add('English, health and character evidence');
    add('Identity and immigration history records');
  }
  return areas.slice(0, 10);
}

function buildEvidenceRows(evidenceItems) {
  const blockedEvidenceText = /request and verify|do not treat|final advice until verified|obtain evidence or address|retain verified evidence|review supporting evidence/i;
  const cleanedEvidenceItems = uniqueClean(evidenceItems).filter(item => !blockedEvidenceText.test(item));
  const grouped = groupEvidence(cleanedEvidenceItems);
  const rows = [];
  for (const [group, items] of grouped) {
    const visibleItems = items.filter(item => !blockedEvidenceText.test(item)).slice(0, 4);
    if (!visibleItems.length) continue;
    rows.push([group, visibleItems.join('; '), priorityFromText(`${group} ${visibleItems.join(' ')}`)]);
  }
  if (!rows.length) {
    rows.push(['Sponsor / Nomination', 'Nomination approval, sponsor details and position documentation', 'High']);
    rows.push(['Skills and Employment', 'CV, employment references, contract, payslips and tax records', 'High']);
    rows.push(['English / Identity / Character', 'Passport, English evidence, police and health records', 'Medium']);
  }
  return rows;
}

function buildDelegatePreparationRows(findings, verificationAreas) {
  const rows = [];
  const add = (area, concern, preparation) => rows.push([area, premiumPhrase(concern), premiumPhrase(preparation)]);
  const joined = JSON.stringify(findings).toLowerCase();
  if (/genuine|position|sponsor|nomination|employer/.test(joined)) add('Employer and nomination', 'The decision maker may seek confirmation that the nominated role is genuine, operationally required and available.', 'Prepare organisational, payroll, business need and role evidence.');
  if (/occupation|anzsco|skill|duties|experience/.test(joined)) add('Occupation alignment', 'The duties, seniority and experience should be consistent with the nominated occupation.', 'Prepare detailed duties, CV, references, qualifications and skills material.');
  if (/trt|482|457|employment continuity|payroll/.test(joined)) add('Employment continuity', 'Claimed employment periods should be consistent with payroll, tax and visa history records.', 'Reconcile payslips, PAYG summaries, superannuation and leave periods.');
  if (/english|age|health|character|pic|integrity/.test(joined)) add('Personal criteria', 'Personal criteria should be verified against documents and prior immigration history.', 'Check English, age/exemption, police, health and prior visa records.');
  if (!rows.length) {
    for (const area of verificationAreas.slice(0, 4)) add(area, 'This area may require further factual clarification during assessment.', 'Prepare concise supporting evidence before final advice.');
  }
  return rows.slice(0, 6);
}


function buildAssessmentPdfBuffer(assessment, adviceBundle) {
  if (!adviceBundle) {
    throw new Error('Advice-grade PDF generation requires adviceBundle. Weak template PDF generation is disabled.');
  }

  return new Promise((resolve, reject) => {
    try {
      const advice = getAdvice(adviceBundle);
      if (!advice) return reject(new Error('Advice-grade PDF generation requires adviceBundle.advice.'));

      const facts = extractFactsObject(assessment || {}, adviceBundle || {});
      const subclass = advice.subclass || assessment.visa_type || pickFirst(facts, ['subclass', 'visaSubclass', 'visa_type'], '186');
      const stream = inferStream(assessment || {}, adviceBundle || {}, advice || {});
      const generatedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
      const title = `Subclass ${subclass} Employer Nomination Scheme preliminary assessment`;
      const applicantName = pickFirst(facts, ['name', 'applicantName', 'applicant_name', 'fullName', 'full_name'], assessment.applicant_name || '—');
      const applicantEmail = pickFirst(facts, ['email', 'applicantEmail', 'applicant_email'], assessment.applicant_email || assessment.client_email || '—');
      const findings = (advice.criterion_findings || adviceBundle.criterionFindings || adviceBundle.findings || []).map(normaliseCriterionFinding);
      const evidenceItems = collectEvidence(advice, adviceBundle);
      const finalPosition = getFinalPosition(adviceBundle, advice);
      const currentPosition = displayPosition(advice.lodgement_position || adviceBundle.lodgementPosition || finalPosition.lodgementPosition || 'Further review required');
      const primaryIssue = premiumPhrase(finalPosition.primaryReason || adviceBundle.primaryReason || advice.primaryReason || 'Evidence verification and professional review');

      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        bufferPages: true,
        info: {
          Title: `Bircan Migration - ${title}`,
          Author: 'Bircan Migration & Education',
          Subject: `Premium advice letter for assessment ${assessment.id || ''}`
        }
      });

      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      drawPremiumCover(doc, {
        title,
        reference: assessment.id || '—',
        applicantName,
        clientEmail: assessment.client_email || applicantEmail,
        subclass,
        stream,
        generatedAt
      });

      doc.addPage();
      drawPremiumPageHeader(doc, title);

      premiumHeading(doc, 'Executive overview', { gold: true, size: 17 });
      premiumParagraph(doc, buildPremiumExecutive(assessment || {}, adviceBundle || {}, advice || {}, stream), { size: 10.5 });

      premiumInfoGrid(doc, [
        ['Current information position', currentPosition],
        ['Primary professional review focus', primaryIssue],
        ['Selected stream indicator', stream],
        ['Assessment type', 'Preliminary migration assessment — subject to verification'],
        ['Professional boundary', 'No lodgement action should occur until original documents and current legal settings are reviewed']
      ]);

      premiumHeading(doc, 'Matter snapshot');
      premiumTable(doc, ['Item', 'Current information'], [
        ['Reference', assessment.id || '—'],
        ['Applicant', applicantName],
        ['Applicant email', applicantEmail],
        ['Client account email', assessment.client_email || '—'],
        ['Subclass', subclass],
        ['Stream', stream],
        ['Generated', generatedAt]
      ], [150, 345]);

      premiumHeading(doc, 'Pathway positioning matrix');
      premiumParagraph(doc, 'The following matrix is a professional positioning tool only. It does not replace final legal advice and should be read together with the evidence verification areas identified below.', { size: 9.8 });
      premiumTable(doc, ['Pathway', 'Current position', 'Potential strength', 'Verification area'], buildPathwayRows(adviceBundle || {}, stream), [92, 138, 132, 133]);

      premiumHeading(doc, 'Stream analysis');
      premiumParagraph(doc, buildStreamNarrative(stream));

      premiumHeading(doc, 'Employer position review');
      premiumParagraph(doc, 'The employer and nomination position should be reviewed by reference to the sponsoring business structure, operational activity, payroll capacity, role necessity and the availability of the nominated position. The current information should be verified against business records, organisational material and nomination documents before any lodgement strategy is finalised.');

      premiumHeading(doc, 'Occupation and ANZSCO alignment review');
      premiumParagraph(doc, 'The nominated role should be assessed against the occupation classification, actual day-to-day duties, seniority, reporting structure, qualifications and work experience. Where the role is specialised or mixed, the evidence should clearly explain why the selected occupation is the best fit for the position and the applicant’s background.');

      premiumHeading(doc, 'Employment and timeline intelligence');
      premiumTable(doc, ['Timeline area', 'Current position'], buildTimelineRows(facts, assessment || {}, adviceBundle || {}), [180, 315]);

      const verificationAreas = buildVerificationAreas(advice || {}, adviceBundle || {}, findings);
      premiumHeading(doc, 'Verification priority areas');
      premiumParagraph(doc, 'These areas should be clarified before final advice is issued or any lodgement strategy is confirmed. They are expressed as professional verification priorities rather than client-facing risk conclusions.');
      verificationAreas.forEach(area => premiumBullet(doc, area));

      premiumHeading(doc, 'Criterion-by-criterion professional analysis');
      if (findings.length) {
        for (const raw of findings) {
          const item = makeCriterionNarrative(raw);
          ensurePremiumPage(doc, 650);
          const y = doc.y;
          doc.roundedRect(50, y, 495, 34, 12).fillAndStroke(BRAND.soft, BRAND.line);
          doc.font('Helvetica-Bold').fontSize(10.6).fillColor(BRAND.navy).text(item.criterion, 66, y + 11, { width: 265, lineBreak: false });
          statusPill(doc, 360, y + 7, item.position, criterionTone(raw), 168);
          doc.y = y + 45;
          premiumParagraph(doc, item.body, { size: 9.9 });
          premiumSubheading(doc, 'Professional consequence');
          premiumParagraph(doc, item.consequence, { size: 9.5, after: 0.2 });
          premiumSubheading(doc, 'Recommended evidence response');
          premiumParagraph(doc, item.recommendation, { size: 9.5 });
        }
      } else {
        premiumParagraph(doc, 'No criterion-specific findings were supplied in the advice bundle. The matter should be reviewed against Schedule 1 validity, common Subclass 186 criteria, the selected stream criteria and applicable public interest or special return criteria.');
      }

      premiumHeading(doc, 'Evidence intelligence matrix');
      premiumTable(doc, ['Evidence category', 'Documents or information to verify', 'Priority'], buildEvidenceRows(evidenceItems), [135, 285, 75]);

      premiumHeading(doc, 'Delegate concern preparation layer');
      premiumParagraph(doc, 'The following preparation points are designed to assist professional review of issues that commonly require careful evidence support in employer-sponsored matters. They are not allegations or findings against the applicant or sponsor.');
      premiumTable(doc, ['Review area', 'Possible assessment focus', 'Preparation response'], buildDelegatePreparationRows(findings, verificationAreas), [115, 210, 170]);

      premiumHeading(doc, 'Alternative pathway observations');
      // Do not print raw comparator narrative. It may contain backend labels or
      // overly negative wording. The professionally controlled matrix above is
      // the source of truth for pathway positioning.
      premiumParagraph(doc, 'Depending on the final evidence position, employer-sponsored and skilled migration alternatives may warrant further professional review. Any alternative pathway should be assessed only after the nomination structure, occupation position, employment history, stream requirements and applicant criteria have been verified.');
      premiumBullet(doc, '186 stream positioning should be confirmed after the nomination and stream-specific evidence is reviewed.');
      premiumBullet(doc, 'Temporary employer-sponsored alternatives may remain relevant depending on sponsor, occupation and visa history.');
      premiumBullet(doc, 'Regional or skilled pathways should be considered only after occupation, points and location factors are separately assessed.');

      premiumHeading(doc, 'Recommended professional next steps');
      const nextSteps = normaliseNextSteps(advice.client_next_steps || adviceBundle.recommendedNextSteps || adviceBundle.nextSteps || verificationAreas, advice);
      nextSteps.forEach(step => premiumBullet(doc, step));

      premiumHeading(doc, 'Final professional position', { gold: true });
      premiumParagraph(doc, `Based on the currently available information, the matter appears capable of progressing to further detailed professional review subject to verification of supporting documentation, clarification of the identified evidence areas and confirmation of the applicable legislative and policy settings at the relevant time.

This report should be treated as a preliminary professional migration assessment prepared for evidence planning, strategic review and migration-agent consideration before any lodgement strategy is finalised.`);

      premiumHeading(doc, 'Important notice');
      premiumParagraph(doc, advice.disclaimer || 'This preliminary advice is based only on questionnaire answers, available evidence metadata and system-generated assessment material. Final advice requires review of original documents, conflict checks, confirmation of current law and policy, and professional assessment by a registered migration agent before any lodgement action.');

      doc.moveDown(0.8);
      doc.fontSize(10).fillColor(BRAND.ink).font('Helvetica').text('Yours faithfully,');
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').text('Kenan Bircan JP');
      doc.font('Helvetica').text('Registered Migration Agent | MARN: 1463685');
      doc.text('Bircan Migration & Education');
      doc.moveDown(0.8);
      doc.fontSize(8).fillColor(BRAND.muted).text('This document is preliminary migration advice and is subject to professional review, verification of original documents and confirmation of current law and policy.', { align: 'center' });

      doc._ending = true;
      addPageFooter(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
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
    writePair(doc, 'Applicant (form):', assessment.applicant_name || '—');
    if (advice.decision_record_applicant && advice.decision_record_applicant !== 'not identified in the uploaded material') writePair(doc, 'Applicant in decision record:', advice.decision_record_applicant);
    writePair(doc, 'Applicant email:', assessment.applicant_email || assessment.client_email);
    writePair(doc, 'Visa subclass:', assessment.visa_subclass || '—');
    writePair(doc, 'Decision type:', assessment.decision_type || '—');
    writePair(doc, 'Decision date:', assessment.decision_date || '—');
    writePair(doc, 'Review deadline:', assessment.tribunal_deadline || '—');
    writePair(doc, 'Risk level:', advice.risk_level || 'High');
    writePair(doc, 'Generated:', generatedAt);

    writeHeading(doc, 'Executive advice');
    writeParagraph(doc, advice.executive_summary || 'I have reviewed the information and uploaded decision material provided for this refusal review assessment. The matter requires careful review of the refusal grounds, evidence position, review deadline and prospects before any review strategy is confirmed.');

    writeHeading(doc, 'Refusal grounds identified');
    const grounds = uniqueClean(advice.refusal_grounds || advice.refusalGrounds || []);
    if (grounds.length) grounds.forEach(g => writeBullet(doc, g));
    else writeParagraph(doc, 'The uploaded decision material should be reviewed against the Department’s stated reasons for refusal. The currently extracted material did not clearly isolate each refusal ground.');

    writeHeading(doc, 'Legal issues for review');
    const legalIssues = uniqueClean(advice.legal_issues || advice.legalIssues || []);
    if (legalIssues.length) legalIssues.forEach(i => writeBullet(doc, i));
    else writeParagraph(doc, 'The legal issues must be mapped to the exact criteria the Department was not satisfied were met.');

    writeHeading(doc, 'Department reasoning breakdown');
    const reasoning = uniqueClean(advice.department_reasoning_breakdown || advice.departmentReasoningBreakdown || []);
    if (reasoning.length) reasoning.forEach(r => writeBullet(doc, r));
    else writeParagraph(doc, 'A ground-by-ground analysis should identify the Department finding, the evidence considered, the weight given to that evidence, and the specific evidentiary weakness relied upon.');

    writeHeading(doc, 'Evidence gaps and document weaknesses');
    const evidence = uniqueClean(advice.evidence_position || advice.evidencePosition || []);
    const evidenceTable = uniqueClean(advice.evidence_gap_table || advice.evidenceGapTable || []);
    if (evidence.length) evidence.forEach(e => writeBullet(doc, e));
    if (evidenceTable.length) evidenceTable.forEach(e => writeBullet(doc, e));
    if (!evidence.length && !evidenceTable.length) writeParagraph(doc, 'Further evidence review is required. Any new evidence should directly respond to the refusal reasons, address inconsistencies, and be organised by issue.');

    writeHeading(doc, 'Tribunal review points');
    const tribunalPoints = uniqueClean(advice.tribunal_review_points || advice.tribunalReviewPoints || []);
    if (tribunalPoints.length) tribunalPoints.forEach(t => writeBullet(doc, t));
    else writeParagraph(doc, 'The review should be prepared on the basis that the Tribunal will reassess the merits of the matter and may consider further evidence, but the new evidence must directly answer the refusal reasons.');

    writeHeading(doc, 'Merits review strategy');
    writeParagraph(doc, advice.strategy || 'The review strategy should focus on answering each refusal reason directly, identifying any error or weakness in the Department’s reasoning, and preparing further evidence that was missing, unclear or insufficient at the time of decision.');

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
