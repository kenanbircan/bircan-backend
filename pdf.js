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
    .replace(/not_recommended/gi, 'further professional review required')
    .replace(/threshold_issue_requiring_clarification/gi, 'professional clarification required')
    .replace(/further_review_required_before_progression/gi, 'further evidentiary review recommended')
    .replace(/appears_capable/gi, 'appears capable subject to verification')
    .replace(/Score:\s*(not scored|\d+\s*\/\s*100)\.?/gi, '')
    .replace(/_/g, ' ')
    .replace(/\s+\./g, '.')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return s || fallback;
}

function ensureArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(ensureArray);
  if (typeof value === 'string' && value.includes(';')) return value.split(';').map(s => s.trim()).filter(Boolean);
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

function titleCaseWords(s) {
  return String(s || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function displayLodgement(value) {
  const raw = String(value || '').toLowerCase();
  if (/ready|green|suitable/.test(raw) && !/not/.test(raw)) return 'Potentially viable subject to verification';
  if (/not lodgeable|invalid|bar|critical|high|threshold/.test(raw)) return 'Professional clarification required before lodgement';
  if (/not ready|information|required|review|medium|moderate/.test(raw)) return 'Further evidentiary review recommended';
  return titleCaseWords(value || 'Further evidentiary review recommended');
}

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function flattenObject(input, prefix = '', out = {}) {
  if (!isPlainObject(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) flattenObject(value, name, out);
    else if (Array.isArray(value)) out[name] = value.map(v => isPlainObject(v) ? JSON.stringify(v) : v).join('; ');
    else if (value !== undefined && value !== null && value !== '') out[name] = value;
  }
  return out;
}

function deepPick(obj, keys, fallback = '') {
  const keySet = new Set(keys.map(k => String(k).toLowerCase().replace(/[^a-z0-9]/g, '')));
  const stack = [obj];
  while (stack.length) {
    const current = stack.shift();
    if (!current || typeof current !== 'object') continue;
    for (const [k, v] of Object.entries(current)) {
      const normal = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (keySet.has(normal) && v !== undefined && v !== null && String(v).trim() !== '') return v;
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return fallback;
}

function getAdvice(adviceBundle) {
  return adviceBundle && adviceBundle.advice ? adviceBundle.advice : (adviceBundle || {});
}

function getFinalPosition(adviceBundle, advice) {
  return adviceBundle?.finalPosition || adviceBundle?.rawDecision || advice?.finalPosition || {};
}

function extractFactsObject(assessment, adviceBundle) {
  const payload = assessment && assessment.form_payload ? assessment.form_payload : {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload.formData || payload.form_data || payload.payload || payload.data || payload || {};
  return {
    ...(isPlainObject(answers) ? answers : {}),
    ...(adviceBundle && isPlainObject(adviceBundle.facts) ? adviceBundle.facts : {}),
    meta: payload.meta || {}
  };
}

function inferStream(assessment, adviceBundle, advice) {
  const blob = JSON.stringify({ assessment, adviceBundle, advice }).toLowerCase();
  if (/labour agreement|labor agreement|la stream|agreement concession/.test(blob)) return 'Labour Agreement';
  if (/direct entry|de stream|skills assessment/.test(blob)) return 'Direct Entry';
  if (/temporary residence transition|\btrt\b|457|482/.test(blob)) return 'Temporary Residence Transition';
  return 'To be confirmed';
}

function inferApplicantName(assessment, adviceBundle, facts) {
  return cleanText(
    assessment?.applicant_name ||
    adviceBundle?.facts?.applicant?.name ||
    adviceBundle?.facts?.applicantName ||
    facts?.applicant?.name ||
    deepPick(facts, [
      'applicantName', 'applicant_name', 'applicant-name',
      'fullName', 'full_name', 'full-name',
      'primaryApplicantName', 'primary_applicant_name', 'primary-applicant-name',
      'name', 'clientName', 'client_name', 'client-name'
    ], '') ||
    '—'
  );
}

function inferApplicantEmail(assessment, facts) {
  return cleanText(
    assessment?.applicant_email ||
    facts?.applicant?.email ||
    deepPick(facts, ['applicantEmail', 'applicant_email', 'applicant-email', 'email'], '') ||
    assessment?.client_email ||
    '—'
  );
}

function isHardNegative(adviceBundle, advice) {
  const joined = [
    advice?.lodgement_position,
    advice?.risk_level,
    adviceBundle?.decisionStatus,
    adviceBundle?.legalStatus,
    adviceBundle?.finalPosition?.lodgementPosition,
    adviceBundle?.finalPosition?.primaryReason,
    JSON.stringify(advice?.criterion_findings || adviceBundle?.criterionFindings || adviceBundle?.findings || [])
  ].join(' ').toLowerCase();
  return /not lodgeable|invalid|refusal likely|not satisfied|pic 4020|character issue|integrity|threshold|barred/.test(joined);
}

function professionalPosition(adviceBundle, advice) {
  const finalPosition = getFinalPosition(adviceBundle, advice);
  const source = advice.lodgement_position || adviceBundle.lodgementPosition || finalPosition.lodgementPositionLabel || finalPosition.lodgementPosition || advice.risk_level || adviceBundle.riskLevel;
  return displayLodgement(source);
}

function primaryIssue(adviceBundle, advice) {
  const finalPosition = getFinalPosition(adviceBundle, advice);
  const raw = finalPosition.primaryReason || adviceBundle.primaryReason || advice.primaryReason || 'evidence verification and pathway positioning';
  return cleanText(raw)
    .replace(/Approved sponsor \/ sponsoring employer/gi, 'sponsoring employer and nomination position')
    .replace(/Genuine position/gi, 'genuine position and operational need')
    .replace(/Integrity \/ PIC 4020 risk/gi, 'integrity and document consistency review')
    .replace(/Salary \/ market salary \/ income threshold/gi, 'salary and market salary evidence');
}

function collectEvidence(advice, adviceBundle) {
  const values = [];
  values.push(advice.evidence_required, adviceBundle.evidenceRequired, adviceBundle.requiredEvidence, adviceBundle.evidence);
  const sections = Array.isArray(advice.sections) ? advice.sections : [];
  for (const section of sections) values.push(section.evidence, section.evidenceRequired, section.bullets);
  const findings = advice.criterion_findings || adviceBundle.criterionFindings || adviceBundle.findings || [];
  for (const finding of ensureArray(findings)) values.push(finding.missingEvidence, finding.evidence, finding.recommendation);
  return uniqueClean(values)
    .filter(x => !/do not treat this as final advice|request and verify supporting documents|obtain evidence or address the criterion|retain verified evidence on file|conduct detailed legal review and prepare submissions if proceeding|lodgement is not recommended/i.test(x))
    .slice(0, 80);
}

function groupEvidence(items) {
  const groups = [
    ['Employer and nomination evidence', /sponsor|nomination|organisation|business|genuine|position|operational/i],
    ['Employment, salary and occupation evidence', /skill|assessment|employment|work|cv|occupation|anzsco|salary|contract|reference|payroll|payslip|tax|superannuation/i],
    ['Labour Agreement and stream evidence', /labour agreement|agreement|concession|stream|trt|direct entry|482|457/i],
    ['English, health and character evidence', /english|ielts|pte|toefl|health|medical|character|police|court/i],
    ['Immigration history and integrity records', /vevo|visa grant|refusal|cancellation|waiver|department|prior visa|application records|pic 4020|integrity|documents previously submitted/i]
  ];
  const buckets = Object.fromEntries(groups.map(([name]) => [name, []]));
  buckets['Supporting material'] = [];
  for (const item of uniqueClean(items)) {
    let placed = false;
    for (const [name, rx] of groups) {
      if (rx.test(item)) { buckets[name].push(item); placed = true; break; }
    }
    if (!placed) buckets['Supporting material'].push(item);
  }
  return Object.entries(buckets).filter(([, list]) => list.length);
}

function normaliseNextSteps(items, advice) {
  const raw = uniqueClean(items);
  const joined = raw.join(' ').toLowerCase();
  const steps = [];
  const add = s => { if (s && !steps.includes(s)) steps.push(s); };
  add('Obtain complete instructions and original supporting documents.');
  if (/sponsor|nomination|employer|position|genuine/.test(joined + JSON.stringify(advice || {}))) add('Review the sponsoring employer’s operational evidence, nomination structure and business need for the role.');
  if (/occupation|anzsco|skill|experience|duties|salary|payroll/.test(joined + JSON.stringify(advice || {}))) add('Reconcile the occupation, duties, salary and employment evidence against the nominated pathway.');
  if (/labour agreement|agreement|concession|stream/.test(joined + JSON.stringify(advice || {}))) add('Check the applicable Labour Agreement terms, concessions and employer compliance requirements.');
  add('Review English, health, character and immigration-history evidence before any final advice.');
  add('Prepare a final written position only after the evidence package has been professionally verified.');
  return steps.slice(0, 6);
}

function criterionTone(item) {
  const combined = JSON.stringify(item || {}).toLowerCase();
  if (/not satisfied|invalid|not lodgeable|bar|pic 4020|character|false|misleading|adverse|threshold/.test(combined)) return 'clarification';
  if (/requires|review|missing|unable|clarif|concern|limited|medium|moderate|insufficient/.test(combined)) return 'review';
  if (/satisfied|capable|available|consistent|met|strong|verified/.test(combined)) return 'capable';
  return 'review';
}

function positionLabel(tone) {
  if (tone === 'capable') return 'Appears capable, subject to verification';
  if (tone === 'clarification') return 'Professional clarification required';
  return 'Further evidentiary review recommended';
}

function normaliseCriterionFinding(item) {
  return {
    criterion: item.criterion || item.heading || item.title || 'Criterion',
    finding: item.finding || item.status || item.evidenceStatus || item.body || '',
    legal_consequence: item.legal_consequence || item.legalConsequence || item.legalEffect || '',
    recommendation: item.recommendation || item.missingEvidence || ''
  };
}

function niceCriterionName(name) {
  return titleCaseWords(name || 'Criterion')
    .replace(/Approved Sponsor \/ Sponsoring Employer/gi, 'Sponsoring Employer Position')
    .replace(/Approved Nomination \/ Nominated Position/gi, 'Nomination and Position Review')
    .replace(/Occupation Eligibility and Alignment/gi, 'Occupation and ANZSCO Alignment')
    .replace(/Pic 4020/g, 'PIC 4020')
    .replace(/Anzsco/g, 'ANZSCO')
    .replace(/Trt/g, 'TRT')
    .replace(/Ens/g, 'ENS');
}

function buildMatterFinding(item) {
  const criterion = niceCriterionName(item.criterion);
  const lower = criterion.toLowerCase();
  const tone = criterionTone(item);
  const pos = positionLabel(tone);
  let body;
  let evidence;
  if (/sponsor|employer|nomination|position|genuine/.test(lower)) {
    body = 'The employer and nomination evidence should establish that the proposed role is commercially genuine, operationally required and consistent with the sponsoring business structure. The present information is sufficient to identify the issue for review, but the final position should be formed only after business records, organisational material and nomination documents have been reconciled.';
    evidence = 'Employer organisational chart, position description, business need evidence, payroll capacity material and nomination records.';
  } else if (/occupation|anzsco|skill|work experience/.test(lower)) {
    body = 'The occupation position should be tested against the actual duties performed, seniority level, reporting lines, qualifications and employment history. Where the role involves mixed or specialised duties, the evidence should explain why the nominated occupation is the most accurate classification.';
    evidence = 'Detailed duties statement, CV, employment references, qualifications, skills assessment or occupation-alignment evidence.';
  } else if (/salary|market|income/.test(lower)) {
    body = 'The salary position should be checked against payroll records, contractual terms and any applicable market salary or income threshold requirement. The evidence should demonstrate consistency between the nominated salary, actual payments and the role being performed.';
    evidence = 'Employment contract, payslips, PAYG/tax records, superannuation records and market salary evidence.';
  } else if (/english/.test(lower)) {
    body = 'The English position may be capable of satisfaction, but the evidence must be checked against validity periods, passport-based exemptions, stream concessions and any Labour Agreement settings that may apply.';
    evidence = 'English test result, passport evidence or concession/exemption evidence.';
  } else if (/health/.test(lower)) {
    body = 'The health position should be reviewed against the applicant’s disclosures and any available medical information. Any identified health concern should be considered before final lodgement advice is given.';
    evidence = 'Health examination records, medical reports and any relevant disclosure material.';
  } else if (/character|integrity|4020/.test(lower)) {
    body = 'The character and integrity position requires careful review of police, court, immigration and document history. This should be treated as a professional verification exercise rather than an adverse finding unless supported by confirmed evidence.';
    evidence = 'Police certificates, court records, prior visa/application records and documents previously submitted to the Department.';
  } else if (/trt|temporary residence|457|482|qualifying employment|stream/.test(lower)) {
    body = 'The stream position should be reconciled against visa history, employment continuity, nominated occupation continuity and sponsor continuity. Any gap, unpaid period or change in duties should be explained before a final strategy is adopted.';
    evidence = 'Visa grant records, employment chronology, payslips, PAYG summaries, superannuation and leave records.';
  } else {
    body = cleanText(item.finding || 'This requirement should be reviewed against the current information and supporting documents before a final position is formed.');
    evidence = cleanText(item.recommendation || 'Supporting evidence should be reviewed before final advice or lodgement action.');
  }
  return { criterion, position: pos, body, evidence };
}

const BRAND = {
  navy: '#061936', blue: '#1f5eff', gold: '#d6a845', ink: '#101828', text: '#1f2937', muted: '#667085', line: '#d8e2f0', soft: '#f4f7fb'
};

const PAGE = { W: 595.28, H: 841.89, L: 50, R: 545, TOP: 78, BOTTOM: 760, WIDTH: 495 };

function createDoc(info) {
  return new PDFDocument({
    size: 'A4',
    margin: 50,
    autoFirstPage: false,
    info
  });
}

function drawFooter(_doc) {
  // Intentionally no-op.
  // Rendering footer text during addPage() was causing PDFKit to create
  // header-only separator pages before each real content page. The stable
  // production layout avoids live footer drawing entirely.
}

function addPage(doc, headerTitle = 'Preliminary Migration Assessment Report') {
  doc.addPage({ size: 'A4', margin: 50 });
  doc.rect(0, 0, PAGE.W, 52).fill('#ffffff');
  doc.moveTo(PAGE.L, 55).lineTo(PAGE.R, 55).strokeColor(BRAND.line).lineWidth(1).stroke();
  doc.font('Helvetica-Bold').fontSize(9.2).fillColor(BRAND.navy).text('Bircan Migration', PAGE.L, 24, { width: 150, lineBreak: false });
  doc.font('Helvetica').fontSize(8.2).fillColor(BRAND.muted).text(headerTitle, 280, 24, { width: 265, align: 'right', lineBreak: false });
  doc.x = PAGE.L;
  doc.y = PAGE.TOP;
}

function ensureSpace(doc, height) {
  const needed = Math.max(0, Number(height) || 0);
  // Do not create separator pages from tiny height-estimation drift.
  // Only add a new page when the next block genuinely needs material space.
  if (needed > 24 && doc.y + needed > PAGE.BOTTOM) addPage(doc);
}

function writeTitle(doc, text, opts = {}) {
  const size = opts.size || 15;
  const t = cleanText(text);
  const h = doc.font('Helvetica-Bold').fontSize(size).heightOfString(t, { width: PAGE.WIDTH, lineGap: 2 }) + 15;
  ensureSpace(doc, h);
  doc.font('Helvetica-Bold').fontSize(size).fillColor(BRAND.navy).text(t, PAGE.L, doc.y, { width: PAGE.WIDTH, lineGap: 2 });
  doc.moveDown(0.25);
  doc.moveTo(PAGE.L, doc.y).lineTo(PAGE.R, doc.y).strokeColor(opts.gold ? BRAND.gold : BRAND.line).lineWidth(opts.gold ? 1.3 : 1).stroke();
  doc.moveDown(0.5);
  doc.x = PAGE.L;
}

function writeSubheading(doc, text) {
  const t = cleanText(text);
  const h = doc.font('Helvetica-Bold').fontSize(10.5).heightOfString(t, { width: PAGE.WIDTH }) + 8;
  ensureSpace(doc, h);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(BRAND.navy).text(t, PAGE.L, doc.y, { width: PAGE.WIDTH });
  doc.moveDown(0.2);
  doc.x = PAGE.L;
}

function writePara(doc, text, opts = {}) {
  const content = cleanText(text || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const size = opts.size || 10.1;
  for (const para of content.length ? content : ['—']) {
    const h = doc.font('Helvetica').fontSize(size).heightOfString(para, { width: PAGE.WIDTH, lineGap: 3 }) + 8;
    ensureSpace(doc, h);
    doc.font('Helvetica').fontSize(size).fillColor(BRAND.text).text(para, PAGE.L, doc.y, { width: PAGE.WIDTH, align: 'left', lineGap: 3 });
    doc.moveDown(opts.after ?? 0.45);
    doc.x = PAGE.L;
  }
}

function writeBullet(doc, text) {
  const t = cleanText(text);
  const h = doc.font('Helvetica').fontSize(9.7).heightOfString(t, { width: 465, lineGap: 2 }) + 5;
  ensureSpace(doc, h);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(9.7).fillColor(BRAND.navy).text('•', PAGE.L, y, { width: 12, lineBreak: false });
  doc.font('Helvetica').fontSize(9.7).fillColor(BRAND.text).text(t, PAGE.L + 16, y, { width: 465, lineGap: 2 });
  doc.moveDown(0.22);
  doc.x = PAGE.L;
}

function writeKeyValue(doc, label, value) {
  const l = cleanText(label).toUpperCase();
  const v = cleanText(value);
  const h = Math.max(
    doc.font('Helvetica-Bold').fontSize(8.2).heightOfString(l, { width: 150 }),
    doc.font('Helvetica').fontSize(9.4).heightOfString(v, { width: 330, lineGap: 2 })
  ) + 10;
  ensureSpace(doc, h);
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(8.2).fillColor(BRAND.muted).text(l, PAGE.L, y + 2, { width: 155 });
  doc.font('Helvetica').fontSize(9.4).fillColor(BRAND.ink).text(v, PAGE.L + 170, y, { width: 325, lineGap: 2 });
  doc.y = y + h;
  doc.x = PAGE.L;
}

function writeCard(doc, title, rows) {
  const cleanedRows = rows.map(([l, v]) => [cleanText(l), cleanText(v)]);
  let totalH = 18;
  for (const [l, v] of cleanedRows) {
    totalH += Math.max(
      doc.font('Helvetica-Bold').fontSize(8.2).heightOfString(l.toUpperCase(), { width: 145 }),
      doc.font('Helvetica').fontSize(9.4).heightOfString(v, { width: 300, lineGap: 2 })
    ) + 10;
  }
  totalH += title ? 24 : 0;
  ensureSpace(doc, totalH + 8);
  const startY = doc.y;
  doc.roundedRect(PAGE.L, startY, PAGE.WIDTH, totalH, 12).fillAndStroke(BRAND.soft, BRAND.line);
  let y = startY + 14;
  if (title) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.navy).text(cleanText(title), PAGE.L + 16, y, { width: 460 });
    y += 24;
  }
  for (const [l, v] of cleanedRows) {
    doc.font('Helvetica-Bold').fontSize(8.2).fillColor(BRAND.muted).text(l.toUpperCase(), PAGE.L + 16, y + 2, { width: 145 });
    const h = doc.font('Helvetica').fontSize(9.4).heightOfString(v, { width: 300, lineGap: 2 });
    doc.fillColor(BRAND.ink).text(v, PAGE.L + 180, y, { width: 295, lineGap: 2 });
    y += Math.max(16, h) + 10;
  }
  doc.y = startY + totalH + 12;
  doc.x = PAGE.L;
}

function writePathwayBlock(doc, pathway, position, strength, verification) {
  const body = `Current position: ${cleanText(position)}\nPotential strength: ${cleanText(strength)}\nVerification area: ${cleanText(verification)}`;
  const h = doc.font('Helvetica').fontSize(9.5).heightOfString(body, { width: 465, lineGap: 2 }) + 36;
  ensureSpace(doc, h);
  doc.font('Helvetica-Bold').fontSize(10.6).fillColor(BRAND.navy).text(cleanText(pathway), PAGE.L, doc.y, { width: PAGE.WIDTH });
  doc.moveDown(0.15);
  doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.text).text(body, PAGE.L + 12, doc.y, { width: 465, lineGap: 2 });
  doc.moveDown(0.45);
  doc.x = PAGE.L;
}

function drawCover(doc, meta) {
  doc.addPage({ size: 'A4', margin: 50 });
  doc.rect(0, 0, PAGE.W, PAGE.H).fill('#ffffff');
  doc.rect(0, 0, PAGE.W, 250).fill(BRAND.navy);
  doc.rect(0, 250, PAGE.W, 8).fill(BRAND.gold);
  doc.circle(520, 80, 95).fillOpacity(0.12).fill(BRAND.blue).fillOpacity(1);
  doc.circle(470, 170, 48).fillOpacity(0.12).fill(BRAND.gold).fillOpacity(1);

  doc.font('Helvetica-Bold').fontSize(28).fillColor('#ffffff').text('Bircan Migration', PAGE.L, 56, { width: 360 });
  doc.font('Helvetica').fontSize(11).fillColor('#dce7f8').text('Migration & Education | Professional Migration Assessment', PAGE.L, 92, { width: 420 });
  doc.moveTo(PAGE.L, 126).lineTo(236, 126).strokeColor(BRAND.gold).lineWidth(1.5).stroke();
  doc.font('Helvetica-Bold').fontSize(31).fillColor('#ffffff').text('Preliminary Migration\nAssessment Report', PAGE.L, 142, { width: 430, lineGap: 5 });
  doc.font('Helvetica').fontSize(12).fillColor('#dce7f8').text(meta.title, PAGE.L, 220, { width: 450 });

  const y = 315;
  const rows = [
    ['Reference', meta.reference],
    ["Applicant's Name", meta.applicantName],
    ['Applicant Email', meta.applicantEmail],
    ['Client Email', meta.clientEmail],
    ['Subclass', meta.subclass],
    ['Stream', meta.stream],
    ['Generated', meta.generatedAt]
  ];
  const boxH = 292;
  doc.roundedRect(PAGE.L, y, PAGE.WIDTH, boxH, 18).fillAndStroke(BRAND.soft, BRAND.line);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(BRAND.navy).text('Matter details', 78, y + 26);
  let yy = y + 62;
  for (const [label, value] of rows) {
    doc.font('Helvetica-Bold').fontSize(8.6).fillColor(BRAND.muted).text(label.toUpperCase(), 78, yy, { width: 145 });
    doc.font('Helvetica').fontSize(10).fillColor(BRAND.ink).text(cleanText(value), 222, yy, { width: 285, lineGap: 2 });
    yy += 27;
  }

  doc.roundedRect(PAGE.L, 642, PAGE.WIDTH, 88, 16).fillAndStroke('#fffaf0', '#f0d99b');
  doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.navy).text('Confidential preliminary advice', 78, 662);
  doc.font('Helvetica').fontSize(9.3).fillColor(BRAND.text).text('This report is prepared for preliminary migration assessment purposes only. It is based on the information provided through the assessment system and remains subject to verification of original documents, conflict checks, current law and professional review before any lodgement action.', 78, 683, { width: 440, lineGap: 3 });
}

function buildExecutiveNarrative({ subclass, stream, position, issue }) {
  return `I have reviewed the information presently available in relation to a proposed Subclass ${subclass} Employer Nomination Scheme pathway under the ${stream} stream. At this stage, the matter appears suitable for further professional review; however, the present information does not yet support a final lodgement recommendation without further evidence verification.

The overall pathway position presently turns on ${issue}. In practical terms, the matter should be approached through a structured review of the sponsoring employer position, nomination connection, occupation alignment, employment history, stream-specific requirements and supporting documentation.

This report should be treated as a preliminary professional migration assessment prepared for evidence planning, strategic review and migration-agent consideration. It does not replace final written advice following review of original documents and confirmation of the law and policy settings applicable at the relevant time.`;
}

function buildStreamNarrative(stream) {
  if (stream === 'Temporary Residence Transition') {
    return 'The Temporary Residence Transition stream should be reviewed by reference to the applicant’s eligible 457/482 visa history, employment continuity, sponsor continuity, occupation continuity and any periods of unpaid leave, stand-down or concession reliance. Payroll, taxation and superannuation records should be reconciled against the claimed employment period before final pathway positioning is confirmed.';
  }
  if (stream === 'Direct Entry') {
    return 'The Direct Entry stream should be reviewed by reference to the nominated occupation, skills assessment position, relevant employment history, qualifications and any mandatory registration or licensing requirement. The evidence should demonstrate that the applicant’s background aligns with the occupation and stream requirements.';
  }
  if (stream === 'Labour Agreement') {
    return 'The Labour Agreement stream introduces additional considerations because eligibility may depend on the specific agreement terms applying to the sponsoring employer. The agreement instrument should be checked for occupation coverage, concession availability, salary framework, English or age concessions, nomination limitations and employer compliance obligations before any final strategy is adopted.';
  }
  return 'The intended stream should be confirmed before final advice is issued. Once confirmed, the matter should be assessed against the specific TRT, Direct Entry or Labour Agreement requirements and the evidence should be organised accordingly.';
}

function buildPathwayRows(stream) {
  return [
    ['186 TRT', stream === 'Temporary Residence Transition' ? 'Primary pathway for professional review' : 'Further evidentiary review recommended', 'Employment continuity', 'Payroll and sponsor continuity records'],
    ['186 Direct Entry', stream === 'Direct Entry' ? 'Primary pathway for professional review' : 'Further evidentiary review recommended', 'Occupation alignment', 'Skills assessment and employment evidence'],
    ['186 Labour Agreement', stream === 'Labour Agreement' ? 'Primary pathway for professional review' : 'Available only if agreement terms apply', 'Agreement-based concessions may assist', 'Agreement coverage and employer compliance'],
    ['482 Employer Sponsored', 'Alternative pathway may warrant review', 'Sponsorship structure', 'Eligibility and occupation clarification'],
    ['494 Regional', 'Alternative pathway may warrant review', 'Regional sponsorship pathway', 'Regional eligibility and employer location']
  ];
}

function buildAssessmentPdfBuffer(assessment, adviceBundle) {
  if (!adviceBundle) throw new Error('Advice-grade PDF generation requires adviceBundle.');

  return new Promise((resolve, reject) => {
    try {
      const advice = getAdvice(adviceBundle);
      if (!advice) return reject(new Error('Advice-grade PDF generation requires adviceBundle.advice.'));

      const facts = extractFactsObject(assessment || {}, adviceBundle || {});
      const subclass = cleanText(advice.subclass || assessment.visa_type || deepPick(facts, ['subclass', 'visaSubclass', 'visa_type'], '186'));
      const stream = inferStream(assessment || {}, adviceBundle || {}, advice || {});
      const generatedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
      const title = `Subclass ${subclass} Employer Nomination Scheme preliminary assessment`;
      const applicantName = inferApplicantName(assessment || {}, adviceBundle || {}, facts || {});
      const applicantEmail = inferApplicantEmail(assessment || {}, facts || {});
      const clientEmail = cleanText(assessment.client_email || deepPick(facts, ['clientEmail', 'client_email'], applicantEmail));
      const position = professionalPosition(adviceBundle || {}, advice || {});
      const issue = primaryIssue(adviceBundle || {}, advice || {});
      const findings = (advice.criterion_findings || adviceBundle.criterionFindings || adviceBundle.findings || []).map(normaliseCriterionFinding);
      const evidenceItems = collectEvidence(advice || {}, adviceBundle || {});

      const doc = createDoc({
        Title: `Bircan Migration - ${title}`,
        Author: 'Bircan Migration & Education',
        Subject: `Senior migration agent preliminary advice for assessment ${assessment.id || ''}`
      });

      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      drawCover(doc, { title, reference: assessment.id || '—', applicantName, applicantEmail, clientEmail, subclass, stream, generatedAt });
      addPage(doc);

      writeTitle(doc, 'Executive overview', { gold: true, size: 17 });
      writePara(doc, buildExecutiveNarrative({ subclass, stream, position, issue }), { size: 10.4 });

      writeCard(doc, 'Current professional position', [
        ['Current information position', position],
        ['Primary review focus', issue],
        ['Selected stream indicator', stream],
        ['Assessment type', 'Preliminary migration assessment — subject to verification'],
        ['Professional boundary', 'No lodgement action should occur until original documents and current legal settings are reviewed']
      ]);

      writeTitle(doc, 'Matter snapshot');
      writeCard(doc, '', [
        ['Reference', assessment.id || '—'],
        ["Applicant's Name", applicantName],
        ['Applicant email', applicantEmail],
        ['Client account email', clientEmail],
        ['Subclass', subclass],
        ['Stream', stream],
        ['Generated', generatedAt]
      ]);

      writeTitle(doc, 'Pathway positioning summary');
      writePara(doc, 'The following positioning summary is a professional planning tool only. It does not replace final legal advice. It identifies the migration pathways that may require further review once the employer, nomination, occupation and applicant evidence positions are properly verified.', { size: 9.8 });
      for (const row of buildPathwayRows(stream)) writePathwayBlock(doc, ...row);

      writeTitle(doc, 'Stream analysis');
      writePara(doc, buildStreamNarrative(stream));

      writeTitle(doc, 'Sponsoring employer position');
      writePara(doc, 'Based on the information presently available, the sponsoring employer position requires professional review against the business structure, operational activity, payroll capacity, commercial need for the role and availability of the nominated position. This is not an adverse finding. It simply means that the employer evidence should be organised so that the nomination can be assessed in a coherent and commercially credible way.');

      writeTitle(doc, 'Occupation and ANZSCO alignment');
      writePara(doc, 'The nominated role should be assessed against the proposed occupation classification, including actual duties, reporting hierarchy, seniority level, technical responsibilities, qualifications and employment history. Where a role contains mixed duties or broader operational responsibilities, the supporting evidence should explain why the nominated occupation remains the best fit for the position and for the applicant’s background.');

      writeTitle(doc, 'Employment and timeline position');
      writePara(doc, 'The employment chronology should be reconciled against visa history, payroll records, taxation records, superannuation records, employment references and any leave or stand-down periods. In employer-sponsored matters, inconsistencies between claimed employment periods and payroll or visa records may attract closer scrutiny and should be resolved before lodgement strategy is finalised.');

      const verification = uniqueClean([
        issue,
        ...findings.filter(f => criterionTone(f) !== 'capable').map(f => niceCriterionName(f.criterion)),
        ...evidenceItems.slice(0, 8)
      ]).slice(0, 10);
      writeTitle(doc, 'Verification priority areas');
      writePara(doc, 'The following areas should be clarified before final advice is issued. They are expressed as professional evidence priorities, not as final adverse findings against the applicant or sponsoring employer.');
      (verification.length ? verification : ['Employer and nomination documentation', 'Occupation alignment evidence', 'Employment and salary records', 'English, health and character evidence']).forEach(writeBullet.bind(null, doc));

      writeTitle(doc, 'Senior migration agent assessment');
      writePara(doc, 'The assessment below consolidates the key legal and evidentiary themes rather than simply repeating each visa criterion. The purpose is to identify what would need to be verified before a professional lodgement strategy could be recommended.');

      const seenCriteria = new Set();
      const important = [];
      for (const rawFinding of findings) {
        const built = buildMatterFinding(rawFinding);
        const key = built.criterion.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!key || seenCriteria.has(key)) continue;
        seenCriteria.add(key);
        important.push(built);
        if (important.length >= 8) break;
      }
      for (const item of important) {
        writeSubheading(doc, item.criterion);
        writeKeyValue(doc, 'Current position', item.position);
        writePara(doc, item.body, { size: 9.9 });
        writeKeyValue(doc, 'Evidence response', item.evidence);
      }

      writeTitle(doc, 'Evidence priority framework');
      const grouped = groupEvidence(evidenceItems);
      if (grouped.length) {
        for (const [group, items] of grouped.slice(0, 6)) {
          writeSubheading(doc, group);
          items.slice(0, 5).forEach(item => writeBullet(doc, item));
        }
      } else {
        writeSubheading(doc, 'Critical priority evidence');
        ['Employer operational records', 'Nomination structure documentation', 'Employment continuity and payroll material', 'Occupation alignment evidence', 'English, health and character records'].forEach(item => writeBullet(doc, item));
      }

      writeTitle(doc, 'Delegate review preparation considerations');
      writePara(doc, 'In employer-sponsored matters, departmental review commonly focuses on whether the nominated position is genuine, operationally required, commercially sustainable, consistent with the nominated occupation and appropriately supported by the sponsoring business structure. The evidence package should therefore present a clear connection between the employer’s operations, the nominated position, the applicant’s duties and the stream requirements.');
      ['Ensure nomination documents, business records and position duties tell a consistent story.', 'Reconcile payroll, taxation and superannuation evidence against the employment chronology.', 'Explain any unusual employment, visa-history or document-history issues before lodgement.', 'Avoid relying on broad statements where specific business or employment records are available.'].forEach(item => writeBullet(doc, item));

      writeTitle(doc, 'Alternative pathway observations');
      writePara(doc, 'Depending on the final evidence position, alternative employer-sponsored or skilled migration pathways may warrant separate review. Any such pathway should be assessed only after the occupation position, sponsorship structure, visa history, location factors and long-term migration objectives are properly considered.');
      ['186 stream positioning should be confirmed after nomination and stream-specific evidence is reviewed.', 'Temporary employer-sponsored alternatives may remain relevant depending on sponsor, occupation and visa history.', 'Regional or skilled pathways should be considered only after occupation, points and location factors are separately assessed.'].forEach(item => writeBullet(doc, item));

      writeTitle(doc, 'Recommended professional next steps');
      normaliseNextSteps(advice.client_next_steps || adviceBundle.recommendedNextSteps || adviceBundle.nextSteps || verification, advice).forEach(step => writeBullet(doc, step));

      writeTitle(doc, 'Final professional position', { gold: true });
      writePara(doc, `Based on the information presently available, the matter appears capable of progressing to further detailed professional review, subject to verification of supporting documentation, clarification of the identified evidence areas and confirmation of the applicable legislative and policy framework at the relevant time.

At this stage, the pathway should be approached as a preliminary professional assessment only. No final eligibility position should be relied upon until original documentation, sponsorship evidence, legislative requirements and policy considerations have been comprehensively reviewed.`);

      writeTitle(doc, 'Important notice');
      writePara(doc, advice.disclaimer || 'This report is prepared for preliminary migration assessment purposes only. It is based on information presently available at the time of preparation and remains subject to verification of original documents, confirmation of current law and policy, and professional review before any lodgement action. This report does not constitute a guarantee of visa grant outcome.');

      ensureSpace(doc, 80);
      doc.font('Helvetica').fontSize(10).fillColor(BRAND.ink).text('Yours faithfully,', PAGE.L, doc.y, { width: PAGE.WIDTH });
      doc.moveDown(0.55);
      doc.font('Helvetica-Bold').text('Kenan Bircan JP', PAGE.L, doc.y, { width: PAGE.WIDTH });
      doc.font('Helvetica').text('Registered Migration Agent | MARN: 1463685', PAGE.L, doc.y, { width: PAGE.WIDTH });
      doc.text('Bircan Migration & Education', PAGE.L, doc.y, { width: PAGE.WIDTH });
      doc.moveDown(0.8);
      doc.fontSize(8).fillColor(BRAND.muted).text('This document is preliminary migration advice and is subject to professional review, verification of original documents and confirmation of current law and policy.', PAGE.L, doc.y, { width: PAGE.WIDTH, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function buildAppealAdvicePdfBuffer(assessment, adviceBundle) {
  if (!adviceBundle) throw new Error('Appeals advice PDF generation requires adviceBundle.');
  return new Promise((resolve, reject) => {
    try {
      const advice = adviceBundle.advice || adviceBundle || {};
      const generatedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
      const title = advice.title || `Visa refusal review advice — Subclass ${assessment.visa_subclass || ''}`;
      const doc = createDoc({ Title: `Bircan Migration - ${title}`, Author: 'Bircan Migration & Education', Subject: `Appeals advice letter for ${assessment.id || ''}` });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('error', reject);
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      drawCover(doc, {
        title,
        reference: assessment.id || '—',
        applicantName: assessment.applicant_name || advice.decision_record_applicant || '—',
        applicantEmail: assessment.applicant_email || assessment.client_email || '—',
        clientEmail: assessment.client_email || '—',
        subclass: assessment.visa_subclass || '—',
        stream: assessment.decision_type || 'Review matter',
        generatedAt
      });
      addPage(doc, 'Appeals Preliminary Advice Report');
      writeTitle(doc, 'Executive advice', { gold: true, size: 17 });
      writePara(doc, advice.executive_summary || 'I have reviewed the information and uploaded decision material provided for this refusal review assessment. The matter requires careful review of the refusal grounds, evidence position, review deadline and prospects before any review strategy is confirmed.');
      writeTitle(doc, 'Refusal grounds identified');
      const grounds = uniqueClean(advice.refusal_grounds || advice.refusalGrounds || []);
      if (grounds.length) grounds.forEach(g => writeBullet(doc, g)); else writePara(doc, 'The uploaded decision material should be reviewed against the Department’s stated reasons for refusal.');
      writeTitle(doc, 'Legal issues for review');
      const legalIssues = uniqueClean(advice.legal_issues || advice.legalIssues || []);
      if (legalIssues.length) legalIssues.forEach(i => writeBullet(doc, i)); else writePara(doc, 'The legal issues must be mapped to the exact criteria the Department was not satisfied were met.');
      writeTitle(doc, 'Evidence gaps and document weaknesses');
      const evidence = uniqueClean(advice.evidence_position || advice.evidencePosition || advice.evidence_gap_table || advice.evidenceGapTable || []);
      if (evidence.length) evidence.forEach(e => writeBullet(doc, e)); else writePara(doc, 'Further evidence review is required. Any new evidence should directly respond to the refusal reasons, address inconsistencies and be organised by issue.');
      writeTitle(doc, 'Merits review strategy');
      writePara(doc, advice.strategy || 'The review strategy should focus on answering each refusal reason directly, identifying any weakness in the Department’s reasoning and preparing further evidence that was missing, unclear or insufficient at the time of decision.');
      writeTitle(doc, 'Recommended next steps');
      uniqueClean(advice.next_steps || advice.nextSteps || ['Confirm the review deadline and lodge any review application within time.', 'Prepare an indexed evidence schedule responding to each refusal ground.', 'Obtain further documents or statements addressing the Department’s concerns.', 'Arrange professional review before lodging submissions or further evidence.']).forEach(step => writeBullet(doc, step));
      writeTitle(doc, 'Important notice');
      writePara(doc, advice.disclaimer || 'This advice is preliminary only and must be verified against the complete Department record, current law, review jurisdiction and original evidence before any final legal strategy is adopted.');
      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = { buildAssessmentPdfBuffer, buildAppealAdvicePdfBuffer, sha256 };
