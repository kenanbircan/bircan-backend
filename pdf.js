'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

function safe(value, fallback = 'Not provided') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

async function generateAssessmentPdf(submission) {
  const outputDir = process.env.PDF_OUTPUT_DIR || path.join(__dirname, 'data', 'pdfs');
  fs.mkdirSync(outputDir, { recursive: true });

  const filePath = path.join(outputDir, `${submission.id}.pdf`);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(20).text('Bircan Migration & Education', { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(11).text('Assessment Letter', { align: 'left' });
  doc.moveDown();

  doc.fontSize(10).text(`Date: ${new Date().toLocaleDateString('en-AU')}`);
  doc.text(`Client Name: ${safe(submission?.client?.fullName || submission?.fullName)}`);
  doc.text(`Client Email: ${safe(submission?.client?.email || submission?.email || submission?.accountEmail)}`);
  doc.text(`Visa Subclass: ${safe(submission?.visa?.subclass || submission?.visaType || submission?.subclass)}`);
  doc.text(`Selected Plan: ${safe(submission?.visa?.selectedPlan || submission?.plan?.label || submission?.plan)}`);
  doc.moveDown();

  const analysis = submission?.analysis?.analysis || submission?.analysis || {};

  const addSection = (title, content) => {
    doc.fontSize(13).text(title, { underline: true });
    doc.moveDown(0.3);
    if (Array.isArray(content)) {
      if (!content.length) doc.fontSize(10).text('No items noted.');
      else content.forEach((item, idx) => doc.fontSize(10).text(`${idx + 1}. ${safe(item)}`));
    } else {
      doc.fontSize(10).text(safe(content));
    }
    doc.moveDown();
  };

  addSection('Summary', analysis.executiveSummary || analysis.summary || analysis.legalStyleSummary || '');
  addSection('Strengths', analysis.strengths || []);
  addSection('Concerns', analysis.concerns || []);
  addSection('Missing Information', analysis.missingInformation || analysis.evidenceCriticalGaps || []);
  addSection('Recommended Next Steps', analysis.recommendedNextSteps || analysis.nextSteps || []);
  addSection('Client Letter Draft', analysis.clientLetterDraft || analysis.professionalOpinion || '');
  addSection('Disclaimer', 'This assessment is general guidance based only on the information supplied by the client and should be reviewed by Bircan Migration before final professional use.');

  doc.end();

  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return filePath;
}

module.exports = { generateAssessmentPdf };
