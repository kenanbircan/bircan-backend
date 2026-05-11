'use strict';

/**
 * Bircan Migration - Delegate-Grade PDF Renderer v10
 * Drop-in replacement for the old questionnaire-style pdf.js renderer.
 *
 * Primary exports:
 *   - generateAssessmentPdfBuffer(input)
 *   - generateAssessmentPdf(input, outputPath)
 *   - buildSeniorAssessmentSections(input)
 *   - sanitiseGenericAssessmentLanguage(text)
 *
 * Required dependency:
 *   npm install pdfkit
 */

const fs = require('fs');
const path = require('path');

const BRAND = {
  navy: '#0B1F3A',
  blue: '#163B73',
  gold: '#B08A3C',
  ink: '#18202A',
  muted: '#5E6A78',
  pale: '#F4F7FB',
  line: '#D8E0EA',
  riskLow: '#E8F6EF',
  riskModerate: '#FFF7E6',
  riskElevated: '#FDEEEE',
  riskCritical: '#F9D7D7'
};

const GENERIC_PHRASES = [
  [/appears capable,? subject to verification/gi, 'requires legal and evidentiary confirmation before reliance'],
  [/further evidentiary review recommended/gi, 'further legal and evidentiary analysis is required'],
  [/professional clarification required/gi, 'a final professional position cannot yet be formed'],
  [/pathway positioning/gi, 'migration strategy and evidentiary positioning'],
  [/commercially genuine/gi, 'genuine, ongoing and supported by the employer\'s business operations'],
  [/operationally required/gi, 'necessary within the employer\'s current business structure'],
  [/appears satisfied/gi, 'is presently indicated by the available instructions'],
  [/may warrant review/gi, 'should be assessed as a structured alternative pathway'],
  [/subject to verification/gi, 'pending review of original supporting documents']
];

function requirePdfKit() {
  try {
    return require('pdfkit');
  } catch (err) {
    const e = new Error('PDFKit is required for delegate-grade PDF generation. Install it with: npm install pdfkit');
    e.cause = err;
    throw e;
  }
}

function value(input, paths, fallback = '') {
  for (const p of paths) {
    const parts = p.split('.');
    let cur = input;
    for (const part of parts) cur = cur && Object.prototype.hasOwnProperty.call(cur, part) ? cur[part] : undefined;
    if (cur !== undefined && cur !== null && String(cur).trim() !== '') return cur;
  }
  return fallback;
}

function asArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return [v];
}

function cleanText(text) {
  return String(text || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitiseGenericAssessmentLanguage(text) {
  let out = cleanText(text);
  for (const [pattern, replacement] of GENERIC_PHRASES) out = out.replace(pattern, replacement);
  return out;
}

function riskLabel(scoreOrText) {
  const s = String(scoreOrText || '').toLowerCase();
  if (s.includes('critical') || s.includes('refusal') || s.includes('do not rely')) return 'Critical Delegate Risk';
  if (s.includes('elevated') || s.includes('weak') || s.includes('insufficient')) return 'Elevated Delegate Risk';
  if (s.includes('moderate') || s.includes('adequate')) return 'Moderate Delegate Risk';
  return 'Low Delegate Risk';
}

function riskFill(label) {
  if (/critical/i.test(label)) return BRAND.riskCritical;
  if (/elevated/i.test(label)) return BRAND.riskElevated;
  if (/moderate/i.test(label)) return BRAND.riskModerate;
  return BRAND.riskLow;
}

function inferVisaFamily(subclass) {
  const s = String(subclass || '');
  if (['482', '186', '187', '494'].includes(s)) return 'Employer Sponsored';
  if (['189', '190', '491'].includes(s)) return 'Skilled Migration';
  if (['300', '309', '820', '801', '100'].includes(s)) return 'Partner / Family';
  if (s === '500') return 'Student';
  if (s === '600') return 'Visitor';
  if (s === '866') return 'Protection';
  return 'Migration';
}

function defaultCriterionBlocks(input) {
  const subclass = String(value(input, ['subclass', 'matter.subclass', 'answers.subclass'], ''));
  const stream = value(input, ['stream', 'matter.stream', 'answers.stream'], '');
  const occupation = value(input, ['occupation', 'matter.occupation', 'answers.occupation', 'nominatedOccupation'], 'the nominated occupation');
  const employer = value(input, ['employer', 'sponsor.name', 'answers.employerName'], 'the sponsoring employer');
  const family = inferVisaFamily(subclass);

  if (family === 'Employer Sponsored') {
    return [
      {
        title: 'Validity, nomination connection and stream selection',
        legislativePosition: `For Subclass ${subclass}${stream ? ` under the ${stream} stream` : ''}, the application must be assessed against the applicable Schedule 1 validity requirements, nomination framework and stream-specific Schedule 2 criteria. The visa application, nomination details and applicant instructions must align before lodgement can safely proceed.`,
        evidencePosition: `The present instructions identify ${occupation} with ${employer}. The current file should be reconciled against the nomination approval, position description, employment contract and any sponsor correspondence before a final position is adopted.`,
        delegateRiskAnalysis: 'A delegate is likely to examine whether the visa application accurately reflects the approved nomination, whether the nominated position remains available, and whether the applicant is properly connected to the position relied upon for the visa pathway.',
        strategicCommentary: 'The safest professional approach is to confirm the nomination history and stream basis first, then assess employment continuity, occupation alignment and sponsor compliance against that confirmed pathway.',
        evidenceMissing: ['Nomination approval or nomination lodgement evidence', 'Current position description', 'Employment contract', 'Sponsor confirmation letter'],
        remediationAction: 'Obtain the complete nomination and sponsor file before final advice is issued.',
        risk: 'Moderate Delegate Risk'
      },
      {
        title: 'Genuine position, business need and sponsor integrity',
        legislativePosition: 'Employer-sponsored criteria require the nominated position to be genuine, ongoing where required, and supported by the employer\'s actual business operations. Sponsor compliance and adverse information must also be considered.',
        evidencePosition: `The file should establish why ${employer} requires the position, how the role fits within the business structure, and whether payroll and operational records support the position over time.`,
        delegateRiskAnalysis: 'Departmental scrutiny commonly focuses on business activity, staffing structure, payroll capacity, related-party issues, role inflation, artificial duties and whether the position exists principally to secure a migration outcome.',
        strategicCommentary: 'The evidentiary package should present a coherent commercial narrative supported by objective records rather than broad employer assertions.',
        evidenceMissing: ['Organisation chart', 'Business activity records', 'Payroll and superannuation records', 'Financial capacity material', 'Role necessity evidence'],
        remediationAction: 'Prepare an employer evidence bundle that connects business activity, staffing need, duties and salary capacity.',
        risk: 'Moderate Delegate Risk'
      },
      {
        title: 'Occupation alignment, skills and employment chronology',
        legislativePosition: 'The applicant\'s qualifications, skills assessment where required, employment history and actual duties must be consistent with the nominated occupation and stream requirements.',
        evidencePosition: `The occupation position for ${occupation} should be tested against duties, seniority, qualifications, employment references, payroll chronology and any registration or licensing requirement.`,
        delegateRiskAnalysis: 'Risk increases where duties are mixed, the title is broad, the applicant performs tasks outside the nominated occupation, or claimed employment periods do not reconcile with payroll, tax and visa history.',
        strategicCommentary: 'Before lodgement, the evidence should be ordered chronologically and mapped to the occupation criteria so that a delegate can follow the applicant\'s claimed experience without ambiguity.',
        evidenceMissing: ['Detailed references', 'Skills assessment if required', 'Qualifications', 'Payroll chronology', 'Tax and superannuation records'],
        remediationAction: 'Create a chronology table and occupation-duty matrix before finalising the advice.',
        risk: 'Elevated Delegate Risk'
      },
      {
        title: 'Public interest criteria, health, character and integrity',
        legislativePosition: 'The applicant and included family members must satisfy applicable health, character and integrity requirements, including any relevant public interest criteria and disclosure obligations.',
        evidencePosition: 'The file should include complete immigration history, prior refusal or cancellation details, police clearances where required, health declarations and consistency checks across all identity and travel documents.',
        delegateRiskAnalysis: 'A delegate may scrutinise undisclosed refusals, inconsistent dates, character issues, health disclosures, identity discrepancies and any payment-for-visas concerns.',
        strategicCommentary: 'Any adverse or unclear history should be disclosed and explained proactively. Silence or inconsistent disclosure is often more damaging than a properly contextualised issue.',
        evidenceMissing: ['Police clearances', 'Health examination records if required', 'Full visa history', 'Refusal/cancellation records if any', 'Payment-for-visas declaration'],
        remediationAction: 'Complete integrity reconciliation before any final lodgement recommendation.',
        risk: 'Moderate Delegate Risk'
      }
    ];
  }

  return [
    {
      title: 'Core eligibility and pathway selection',
      legislativePosition: `The Subclass ${subclass || 'visa'} pathway must be assessed against the applicable validity, primary criteria and public interest requirements.`,
      evidencePosition: 'The presently available instructions provide a preliminary basis for assessment, but the legal position depends on original document review and evidence reconciliation.',
      delegateRiskAnalysis: 'A delegate is likely to focus on whether the claimed facts are supported by objective documents and whether any inconsistencies affect eligibility or credibility.',
      strategicCommentary: 'The matter should be structured around the strongest available pathway and any weaker elements should be addressed before lodgement.',
      evidenceMissing: ['Identity evidence', 'Eligibility evidence', 'Migration history', 'Health and character evidence'],
      remediationAction: 'Complete legal and evidentiary review before final advice.',
      risk: 'Moderate Delegate Risk'
    }
  ];
}

function buildSeniorAssessmentSections(input = {}) {
  const subclass = value(input, ['subclass', 'matter.subclass', 'answers.subclass'], '');
  const stream = value(input, ['stream', 'matter.stream', 'answers.stream'], '');
  const applicant = value(input, ['applicantName', 'client.name', 'matter.applicantName', 'answers.fullName'], 'Applicant');
  const ref = value(input, ['reference', 'submissionRef', 'matter.reference'], `BM-${Date.now()}`);
  const family = inferVisaFamily(subclass);
  const criteria = asArray(value(input, ['criteriaAnalysis', 'adviceBundle.criteriaAnalysis', 'analysis.criteria'], null, null));
  const criterionBlocks = criteria.length ? criteria.map(c => ({
    title: c.title || c.criterion || 'Criterion analysis',
    legislativePosition: c.legislativePosition || c.legalRequirement || c.requirement,
    evidencePosition: c.evidencePosition || c.evidence || c.finding,
    delegateRiskAnalysis: c.delegateRiskAnalysis || c.riskAnalysis || c.risk,
    strategicCommentary: c.strategicCommentary || c.strategy || c.commentary,
    evidenceMissing: c.evidenceMissing || c.missingEvidence || [],
    remediationAction: c.remediationAction || c.nextStep || c.recommendation,
    risk: riskLabel(c.risk || c.grade || c.status)
  })) : defaultCriterionBlocks(input);

  const riskSummary = criterionBlocks.map(c => ({ title: c.title, risk: riskLabel(c.risk) }));
  const highRisk = riskSummary.filter(r => /elevated|critical/i.test(r.risk)).length;
  const readiness = highRisk ? 'Not yet lodgement-ready without targeted evidence reconciliation' : 'Capable of progressing toward lodgement-ready review';

  return {
    matter: {
      reference: ref,
      applicant,
      applicantEmail: value(input, ['applicantEmail', 'client.email', 'answers.email'], ''),
      clientEmail: value(input, ['clientEmail', 'account.email', 'answers.accountEmail'], ''),
      subclass,
      stream,
      family,
      generatedAt: value(input, ['generatedAt'], new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' }))
    },
    executive: {
      title: `Subclass ${subclass || ''}${stream ? ` - ${stream}` : ''} Senior Migration Assessment`,
      overview: `I have considered the available instructions for ${applicant} in relation to the proposed ${family.toLowerCase()} pathway. This assessment is expressed as a senior pre-lodgement legal and evidentiary review, not as a questionnaire summary. The present file should be advanced only after the identified legal, evidentiary and delegate-risk issues have been reconciled against original supporting documents and the current law and policy settings.`,
      viability: `The matter is presently assessed as: ${readiness}. The principal professional question is not merely whether individual criteria can be listed as satisfied, but whether the evidence, chronology and pathway selection would withstand delegate-level scrutiny if lodged in the present form.`,
      recommendation: highRisk
        ? 'The recommended course is to complete a targeted evidence repair stage before any final lodgement advice is issued.'
        : 'The recommended course is to proceed to final document verification and prepare the matter for lodgement-readiness review.'
    },
    criterionBlocks,
    riskSummary,
    conclusion: {
      readiness,
      opinion: highRisk
        ? 'On the present information, the matter may be capable of progression, but it is not yet appropriate to treat it as lodgement-ready. The current risk profile is driven by evidence consistency and delegate scrutiny issues rather than a concluded finding of ineligibility.'
        : 'On the present information, the matter appears capable of progressing to a final professional review stage, provided original documents confirm the instructions and no adverse information emerges.',
      nextStage: 'Obtain original documents, reconcile chronology, confirm legal criteria against the current knowledgebase, then issue final written advice before any lodgement action.'
    },
    knowledgebase: value(input, ['knowledgebase', 'adviceBundle.knowledgebase', 'legalSourcePack'], null, null)
  };
}

function addHeaderFooter(doc, sections) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const page = i + 1;
    doc.save();
    doc.rect(36, 24, doc.page.width - 72, 1).fill(BRAND.line);
    doc.fillColor(BRAND.muted).fontSize(8).text('Bircan Migration & Education - Senior Migration Assessment', 36, 28, { width: 340 });
    doc.text(`Page ${page}`, doc.page.width - 90, 28, { width: 54, align: 'right' });
    doc.rect(36, doc.page.height - 38, doc.page.width - 72, 1).fill(BRAND.line);
    doc.fillColor(BRAND.muted).fontSize(7).text('Preliminary professional migration assessment - subject to review of original documents and current law.', 36, doc.page.height - 32, { width: doc.page.width - 72, align: 'center' });
    doc.restore();
  }
}

function paragraph(doc, text, opts = {}) {
  const t = sanitiseGenericAssessmentLanguage(text);
  if (!t) return;
  doc.fillColor(opts.color || BRAND.ink).fontSize(opts.size || 10).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
    .text(t, { align: opts.align || 'left', lineGap: opts.lineGap ?? 3 });
  doc.moveDown(opts.after ?? 0.7);
}

function sectionTitle(doc, title) {
  doc.moveDown(0.5);
  doc.fillColor(BRAND.navy).font('Helvetica-Bold').fontSize(15).text(cleanText(title));
  doc.moveDown(0.25);
  doc.rect(doc.x, doc.y, 90, 2).fill(BRAND.gold);
  doc.moveDown(0.9);
}

function keyValueGrid(doc, rows) {
  const startX = doc.x;
  const colW = (doc.page.width - doc.page.margins.left - doc.page.margins.right) / 2 - 6;
  rows.forEach((row, idx) => {
    const x = startX + (idx % 2) * (colW + 12);
    if (idx % 2 === 0 && idx > 0) doc.moveDown(0.5);
    const y = doc.y;
    doc.roundedRect(x, y, colW, 42, 6).fillAndStroke(BRAND.pale, BRAND.line);
    doc.fillColor(BRAND.muted).font('Helvetica-Bold').fontSize(7).text(String(row[0]).toUpperCase(), x + 8, y + 8, { width: colW - 16 });
    doc.fillColor(BRAND.ink).font('Helvetica-Bold').fontSize(10).text(cleanText(row[1] || '-'), x + 8, y + 21, { width: colW - 16 });
    if (idx % 2 === 1) doc.y = Math.max(doc.y, y + 48);
  });
  if (rows.length % 2 === 1) doc.y += 48;
  doc.moveDown(0.6);
}

function riskCard(doc, title, risk, text) {
  const y = doc.y;
  const h = 78;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.roundedRect(doc.x, y, w, h, 8).fillAndStroke(riskFill(risk), BRAND.line);
  doc.fillColor(BRAND.navy).font('Helvetica-Bold').fontSize(10).text(cleanText(title), doc.x + 12, y + 11, { width: w - 24 });
  doc.fillColor(BRAND.ink).font('Helvetica-Bold').fontSize(9).text(cleanText(risk), doc.x + 12, y + 29, { width: w - 24 });
  doc.fillColor(BRAND.ink).font('Helvetica').fontSize(8.5).text(sanitiseGenericAssessmentLanguage(text), doc.x + 12, y + 45, { width: w - 24, lineGap: 2 });
  doc.y = y + h + 10;
}

function bulletList(doc, items) {
  asArray(items).slice(0, 10).forEach(item => {
    doc.fillColor(BRAND.ink).font('Helvetica').fontSize(9).text(`- ${sanitiseGenericAssessmentLanguage(item)}`, { indent: 8, lineGap: 2 });
  });
  doc.moveDown(0.6);
}

function drawCriterion(doc, c) {
  sectionTitle(doc, c.title);
  const risk = riskLabel(c.risk);
  riskCard(doc, 'Delegate risk classification', risk, c.delegateRiskAnalysis || 'Delegate risk requires assessment against the final evidence package.');

  doc.fillColor(BRAND.blue).font('Helvetica-Bold').fontSize(10).text('Legislative position');
  paragraph(doc, c.legislativePosition, { size: 9.5 });
  doc.fillColor(BRAND.blue).font('Helvetica-Bold').fontSize(10).text('Present evidence position');
  paragraph(doc, c.evidencePosition, { size: 9.5 });
  doc.fillColor(BRAND.blue).font('Helvetica-Bold').fontSize(10).text('Strategic commentary');
  paragraph(doc, c.strategicCommentary, { size: 9.5 });
  doc.fillColor(BRAND.blue).font('Helvetica-Bold').fontSize(10).text('Evidence response required');
  bulletList(doc, c.evidenceMissing || []);
  if (c.remediationAction) {
    doc.fillColor(BRAND.blue).font('Helvetica-Bold').fontSize(10).text('Remediation pathway');
    paragraph(doc, c.remediationAction, { size: 9.5 });
  }
}

function drawKnowledgebase(doc, kb) {
  if (!kb) return;
  sectionTitle(doc, 'Knowledgebase enforcement record');
  paragraph(doc, 'This assessment has been prepared using the Bircan Migration legal knowledgebase. The authority hierarchy is preserved for professional review and quality control. Client-facing conclusions remain preliminary until original documents and current law are verified.', { size: 9.5 });
  const rows = [
    ['Authority order', value(kb, ['authorityOrder'], 'Act > Regulations > Instruments > PAMs > Other')],
    ['Documents scanned', value(kb, ['documentsScanned', 'files'], '-')],
    ['Documents loaded', value(kb, ['documentsLoaded', 'loaded'], '-')],
    ['Snapshot', value(kb, ['snapshot', 'knowledgebaseSnapshot'], '-')],
    ['Law checked as at', value(kb, ['lawVersionCheckedAt', 'checkedAt'], '-')],
    ['Source hash', value(kb, ['aggregateSourceHash', 'hash'], '-')]
  ];
  keyValueGrid(doc, rows);
  const files = asArray(value(kb, ['filesLoaded', 'files', 'sources'], []));
  if (files.length) {
    doc.fillColor(BRAND.blue).font('Helvetica-Bold').fontSize(10).text('Source materials applied');
    bulletList(doc, files.map(f => typeof f === 'string' ? f : `${f.category || f.type || 'SOURCE'}: ${f.name || f.file || ''}${f.hash ? ` - ${f.hash}` : ''}`));
  }
}

function generateAssessmentPdfBuffer(input = {}) {
  const PDFDocument = requirePdfKit();
  const sections = buildSeniorAssessmentSections(input);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true, info: { Title: sections.executive.title, Author: 'Bircan Migration & Education' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    // Cover
    doc.rect(0, 0, doc.page.width, 118).fill(BRAND.navy);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(22).text('Senior Migration Assessment', 54, 42, { width: 430 });
    doc.fillColor('#D7B76B').fontSize(11).text('Delegate-grade preliminary legal and evidentiary memorandum', 54, 74);
    doc.moveDown(4.5);

    keyValueGrid(doc, [
      ['Reference', sections.matter.reference],
      ['Applicant', sections.matter.applicant],
      ['Applicant email', sections.matter.applicantEmail],
      ['Client account email', sections.matter.clientEmail],
      ['Subclass', sections.matter.subclass],
      ['Stream', sections.matter.stream],
      ['Visa family', sections.matter.family],
      ['Generated', sections.matter.generatedAt]
    ]);

    sectionTitle(doc, 'Executive legal overview');
    paragraph(doc, sections.executive.overview, { size: 10.2 });
    paragraph(doc, sections.executive.viability, { size: 10.2, bold: true });
    paragraph(doc, sections.executive.recommendation, { size: 10.2 });

    sectionTitle(doc, 'Delegate risk overview');
    sections.riskSummary.forEach(r => riskCard(doc, r.title, r.risk, 'This issue must be assessed by reference to the final document set, chronology and any stream-specific legal criteria.'));

    doc.addPage();
    sectionTitle(doc, 'Senior migration agent assessment');
    paragraph(doc, 'The assessment below is structured as a legal and evidentiary opinion. It is not a questionnaire export. Each issue is considered by reference to the legal requirement, the present evidence position, likely delegate scrutiny and the remediation pathway required before final advice or lodgement action.', { size: 10 });

    sections.criterionBlocks.forEach(c => {
      if (doc.y > doc.page.height - 230) doc.addPage();
      drawCriterion(doc, c);
    });

    if (doc.y > doc.page.height - 230) doc.addPage();
    sectionTitle(doc, 'Professional conclusion and lodgement-readiness position');
    keyValueGrid(doc, [
      ['Readiness', sections.conclusion.readiness],
      ['Next stage', sections.conclusion.nextStage]
    ]);
    paragraph(doc, sections.conclusion.opinion, { size: 10.2 });
    paragraph(doc, 'No final eligibility position should be relied upon until the original documents, sponsor or pathway evidence, legislative requirements and policy considerations have been comprehensively reviewed. No guarantee of visa grant is given.', { size: 9.5 });

    if (doc.y > doc.page.height - 260) doc.addPage();
    drawKnowledgebase(doc, sections.knowledgebase);

    sectionTitle(doc, 'Important notice');
    paragraph(doc, 'This document is preliminary migration advice prepared for professional review and evidence planning. It is based on the information provided and the legal-source material available to the assessment engine at the time of generation. It is not a substitute for final written advice following review of original documents and confirmation of current law and policy.', { size: 9.5 });
    doc.moveDown(1.4);
    doc.fillColor(BRAND.ink).font('Helvetica').fontSize(10).text('Yours faithfully,');
    doc.moveDown(1.8);
    doc.font('Helvetica-Bold').text('Kenan Bircan JP');
    doc.font('Helvetica').text('Registered Migration Agent | MARN: 1463685');
    doc.text('Bircan Migration & Education');

    addHeaderFooter(doc, sections);
    doc.end();
  });
}

async function generateAssessmentPdf(input = {}, outputPath) {
  const buffer = await generateAssessmentPdfBuffer(input);
  if (!outputPath) return buffer;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return { outputPath, bytes: buffer.length };
}

module.exports = {
  generateAssessmentPdfBuffer,
  generateAssessmentPdf,
  buildSeniorAssessmentSections,
  sanitiseGenericAssessmentLanguage,
  cleanText,
  riskLabel
};
