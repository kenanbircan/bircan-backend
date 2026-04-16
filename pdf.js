import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const reportsDir = path.join(__dirname, '..', 'storage', 'reports');

if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

function pretty(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export async function generateAssessmentPdf(submission) {
  const filename = `${submission.id}.pdf`;
  const target = path.join(reportsDir, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(target);
    doc.pipe(stream);

    doc.fontSize(20).fillColor('#0b3d91').text('Bircan Migration', { continued: false });
    doc.moveDown(0.3);
    doc.fontSize(14).fillColor('#1f2d3d').text('Assessment Report');
    doc.moveDown();

    doc.fontSize(10).fillColor('#4a5a6a');
    doc.text(`Submission ID: ${submission.id}`);
    doc.text(`Created: ${submission.createdAt}`);
    doc.text(`Assessment Type: ${pretty(submission.type)}`);
    doc.text(`Product: ${pretty(submission.productKey)}`);
    doc.text(`Client Name: ${pretty(submission.name)}`);
    doc.text(`Client Email: ${pretty(submission.email)}`);
    doc.text(`Client Phone: ${pretty(submission.phone)}`);
    doc.moveDown();

    if (submission.score !== null && submission.score !== undefined) {
      doc.fontSize(12).fillColor('#0b3d91').text(`Score: ${submission.score}`);
      doc.moveDown(0.5);
    }

    if (submission.summary) {
      doc.fontSize(12).fillColor('#1f2d3d').text('Summary');
      doc.moveDown(0.25);
      doc.fontSize(10).fillColor('#333').text(submission.summary, { lineGap: 3 });
      doc.moveDown();
    }

    doc.fontSize(12).fillColor('#1f2d3d').text('Form Data');
    doc.moveDown(0.25);
    doc.fontSize(10).fillColor('#333');

    const entries = Object.entries(submission.formData || {});
    if (!entries.length) {
      doc.text('No form data captured.');
    } else {
      entries.forEach(([key, value]) => {
        doc.text(`${key}: ${pretty(value)}`, { lineGap: 2 });
      });
    }

    doc.moveDown();
    doc.fontSize(9).fillColor('#6b7280').text('This report is a frontend-generated intake summary and should be reviewed professionally before use as legal advice.', { lineGap: 3 });

    doc.end();

    stream.on('finish', () => resolve(target));
    stream.on('error', reject);
  });
}
