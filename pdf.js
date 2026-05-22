'use strict';

/**
 * Bircan Migration pdf.js — server-contract renderer v110
 *
 * Rendering-only module for server.js.
 * - Receives the client-facing advice bundle produced by server.js.
 * - Does not create legal advice.
 * - Deduplicates repeated findings at render time as a final safety net.
 * - Blocks unsafe/internal/debug material before a client PDF is issued.
 * - Uses paragraph/card layout instead of dense tables to avoid overflow.
 */

const crypto = require('crypto');
const PDFDocument = require('pdfkit');

const RENDERER_VERSION = 'pdf-js-server-contract-renderer-v111-20260522-polished';

const BRAND = {
  name: 'Bircan Migration & Education',
  subtitle: 'Professional Migration Assessment',
  agent: 'Kenan Bircan JP',
  marn: '1463685'
};

const INTERNAL_KEYS = new Set([
  'internalLegalAudit', 'internalAuditObject', 'criteriaRegistryAudit', 'rawRegistryFindings',
  'criteriaRegistryFindings', 'debug', 'rawDebug', 'sourceHash', 'sourceHashes', 'quality_flags'
]);

const FORBIDDEN_CLIENT_PHRASES = [
  'Registry-controlled pathway',
  'Registry controlled pathway',
  'Grant Criterion Control',
  'Subclass Specific Grant Criterion',
  'Map the original evidence to the clause',
  'Primary pathway',
  'quality_flags',
  'source hash',
  'internalLegalAudit',
  'rawRegistryFindings',
  'criteriaRegistryAudit'
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(v => v !== undefined && v !== null && v !== '') : [value];
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}


function humanizeObject(value) {
  if (!isPlainObject(value)) return '';
  const issue = pick(value.issue, value.title, value.area, value.criterion, value.criterionLabel, value.criterionName);
  const evidence = pick(value.requiredEvidence, value.evidenceRequired, value.evidence, value.documentsRequired, value.evidenceGap);
  const action = pick(value.requiredAction, value.action, value.recommendation, value.nextStep);
  const position = pick(value.position, value.summary, value.fullText, value.finding, value.professionalPosition);
  const risk = pick(value.overallRisk, value.risk, value.riskLevel, value.status, value.statusLabel);
  const parts = [];
  if (issue) parts.push(String(issue));
  if (position) parts.push(String(position));
  if (risk) parts.push(`Risk/status: ${String(risk)}`);
  if (evidence) parts.push(`Evidence required: ${Array.isArray(evidence) ? evidence.join(', ') : String(evidence)}`);
  if (action) parts.push(`Action: ${String(action)}`);
  if (parts.length) return parts.join(' — ');
  return Object.entries(value)
    .filter(([k, v]) => !INTERNAL_KEYS.has(k) && v !== undefined && v !== null && v !== '')
    .slice(0, 6)
    .map(([k, v]) => `${String(k).replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}: ${Array.isArray(v) ? v.join(', ') : (isPlainObject(v) ? humanizeObject(v) : String(v))}`)
    .join('; ');
}

function professionalStatus(value) {
  const s = String(value || '').toLowerCase().trim();
  if (!s) return 'Not verified';
  if (/likely[_\s-]*satisfied|appears supportable|supportable/.test(s)) return 'Appears supportable, subject to evidence';
  if (/not[_\s-]*satisfied|adverse|not supportable/.test(s)) return 'Presently adverse on current information';
  if (/not[_\s-]*applicable|n\/a/.test(s)) return 'Not presently applicable';
  if (/manual[_\s-]*review|required/.test(s)) return 'Requires migration-agent review';
  if (/unclear|unknown|review|required|verify|reconcil/.test(s)) return 'Requires evidence reconciliation';
  return cleanClientText(value);
}

function uniqueByNormalised(items) {
  const seen = new Set();
  const out = [];
  for (const item of asArray(items)) {
    const text = body(isPlainObject(item) ? humanizeObject(item) : item);
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function toText(value, fallback = '—') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.map(v => toText(v, '')).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') return humanizeObject(value) || fallback;
  return String(value);
}

function cleanClientText(value) {
  if (value === undefined || value === null) return '';
  let out = String(value)
    .normalize('NFKC')
    .replace(/[\uFFFC-\uFFFF]/g, ' ')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\u00AD/g, '')
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
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Render-time score normalisation safety net: if upstream sent IELTS 65, display 6.5.
  if (/\bIELTS\b/i.test(out)) {
    out = out.replace(/\b(listening|reading|writing|speaking)\s+([0-9]{2})(\b|[,;)])/gi, (m, comp, raw, end) => {
      const n = Number(raw);
      if (n >= 10 && n <= 90) return `${comp} ${(n / 10).toFixed(1).replace(/\.0$/, '.0')}${end}`;
      return m;
    });
  }
  return out;
}

function wrapLongTokens(value, max = 42) {
  return String(value || '').split(/(\s+)/).map(part => {
    if (/\s+/.test(part) || part.length <= max) return part;
    return part.replace(new RegExp(`(.{1,${max}})`, 'g'), '$1 ').trim();
  }).join('');
}

function body(value) {
  return wrapLongTokens(cleanClientText(toText(value, '')))
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function deepClean(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return cleanClientText(value);
  if (Array.isArray(value)) return value.map(v => deepClean(v, seen));
  if (isPlainObject(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (INTERNAL_KEYS.has(key)) continue;
      out[key] = deepClean(val, seen);
    }
    return out;
  }
  return value;
}

function flattenStrings(value, out = [], seen = new WeakSet()) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'string') { out.push(value); return out; }
  if (Array.isArray(value)) { value.forEach(v => flattenStrings(v, out, seen)); return out; }
  if (isPlainObject(value)) {
    if (seen.has(value)) return out;
    seen.add(value);
    for (const [key, val] of Object.entries(value)) {
      out.push(String(key));
      flattenStrings(val, out, seen);
    }
  }
  return out;
}

function assertNoForbiddenClientText(model, stage = 'PDF') {
  const all = flattenStrings(model).join('\n');
  for (const phrase of FORBIDDEN_CLIENT_PHRASES) {
    if (all.includes(phrase)) throw new Error(`${stage} blocked: forbidden fallback/internal wording leaked into advice letter: ${phrase}`);
  }
  for (const key of INTERNAL_KEYS) {
    if (all.includes(key)) throw new Error(`${stage} blocked: internal audit field leaked into client PDF: ${key}`);
  }
}

function assertNoWrongSubclassLeak(model, subclass) {
  const subclassText = String(subclass || '').trim();
  if (!/^\d{3}$/.test(subclassText)) return;
  const all = flattenStrings(model).join('\n');
  const matches = all.match(/\bSubclass\s+(\d{3})\b/gi) || [];
  for (const match of matches) {
    const n = (match.match(/\d{3}/) || [])[0];
    if (n && n !== subclassText) throw new Error(`PDF blocked: wrong subclass legal frame leaked into Subclass ${subclassText}: ${match}`);
  }
}

function getAdviceModel(bundle) {
  const b = bundle || {};
  return deepClean(pick(
    b.clientAdviceObject,
    b.universalAdviceModel,
    b.seniorAdviceModel,
    b.adviceModel,
    b.advice && b.advice.clientAdviceObject,
    b.advice && b.advice.universalAdviceModel,
    b.advice && b.advice.seniorAdviceModel,
    b.advice,
    b
  ));
}

function getSubclass(assessment, bundle, model) {
  return String(pick(
    assessment.subclass, assessment.visa_type, assessment.visa_subclass, assessment.visaSubclass,
    model.subclass, model.visaSubclass,
    bundle.subclass, bundle.visaSubclass,
    bundle.advice && (bundle.advice.subclass || bundle.advice.visaSubclass)
  ) || '').replace(/[^0-9]/g, '').slice(0, 3);
}

function getStream(assessment, bundle, model) {
  return cleanClientText(pick(
    model.streamLabel, model.stream, model.pathway, model.clientFacingStream,
    bundle.streamLabel, bundle.stream, bundle.pathway, bundle.clientFacingStream,
    bundle.advice && (bundle.advice.streamLabel || bundle.advice.stream || bundle.advice.pathway),
    assessment.streamLabel, assessment.stream, assessment.pathway, assessment.selected_stream, assessment.selectedStream, assessment.visa_stream
  ));
}

function isUnresolvedStream(value) {
  return /registry-controlled|registry controlled|primary pathway|generic pathway|stream\/pathway|not confirmed/i.test(String(value || ''));
}

function findingTitle(f) {
  if (!isPlainObject(f)) return body(f);
  return body(pick(f.issue, f.title, f.label, f.criterionLabel, f.criterionName, f.name, f.criterion, f.criterionId, 'Legal requirement'));
}

function findingStatus(f) {
  if (!isPlainObject(f)) return 'Not verified';
  return professionalStatus(pick(f.professionalStatus, f.statusLabel, f.status, f.finding, f.riskLevel, f.risk, f.evidenceStatus, 'Not verified'));
}

function findingRequirement(f) {
  if (!isPlainObject(f)) return '';
  return body(pick(f.legalRequirement, f.requirement, f.legalTest, f.rule, f.whatMustBeEstablished, f.assessmentRequired, f.legislativeRequirement));
}

function findingFacts(f) {
  if (!isPlainObject(f)) return '';
  return body(pick(f.clientFacts, f.factsApplied, f.currentPosition, f.presentInformation, f.evidenceHeld, f.filePosition, f.applicationToFacts));
}

function findingGap(f) {
  if (!isPlainObject(f)) return '';
  return body(pick(f.evidenceGap, f.evidenceMissing, f.gap, f.requiredEvidence, f.documentsRequired, f.evidence));
}

function findingConsequence(f) {
  if (!isPlainObject(f)) return '';
  return body(pick(f.consequence, f.legalConsequence, f.consequenceOfFailure, f.riskIfMissing, f.whyItMatters, f.delegateRisk));
}

function findingAction(f) {
  if (!isPlainObject(f)) return '';
  return body(pick(f.requiredAction, f.action, f.recommendation, f.seniorOpinion, f.agentOpinion, f.professionalPosition, f.strategy));
}


function buildForcedAgeFindingFromAnswers(assessment, subclass, stream) {
  const flat = flattenObject(collectAnswers(assessment));
  const entries = Object.entries(flat);
  const get = (patterns) => {
    for (const re of patterns) {
      const hit = entries.find(([k]) => re.test(k));
      if (hit) return hit[1];
    }
    return '';
  };
  const dob = get([/date[-_\s]*of[-_\s]*birth/i, /dob/i, /birth/i]);
  const age = get([/age[-_\s]*at[-_\s]*application/i, /applicant[-_\s]*age/i, /\bage\b/i]);
  const exemption = get([/age[-_\s]*exemption/i, /age[-_\s]*concession/i, /high[-_\s]*income/i, /earnings/i]);
  const factBits = [];
  if (age) factBits.push(`recorded age/intended age: ${body(age)}`);
  if (dob) factBits.push(`date of birth recorded`);
  if (exemption) factBits.push(`age exemption/concession indicator: ${body(exemption)}`);
  return {
    issue: 'Age',
    title: 'Age',
    criterion: 'Age',
    criterionLabel: 'Age',
    criterionName: 'Age',
    area: 'age',
    status: 'unclear',
    displayStatus: 'Unclear - age evidence required',
    riskLevel: 'High',
    materiality: 'material',
    legalRequirement: `The applicant must satisfy the applicable Subclass ${subclass}${stream ? ` ${stream}` : ''} age setting or establish a valid exemption or concession before lodgement-ready advice is released.`,
    clientFacts: factBits.length ? `The saved assessment includes age-related information (${factBits.join('; ')}). This must be reconciled against identity evidence and the selected Subclass ${subclass} stream.` : 'The saved assessment includes age/date-of-birth information which must be assessed against the selected stream.',
    evidenceGap: 'Passport bio page/date-of-birth evidence and any age exemption, concession, high-income, labour agreement or DAMA material.',
    consequence: 'If the age setting is not satisfied and no exemption or concession applies, the selected pathway may not be viable.',
    requiredAction: 'Confirm age at the relevant time and verify whether any age exemption or concession applies before final advice.',
    insertedByPdfQualityGate: true
  };
}

function ensureRendererMandatoryFindings(assessment, subclass, stream, findings) {
  const out = Array.isArray(findings) ? [...findings] : [];
  const keys = new Set(out.map(criterionKey));
  if (hasAnswerMatching(assessment, /\bage\b|date[-_\s]*of[-_\s]*birth|birth/i) && !keys.has('age')) {
    out.push(buildForcedAgeFindingFromAnswers(assessment, subclass, stream));
  }
  return out;
}

function criterionKey(f) {
  const title = findingTitle(f).toLowerCase();
  if (/english/.test(title)) return 'english';
  if (/age/.test(title)) return 'age';
  if (/salary|market|remuneration|amsr/.test(title)) return 'salary-market';
  if (/skill|qualification|occupation pathway/.test(title)) return 'skills';
  if (/occupation|anzsco|duties/.test(title)) return 'occupation';
  if (/sponsor|employer|nomination|genuine position|operational need/.test(title)) return 'nomination-employer';
  if (/health/.test(title)) return 'health';
  if (/character|integrity|public interest|pic/.test(title)) return 'character-integrity';
  if (/migration history|compliance|refusal|cancellation|section 48|8503/.test(title)) return 'migration-history';
  if (/identity|valid|application/.test(title)) return 'validity-identity';
  return title.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'criterion';
}

function findingScore(f) {
  return [findingRequirement(f), findingFacts(f), findingGap(f), findingConsequence(f), findingAction(f)].filter(Boolean).join(' ').length;
}

function dedupeFindings(findings) {
  const map = new Map();
  for (const raw of asArray(findings)) {
    const f = deepClean(raw);
    const key = criterionKey(f);
    const previous = map.get(key);
    if (!previous || findingScore(f) > findingScore(previous)) map.set(key, f);
  }
  return Array.from(map.values());
}

function collectFindings(model, bundle) {
  const candidates = [
    model.criteriaFindings,
    model.seniorCriteriaFindings,
    model.grantCriteriaFindings,
    model.clientFacingCriteriaFindings,
    model.criterion_findings,
    model.eligibilityFindings,
    model.riskFindings,
    model.legalIssues,
    model.issues,
    bundle.seniorCriteriaFindings,
    bundle.clientFacingCriteriaFindings,
    bundle.grantCriteriaFindings,
    bundle.criterion_findings,
    bundle.advice && bundle.advice.seniorCriteriaFindings,
    bundle.advice && bundle.advice.grantCriteriaFindings,
    bundle.advice && bundle.advice.criterion_findings
  ];
  for (const candidate of candidates) {
    const arr = asArray(candidate);
    if (arr.length) return dedupeFindings(arr);
  }
  return [];
}

function collectAnswers(assessment) {
  const p = isPlainObject(assessment.form_payload) ? assessment.form_payload : {};
  const answers = isPlainObject(p.answers) ? p.answers : isPlainObject(p.formPayload) ? p.formPayload : p;
  return isPlainObject(answers) ? answers : {};
}

function flattenObject(input, prefix = '', out = {}) {
  if (!isPlainObject(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) flattenObject(value, name, out);
    else if (Array.isArray(value)) out[name] = value.join('; ');
    else if (value !== undefined && value !== null && value !== '') out[name] = value;
  }
  return out;
}

function hasAnswerMatching(assessment, re) {
  const flat = flattenObject(collectAnswers(assessment));
  return Object.entries(flat).some(([k, v]) => re.test(`${k} ${v}`));
}

function assertAdviceModelReady(assessment, bundle, model, subclass, stream, findings) {
  if (!bundle) throw new Error('Advice-grade PDF generation requires adviceBundle.');
  if (!subclass) throw new Error('Advice-grade PDF blocked: subclass could not be identified.');
  if (!stream || isUnresolvedStream(stream)) throw new Error(`Advice-grade PDF blocked: valid stream/pathway not confirmed for Subclass ${subclass}.`);
  if (!findings.length) throw new Error(`Advice-grade PDF blocked: no criterion-level senior advice findings were supplied for Subclass ${subclass}.`);

  const substantive = findings.filter(f => findingRequirement(f) || findingFacts(f) || findingGap(f) || findingConsequence(f) || findingAction(f));
  if (!substantive.length) throw new Error(`Advice-grade PDF blocked: criterion findings for Subclass ${subclass} do not contain legal-frame or fact-application content.`);

  // Renderer quality gate: if saved answers clearly include age or English, final client model must contain corresponding findings.
  const keys = new Set(findings.map(criterionKey));
  if (hasAnswerMatching(assessment, /\bage\b|date[-_\s]*of[-_\s]*birth|birth/i) && !keys.has('age')) {
    throw new Error(`Advice-grade PDF blocked: saved age/date-of-birth answers exist but no age criterion finding was supplied for Subclass ${subclass}.`);
  }
  if (hasAnswerMatching(assessment, /english|ielts|pte|toefl|oet|cambridge|listening|reading|writing|speaking/i) && !keys.has('english')) {
    throw new Error(`Advice-grade PDF blocked: saved English answers exist but no English criterion finding was supplied for Subclass ${subclass}.`);
  }

  assertNoForbiddenClientText({ assessment, model, findings, subclass, stream }, 'PDF');
  assertNoWrongSubclassLeak({ model, findings, stream }, subclass);
}

function createDoc(resolve, reject) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 54, bottom: 54, left: 54, right: 54 },
    bufferPages: true,
    info: { Title: 'Professional Migration Advice Letter', Author: BRAND.name, Subject: 'Migration advice letter', Creator: BRAND.name }
  });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
  return doc;
}

function pageWidth(doc) { return doc.page.width - doc.page.margins.left - doc.page.margins.right; }
function bottomY(doc) { return doc.page.height - doc.page.margins.bottom; }
function remainingY(doc) { return bottomY(doc) - doc.y; }
function ensureSpace(doc, h = 90) { if (doc.y + h > bottomY(doc)) doc.addPage(); }
function measure(doc, text, width, font = 'Helvetica', size = 9.2, lineGap = 3) {
  doc.font(font).fontSize(size);
  return doc.heightOfString(body(text), { width, lineGap });
}
function ensureMeasured(doc, text, width, options = {}) {
  const h = measure(doc, text, width, options.bold ? 'Helvetica-Bold' : 'Helvetica', options.size || 9.2, options.lineGap || 3) + (options.extra || 12);
  if (h < 580 && remainingY(doc) < h) doc.addPage();
}
function rule(doc) {
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#d7deea').lineWidth(0.7).stroke();
  doc.moveDown(0.55);
}
function h1(doc, value) {
  ensureSpace(doc, 70);
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#0b2545').text(cleanClientText(value), { width: pageWidth(doc), lineGap: 2.4 });
  doc.moveDown(0.4); rule(doc);
}
function h2(doc, value) {
  ensureSpace(doc, 50);
  doc.moveDown(0.25);
  doc.font('Helvetica-Bold').fontSize(11.2).fillColor('#12355b').text(cleanClientText(value), { width: pageWidth(doc), lineGap: 2.2 });
  doc.moveDown(0.25);
}
function p(doc, value, options = {}) {
  const b = body(value); if (!b) return;
  const width = options.width || pageWidth(doc);
  const paras = b.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
  for (const para of paras) {
    ensureMeasured(doc, para, width, options);
    doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(options.size || 9.2).fillColor(options.color || '#182334')
      .text(para, { width, lineGap: options.lineGap || 3.1, align: options.align || 'left' });
    doc.moveDown(options.after === undefined ? 0.48 : options.after);
  }
}
function bullet(doc, value) {
  const b = body(value); if (!b) return;
  const x = doc.page.margins.left + 12;
  const width = pageWidth(doc) - 18;
  ensureMeasured(doc, b, width, { size: 9, lineGap: 2.7, extra: 8 });
  doc.font('Helvetica').fontSize(9).fillColor('#182334').text('•', doc.page.margins.left, doc.y, { continued: true });
  doc.text(' ' + b, x, doc.y, { width, lineGap: 2.7 });
  doc.moveDown(0.35);
}
function keyValue(doc, rows) {
  const usable = pageWidth(doc), leftW = Math.round(usable * 0.34), rightW = usable - leftW, pad = 7;
  for (const [k, v] of rows) {
    const kk = body(k), vv = body(v || '—');
    const kh = measure(doc, kk, leftW - pad * 2, 'Helvetica-Bold', 8.4, 2);
    const vh = measure(doc, vv, rightW - pad * 2, 'Helvetica', 8.4, 2.2);
    const h = Math.max(kh, vh, 14) + 14;
    ensureSpace(doc, h + 4);
    const y = doc.y;
    doc.rect(doc.page.margins.left, y, usable, h).fillAndStroke('#f8fafc', '#e2e8f0');
    doc.fillColor('#26364a').font('Helvetica-Bold').fontSize(8.4).text(kk, doc.page.margins.left + pad, y + pad, { width: leftW - pad * 2, lineGap: 2 });
    doc.fillColor('#182334').font('Helvetica').fontSize(8.4).text(vv, doc.page.margins.left + leftW + pad, y + pad, { width: rightW - pad * 2, lineGap: 2.2 });
    doc.y = y + h;
  }
  doc.moveDown(0.6);
}
function adviceBlock(doc, label, value) {
  const v = body(value); if (!v) return;
  const width = pageWidth(doc), pad = 8;
  const h = measure(doc, label, width - pad * 2, 'Helvetica-Bold', 8.2, 2) + measure(doc, v, width - pad * 2, 'Helvetica', 8.8, 2.5) + 20;
  ensureSpace(doc, Math.min(h + 8, 520));
  const y = doc.y;
  doc.roundedRect(doc.page.margins.left, y, width, h, 8).fillAndStroke('#fbfdff', '#e2e8f0');
  doc.fillColor('#0b2545').font('Helvetica-Bold').fontSize(8.2).text(label, doc.page.margins.left + pad, y + 7, { width: width - pad * 2 });
  doc.fillColor('#182334').font('Helvetica').fontSize(8.8).text(v, doc.page.margins.left + pad, doc.y + 3, { width: width - pad * 2, lineGap: 2.5 });
  doc.y = y + h + 5;
}

function cover(doc, assessment, subclass, stream, model) {
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#0b2545').text('Professional Migration\nAdvice Letter', { width: pageWidth(doc), lineGap: 4 });
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10).fillColor('#4a5568').text(`${BRAND.name} | ${BRAND.subtitle}`);
  doc.moveDown(1.2);
  keyValue(doc, [
    ['Matter', `Subclass ${subclass || '—'}${stream ? ' — ' + stream : ''}`],
    ['Reference', pick(assessment.id, assessment.reference, assessment.assessment_id, '—')],
    ["Applicant's name", pick(assessment.applicant_name, model.applicantName, model.clientName, '—')],
    ['Applicant email', pick(assessment.applicant_email, model.applicantEmail, '—')],
    ['Client email', pick(assessment.client_email, model.clientEmail, assessment.applicant_email, '—')],
    ['Generated', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })]
  ]);
  h2(doc, 'Confidential professional advice');
  p(doc, 'This advice letter is prepared from the information presently available and is subject to review of original evidence, current law, Departmental records, conflict checks and final migration-agent review before lodgement action. No guarantee of visa grant is given.');
  doc.addPage();
}

function writeExecutive(doc, model, subclass, stream, findings) {
  h1(doc, '1. Executive professional advice');
  const intro = pick(model.executiveAdvice, model.executiveSummary, model.summary, model.clientSummary && model.clientSummary.summary,
    `On the current saved answers, the Subclass ${subclass} ${stream} pathway requires criterion-by-criterion evidence reconciliation before final lodgement advice.`);
  p(doc, intro);
  keyValue(doc, [
    ['Pathway assessed', `Subclass ${subclass}${stream ? ' - ' + stream : ''}`],
    ['Current professional position', pick(model.currentProfessionalPosition, model.lodgementPosition, model.agentPosition && model.agentPosition.position, 'Potentially viable subject to evidence reconciliation')],
    ['Overall risk', pick(model.overallRisk, model.riskLevel, model.agentPosition && model.agentPosition.risk, 'Evidence review required')],
    ['Renderer version', RENDERER_VERSION]
  ]);
  const blockers = asArray(pick(model.topMaterialBlockers, model.materialBlockers, model.clientAdviceObject && model.clientAdviceObject.topMaterialBlockers));
  if (blockers.length) { h2(doc, 'Main issues to resolve'); uniqueByNormalised(blockers).slice(0, 6).forEach(bullet.bind(null, doc)); }
  else { h2(doc, 'Main issues to resolve'); findings.slice(0, 5).forEach(f => bullet(doc, findingTitle(f))); }
}

function writeFacts(doc, assessment, model) {
  h1(doc, '2. Facts, assumptions and evidence status');
  keyValue(doc, [
    ['Applicant identity', pick(assessment.applicant_name, model.applicantName, 'Not confirmed')],
    ['Current location / visa status', pick(model.currentLocationVisaStatus, model.facts && model.facts.currentStatus, 'Not confirmed')],
    ['Stream/pathway evidence', pick(model.streamEvidenceStatus, 'Not verified')],
    ['Evidence status', pick(model.evidenceStatus, model.evidenceSummary, 'Original evidence not yet fully reviewed')]
  ]);
}

function writeLegalFramework(doc, model, subclass, stream) {
  h1(doc, '3. Legal framework applied');
  p(doc, pick(model.legalFramework, model.framework,
    `This preliminary assessment considered the Subclass ${subclass} ${stream || ''} framework using the saved assessment answers, subclass criteria registry, knowledgebase source mapping, evidence validation and risk controls. Exact clause references should be used only where verified in the source-mapped registry and remain subject to RMA review.`));
}

function writeFindings(doc, findings) {
  h1(doc, '4. Application of law to the client’s facts');
  p(doc, 'The following findings apply the identified requirements to the information currently available. Status labels separate matters that appear supportable from matters that remain unclear or higher risk.');
  findings.slice(0, 24).forEach((f, i) => {
    ensureSpace(doc, 130);
    doc.font('Helvetica-Bold').fontSize(11.4).fillColor('#0b2545').text(`${i + 1}. ${findingTitle(f)}`, { width: pageWidth(doc), lineGap: 1.8 });
    doc.moveDown(0.2);
    adviceBlock(doc, 'Status', findingStatus(f));
    adviceBlock(doc, 'Legal requirement', findingRequirement(f) || 'Requirement to be verified against the subclass legal frame.');
    adviceBlock(doc, 'Application to current instructions', findingFacts(f) || 'The available instructions must be reconciled against original evidence before final advice.');
    adviceBlock(doc, 'Evidence still required', findingGap(f) || 'Supporting evidence required before final lodgement advice.');
    adviceBlock(doc, 'Consequence if unresolved', findingConsequence(f) || 'The issue may affect lodgement readiness if unresolved.');
    adviceBlock(doc, 'Required action', findingAction(f) || 'Resolve before final lodgement advice.');
    rule(doc);
  });
}

function writeEvidence(doc, model, findings) {
  h1(doc, '5. Evidence gaps and document request');
  const items = asArray(pick(model.evidenceChecklist, model.evidenceGaps, model.requiredEvidence, model.documentRequests));
  if (items.length) uniqueByNormalised(items).slice(0, 30).forEach(x => bullet(doc, x));
  else findings.forEach(f => bullet(doc, `${findingTitle(f)}: ${findingGap(f) || 'Evidence to be verified.'}`));
}

function writeRisk(doc, model, findings) {
  h1(doc, '6. Risk assessment');
  p(doc, pick(model.riskAssessmentSummary, model.riskSummary, 'The matter should be treated as not lodgement-ready until the identified legal criteria, evidence gaps and public-interest matters have been reconciled.'));
  findings.slice(0, 18).forEach((f, i) => {
    ensureSpace(doc, 92);
    doc.font('Helvetica-Bold').fontSize(9.8).fillColor('#0b2545').text(`${i + 1}. ${findingTitle(f)}`);
    adviceBlock(doc, 'Risk/status', findingStatus(f));
    adviceBlock(doc, 'Professional consequence', findingConsequence(f) || 'Requires evidence review before final advice.');
    adviceBlock(doc, 'Required action', findingAction(f) || 'Resolve before lodgement.');
  });
}

function writeActionPlan(doc, model, findings) {
  h1(doc, '7. Lodgement-readiness action plan');
  const plan = asArray(pick(model.priorityActionPlan, model.actionPlan, model.nextSteps, model.requiredActions));
  if (plan.length) uniqueByNormalised(plan.map((x, i) => isPlainObject(x) ? `Priority ${pick(x.priority, i + 1)} - ${pick(x.issue, x.title, 'Issue')}: ${pick(x.requiredAction, x.action, x.description, x.nextStep, 'Resolve before final advice.')}` : x)).slice(0, 18).forEach(x => bullet(doc, x));
  else findings.slice(0, 8).forEach((f, i) => bullet(doc, `Priority ${i + 1} - ${findingTitle(f)}: ${findingAction(f) || 'Resolve before final advice.'}`));
}

function writeRecommendation(doc, model) {
  h1(doc, '8. Final professional recommendation');
  const rec = pick(model.finalRecommendation, model.recommendation, model.agentPosition && model.agentPosition.recommendation,
    'The matter should proceed to formal evidence review and lodgement-readiness assessment before filing.');
  p(doc, isPlainObject(rec) ? humanizeObject(rec) : rec);
}

function writeLimitations(doc) {
  h1(doc, '9. Important limitations');
  p(doc, 'This advice is preliminary and based on the information presently available. It is subject to review of original documents, current law and policy, Departmental records, conflict checks and final professional review before lodgement. No guarantee of visa grant is given.');
  doc.moveDown(1.4);
  p(doc, `Yours faithfully,\n${BRAND.agent}\nRegistered Migration Agent | MARN: ${BRAND.marn}\n${BRAND.name}`, { bold: true });
}

function writeAppendix(doc, findings) {
  doc.addPage();
  h1(doc, 'Appendix A — Criterion-by-criterion lodgement-readiness matrix');
  p(doc, 'This appendix records the issue, status, requirement, evidence gap and action for file control. Dense table formatting is deliberately avoided so criterion content remains readable.');
  findings.slice(0, 24).forEach((f, i) => {
    ensureSpace(doc, 110);
    doc.font('Helvetica-Bold').fontSize(9.4).fillColor('#0b2545').text(`${i + 1}. ${findingTitle(f)}`, { width: pageWidth(doc), lineGap: 1.6 });
    adviceBlock(doc, 'Status', findingStatus(f));
    adviceBlock(doc, 'Requirement', findingRequirement(f) || 'Requirement to be verified against legal frame.');
    adviceBlock(doc, 'Gap/action', `${findingGap(f) || 'Evidence gap to be resolved.'} ${findingAction(f) || 'Resolve before final lodgement advice.'}`);
    rule(doc);
  });
}

function buildAssessmentPdfBuffer(assessment = {}, adviceBundle = {}) {
  return new Promise((resolve, reject) => {
    try {
      const cleanBundle = deepClean(adviceBundle);
      const cleanAssessment = deepClean(assessment);
      const model = getAdviceModel(cleanBundle);
      const subclass = getSubclass(cleanAssessment, cleanBundle, model);
      const stream = getStream(cleanAssessment, cleanBundle, model);
      let findings = collectFindings(model, cleanBundle);
      findings = ensureRendererMandatoryFindings(cleanAssessment, subclass, stream, findings);
      assertAdviceModelReady(cleanAssessment, cleanBundle, model, subclass, stream, findings);

      const doc = createDoc(resolve, reject);
      cover(doc, cleanAssessment, subclass, stream, model);
      writeExecutive(doc, model, subclass, stream, findings);
      writeFacts(doc, cleanAssessment, model);
      writeLegalFramework(doc, model, subclass, stream);
      writeFindings(doc, findings);
      writeEvidence(doc, model, findings);
      writeRisk(doc, model, findings);
      writeActionPlan(doc, model, findings);
      writeRecommendation(doc, model);
      writeLimitations(doc);
      writeAppendix(doc, findings);
      assertNoForbiddenClientText({ model, cleanAssessment, subclass, stream, findings }, 'PDF');
      assertNoWrongSubclassLeak({ model, findings, stream }, subclass);
      doc.end();
    } catch (err) { reject(err); }
  });
}

function buildAppealAdvicePdfBuffer(assessment = {}, adviceBundle = {}) {
  return new Promise((resolve, reject) => {
    try {
      const model = deepClean(pick(adviceBundle.appealAdviceModel, adviceBundle.advice, adviceBundle));
      const doc = createDoc(resolve, reject);
      h1(doc, pick(model.title, 'Visa refusal review advice'));
      keyValue(doc, [
        ['Reference', pick(assessment.reference, assessment.assessment_id, assessment.id, '—')],
        ['Applicant', pick(assessment.applicant_name, assessment.applicantName, model.applicantName, '—')],
        ['Generated', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })]
      ]);
      p(doc, pick(model.executiveAdvice, model.summary, 'This appeal assessment is prepared from the information presently available and requires review of the decision record, application file and relevant time limits.'));
      h1(doc, 'Issues for review');
      asArray(pick(model.issues, model.findings, model.reviewIssues)).slice(0, 20).forEach(x => bullet(doc, isPlainObject(x) ? pick(x.issue, x.title, x.finding, x.summary) : x));
      h1(doc, 'Recommendation');
      p(doc, pick(model.recommendation, model.finalRecommendation, 'A final appeal recommendation should be issued only after the decision record, reasons, evidence and time limits are reviewed.'));
      writeLimitations(doc);
      assertNoForbiddenClientText(model, 'Appeal PDF');
      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = {
  buildAssessmentPdfBuffer,
  buildAppealAdvicePdfBuffer,
  sha256,
  RENDERER_VERSION
};
