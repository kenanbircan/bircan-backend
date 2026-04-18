const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const brand = require('./brandConfig');

function toText(value, fallback = 'Not provided') {
  if (value === undefined || value === null) return fallback;
  const str = String(value).trim();
  return str || fallback;
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const str = String(value || '').trim().toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(str)) return 'Yes';
  if (['no', 'n', 'false', '0'].includes(str)) return 'No';
  return toText(value);
}

function listify(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
  return String(value)
    .split(/\n|;|\.|•|\-/)
    .map((part) => part.trim())
    .filter((part) => part.length > 4);
}

function titleCase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildOutcomeTone(outcome) {
  const val = String(outcome || '').toLowerCase();
  if (val.includes('eligible') && !val.includes('not')) {
    return {
      label: titleCase(outcome || 'Potentially eligible'),
      fill: brand.colors.successBg,
      text: brand.colors.successText
    };
  }
  if (val.includes('uncertain') || val.includes('borderline')) {
    return {
      label: titleCase(outcome || 'Requires detailed review'),
      fill: brand.colors.warningBg,
      text: brand.colors.warningText
    };
  }
  return {
    label: titleCase(outcome || 'Further review required'),
    fill: brand.colors.riskBg,
    text: brand.colors.riskText
  };
}

function resolveMatter(assessment) {
  return toText(
    assessment.matter ||
      assessment.visaType ||
      assessment.subclass ||
      (assessment.stream ? `Subclass 482 - ${assessment.stream}` : 'Preliminary visa assessment')
  );
}

function resolveDate(value) {
  if (!value) return new Date().toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return toText(value);
  return date.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
}

class AssessmentPdfBuilder {
  constructor(doc, options = {}) {
    this.doc = doc;
    this.options = options;
    this.pageNumber = 0;
    this.marginX = 52;
    this.headerHeight = 102;
    this.footerHeight = 44;
    this.contentTop = this.marginX + this.headerHeight;
    this.contentBottom = doc.page.height - this.marginX - this.footerHeight;
    this.contentWidth = doc.page.width - this.marginX * 2;
    this.addPageDecorations();
    this.doc.on('pageAdded', () => this.addPageDecorations());
  }

  addPageDecorations() {
    this.pageNumber += 1;
    const { doc } = this;
    const left = this.marginX;
    const right = doc.page.width - this.marginX;
    const top = this.marginX - 12;
    const colors = brand.colors;

    doc.save();
    doc.rect(0, 0, doc.page.width, 16).fill(colors.navy);
    doc.restore();

    if (this.options.logoPath && fs.existsSync(this.options.logoPath)) {
      try {
        doc.image(this.options.logoPath, left, top + 6, { fit: [78, 78], align: 'left', valign: 'center' });
      } catch (_) {
        this.drawLogoFallback(left, top + 6);
      }
    } else {
      this.drawLogoFallback(left, top + 6);
    }

    const headerTextX = left + 92;
    doc.font('Helvetica-Bold').fontSize(16).fillColor(colors.navy).text(brand.principal, headerTextX, top + 6, {
      width: 220,
      lineGap: 1
    });

    doc.font('Helvetica').fontSize(9.2).fillColor(colors.text);
    doc.text(brand.credentials.join(' | '), headerTextX, top + 28, {
      width: 300,
      lineGap: 1
    });

    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(colors.blue).text(brand.firmName, right - 205, top + 8, {
      width: 205,
      align: 'right'
    });
    doc.font('Helvetica').fontSize(8.9).fillColor(colors.text)
      .text(brand.website, right - 205, top + 26, { width: 205, align: 'right' })
      .text(brand.email, right - 205, top + 38, { width: 205, align: 'right' })
      .text(brand.phone, right - 205, top + 50, { width: 205, align: 'right' })
      .text(brand.address, right - 205, top + 62, { width: 205, align: 'right' });

    doc.moveTo(left, top + 90).lineTo(right, top + 90).lineWidth(1.2).strokeColor(colors.gold).stroke();

    const footerY = doc.page.height - this.marginX + 8;
    doc.moveTo(left, footerY - 12).lineTo(right, footerY - 12).lineWidth(0.6).strokeColor(colors.lightBorder).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(colors.muted)
      .text('This preliminary assessment is subject to documentary verification and final legal review.', left, footerY - 4, {
        width: 320,
        align: 'left'
      })
      .text(`Page ${this.pageNumber}`, right - 60, footerY - 4, {
        width: 60,
        align: 'right'
      });

    doc.x = left;
    doc.y = this.contentTop;
  }

  drawLogoFallback(x, y) {
    const { doc } = this;
    doc.save();
    doc.roundedRect(x, y, 74, 74, 10).fillAndStroke('#F3F6FB', brand.colors.lightBorder);
    doc.font('Helvetica-Bold').fontSize(18).fillColor(brand.colors.navy).text('BM', x, y + 20, { width: 74, align: 'center' });
    doc.font('Helvetica').fontSize(7.8).fillColor(brand.colors.blue).text('Migration', x, y + 44, { width: 74, align: 'center' });
    doc.restore();
  }

  ensureSpace(height = 24) {
    if (this.doc.y + height > this.contentBottom) {
      this.doc.addPage();
    }
  }

  section(title, body) {
    this.ensureSpace(52);
    this.doc.moveDown(0.3);
    this.doc.font('Helvetica-Bold').fontSize(11).fillColor(brand.colors.navy).text(title.toUpperCase(), this.marginX, this.doc.y);
    this.doc.moveTo(this.marginX, this.doc.y + 2).lineTo(this.marginX + this.contentWidth, this.doc.y + 2).lineWidth(0.8).strokeColor(brand.colors.lightBorder).stroke();
    this.doc.moveDown(0.55);
    this.doc.font('Helvetica').fontSize(10.1).fillColor(brand.colors.text).text(body, {
      width: this.contentWidth,
      align: 'justify',
      lineGap: 3
    });
    this.doc.moveDown(0.8);
  }

  bullets(title, items) {
    const cleaned = items.filter(Boolean);
    if (!cleaned.length) return;
    this.ensureSpace(44);
    this.doc.font('Helvetica-Bold').fontSize(11).fillColor(brand.colors.navy).text(title.toUpperCase(), this.marginX, this.doc.y);
    this.doc.moveDown(0.35);
    cleaned.forEach((item) => {
      this.ensureSpace(26);
      const bulletX = this.marginX + 8;
      const textX = this.marginX + 20;
      const y = this.doc.y + 4;
      this.doc.circle(bulletX, y, 2.1).fill(brand.colors.gold);
      this.doc.fillColor(brand.colors.text).font('Helvetica').fontSize(10.1).text(item, textX, this.doc.y, {
        width: this.contentWidth - 24,
        align: 'justify',
        lineGap: 2
      });
      this.doc.moveDown(0.35);
    });
    this.doc.moveDown(0.45);
  }

  keyValueGrid(title, rows) {
    const filtered = rows.filter((row) => row && row.label && row.value);
    if (!filtered.length) return;
    this.ensureSpace(70);
    this.doc.font('Helvetica-Bold').fontSize(11).fillColor(brand.colors.navy).text(title.toUpperCase(), this.marginX, this.doc.y);
    this.doc.moveDown(0.45);

    const tableX = this.marginX;
    const labelW = 165;
    const valueW = this.contentWidth - labelW;

    filtered.forEach((row, idx) => {
      const rowHeight = Math.max(
        26,
        this.doc.heightOfString(String(row.value), { width: valueW - 16, lineGap: 2 }) + 12
      );
      this.ensureSpace(rowHeight + 4);
      const y = this.doc.y;
      this.doc.save();
      this.doc.roundedRect(tableX, y, this.contentWidth, rowHeight, 5).fillAndStroke(idx % 2 === 0 ? '#FBFCFE' : '#F6F8FB', brand.colors.lightBorder);
      this.doc.restore();
      this.doc.font('Helvetica-Bold').fontSize(9.4).fillColor(brand.colors.navy).text(row.label, tableX + 10, y + 8, {
        width: labelW - 16
      });
      this.doc.font('Helvetica').fontSize(9.4).fillColor(brand.colors.text).text(String(row.value), tableX + labelW, y + 8, {
        width: valueW - 12,
        lineGap: 2
      });
      this.doc.y = y + rowHeight + 6;
    });
    this.doc.moveDown(0.45);
  }

  titleBlock({ title, subtitle, matter, date, outcome }) {
    this.ensureSpace(120);
    const y = this.doc.y;
    const leftW = this.contentWidth - 165;
    const tone = buildOutcomeTone(outcome);

    this.doc.font('Helvetica-Bold').fontSize(19).fillColor(brand.colors.navy).text(title, this.marginX, y, { width: leftW });
    this.doc.font('Helvetica').fontSize(10.5).fillColor(brand.colors.text).text(subtitle, this.marginX, this.doc.y + 4, {
      width: leftW,
      lineGap: 2
    });

    const badgeX = this.marginX + leftW + 18;
    const badgeY = y + 8;
    this.doc.save();
    this.doc.roundedRect(badgeX, badgeY, 147, 46, 8).fillAndStroke(tone.fill, tone.fill);
    this.doc.restore();
    this.doc.font('Helvetica-Bold').fontSize(8.4).fillColor(tone.text).text('PRELIMINARY OUTCOME', badgeX, badgeY + 8, {
      width: 147,
      align: 'center'
    });
    this.doc.font('Helvetica-Bold').fontSize(13).fillColor(tone.text).text(tone.label, badgeX, badgeY + 22, {
      width: 147,
      align: 'center'
    });

    const detailsY = Math.max(this.doc.y + 8, y + 62);
    this.doc.y = detailsY;
    this.keyValueGrid('Matter Details', [
      { label: 'Date', value: date },
      { label: 'Matter', value: matter }
    ]);
  }
}

function composeNarrative(input) {
  const clientName = toText(input.fullName || input.clientName, 'The applicant');
  const citizenship = toText(input.citizenship || input.nationality);
  const location = toText(input.location || input.currentLocation || input.currentVisa);
  const employer = toText(input.employerName || input.sponsorName);
  const occupation = toText(input.occupation);
  const qualification = toText(input.highestQualification);
  const field = toText(input.fieldOfStudy);
  const experience = toText(input.workYears || input.experienceYears);
  const english = toText(input.englishScore || input.englishStatus);
  const stream = toText(input.stream);
  const nomination = toText(input.nominationStatus);

  return {
    scope:
      `We have been instructed to provide a preliminary migration assessment in relation to a potential ${resolveMatter(input)} application. This advice is based solely on the information presently supplied and is prepared for initial case screening, professional review, and client guidance before formal lodgement. It is not a substitute for a full documentary audit or final legal advice on the completed application package.`,
    background:
      `${clientName} is identified as a citizen of ${citizenship} and is presently recorded as ${location}. The proposed sponsoring business is ${employer}, with the nominated role of ${occupation}. The available instructions indicate the matter is being considered under the ${stream} pathway, with nomination status recorded as ${nomination}. The applicant reports ${qualification} in ${field}, together with ${experience} of relevant employment experience. English language information has been recorded as ${english}.`,
    legalAssessment:
      `On the present instructions, the application demonstrates a prima facie level of suitability for further progression. The nominated occupation appears to align with the role described, the professional profile is broadly consistent with the claimed employment history, and the current information does not disclose any immediate integrity, compliance, or character barriers. Final legal viability will remain dependent on documentary verification, sponsor and nomination validity, legislative criteria under the Migration Act 1958 and Migration Regulations 1994, and any policy settings applicable at time of decision.`,
    finding:
      `Subject to verification of the applicant's qualifications, skills, work history, identity, sponsorship framework, nomination approval, and all supporting evidence, this matter may reasonably proceed to the next stage of preparation. The case should nonetheless be treated as preliminary only, and no assurance can be given as to grant until a complete evidentiary review has been completed and the Department of Home Affairs has assessed the application in full.`,
    recommendation:
      `The recommended course is to complete a full document collection, verify role genuineness and sponsor readiness, confirm all statutory requirements for the intended visa pathway, and conduct final legal review before lodgement. Any discrepancy between the information supplied and the supporting records should be addressed before submission to reduce refusal risk and improve the overall presentation of the case.`
  };
}

function buildStrengths(input) {
  const strengths = [];
  if (normalizeBoolean(input.hasSponsor) === 'Yes') strengths.push('A sponsoring employer has been identified, supporting progression of the matter.');
  if (toText(input.nominationStatus).toLowerCase().includes('lodged')) strengths.push(`Nomination status is recorded as: ${toText(input.nominationStatus)}.`);
  if (toText(input.occupationList, '').length) strengths.push(`The nominated occupation is referenced against: ${toText(input.occupationList)}.`);
  if (normalizeBoolean(input.qualificationRelevant) === 'Yes') strengths.push(`The applicant reports a relevant qualification in ${toText(input.fieldOfStudy)}.`);
  if (/completed|positive|successful/i.test(toText(input.skillsAssessment, ''))) strengths.push(`Skills assessment position is favourable: ${toText(input.skillsAssessment)}.`);
  if (normalizeBoolean(input.oneYearRecentExperience) === 'Yes' || toText(input.workYears, '').length) strengths.push(`Employment history indicates recent relevant experience: ${toText(input.workYears || input.employmentHistory)}.`);
  if (!/not completed|waived/i.test(toText(input.englishStatus, '')) && toText(input.englishStatus, '').length) strengths.push(`English language position recorded as: ${toText(input.englishScore || input.englishStatus)}.`);
  if (normalizeBoolean(input.includePartner) === 'Yes') strengths.push('Secondary applicant information has been flagged for spouse/partner inclusion.');
  if (normalizeBoolean(input.docsReady) === 'Yes' || toText(input.docsReady, '').length) strengths.push(`Document readiness appears positive based on the materials identified: ${toText(input.docsReady)}.`);
  return strengths;
}

function buildRisks(input) {
  const risks = [];
  if (/pending|not approved|to be lodged/i.test(toText(input.nominationStatus, ''))) risks.push('Nomination approval remains a critical dependency and must be secured before grant can occur.');
  if (/will arrange|not yet|pending/i.test(toText(input.healthInsurance, ''))) risks.push('Health insurance arrangements should be formally confirmed before the matter proceeds to finalisation.');
  if (normalizeBoolean(input.genuinePosition) !== 'Yes') risks.push('The genuineness of the position should be assessed carefully with employer-side evidence.');
  if (normalizeBoolean(input.passportReady) !== 'Yes') risks.push('Identity documentation should be checked and completed, including a valid passport copy.');
  if (normalizeBoolean(input.employmentRefs) !== 'Yes') risks.push('Employment references should be reviewed to ensure duties, dates, and remuneration align with the claimed occupation.');
  if (normalizeBoolean(input.qualificationDocs) !== 'Yes') risks.push('Qualification documents and transcripts should be verified and, where necessary, certified.');
  if (normalizeBoolean(input.characterIssues) === 'Yes' || normalizeBoolean(input.returnIssue) === 'Yes' || normalizeBoolean(input.visaCompliance) === 'No') {
    risks.push('Potential compliance or integrity issues require detailed legal review before any lodgement strategy is confirmed.');
  }
  if (!risks.length) {
    risks.push('No major disqualifying issue is apparent from the current instructions; however, all facts remain subject to document verification and legal review.');
  }
  return risks;
}

function buildEvidenceList(input) {
  const evidence = [];
  if (normalizeBoolean(input.passportReady) !== 'Yes') evidence.push('Certified copy of current passport biodata page.');
  else evidence.push('Current passport biodata page for all applicants.');
  if (normalizeBoolean(input.cvReady) !== 'Yes') evidence.push('Updated curriculum vitae setting out complete employment history.');
  else evidence.push('Updated curriculum vitae confirming recent employment chronology.');
  if (normalizeBoolean(input.employmentRefs) !== 'Yes') evidence.push('Employer references confirming duties, dates, hours, and remuneration.');
  else evidence.push('Employment references and supporting records verifying claimed duties and duration.');
  if (normalizeBoolean(input.qualificationDocs) !== 'Yes') evidence.push('Qualification certificates and academic transcripts.');
  else evidence.push('Certified qualification certificates and transcripts.');
  if (toText(input.skillsAssessment, '').length) evidence.push(`Skills assessment evidence: ${toText(input.skillsAssessment)}${input.skillsAssessmentRef ? ` (${input.skillsAssessmentRef})` : ''}.`);
  if (toText(input.englishStatus, '').length) evidence.push(`English language evidence: ${toText(input.englishScore || input.englishStatus)}.`);
  if (normalizeBoolean(input.hasSponsor) === 'Yes') evidence.push('Sponsor and nomination documents, including evidence of business operations and role genuineness.');
  if (normalizeBoolean(input.includePartner) === 'Yes') evidence.push('Marriage or relationship evidence and identification documents for the secondary applicant.');
  if (toText(input.healthInsurance, '').length) evidence.push(`Health insurance position: ${toText(input.healthInsurance)}.`);
  return evidence;
}

function buildSnapshot(input) {
  return [
    { label: 'Client', value: toText(input.fullName || input.clientName) },
    { label: 'Email', value: toText(input.email || input.clientEmail) },
    { label: 'Date of birth', value: toText(input.dob || input.dateOfBirth) },
    { label: 'Nationality', value: toText(input.citizenship || input.nationality) },
    { label: 'Location', value: toText(input.location || input.currentVisa) },
    { label: 'Visa pathway', value: toText(input.stream || input.visaType || input.subclass) },
    { label: 'Occupation', value: toText(input.occupation) },
    { label: 'Sponsor', value: toText(input.employerName || input.sponsorName) },
    { label: 'Nomination status', value: toText(input.nominationStatus) },
    { label: 'Qualification', value: `${toText(input.highestQualification)}${input.fieldOfStudy ? ` - ${toText(input.fieldOfStudy)}` : ''}` },
    { label: 'Work experience', value: toText(input.workYears || input.employmentHistory) },
    { label: 'English', value: toText(input.englishScore || input.englishStatus) },
    { label: 'Partner included', value: normalizeBoolean(input.includePartner) },
    { label: 'Submission ID', value: toText(input.submissionId) }
  ];
}

function writeSignature(doc) {
  doc.moveDown(0.9);
  doc.font('Helvetica').fontSize(10.2).fillColor(brand.colors.text).text('Yours faithfully,');
  doc.moveDown(1.0);
  doc.font('Helvetica-Bold').fontSize(11.2).fillColor(brand.colors.navy).text(brand.principal);
  doc.font('Helvetica').fontSize(9.8).fillColor(brand.colors.text)
    .text('Registered Migration Agent')
    .text('MARN: 1463685')
    .text(brand.firmName);
}

async function generateAssessmentPdf({ assessment, outputPath, logoPath, title } = {}) {
  if (!assessment || typeof assessment !== 'object') {
    throw new Error('assessment object is required');
  }

  const narrative = composeNarrative(assessment);
  const strengths = buildStrengths(assessment);
  const risks = buildRisks(assessment);
  const evidence = buildEvidenceList(assessment);
  const snapshot = buildSnapshot(assessment);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      autoFirstPage: true,
      info: {
        Title: title || 'Preliminary Visa Assessment Letter',
        Author: brand.principal,
        Subject: resolveMatter(assessment),
        Creator: brand.firmName,
        Producer: brand.firmName,
        Keywords: 'migration law, visa assessment, bircan migration, preliminary advice'
      }
    });

    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(buffers);
      if (outputPath) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, pdfBuffer);
      }
      resolve(pdfBuffer);
    });

    const builder = new AssessmentPdfBuilder(doc, { logoPath });

    builder.titleBlock({
      title: title || 'Preliminary Visa Assessment Letter',
      subtitle:
        'Prepared for initial migration-law screening and client guidance. This document is preliminary only and remains subject to full documentary review, legal verification, sponsorship and nomination outcomes, and Departmental assessment.',
      matter: resolveMatter(assessment),
      date: resolveDate(assessment.date || assessment.createdAt),
      outcome: assessment.preliminaryOutcome || assessment.outcome || 'Potentially eligible'
    });

    builder.keyValueGrid('Client Snapshot', snapshot);
    builder.section('A. Instructions and Scope', narrative.scope);
    builder.section('B. Applicant Background', narrative.background);
    builder.section('C. Preliminary Legal Assessment', narrative.legalAssessment);
    builder.bullets('D. Findings Supporting Progression', strengths);
    builder.bullets('E. Risks and Migration Considerations', risks);
    builder.bullets('F. Required Evidence and Documentation', evidence);
    builder.section('G. Professional Recommendation', narrative.recommendation);
    builder.section(
      'H. Important Legal Notice',
      'This preliminary assessment has been prepared on the basis of the information provided to date and should not be relied on as a guarantee of visa grant. Final outcomes depend on the complete evidentiary record, sponsor and nomination validity, applicable legislative criteria, policy settings, and the discretion of the Department of Home Affairs. Any change in facts, law, policy, or supporting documents may materially affect the merits of the case.'
    );

    if (assessment.extraNotes) {
      builder.section('I. Internal Case Note', toText(assessment.extraNotes));
    }

    writeSignature(doc);
    doc.end();
  });
}

module.exports = {
  generateAssessmentPdf
};
