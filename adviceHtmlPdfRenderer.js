'use strict';

/**
 * adviceHtmlPdfRenderer.js v38
 * Engine-design compliant HTML/PDF renderer.
 *
 * This file formats a client-safe advice object only.
 * It does not create subclass criteria, legal findings, or fallback legal advice.
 * If the advice object is missing, unresolved, internally contaminated, or mixed
 * with another subclass/stream, it blocks and returns the matter to manual/RMA review.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const RENDERER_VERSION = 'advice-html-pdf-renderer-v38-engine-design-client-advice-only';

const BRAND = {
  name: 'Bircan Migration & Education',
  shortName: 'Bircan Migration',
  subtitle: 'Professional Migration Assessment',
  agent: 'Kenan Bircan JP',
  marn: '1463685'
};

const INTERNAL_KEYS = new Set([
  'internalLegalAudit', 'internalAuditObject', 'criteriaRegistryAudit', 'rawRegistryFindings',
  'criteriaRegistryFindings', 'debug', 'rawDebug', 'sourceHash', 'sourceHashes', 'quality_flags',
  'prompt', 'systemPrompt', 'developerPrompt', 'chainOfThought', 'internal_audit_object',
  'answerToCriteriaMap', 'sourcesUsed', 'sourceConfidence', 'coverageWarnings', 'adminWarnings'
]);

const FORBIDDEN_CLIENT_PHRASES = [
  'engine output', 'rawRegistryFindings', 'criteriaRegistryAudit', 'internalLegalAudit',
  'quality_flags', 'source hash', 'Grant Criterion Control', 'Primary pathway',
  'Registry-controlled pathway', 'Registry controlled pathway',
  'Map the original evidence to the clause', 'saved assessment answers',
  'knowledgebase source mapping', 'subclass criteria registry'
];

const EMPLOYER_ONLY_TERMS = [
  /Direct Entry skills and occupation pathway/i,
  /salary and market position/i,
  /market salary/i,
  /AMSR/i,
  /genuine position and operational need/i,
  /nominated occupation/i,
  /ANZSCO/i,
  /employer nomination/i,
  /nomination position/i,
  /sponsoring employer/i,
  /Labour Market Testing/i
];

const VISA_FAMILY = {
  employer: ['186', '187', '407', '482', '494'],
  partner: ['100', '300', '309', '801', '820'],
  skilled: ['188', '189', '190', '485', '489', '491', '888'],
  student: ['500', '590'],
  visitor: ['600', '602'],
  protection: ['785', '790', '866'],
  workingHoliday: ['417', '462'],
  special: ['444', '461']
};

function clean(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value)
    .normalize('NFKC')
    .replace(/[\uFFFC-\uFFFF]/g, ' ')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\u00AD/g, '')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}
function esc(value) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function isObj(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function arr(value) { if (!value) return []; return Array.isArray(value) ? value.filter(Boolean) : [value]; }
function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}
function subclassOf(value) { return clean(value).replace(/[^0-9]/g, '').slice(0, 3); }
function familyOf(subclass) {
  const sc = subclassOf(subclass);
  for (const [family, list] of Object.entries(VISA_FAMILY)) if (list.includes(sc)) return family;
  return 'general';
}
function flattenStrings(value, out = [], seen = new WeakSet()) {
  if (value === undefined || value === null) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { out.push(String(value)); return out; }
  if (Array.isArray(value)) { value.forEach(v => flattenStrings(v, out, seen)); return out; }
  if (isObj(value)) {
    if (seen.has(value)) return out;
    seen.add(value);
    for (const [key, val] of Object.entries(value)) {
      out.push(String(key));
      flattenStrings(val, out, seen);
    }
  }
  return out;
}
function stripInternal(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => stripInternal(v, seen)).filter(v => v !== undefined && v !== null && v !== '');
  if (seen.has(value)) return undefined;
  seen.add(value);
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (INTERNAL_KEYS.has(key)) continue;
    out[key] = stripInternal(val, seen);
  }
  return out;
}

function getClientAdviceObject(adviceBundle = {}) {
  const b = adviceBundle || {};
  const candidates = [
    b.clientAdviceObject,
    b.client_advice_object,
    b.clientAdvice,
    b.advice && b.advice.clientAdviceObject,
    b.advice && b.advice.client_advice_object,
    b.professionalAdvice,
    b.advice
  ].filter(Boolean);
  return stripInternal(candidates[0] || b);
}

function modelSubclass(assessment, bundle, model) {
  return subclassOf(pick(
    model.subclass,
    model.matter && model.matter.subclass,
    model.visaSubclass,
    bundle.subclass,
    bundle.visaSubclass,
    assessment.subclass,
    assessment.visa_type,
    assessment.visa_subclass
  ));
}
function modelStream(assessment, bundle, model) {
  return clean(pick(
    model.stream,
    model.pathway,
    model.streamLabel,
    model.matter && (model.matter.stream || model.matter.pathway || model.matter.streamLabel),
    bundle.stream,
    bundle.pathway,
    bundle.streamLabel,
    assessment.stream,
    assessment.pathway,
    assessment.selected_stream,
    assessment.visa_stream
  ));
}
function isUnresolvedStream(stream) {
  return !clean(stream) || /stream\/pathway|registry controlled|registry-controlled|primary pathway|generic|not confirmed|unknown/i.test(stream);
}

function statusText(value) {
  const s = clean(value).toLowerCase();
  if (!s) return 'Requires evidence review';
  if (/likely|supportable|satisfied/.test(s)) return 'Appears supportable, subject to evidence';
  if (/not[_\s-]*satisfied|adverse|not supportable/.test(s)) return 'Presently adverse on current information';
  if (/not[_\s-]*applicable|n\/a/.test(s)) return 'Not presently applicable';
  if (/unclear|review|required|verify|reconcil|missing|manual/.test(s)) return 'Requires evidence reconciliation';
  return clean(value);
}
function textOf(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.map(v => textOf(v, '')).filter(Boolean).join(', ') || fallback;
  if (isObj(value)) {
    const parts = [
      pick(value.issue, value.title, value.area, value.criterion, value.label),
      pick(value.finding, value.summary, value.position, value.professionalFinding),
      pick(value.requiredAction, value.action, value.nextStep)
    ].map(x => clean(x)).filter(Boolean);
    return parts.join(' - ') || fallback;
  }
  return clean(value) || fallback;
}
function findingTitle(f) { return textOf(pick(f.issue, f.title, f.area, f.criterionLabel, f.criterionName, f.criterion, f.label), 'Assessment issue'); }
function findingReq(f) { return textOf(pick(f.legalRequirement, f.requirement, f.legalTest, f.rule, f.whatMustBeEstablished), ''); }
function findingFacts(f) { return textOf(pick(f.applicationToFacts, f.factsApplied, f.clientFacts, f.reasoning, f.finding, f.summary), ''); }
function findingEvidence(f) { return textOf(pick(f.evidenceStillRequired, f.evidenceGap, f.requiredEvidence, f.evidenceRequired, f.missingEvidence, f.documentsRequired), ''); }
function findingAction(f) { return textOf(pick(f.requiredAction, f.action, f.nextStep, f.recommendation), ''); }
function findingConsequence(f) { return textOf(pick(f.consequenceIfUnresolved, f.consequence, f.legalConsequence, f.professionalConsequence, f.riskConsequence), ''); }
function findingStatus(f) { return statusText(pick(f.professionalStatus, f.statusLabel, f.status, f.result, f.riskLevel, f.risk)); }

function gatherFindings(model = {}) {
  const candidates = [
    model.eligibilityFindings,
    model.criteriaFindings,
    model.legalFindings,
    model.issueFindings,
    model.riskFindings,
    model.legalIssues,
    model.findings
  ];
  const out = [];
  const seen = new Set();
  for (const list of candidates) {
    for (const item of arr(list)) {
      if (!isObj(item)) continue;
      const key = clean(pick(item.criterionId, item.clause, findingTitle(item))).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    if (out.length) break;
  }
  return out;
}
function gatherRisks(model, findings) {
  const risks = arr(pick(model.riskFindings, model.risks, model.riskAnalysis && model.riskAnalysis.items));
  return risks.length ? risks : findings.filter(f => /high|critical|risk|required|unclear/i.test(JSON.stringify(f || {}))).slice(0, 12);
}
function gatherEvidence(model, findings) {
  const checklist = arr(pick(model.evidenceChecklist, model.evidenceGaps, model.missingInformation, model.requiredEvidence));
  if (checklist.length) return checklist.map(e => isObj(e) ? {
    category: pick(e.category, e.issue, e.title, e.area, 'Evidence'),
    documents: textOf(pick(e.documents, e.requiredEvidence, e.evidenceMissing, e.missingEvidence, e.evidence, e.summary), 'Evidence to be reviewed'),
    purpose: textOf(pick(e.purpose, e.requiredAction, e.action), 'Confirm lodgement-readiness')
  } : { category: 'Evidence', documents: textOf(e), purpose: 'Confirm lodgement-readiness' });
  return findings.map(f => ({ category: findingTitle(f), documents: findingEvidence(f) || 'Evidence to be reviewed', purpose: findingAction(f) || 'Confirm lodgement-readiness' })).filter(x => clean(x.documents));
}

function assertDesignCompliant({ assessment, adviceBundle, model, subclass, stream, findings }) {
  if (!model || !isObj(model)) throw new Error('PDF blocked: client advice object missing. Worker must build clientAdviceObject before rendering.');
  if (!subclass) throw new Error('PDF blocked: subclass missing from client advice object.');
  if (isUnresolvedStream(stream)) throw new Error(`PDF blocked: valid stream/pathway is not confirmed for Subclass ${subclass}.`);
  if (!findings.length) throw new Error(`PDF blocked: client advice object contains no criterion findings for Subclass ${subclass}.`);

  const text = flattenStrings({ model, findings }).join('\n');
  for (const phrase of FORBIDDEN_CLIENT_PHRASES) {
    if (text.includes(phrase)) throw new Error(`PDF blocked: internal/generic wording leaked into client advice object: ${phrase}`);
  }
  for (const key of INTERNAL_KEYS) {
    if (text.includes(key)) throw new Error(`PDF blocked: internal audit field leaked into client advice object: ${key}`);
  }

  const family = familyOf(subclass);
  if (family !== 'employer') {
    for (const rule of EMPLOYER_ONLY_TERMS) {
      if (rule.test(text)) throw new Error(`PDF blocked: employer-sponsored criterion leaked into Subclass ${subclass} (${family}) advice object: ${rule}`);
    }
  }

  const subclassMatches = text.match(/\bSubclass\s+(\d{3})\b/gi) || [];
  for (const match of subclassMatches) {
    const n = subclassOf(match);
    if (n && n !== subclass) throw new Error(`PDF blocked: wrong subclass reference leaked into Subclass ${subclass} advice object: ${match}`);
  }

  return true;
}

function logoDataUri() {
  const candidates = [
    path.join(__dirname, 'assets', 'branding', 'Bircan-Migration-Logo-PNG.png'),
    path.join(__dirname, 'assets', 'branding', 'Bircan-Migration-Logo-PNG(23).png')
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
    } catch (_err) {}
  }
  return '';
}

function kv(rows) {
  return `<div class="kv">${rows.map(([k, v]) => `<div class="kv-row"><div class="kv-key">${esc(k)}</div><div class="kv-val">${esc(v || '—')}</div></div>`).join('')}</div>`;
}
function paragraph(text, cls = '') { const t = clean(text); return t ? `<p class="${cls}">${esc(t)}</p>` : ''; }
function h1(text) { return `<h1>${esc(text)}</h1>`; }
function h2(text) { return `<h2>${esc(text)}</h2>`; }
function bullets(items) { return `<ul>${arr(items).map(x => textOf(x)).filter(Boolean).map(x => `<li>${esc(x)}</li>`).join('')}</ul>`; }
function table(headers, rows) {
  return `<table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function findingCard(f, i) {
  return `<section class="card avoid"><h2>${i + 1}. ${esc(findingTitle(f))}</h2>${kv([
    ['Status', findingStatus(f)],
    ['Legal requirement', findingReq(f) || 'Requirement recorded in client advice object.'],
    ['Application to facts', findingFacts(f) || 'Evidence must be reconciled before final lodgement advice.'],
    ['Evidence still required', findingEvidence(f) || 'Evidence review required.'],
    ['Consequence if unresolved', findingConsequence(f) || 'This issue may affect lodgement readiness if unresolved.'],
    ['Required action', findingAction(f) || 'Resolve before final lodgement advice.']
  ])}</section>`;
}

function buildAssessmentHtml(assessment = {}, adviceBundle = {}) {
  const model = getClientAdviceObject(adviceBundle);
  const subclass = modelSubclass(assessment, adviceBundle, model);
  const stream = modelStream(assessment, adviceBundle, model);
  const findings = gatherFindings(model);
  assertDesignCompliant({ assessment, adviceBundle, model, subclass, stream, findings });

  const generated = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  const applicantName = pick(assessment.applicant_name, model.matter && model.matter.applicantName, model.applicantName, model.clientName, 'Client');
  const applicantEmail = pick(assessment.applicant_email, model.matter && model.matter.applicantEmail, model.applicantEmail, assessment.client_email, '—');
  const clientEmail = pick(assessment.client_email, model.matter && model.matter.clientEmail, model.clientEmail, applicantEmail, '—');
  const reference = pick(assessment.id, assessment.assessment_id, model.matter && model.matter.reference, '—');
  const risks = gatherRisks(model, findings);
  const evidence = gatherEvidence(model, findings).slice(0, 20);
  const recommendation = pick(model.agentPosition && model.agentPosition.position, model.finalRecommendation && model.finalRecommendation.lodgementPosition, model.recommendation, 'The matter should proceed to evidence review before any lodgement action.');
  const overallRisk = pick(model.overallRisk, model.riskLevel, model.riskAnalysis && model.riskAnalysis.overallRisk, 'Evidence review required');
  const logo = logoDataUri();

  return htmlDocument(`${BRAND.shortName} - Professional Migration Advice`, `
    <section class="cover page-break-after">
      <div class="hero">
        <div class="hero-logo">${logo ? `<img src="${logo}" alt="Bircan Migration"/>` : '<strong>BIRCAN</strong><span>MIGRATION</span>'}</div>
        <div class="hero-subtitle">${esc(BRAND.name)} | ${esc(BRAND.subtitle)}</div>
        <div class="gold-line"></div>
        <div class="hero-title">Professional Migration<br/>Advice Letter</div>
        <div class="hero-pathway">Subclass ${esc(subclass)} - ${esc(stream)}</div>
      </div>
      <div class="matter-card">
        <h2>Matter details</h2>
        ${kv([
          ['Reference', reference],
          ["Applicant's name", applicantName],
          ['Applicant email', applicantEmail],
          ['Client email', clientEmail],
          ['Subclass', subclass],
          ['Stream/pathway', stream],
          ['Generated', generated]
        ])}
      </div>
      <div class="note"><strong>Confidential professional advice</strong>${paragraph('This advice letter is prepared from the information presently available. It is subject to review of original evidence, current law, Departmental records, conflict checks and final migration-agent review before lodgement action. No guarantee of visa grant is given.')}</div>
    </section>

    <main>
      ${h1('1. Executive professional advice')}
      ${paragraph(pick(model.clientSummary && model.clientSummary.executiveSummary, model.executiveAdvice && model.executiveAdvice.summary, model.executiveSummary, `On the current instructions, the Subclass ${subclass} ${stream} pathway requires evidence reconciliation before lodgement-ready advice can be issued.`), 'lead')}
      ${kv([
        ['Pathway assessed', `Subclass ${subclass} - ${stream}`],
        ['Current professional position', pick(model.currentProfessionalPosition, model.lodgementPosition, model.agentPosition && model.agentPosition.position, 'Evidence review required')],
        ['Overall risk', overallRisk],
        ['Lodgement-readiness position', pick(model.lodgementReadiness, model.documentStatus, 'Not lodgement-ready until priority evidence is reconciled and reviewed')]
      ])}
      ${h2('Main issues to resolve')}
      ${bullets(findings.slice(0, 6).map(findingTitle))}

      ${h1('2. Facts, assumptions and evidence status')}
      ${kv([
        ['Applicant identity', applicantName],
        ['Current location / visa status', pick(model.facts && model.facts.currentStatus, model.currentLocationVisaStatus, 'Not confirmed')],
        ['Stream/pathway evidence', pick(model.streamEvidenceStatus, 'Not verified')],
        ['Evidence status', pick(model.evidenceStatus, model.evidenceSummary, 'Original evidence not yet fully reviewed')]
      ])}

      ${h1('3. Legal framework applied')}
      ${paragraph(pick(model.legalFramework && model.legalFramework.summary, model.legalFramework, model.framework, `This advice applies the Subclass ${subclass} ${stream} legal framework identified in the client advice object. Exact clause references are used only where verified by the upstream criteria registry and source-mapping process.`))}

      ${h1('4. Criterion-by-criterion assessment')}
      ${findings.map(findingCard).join('')}

      ${h1('5. Evidence gaps and document request')}
      ${paragraph('Before final lodgement advice can be issued, the following evidence should be obtained and reconciled against the current instructions.')}
      ${table(['Priority / category', 'Documents required', 'Purpose'], evidence.map((e, i) => [`Priority ${i + 1} - ${textOf(e.category, 'Evidence')}`, textOf(e.documents), textOf(e.purpose)]))}

      ${h1('6. Risk assessment')}
      ${paragraph(pick(model.riskAssessmentSummary, model.riskSummary, model.riskAnalysis && model.riskAnalysis.reason, 'Risk remains evidence-dependent until each applicable criterion has been reconciled against original evidence.'))}
      ${risks.slice(0, 10).map((r, i) => findingCard(isObj(r) ? r : { issue: `Risk ${i + 1}`, finding: r, status: 'Requires evidence reconciliation' }, i)).join('')}

      ${h1('7. Lodgement-readiness action plan')}
      ${bullets(arr(pick(model.requiredActions, model.clientNextSteps, model.nextSteps, findings.map(f => `${findingTitle(f)}: ${findingAction(f) || 'Resolve before final advice.'}`))).slice(0, 10))}

      ${h1('8. Final professional recommendation')}
      ${paragraph(recommendation, 'strong')}
      ${paragraph(pick(model.finalRecommendation && model.finalRecommendation.summary, model.agentPosition && model.agentPosition.reason, 'The matter should not be lodged until the priority evidence and applicable criteria have been reviewed and the migration agent has approved the final advice.'))}

      ${h1('9. Important limitations')}
      ${paragraph('This advice is preliminary and based only on information available at the time of assessment. It is not a visa application decision and does not guarantee an outcome. It remains subject to review of original documents, current law and policy, Departmental records, conflict checks and final review by a registered migration agent before release or lodgement action.')}
      <div class="signature"><p><strong>Yours faithfully,</strong></p><p><strong>${esc(BRAND.agent)}</strong><br/><strong>Registered Migration Agent | MARN: ${esc(BRAND.marn)}</strong><br/><strong>${esc(BRAND.name)}</strong></p></div>
    </main>
  `);
}

function buildAppealHtml(assessment = {}, adviceBundle = {}) {
  const model = getClientAdviceObject(adviceBundle);
  const issues = arr(pick(model.issues, model.findings, model.reviewIssues, model.riskFindings));
  if (!issues.length) throw new Error('Appeal PDF blocked: client advice object contains no review issues.');
  return htmlDocument(`${BRAND.shortName} - Appeal Advice`, `<main>${h1('Visa refusal review advice')}${paragraph(pick(model.executiveAdvice, model.summary, 'This appeal assessment requires review of the decision record, reasons, evidence and time limits.'), 'lead')}${h1('Issues for review')}${bullets(issues.map(textOf))}${h1('Recommendation')}${paragraph(pick(model.recommendation, model.finalRecommendation, 'Final review advice should be issued after the decision record and time limits are reviewed.'))}</main>`);
}

function htmlDocument(title, bodyContent) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><title>${esc(title)}</title><style>
    @page { size: A4; margin: 15mm 16mm 18mm 16mm; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Arial, Helvetica, sans-serif; color:#172033; font-size:10.2pt; line-height:1.42; }
    .page-break-after { page-break-after: always; }
    .avoid { break-inside: avoid; page-break-inside: avoid; }
    .hero { position:relative; height:270px; background:#061f3f; color:white; padding:34px 38px; overflow:hidden; }
    .hero:before { content:''; position:absolute; right:-35px; top:-60px; width:220px; height:220px; border-radius:50%; background:#123a78; opacity:.55; }
    .hero:after { content:''; position:absolute; right:95px; top:105px; width:105px; height:105px; border-radius:50%; background:#6c7480; opacity:.35; }
    .hero-logo { position:absolute; left:38px; top:34px; width:190px; height:78px; background:white; color:#0b2545; border-radius:14px; display:flex; flex-direction:column; align-items:center; justify-content:center; letter-spacing:4px; font-weight:800; z-index:2; }
    .hero-logo img { max-width:150px; max-height:62px; object-fit:contain; }
    .hero-logo span { display:block; font-size:8px; letter-spacing:5px; margin-top:2px; }
    .hero-subtitle { position:absolute; left:255px; top:68px; color:#d6deea; z-index:2; }
    .gold-line { position:absolute; left:38px; top:138px; width:220px; height:2px; background:#d6aa3d; z-index:2; }
    .hero-title { position:absolute; left:38px; top:155px; font-size:31pt; line-height:1.05; font-weight:800; z-index:2; }
    .hero-pathway { position:absolute; left:38px; bottom:34px; color:#dbe6f4; font-size:12pt; z-index:2; }
    .hero + .matter-card { margin-top:55px; }
    .matter-card { border:1px solid #d8e1ec; border-radius:22px; background:#f4f7fb; padding:28px 34px; margin:0 6px 42px 6px; }
    .note { border:1px solid #e8d58f; border-radius:16px; background:#fffaf0; padding:18px 24px; margin:0 6px; }
    h1 { color:#0b2545; font-size:18pt; margin:18px 0 9px; padding-bottom:7px; border-bottom:2px solid #d6aa3d; }
    h2 { color:#12355b; font-size:12.4pt; margin:14px 0 7px; }
    p { margin:0 0 9px; }
    .lead { font-size:10.8pt; }
    .strong { font-weight:700; }
    .kv { border:1px solid #dde5ef; border-radius:8px; overflow:hidden; margin:8px 0 14px; }
    .kv-row { display:grid; grid-template-columns: 32% 68%; border-bottom:1px solid #e5ebf3; }
    .kv-row:last-child { border-bottom:0; }
    .kv-key { background:#f1f5fa; font-weight:700; color:#334155; padding:9px 11px; }
    .kv-val { background:white; padding:9px 11px; }
    .card { border:1px solid #dce5ef; border-radius:12px; padding:12px 14px; margin:12px 0; background:#fff; }
    table { width:100%; border-collapse:collapse; margin:10px 0 16px; font-size:9.2pt; }
    th { background:#061f3f; color:white; text-align:left; padding:9px; }
    td { border:1px solid #dfe6ef; vertical-align:top; padding:8px; }
    ul { margin:6px 0 13px 20px; padding:0; }
    li { margin:0 0 5px; }
    .signature { margin-top:22px; }
    footer { position: fixed; left:16mm; right:16mm; bottom:7mm; color:#64748b; font-size:8pt; display:flex; justify-content:space-between; }
  </style></head><body>${bodyContent}<footer><strong>${esc(BRAND.shortName)}</strong><span>Professional Migration Advice Letter</span></footer></body></html>`;
}

async function renderPdf(html) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

async function buildAssessmentPdfBuffer(assessment = {}, adviceBundle = {}) {
  return renderPdf(buildAssessmentHtml(assessment, adviceBundle));
}
async function buildAppealAdvicePdfBuffer(assessment = {}, adviceBundle = {}) {
  return renderPdf(buildAppealHtml(assessment, adviceBundle));
}

module.exports = {
  buildAssessmentPdfBuffer,
  buildAppealAdvicePdfBuffer,
  buildAssessmentHtml,
  buildAppealHtml,
  RENDERER_VERSION
};
