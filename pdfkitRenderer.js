'use strict';

/**
 * Strict PDFKit fallback v38.
 * Formats client advice object only. Does not create legal advice.
 */

const PDFDocument = require('pdfkit');

const RENDERER_VERSION = 'pdfkit-strict-fallback-v38-engine-design-client-advice-only';

function clean(v, fallback = '') { return String(v === undefined || v === null || v === '' ? fallback : v).normalize('NFKC').replace(/[\uFFFC-\uFFFF]/g, ' ').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim(); }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function arr(v) { if (!v) return []; return Array.isArray(v) ? v.filter(Boolean) : [v]; }
function pick(...values) { for (const v of values) if (v !== undefined && v !== null && v !== '') return v; return ''; }
function subclassOf(v) { return clean(v).replace(/[^0-9]/g, '').slice(0, 3); }
function getModel(bundle = {}) { return pick(bundle.clientAdviceObject, bundle.client_advice_object, bundle.clientAdvice, bundle.advice && bundle.advice.clientAdviceObject, bundle.advice) || bundle; }
function getSubclass(assessment, bundle, model) { return subclassOf(pick(model.subclass, model.matter && model.matter.subclass, bundle.subclass, assessment.subclass, assessment.visa_type)); }
function getStream(assessment, bundle, model) { return clean(pick(model.stream, model.pathway, model.streamLabel, model.matter && (model.matter.stream || model.matter.pathway), bundle.stream, assessment.stream, assessment.pathway)); }
function unresolved(s) { return !s || /stream\/pathway|registry|primary pathway|generic|not confirmed/i.test(s); }
function titleOf(f) { return clean(pick(f.issue, f.title, f.area, f.criterionLabel, f.criterionName, f.criterion, 'Assessment issue')); }
function statusOf(f) { return clean(pick(f.professionalStatus, f.statusLabel, f.status, f.riskLevel, 'Requires evidence review')); }
function reqOf(f) { return clean(pick(f.legalRequirement, f.requirement, f.legalTest, 'Requirement recorded in client advice object.')); }
function factsOf(f) { return clean(pick(f.applicationToFacts, f.factsApplied, f.clientFacts, f.finding, f.summary, 'Evidence must be reconciled before final advice.')); }
function gapOf(f) { return clean(pick(f.evidenceStillRequired, f.evidenceGap, f.requiredEvidence, f.evidenceRequired, f.missingEvidence, 'Evidence review required.')); }
function actionOf(f) { return clean(pick(f.requiredAction, f.action, f.nextStep, f.recommendation, 'Resolve before final advice.')); }
function findingsOf(model) { return arr(pick(model.eligibilityFindings, model.criteriaFindings, model.legalFindings, model.issueFindings, model.riskFindings, model.legalIssues, model.findings)).filter(isObj); }
function allText(v, out = []) { if (!v) return out; if (typeof v !== 'object') { out.push(String(v)); return out; } if (Array.isArray(v)) { v.forEach(x => allText(x, out)); return out; } for (const [k, val] of Object.entries(v)) { out.push(k); allText(val, out); } return out; }
function assertSafe({ model, subclass, stream, findings }) {
  if (!isObj(model)) throw new Error('PDF fallback blocked: client advice object missing.');
  if (!subclass) throw new Error('PDF fallback blocked: subclass missing.');
  if (unresolved(stream)) throw new Error(`PDF fallback blocked: stream/pathway not confirmed for Subclass ${subclass}.`);
  if (!findings.length) throw new Error(`PDF fallback blocked: no client-safe findings for Subclass ${subclass}.`);
  const text = allText({ model, findings }).join('\n');
  const employerTerms = [/Direct Entry skills/i, /salary and market/i, /market salary/i, /genuine position/i, /nominated occupation/i, /ANZSCO/i, /sponsoring employer/i];
  if (!['186', '187', '407', '482', '494'].includes(subclass)) {
    for (const re of employerTerms) if (re.test(text)) throw new Error(`PDF fallback blocked: employer-sponsored criterion leaked into Subclass ${subclass}.`);
  }
  if (/stream\/pathway|Registry-controlled pathway|Grant Criterion Control|Map the original evidence/i.test(text)) throw new Error('PDF fallback blocked: generic/internal wording leaked into client advice object.');
}
function createDoc(resolve, reject) {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 54, bottom: 54, left: 54, right: 54 }, bufferPages: true });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.on('error', reject);
  return doc;
}
function ensure(doc, h = 60) { if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage(); }
function h1(doc, s) { ensure(doc, 60); doc.font('Helvetica-Bold').fontSize(17).fillColor('#0b2545').text(clean(s)); doc.moveDown(.45); doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width-doc.page.margins.right, doc.y).strokeColor('#d6aa3d').lineWidth(1).stroke(); doc.moveDown(.55); }
function h2(doc, s) { ensure(doc, 40); doc.font('Helvetica-Bold').fontSize(12).fillColor('#12355b').text(clean(s)); doc.moveDown(.25); }
function p(doc, s, bold = false) { const t = clean(s); if (!t) return; ensure(doc, 45); doc.font(bold ? 'Helvetica-Bold':'Helvetica').fontSize(9.3).fillColor('#172033').text(t, { width: doc.page.width-doc.page.margins.left-doc.page.margins.right, lineGap: 2.5 }); doc.moveDown(.45); }
function kv(doc, rows) { for (const [k,v] of rows) { ensure(doc, 28); doc.font('Helvetica-Bold').fontSize(8.7).fillColor('#334155').text(clean(k), { continued:true, width:170 }); doc.font('Helvetica').fillColor('#172033').text(`  ${clean(v || '—')}`); doc.moveDown(.3); } doc.moveDown(.4); }
function cover(doc, assessment, model, subclass, stream) {
  doc.rect(54, 54, doc.page.width-108, 170).fill('#061f3f');
  doc.fillColor('white').font('Helvetica-Bold').fontSize(26).text('Professional Migration\nAdvice Letter', 76, 112, { lineGap: 4 });
  doc.fillColor('#d6aa3d').rect(54, 224, doc.page.width-108, 8).fill();
  doc.y = 270;
  h1(doc, 'Matter details');
  kv(doc, [
    ['Reference', pick(assessment.id, assessment.assessment_id, model.matter && model.matter.reference, '—')],
    ["Applicant's name", pick(assessment.applicant_name, model.applicantName, model.clientName, '—')],
    ['Applicant email', pick(assessment.applicant_email, model.applicantEmail, assessment.client_email, '—')],
    ['Client email', pick(assessment.client_email, model.clientEmail, assessment.applicant_email, '—')],
    ['Subclass', subclass],
    ['Stream/pathway', stream]
  ]);
  h2(doc, 'Confidential professional advice');
  p(doc, 'This advice letter is prepared from the information presently available. It is subject to review of original evidence, current law, Departmental records, conflict checks and final migration-agent review before lodgement action. No guarantee of visa grant is given.');
  doc.addPage();
}
async function buildAssessmentPdfBuffer(assessment = {}, adviceBundle = {}) {
  return new Promise((resolve, reject) => {
    const model = getModel(adviceBundle);
    const subclass = getSubclass(assessment, adviceBundle, model);
    const stream = getStream(assessment, adviceBundle, model);
    const findings = findingsOf(model);
    assertSafe({ model, subclass, stream, findings });
    const doc = createDoc(resolve, reject);
    cover(doc, assessment, model, subclass, stream);
    h1(doc, '1. Executive professional advice');
    p(doc, pick(model.clientSummary && model.clientSummary.executiveSummary, model.executiveSummary, model.executiveAdvice && model.executiveAdvice.summary, 'This matter requires evidence review before lodgement-ready advice can be issued.'));
    kv(doc, [['Pathway assessed', `Subclass ${subclass} - ${stream}`], ['Overall risk', pick(model.overallRisk, model.riskLevel, model.riskAnalysis && model.riskAnalysis.overallRisk, 'Evidence review required')]]);
    h1(doc, '2. Criterion-by-criterion assessment');
    findings.forEach((f, i) => { h2(doc, `${i+1}. ${titleOf(f)}`); kv(doc, [['Status', statusOf(f)], ['Legal requirement', reqOf(f)], ['Application to facts', factsOf(f)], ['Evidence required', gapOf(f)], ['Required action', actionOf(f)]]); });
    h1(doc, '3. Important limitations');
    p(doc, 'This advice is preliminary and subject to final registered migration agent review before release.');
    p(doc, `Yours faithfully,\nKenan Bircan JP\nRegistered Migration Agent | MARN: 1463685\nBircan Migration & Education`, true);
    doc.end();
  });
}
async function buildAppealAdvicePdfBuffer(assessment = {}, adviceBundle = {}) { return buildAssessmentPdfBuffer(assessment, adviceBundle); }
module.exports = { buildAssessmentPdfBuffer, buildAppealAdvicePdfBuffer, RENDERER_VERSION };
