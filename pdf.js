'use strict';

const crypto = require('crypto');
const PDFDocument = require('pdfkit');

function safeText(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function clientSafeText(value, fallback = '—') {
  let s = safeText(value, fallback);
  if (!s || s === '—') return s;
  s = String(s)
    .replace(/known issue\.?/gi, 'The information provided indicates a matter requiring further review.')
    .replace(/weak\/generic gpt wording detected[^\n.]*[\n.]?/gi, '')
    .replace(/matrix coverage warning[^\n.]*[\n.]?/gi, '')
    .replace(/criterion reasoning warning[^\n.]*[\n.]?/gi, '')
    .replace(/\bGPT\b|\bAI\b|artificial intelligence|model output|prompt|quality flags?/gi, 'internal assessment')
    .replace(/will be refused/gi, 'may result in refusal if not addressed')
    .replace(/will result in refusal/gi, 'may result in refusal if not addressed')
    .replace(/cannot succeed/gi, 'is unlikely to succeed unless the issue is resolved')
    .replace(/hard[- ]fail/gi, 'potentially blocking')
    .replace(/do not lodge/gi, 'lodgement is not recommended')
    .replace(/\s+/g, ' ')
    .trim();
  return s || fallback;
}
function writeComplianceScope(doc) {
  writeHeading(doc, 'Scope and compliance safeguards');
  writeParagraph(doc, 'This letter is a preliminary written assessment based on questionnaire information provided by the client. It is subject to verification of identity, review of original supporting documents, conflict checks, and confirmation that any required service agreement, Consumer Guide and fee disclosures have been properly completed before further immigration assistance or lodgement action is undertaken.');
}

function writeHeading(doc, text) {
  if (doc.y > 690) doc.addPage();
  doc.moveDown(0.8);
  doc.fontSize(13).fillColor('#061936').font('Helvetica-Bold').text(text);
  doc.moveDown(0.25);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#d8e2f0').stroke();
  doc.moveDown(0.45);
  doc.font('Helvetica').fillColor('#1f2937');
}
function writeParagraph(doc, text) {
  const paras = clientSafeText(text || '').split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  for (const p of paras.length ? paras : ['—']) {
    if (doc.y > 735) doc.addPage();
    doc.fontSize(10.2).fillColor('#1f2937').font('Helvetica').text(p, { align: 'justify', lineGap: 3 });
    doc.moveDown(0.45);
  }
}
function writeBullet(doc, text) {
  if (doc.y > 735) doc.addPage();
  doc.fontSize(10).fillColor('#1f2937').font('Helvetica').text(`• ${clientSafeText(text)}`, { indent: 14, lineGap: 2 });
}
function writePair(doc, label, value) {
  if (doc.y > 735) doc.addPage();
  doc.fontSize(9).fillColor('#475467').font('Helvetica-Bold').text(label, { continued: true });
  doc.fillColor('#101828').font('Helvetica').text(` ${clientSafeText(value)}`);
}
function drawHeader(doc, title) {
  doc.rect(0, 0, 595.28, 84).fill('#061936');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('Bircan Migration', 50, 28);
  doc.font('Helvetica').fontSize(10).text('Preliminary migration advice letter', 50, 54);
  doc.fillColor('#061936').font('Helvetica-Bold').fontSize(17).text(title, 50, 112, { align: 'center' });
  doc.moveDown(2.2);
}

function buildAssessmentPdfBuffer(assessment, adviceBundle) {
  if (!adviceBundle || !adviceBundle.advice) {
    throw new Error('Advice-grade PDF generation requires GPT adviceBundle. Weak template PDF generation is disabled.');
  }
  return new Promise((resolve, reject) => {
    const advice = adviceBundle.advice;
    const facts = adviceBundle.facts || {};
    const generatedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
    const doc = new PDFDocument({
      size: 'A4', margin: 50,
      info: { Title: `Bircan Migration - ${advice.title}`, Author: 'Bircan Migration', Subject: `Advice letter for assessment ${assessment.id}` }
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    drawHeader(doc, advice.title || `Subclass ${assessment.visa_type} Preliminary Advice Letter`);

    writePair(doc, 'Reference:', assessment.id);
    writePair(doc, 'Client email:', assessment.client_email);
    writePair(doc, 'Applicant:', facts.applicant && facts.applicant.name ? facts.applicant.name : assessment.applicant_name);
    writePair(doc, 'Applicant email:', facts.applicant && facts.applicant.email ? facts.applicant.email : assessment.applicant_email);
    writePair(doc, 'Subclass:', advice.subclass || assessment.visa_type);
    writePair(doc, 'Risk level:', advice.risk_level);
    writePair(doc, 'Lodgement position:', String(advice.lodgement_position || '').replace(/_/g, ' '));
    writePair(doc, 'Generated:', generatedAt);

    writeComplianceScope(doc);

    for (const section of advice.sections || []) {
      writeHeading(doc, section.heading);
      writeParagraph(doc, section.body);
    }

    writeHeading(doc, 'Criterion-by-criterion findings');
    for (const item of advice.criterion_findings || []) {
      if (doc.y > 690) doc.addPage();
      doc.fontSize(10.5).fillColor('#061936').font('Helvetica-Bold').text(item.criterion || 'Criterion');
      writeParagraph(doc, `Finding: ${clientSafeText(item.finding)}\n\nLegal consequence: ${clientSafeText(item.legal_consequence)}\n\nEvidence gap: ${clientSafeText(item.evidence_gap)}\n\nRecommendation: ${clientSafeText(item.recommendation)}`);
    }

    writeHeading(doc, 'Evidence required before final advice or lodgement');
    (advice.evidence_required || []).forEach(writeBullet.bind(null, doc));

    writeHeading(doc, 'Recommended next steps');
    (advice.client_next_steps || []).forEach(writeBullet.bind(null, doc));

    // Internal quality flags are deliberately not exposed in client PDFs.

    writeHeading(doc, 'Important qualification');
    writeParagraph(doc, advice.disclaimer || 'This preliminary advice is based only on questionnaire answers and is subject to verification against supporting evidence and the law, instruments, policy and Department requirements current at the time of decision.');

    doc.moveDown(0.6);
    doc.fontSize(10).fillColor('#101828').font('Helvetica').text('Yours faithfully,');
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').text('Kenan Bircan JP');
    doc.font('Helvetica').text('Registered Migration Agent | MARN: 1463685');
    doc.text('Bircan Migration & Education');
    doc.moveDown(0.8);
    doc.fontSize(8).fillColor('#667085').text('Prepared by Bircan Migration internal assessment systems. Preliminary advice only and subject to professional review.', { align: 'center' });
    doc.end();
  });
}
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
module.exports = { buildAssessmentPdfBuffer, sha256 };
