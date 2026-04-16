import PDFDocument from 'pdfkit';

function safe(value, fallback = '') {
  if (value === null || value === undefined || String(value).trim() === '') {
    return fallback;
  }
  return String(value).trim();
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleDateString('en-AU', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return safe(value, '');
  }
}

function footer(doc) {
  const y = doc.page.height - 40;

  doc
    .moveTo(50, y - 10)
    .lineTo(545, y - 10)
    .strokeColor('#D5E4F1')
    .lineWidth(1)
    .stroke();

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#6B7280')
    .text('Bircan Migration', 50, y, { width: 150 });

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#6B7280')
    .text('www.bircanmigration.au', 190, y, { width: 200, align: 'center' });

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor('#6B7280')
    .text(`Page ${doc.page.pageNumber}`, 470, y, { width: 75, align: 'right' });
}

function header(doc, data) {
  doc.rect(0, 0, doc.page.width, 95).fill('#0E3A5D');

  doc
    .font('Helvetica-Bold')
    .fontSize(21)
    .fillColor('#FFFFFF')
    .text(safe(data.firmName, 'Bircan Migration'), 50, 25, { width: 280 });

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#D9ECFA')
    .text(safe(data.website, 'https://www.bircanmigration.au'), 50, 54, { width: 280 });

  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor('#FFFFFF')
    .text('Client Assessment Letter', 310, 28, { width: 220, align: 'right' });

  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#D9ECFA')
    .text(`Generated: ${formatDate(data.generatedAt || new Date().toISOString())}`, 310, 54, {
      width: 220,
      align: 'right',
    });

  doc
    .moveTo(50, 108)
    .lineTo(545, 108)
    .strokeColor('#D5E4F1')
    .lineWidth(1)
    .stroke();

  doc.y = 125;
}

function ensureSpace(doc, spaceNeeded = 120, data = {}) {
  if (doc.y + spaceNeeded > doc.page.height - 65) {
    doc.addPage();
    header(doc, data);
  }
}

function sectionTitle(doc, title) {
  const y = doc.y;

  doc.roundedRect(50, y, 495, 24, 6).fill('#EAF4FB');

  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#0E3A5D')
    .text(title, 62, y + 7, { width: 460 });

  doc.moveDown(1.7);
}

function labelValue(doc, label, value, fallback = 'Not provided') {
  const y = doc.y;

  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#163955')
    .text(label, 50, y, { width: 165 });

  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor('#222222')
    .text(safe(value, fallback), 185, y, { width: 350 });

  doc.moveDown(1.05);
}

function bulletList(doc, items, emptyText = 'No details provided.') {
  const list = arrayOrEmpty(items);

  if (!list.length) {
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#444444')
      .text(emptyText, 62, doc.y, { width: 470 });
    doc.moveDown(0.8);
    return;
  }

  for (const item of list) {
    const y = doc.y;

    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor('#0F5E9C')
      .text('•', 62, y);

    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#222222')
      .text(safe(item), 78, y, { width: 450, lineGap: 2 });

    doc.moveDown(0.5);
  }

  doc.moveDown(0.35);
}

export default async function generatePDF(data = {}) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: {
          top: 50,
          bottom: 50,
          left: 50,
          right: 50,
        },
        bufferPages: true,
      });

      const chunks = [];
      const assessment = data.assessment || {};

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      header(doc, data);

      doc
        .font('Helvetica-Bold')
        .fontSize(15)
        .fillColor('#163955')
        .text(`Client: ${safe(data.fullName, 'Client')}`, 50, doc.y, { width: 495 });

      doc.moveDown(0.35);

      doc
        .font('Helvetica')
        .fontSize(10.5)
        .fillColor('#374151')
        .text(
          `This document sets out a preliminary migration assessment summary for ${safe(
            data.visaType,
            'the requested visa pathway'
          )}. It is based on the information provided by the client and should be treated as an initial review only.`,
          { width: 495, lineGap: 3 }
        );

      ensureSpace(doc, 170, data);
      sectionTitle(doc, 'Client Information');

      labelValue(doc, 'Full name', data.fullName);
      labelValue(doc, 'Visa type', data.visaType);
      labelValue(doc, 'Email', data.email);
      labelValue(doc, 'Phone', data.phone);
      labelValue(doc, 'Date of birth', data.dateOfBirth);
      labelValue(doc, 'Nationality', data.nationality);
      labelValue(doc, 'Current location', data.location);
      labelValue(doc, 'Relationship status', data.relationshipStatus);
      labelValue(doc, 'Sponsor status', data.sponsorStatus || data.sponsorCitizenshipStatus);
      labelValue(doc, 'Current visa', data.currentVisa || data.applicantStatus);
      labelValue(doc, 'Relationship start date', data.relationshipStartDate);
      labelValue(doc, 'Cohabitation start date', data.cohabitationStartDate);
      labelValue(doc, 'Children details', data.childrenDetails);
      labelValue(doc, 'Submitted', formatDate(data.submittedAt || data.generatedAt));

      ensureSpace(doc, 90, data);
      sectionTitle(doc, 'Assessment Outcome');
      labelValue(doc, 'Outcome', assessment.outcome);
      labelValue(doc, 'Suitability', assessment.suitability);

      ensureSpace(doc, 120, data);
      sectionTitle(doc, 'Key Findings');
      bulletList(doc, assessment.findings, 'No findings recorded.');

      ensureSpace(doc, 120, data);
      sectionTitle(doc, 'Strengths');
      bulletList(doc, assessment.strengths, 'No strengths recorded.');

      ensureSpace(doc, 120, data);
      sectionTitle(doc, 'Risks / Review Flags');
      bulletList(doc, assessment.risks, 'No immediate review flags were identified in this preliminary summary.');

      ensureSpace(doc, 120, data);
      sectionTitle(doc, 'Recommended Next Steps');
      bulletList(doc, assessment.recommendedNextSteps, 'No next steps recorded.');

      ensureSpace(doc, 120, data);
      sectionTitle(doc, 'Client Notes');
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor('#222222')
        .text(safe(data.notes, 'No additional notes were provided.'), 62, doc.y, {
          width: 470,
          lineGap: 3,
        });

      doc.moveDown(1.2);

      ensureSpace(doc, 120, data);
      sectionTitle(doc, 'Important Notice');
      doc
        .font('Helvetica')
        .fontSize(9.5)
        .fillColor('#444444')
        .text(
          'This letter is a preliminary assessment summary only. It does not constitute formal legal advice, a final eligibility determination, or a guarantee of visa outcome. A full review of evidence, history, legal criteria, and application strategy should be completed before any application is lodged.',
          62,
          doc.y,
          {
            width: 470,
            lineGap: 4,
          }
        );

      doc.moveDown(1.2);

      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#163955')
        .text('Bircan Migration', 62, doc.y);

      doc
        .font('Helvetica')
        .fontSize(9.5)
        .fillColor('#444444')
        .text(safe(data.website, 'https://www.bircanmigration.au'), 62, doc.y + 2);

      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(i);
        footer(doc);
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
