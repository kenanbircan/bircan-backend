const crypto = require('crypto');
const PDFDocument = require('pdfkit');

function safeText(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function buildAssessmentPdfBuffer(assessment) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Subclass ${assessment.visa_type} preliminary assessment` } });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.fontSize(18).text('Bircan Migration', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(14).text(`Subclass ${assessment.visa_type} Preliminary Assessment`, { align: 'center' });
    doc.moveDown(1.2);

    doc.fontSize(10).fillColor('#333');
    doc.text(`Reference: ${safeText(assessment.id)}`);
    doc.text(`Client email: ${safeText(assessment.client_email)}`);
    doc.text(`Applicant email: ${safeText(assessment.applicant_email)}`);
    doc.text(`Plan: ${safeText(assessment.active_plan)}`);
    doc.text(`Generated: ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })}`);
    doc.moveDown();

    doc.fontSize(12).fillColor('#000').text('Important notice', { underline: true });
    doc.fontSize(10).fillColor('#333').text(
      'This document is a preliminary assessment generated from the client questionnaire. It must be reviewed against the Migration Act, Migration Regulations, legislative instruments, policy and the evidence available before any final advice is issued.',
      { align: 'justify' }
    );
    doc.moveDown();

    doc.fontSize(12).fillColor('#000').text('Questionnaire record', { underline: true });
    doc.moveDown(0.3);
    const payload = assessment.form_payload || {};
    Object.entries(payload).slice(0, 120).forEach(([key, value]) => {
      doc.fontSize(9).fillColor('#000').text(String(key), { continued: true }).fillColor('#333').text(`: ${safeText(value)}`);
    });

    doc.moveDown();
    doc.fontSize(12).fillColor('#000').text('Preliminary outcome', { underline: true });
    doc.fontSize(10).fillColor('#333').text(
      'The matter requires assessment against all applicable visa criteria, including identity, eligibility, evidence, health, character, genuineness and any stream-specific requirements. Any adverse information, inconsistency or missing evidence should be resolved before lodgement or final advice.',
      { align: 'justify' }
    );

    doc.end();
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { buildAssessmentPdfBuffer, sha256 };
