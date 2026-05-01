const crypto = require('crypto');
const PDFDocument = require('pdfkit');

function safeText(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function normalisePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.formPayload && typeof payload.formPayload === 'object') return payload.formPayload;
  if (payload.answers && typeof payload.answers === 'object') return payload.answers;
  return payload;
}

function pick(payload, names, fallback = '—') {
  const keys = Object.keys(payload || {});
  for (const name of names) {
    if (payload[name] !== undefined && payload[name] !== null && payload[name] !== '') return payload[name];
    const found = keys.find(k => k.toLowerCase().replace(/[^a-z0-9]/g, '') === String(name).toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (found && payload[found] !== undefined && payload[found] !== null && payload[found] !== '') return payload[found];
  }
  return fallback;
}

function writeHeading(doc, text) {
  doc.moveDown(0.75);
  doc.fontSize(12).fillColor('#061936').font('Helvetica-Bold').text(text);
  doc.moveDown(0.25);
  doc.moveTo(doc.x, doc.y).lineTo(545, doc.y).strokeColor('#d8e2f0').stroke();
  doc.moveDown(0.45);
  doc.font('Helvetica').fillColor('#1f2937');
}

function writePair(doc, label, value) {
  doc.fontSize(9).fillColor('#475467').font('Helvetica-Bold').text(label, { continued: true });
  doc.fillColor('#101828').font('Helvetica').text(` ${safeText(value)}`);
}

function writeParagraph(doc, text) {
  doc.fontSize(10).fillColor('#1f2937').font('Helvetica').text(String(text), { align: 'justify', lineGap: 3 });
  doc.moveDown(0.45);
}

function writeBullet(doc, text) {
  doc.fontSize(10).fillColor('#1f2937').font('Helvetica').text(`• ${String(text)}`, { indent: 12, align: 'left', lineGap: 2 });
}

function buildAssessmentPdfBuffer(assessment) {
  return new Promise((resolve, reject) => {
    const visaType = safeText(assessment.visa_type, 'Visa');
    const payload = normalisePayload(assessment.form_payload || {});
    const generatedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });

    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `Bircan Migration - Subclass ${visaType} Advice Letter`,
        Author: 'Bircan Migration',
        Subject: `Advice letter for assessment ${assessment.id}`
      }
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    doc.rect(0, 0, 595.28, 84).fill('#061936');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('Bircan Migration', 50, 28);
    doc.font('Helvetica').fontSize(10).text('Migration advice-letter issue copy', 50, 54);

    doc.fillColor('#061936').font('Helvetica-Bold').fontSize(18).text(`Subclass ${visaType} Advice Letter`, 50, 112, { align: 'center' });
    doc.moveDown(1.2);

    doc.fontSize(9).fillColor('#101828');
    writePair(doc, 'Reference:', assessment.id);
    writePair(doc, 'Client email:', assessment.client_email);
    writePair(doc, 'Applicant email:', assessment.applicant_email || pick(payload, ['applicantEmail', 'email']));
    writePair(doc, 'Applicant name:', assessment.applicant_name || pick(payload, ['applicantName', 'fullName', 'name']));
    writePair(doc, 'Processing plan:', assessment.active_plan || assessment.selected_plan);
    writePair(doc, 'Generated:', generatedAt);

    writeHeading(doc, '1. Instructions and basis of assessment');
    writeParagraph(doc, 'We have prepared this advice letter from the information entered in the online questionnaire and the payment-confirmed assessment record. This document is the issued PDF copy held against the client matter, not the legacy preview/template endpoint.');
    writeParagraph(doc, 'The assessment remains subject to verification of supporting evidence and any facts not disclosed in the questionnaire. Any inconsistency, omission or adverse information may materially alter the outcome.');

    writeHeading(doc, '2. Applicant and matter summary');
    const summaryPairs = [
      ['Visa subclass', visaType],
      ['Current location', pick(payload, ['currentLocation', 'location', 'countryOfResidence'])],
      ['Citizenship/passport', pick(payload, ['citizenship', 'passportCountry', 'nationality'])],
      ['Relationship/employer/sponsor context', pick(payload, ['sponsor', 'employer', 'partner', 'relationship', 'nomination'])],
      ['Occupation/course/purpose', pick(payload, ['occupation', 'anzsco', 'course', 'purpose', 'visitPurpose'])],
      ['English/evidence position', pick(payload, ['english', 'englishTest', 'evidence', 'documents'])]
    ];
    summaryPairs.forEach(([label, value]) => writePair(doc, `${label}:`, value));

    writeHeading(doc, '3. Preliminary legal assessment');
    writeParagraph(doc, `On the information presently available, the matter must be assessed against the grant criteria for subclass ${visaType}, including the primary eligibility criteria, evidence requirements, health and character requirements, genuineness considerations, and any stream-specific nomination, sponsorship, relationship, skills, English, financial capacity or temporary-stay requirements that apply to the selected pathway.`);
    writeBullet(doc, 'Payment has been verified for this assessment before the PDF was issued.');
    writeBullet(doc, 'The assessment record is tied to the authenticated client account email.');
    writeBullet(doc, 'The questionnaire answers should be checked against documentary evidence before lodgement or final legal advice.');
    doc.moveDown(0.4);

    writeHeading(doc, '4. Key risk and evidence issues');
    const riskFields = Object.entries(payload).filter(([k, v]) => {
      const kk = String(k).toLowerCase();
      return /(refusal|cancel|overstay|character|health|criminal|breach|condition|gap|risk|issue|previous|debt|8503|schedule)/.test(kk) || /yes|true|refus|cancel|overstay|criminal/i.test(String(v));
    }).slice(0, 12);
    if (riskFields.length) {
      riskFields.forEach(([k, v]) => writeBullet(doc, `${k}: ${safeText(v)}`));
    } else {
      writeBullet(doc, 'No specific adverse-risk answer was isolated from the questionnaire record. This must still be verified against the applicant’s full immigration history and evidence.');
    }

    writeHeading(doc, '5. Questionnaire record relied upon');
    const entries = Object.entries(payload).filter(([k]) => !['password', 'token'].includes(String(k).toLowerCase())).slice(0, 90);
    if (!entries.length) {
      writeParagraph(doc, 'No questionnaire payload was attached to this assessment record. The matter should be reviewed manually before any further advice is issued.');
    } else {
      entries.forEach(([key, value]) => {
        if (doc.y > 735) doc.addPage();
        doc.fontSize(8.5).fillColor('#061936').font('Helvetica-Bold').text(String(key), { continued: true })
          .fillColor('#344054').font('Helvetica').text(`: ${safeText(value)}`);
      });
    }

    writeHeading(doc, '6. Next professional action');
    writeParagraph(doc, 'Before any application is lodged or final advice is given, the client should provide complete supporting evidence and the file should be checked against the current Migration Act, Migration Regulations, legislative instruments, policy and Departmental forms applicable at the time of decision.');

    doc.moveDown(0.7);
    doc.fontSize(8).fillColor('#667085').text('Generated by Bircan Migration client portal. This PDF is attached to the verified assessment matter in the client dashboard.', { align: 'center' });

    doc.end();
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { buildAssessmentPdfBuffer, sha256 };
