'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const app = express();

const PORT = Number(process.env.PORT || 10000);
const NODE_ENV = process.env.NODE_ENV || 'development';

const PRIMARY_FRONTEND_URL = 'https://assessment.bircanmigration.au';
const HARDCODED_ALLOWED_ORIGINS = [
  'https://assessment.bircanmigration.au',
  'https://www.assessment.bircanmigration.au',
  'https://www.bircanmigration.au',
  'https://bircanmigration.au',
  'https://www.bircanmigration.com.au',
  'https://bircanmigration.com.au',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'null',
];

const FRONTEND_URL_OVERRIDE = String(process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');
const APP_BASE_URL = FRONTEND_URL_OVERRIDE || PRIMARY_FRONTEND_URL;
const ALLOWED_ORIGINS = HARDCODED_ALLOWED_ORIGINS;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'no-reply@bircanmigration.com.au';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'data');
const SUBMISSIONS_DIR = path.join(STORAGE_DIR, 'submissions');
const PDF_DIR = path.join(STORAGE_DIR, 'pdfs');
const PUBLIC_DIR = path.join(__dirname, 'public');

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
[STORAGE_DIR, SUBMISSIONS_DIR, PDF_DIR, PUBLIC_DIR].forEach(ensureDirSync);

function nowIso() {
  return new Date().toISOString();
}

function todayHuman() {
  return new Date().toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function logoPath() {
  return path.join(__dirname, 'public', 'logo.png');
}

const FIRM_PROFILE = {
  principalName: 'Kenan Bircan JP',
  title: 'Registered Migration Agent',
  marn: '1463685',
  mmia: '10497',
  cma: '20156912',
  jpNo: '218851',
  businessName: 'Bircan Migration & Education',
  website: 'www.bircanmigration.com.au',
  email: 'kenan@bircanmigration.com.au',
  phone: '0421 618 522',
  address: '5-7 Northumberland Road Auburn NSW 2144'
};

function safeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'file';
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function submissionPath(submissionId) {
  return path.join(SUBMISSIONS_DIR, `${sanitizeFileName(submissionId)}.json`);
}

async function getSubmission(submissionId) {
  return readJsonSafe(submissionPath(submissionId), null);
}

async function getAllSubmissions() {
  const files = await fsp.readdir(SUBMISSIONS_DIR).catch(() => []);
  const rows = files
    .filter(name => name.endsWith('.json'))
    .map(name => readJsonSafe(path.join(SUBMISSIONS_DIR, name), null))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return rows;
}

async function saveSubmission(submission) {
  submission.updatedAt = nowIso();
  await writeJson(submissionPath(submission.id), submission);
  return submission;
}

async function updateSubmission(submissionId, patch) {
  const current = (await getSubmission(submissionId)) || { id: submissionId, createdAt: nowIso() };
  const next = { ...current, ...patch, id: submissionId };
  await saveSubmission(next);
  return next;
}

function normalizePlan(input) {
  const raw = String(input || '').trim().toLowerCase();
  const map = {
    instant: { code: 'instant', label: 'Instant', price: 30000, turnaround: 'Instant' },
    '24 hours': { code: '24h', label: '24 Hours', price: 25000, turnaround: '24 hours' },
    '24h': { code: '24h', label: '24 Hours', price: 25000, turnaround: '24 hours' },
    '3 days': { code: '3d', label: '3 Days', price: 15000, turnaround: '3 days' },
    '3d': { code: '3d', label: '3 Days', price: 15000, turnaround: '3 days' },
  };
  return map[raw] || map['24 hours'];
}

function normalizeAnswers(rawAnswers = []) {
  if (!Array.isArray(rawAnswers)) return [];
  return rawAnswers
    .map((item, index) => {
      if (typeof item === 'string') return { question: `Question ${index + 1}`, answer: item };
      return {
        question: String(item?.question || `Question ${index + 1}`).trim(),
        answer: Array.isArray(item?.answer)
          ? item.answer.map(v => String(v ?? '')).join(', ')
          : String(item?.answer ?? '').trim(),
      };
    })
    .filter(item => item.question || item.answer);
}

function extractAssessmentPayload(body = {}) {
  const plan = normalizePlan(body.plan || body.package || body.delivery);
  const client = body.client || {};
  const answers = normalizeAnswers(Array.isArray(body.answers) ? body.answers : body.responses || body.questions || []);
  return {
    visaType: body.visaType || body.subclass || 'Subclass 482',
    plan,
    client: {
      fullName: client.fullName || body.fullName || '',
      email: String(client.email || body.email || '').trim(),
      phone: client.phone || body.phone || '',
      dob: client.dob || body.dob || '',
      nationality: client.nationality || body.nationality || body.citizenship || '',
    },
    answers,
    notes: body.notes || '',
    metadata: body.metadata || {},
  };
}

function formatAnswersForPrompt(answers = []) {
  if (!answers.length) return 'No answers provided.';
  return answers.map((item, index) => `${index + 1}. ${item.question}: ${item.answer || 'No answer provided'}`).join('\n');
}

function normaliseAnalysisShape(ai = {}, submission = {}) {
  const fallbackSummary = `Preliminary ${submission.visaType || 'visa'} assessment prepared for ${submission.client?.fullName || 'the client'}.`;
  const fallback = {
    caseCaption: 'Preliminary Migration Assessment',
    eligibilityOutcome: 'Needs professional review',
    overallAssessment: fallbackSummary,
    executiveSummary: fallbackSummary,
    legalStyleSummary: fallbackSummary,
    strengths: [],
    concerns: [],
    missingInformation: [],
    recommendedNextSteps: [],
    documentChecklist: [],
    factualAssumptions: [],
    disclaimer:
      'This letter is a preliminary assessment only. Final visa eligibility depends on documentary evidence, sponsorship and nomination outcomes, health and character checks, and departmental assessment at the time of decision.',
    ratings: {
      sponsorReadiness: 'Unknown',
      occupationFit: 'Unknown',
      experienceFit: 'Unknown',
      englishPosition: 'Unknown',
      complianceRisk: 'Unknown',
      overallReadiness: 'Unknown',
    },
  };

  const merged = { ...fallback, ...ai, ratings: { ...fallback.ratings, ...(ai.ratings || {}) } };

  [
    'strengths',
    'concerns',
    'missingInformation',
    'recommendedNextSteps',
    'documentChecklist',
    'factualAssumptions',
  ].forEach(key => {
    if (!Array.isArray(merged[key])) merged[key] = [];
    merged[key] = merged[key].map(item => String(item || '').trim()).filter(Boolean).slice(0, 14);
  });

  ['caseCaption', 'eligibilityOutcome', 'overallAssessment', 'executiveSummary', 'legalStyleSummary', 'disclaimer'].forEach(key => {
    merged[key] = String(merged[key] || fallback[key]).trim() || fallback[key];
  });

  return merged;
}

async function runAssessmentAnalysis(submission) {
  if (!OPENAI_API_KEY) {
    const analysis = normaliseAnalysisShape({
      caseCaption: 'OpenAI Key Missing',
      eligibilityOutcome: 'AI analysis unavailable',
      executiveSummary: 'The questionnaire was received, but the server does not currently have an OPENAI_API_KEY configured.',
      legalStyleSummary: 'The instructions and facts were received by the system; however, no AI assessment could be prepared because the required API credential is missing.',
      concerns: ['OPENAI_API_KEY is not configured on the server.'],
      recommendedNextSteps: ['Add OPENAI_API_KEY to Render.', 'Redeploy the backend.', 'Resubmit the assessment.']
    }, submission);
    return { status: 'completed', model: 'fallback-no-openai-key', summary: analysis.executiveSummary, analysis, generatedAt: nowIso() };
  }

  const systemPrompt = [
    'You are drafting a professional preliminary migration assessment letter for Bircan Migration & Education.',
    'Use a law-firm style tone: measured, formal, structured, and careful.',
    'Do not overstate certainty. Do not guarantee grant outcomes.',
    'Do not invent legislation or policy details not directly supported by the applicant facts.',
    'Frame the letter as preliminary migration-grade advice based only on the questionnaire.',
    'Return STRICT JSON only with this exact top-level shape:',
    '{',
    '  "caseCaption": string,',
    '  "eligibilityOutcome": string,',
    '  "overallAssessment": string,',
    '  "executiveSummary": string,',
    '  "legalStyleSummary": string,',
    '  "strengths": string[],',
    '  "concerns": string[],',
    '  "missingInformation": string[],',
    '  "recommendedNextSteps": string[],',
    '  "documentChecklist": string[],',
    '  "factualAssumptions": string[],',
    '  "disclaimer": string,',
    '  "ratings": {',
    '    "sponsorReadiness": string,',
    '    "occupationFit": string,',
    '    "experienceFit": string,',
    '    "englishPosition": string,',
    '    "complianceRisk": string,',
    '    "overallReadiness": string',
    '  }',
    '}',
  ].join('\n');

  const userPrompt = [
    `Matter: ${submission.visaType || 'Subclass 482'} preliminary assessment`,
    `Service plan: ${submission.plan?.label || ''}`,
    `Client name: ${submission.client?.fullName || ''}`,
    `Client nationality: ${submission.client?.nationality || ''}`,
    `Client DOB: ${submission.client?.dob || ''}`,
    '',
    'Instructions:',
    '- Draft in a migration-grade, law-firm style tone.',
    '- Use structured language suitable for a paid preliminary advice letter.',
    '- Identify strengths, risks, missing documents, and next steps.',
    '- Where the case appears viable, say "potentially eligible" or "appears to meet preliminary criteria", not guaranteed.',
    '',
    'Applicant answers:',
    formatAnswersForPrompt(submission.answers),
    '',
    'Return JSON only.'
  ].join('\n');

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.15,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${raw.slice(0, 800)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== 'string') throw new Error('Invalid OpenAI response structure.');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Failed to parse OpenAI JSON response.');
  }

  const analysis = normaliseAnalysisShape(parsed, submission);
  return {
    status: 'completed',
    model: OPENAI_MODEL,
    summary: analysis.executiveSummary,
    analysis,
    generatedAt: nowIso(),
  };
}

function drawHeader(doc, submission, analysis, isFirstPage = false) {
  const lp = logoPath();

  if (isFirstPage) {
    doc.save();
    doc.roundedRect(28, 20, 539, 120, 16).fill('#ffffff').lineWidth(1).strokeColor('#dce4ef').stroke();

    if (fs.existsSync(lp)) {
      try {
        doc.image(lp, 40, 30, { fit: [150, 96], align: 'left', valign: 'center' });
      } catch (_) {}
    }

    doc.moveTo(310, 34).lineTo(310, 126).strokeColor('#dce4ef').stroke();

    doc.fillColor('#0b1f3a').font('Helvetica-Bold').fontSize(13.5)
      .text(FIRM_PROFILE.businessName, 200, 38, { width: 102, align: 'left' });
    doc.fillColor('#172033').font('Helvetica').fontSize(10)
      .text(FIRM_PROFILE.website, 200, 61, { width: 105 })
      .text(FIRM_PROFILE.email, 200, 77, { width: 105 })
      .text(FIRM_PROFILE.phone, 200, 93, { width: 105 })
      .text(FIRM_PROFILE.address, 200, 109, { width: 105 });

    doc.fillColor('#9a6b00').font('Helvetica-Bold').fontSize(16)
      .text(FIRM_PROFILE.principalName, 326, 38, { width: 214 });
    doc.fillColor('#0b1f3a').font('Helvetica-Bold').fontSize(10.5)
      .text(FIRM_PROFILE.title, 326, 62, { width: 214 });
    doc.fillColor('#172033').font('Helvetica').fontSize(10)
      .text(`MARN: ${FIRM_PROFILE.marn}`, 326, 82, { width: 214 })
      .text(`MMIA: ${FIRM_PROFILE.mmia}`, 326, 97, { width: 214 })
      .text(`CMA: ${FIRM_PROFILE.cma}`, 326, 112, { width: 110 })
      .text(`JP No: ${FIRM_PROFILE.jpNo}`, 440, 112, { width: 100, align: 'right' });

    doc.restore();

    doc.fillColor('#0b1f3a').font('Helvetica-Bold').fontSize(20)
      .text(`${submission.visaType || 'Subclass 482'} Skills In Demand Visa`, 40, 162, { width: 350 });
    doc.fillColor('#9a6b00').font('Helvetica-Bold').fontSize(11.5)
      .text('PRELIMINARY ASSESSMENT & ADVICE', 40, 192);

    doc.roundedRect(422, 154, 138, 62, 8).fill('#f6f9fc').strokeColor('#dce4ef').stroke();
    doc.fillColor('#5f6b7d').font('Helvetica-Bold').fontSize(8.5)
      .text('ASSESSMENT DATE', 434, 166, { width: 112 });
    doc.fillColor('#172033').font('Helvetica-Bold').fontSize(10.5)
      .text(todayHuman(), 434, 180, { width: 112 });
    doc.fillColor('#5f6b7d').font('Helvetica-Bold').fontSize(8.5)
      .text('SUBMISSION ID', 434, 198, { width: 112 });
    doc.fillColor('#172033').font('Helvetica').fontSize(8.7)
      .text(submission.id, 434, 211, { width: 118 });

    doc.y = 238;
    return;
  }

  doc.save();
  doc.roundedRect(30, 24, 535, 58, 14).fill('#0b1f3a');
  if (fs.existsSync(lp)) {
    try {
      doc.image(lp, 40, 30, { fit: [90, 46], align: 'left', valign: 'center' });
    } catch (_) {}
  }
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(15)
    .text('Preliminary Visa Assessment Letter', 150, 36, { width: 320 });
  doc.fillColor('#cfe0ff').font('Helvetica').fontSize(9.5)
    .text(`${submission.visaType || 'Subclass 482'} | ${analysis.eligibilityOutcome || 'Preliminary outcome'}`, 150, 56, { width: 320 });
  doc.restore();
  doc.fillColor('#172033');
  doc.y = 102;
}

function drawFooterOnCurrentPage(doc, pageNumber, pageCount) {
  const footerY = doc.page.height - 34;
  doc.save();
  doc.moveTo(34, footerY - 10).lineTo(560, footerY - 10).strokeColor('#dce4ef').stroke();
  doc.fillColor('#5f6b7d').font('Helvetica').fontSize(8.5)
    .text(`${FIRM_PROFILE.businessName} | ${FIRM_PROFILE.website} | ${FIRM_PROFILE.email} | ${FIRM_PROFILE.phone}`, 38, footerY, { width: 420 });
  doc.fillColor('#0b1f3a').font('Helvetica-Bold').fontSize(8.8)
    .text(`Page ${pageNumber} of ${pageCount}`, 468, footerY, { width: 85, align: 'right' });
  doc.restore();
  doc.fillColor('#172033');
}

function ensureSpace(doc, submission, analysis, threshold = 700) {
  if (doc.y > threshold) {
    doc.addPage();
    drawHeader(doc, submission, analysis, false);
  }
}

function addSectionTitle(doc, submission, analysis, title) {
  ensureSpace(doc, submission, analysis, 680);
  doc.moveDown(0.35);
  doc.font('Helvetica-Bold').fontSize(12.8).fillColor('#0b1f3a').text(title);
  doc.moveTo(40, doc.y + 3).lineTo(555, doc.y + 3).strokeColor('#dce4ef').stroke();
  doc.moveDown(0.48);
}

function addParagraph(doc, submission, analysis, text) {
  ensureSpace(doc, submission, analysis, 718);
  doc.font('Helvetica').fontSize(10.3).fillColor('#172033').text(String(text || ''), {
    width: 515,
    lineGap: 3,
    align: 'left',
  });
  doc.moveDown(0.5);
}

function addBulletList(doc, submission, analysis, items, fallbackText = 'Not provided.') {
  const list = Array.isArray(items) && items.length ? items : [fallbackText];
  list.forEach(item => {
    ensureSpace(doc, submission, analysis, 722);
    const y = doc.y;
    doc.circle(47, y + 6.7, 2.2).fill('#3aa76d');
    doc.fillColor('#172033').font('Helvetica').fontSize(10.2).text(String(item || ''), 58, y, {
      width: 492,
      lineGap: 3,
    });
    doc.moveDown(0.34);
  });
  doc.moveDown(0.2);
}

function addMetaPanel(doc, submission, analysis) {
  ensureSpace(doc, submission, analysis, 665);
  const y = doc.y;
  doc.roundedRect(40, y, 515, 98, 14).fill('#f7f9fc').strokeColor('#dce4ef').stroke();

  doc.fillColor('#0b1f3a').font('Helvetica-Bold').fontSize(12).text('Applicant Snapshot', 58, y + 14);

  const occupation = submission.answers.find(a => a.question === 'occupation')?.answer || 'Not provided';
  const skills = submission.answers.find(a => a.question === 'skillsAssessment')?.answer || 'Not provided';
  const english = submission.answers.find(a => a.question === 'englishScore')?.answer || 'Not provided';
  const workYears = submission.answers.find(a => a.question === 'workYears')?.answer || 'Not provided';

  doc.fillColor('#5f6b7d').font('Helvetica-Bold').fontSize(8.7)
    .text('Occupation', 58, y + 38)
    .text('Skills Assessment', 228, y + 38)
    .text('English Level', 58, y + 72)
    .text('Work Experience', 228, y + 72);

  doc.fillColor('#172033').font('Helvetica').fontSize(10.1)
    .text(occupation, 58, y + 50, { width: 148 })
    .text(skills, 228, y + 50, { width: 148 })
    .text(english, 58, y + 84, { width: 148 })
    .text(workYears, 228, y + 84, { width: 148 });

  doc.roundedRect(392, y + 14, 146, 68, 12).fill('#0b1f3a');
  doc.fillColor('#ffffff').font('Helvetica').fontSize(8.8)
    .text('This assessment is prepared using AI-assisted analysis combined with migration expertise and is provided for information purposes only.', 404, y + 22, {
      width: 122,
      align: 'left'
    });

  doc.y = y + 114;
}

function addOutcomePanel(doc, submission, analysis) {
  ensureSpace(doc, submission, analysis, 655);
  const y = doc.y;
  doc.roundedRect(40, y, 515, 140, 16).fill('#0f2f66');

  doc.roundedRect(56, y + 18, 118, 24, 12).fill('#d8b15a');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10.5)
    .text('OVERALL RESULT', 72, y + 25, { width: 86, align: 'center' });

  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(28)
    .text(analysis.eligibilityOutcome || 'Preliminary outcome pending', 58, y + 58, { width: 220 });

  doc.fillColor('#ffffff').font('Helvetica').fontSize(11)
    .text('You appear to meet the key preliminary criteria based on the facts currently provided, subject to final documentary review and departmental assessment.', 58, y + 96, { width: 230 });

  const scoreRows = [
    ['Visa Eligibility', analysis.ratings?.overallReadiness || 'Preliminary'],
    ['Skills & Occupation Match', analysis.ratings?.occupationFit || 'Preliminary'],
    ['English Language Readiness', analysis.ratings?.englishPosition || 'Preliminary'],
  ];

  let x = 324
  for (const [label, value] of scoreRows) {
    doc.circle(x, y + 70, 30).lineWidth(5).strokeColor('#d8b15a').stroke();
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.2)
      .text(value, x - 28, y + 62, { width: 56, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(8.6)
      .text(label, x - 36, y + 104, { width: 72, align: 'center' });
    x += 78;
  }

  doc.y = y + 154;
}

function addSummaryPanel(doc, submission, analysis) {
  ensureSpace(doc, submission, analysis, 675);
  const y = doc.y;
  doc.roundedRect(40, y, 515, 132, 16).fill('#edf8f3').strokeColor('#b7dfc7').stroke();

  doc.fillColor('#2f8a5b').font('Helvetica-Bold').fontSize(12)
    .text('AI Assessment Summary', 58, y + 16);
  doc.fillColor('#172033').font('Helvetica').fontSize(10.4)
    .text(analysis.executiveSummary || 'No summary available.', 58, y + 38, {
      width: 470,
      lineGap: 3
    });

  const innerY = y + 90;
  doc.roundedRect(58, innerY, 475, 28, 10).fill('#fff6e6').strokeColor('#e6c27a').stroke();
  doc.fillColor('#9a6b00').font('Helvetica-Bold').fontSize(10.2)
    .text('Professional Recommendation', 72, innerY + 9);

  doc.y = y + 146;
}

async function generateProfessionalPdf(submission) {
  const pdfFileName = `${sanitizeFileName(submission.id)}.pdf`;
  const pdfPath = path.join(PDF_DIR, pdfFileName);
  const analysis = submission.analysis?.analysis || {};
  const answers = normalizeAnswers(submission.answers || []);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true, bufferPages: true });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);

    drawHeader(doc, submission, analysis, true);
    addOutcomePanel(doc, submission, analysis);
    addMetaPanel(doc, submission, analysis);

    addSectionTitle(doc, submission, analysis, 'Key Findings');
    addBulletList(doc, submission, analysis, analysis.strengths, 'No material strengths were identified from the currently available information.');

    addSummaryPanel(doc, submission, analysis);
    addParagraph(doc, submission, analysis, analysis.legalStyleSummary || analysis.overallAssessment || 'Preliminary advice not available.');

    addSectionTitle(doc, submission, analysis, 'Further Information or Evidence Required');
    addBulletList(doc, submission, analysis, analysis.missingInformation, 'No additional information items were identified.');

    addSectionTitle(doc, submission, analysis, 'Recommended Next Steps');
    addBulletList(doc, submission, analysis, analysis.recommendedNextSteps, 'No specific next steps were generated.');

    addSectionTitle(doc, submission, analysis, 'Suggested Supporting Document Checklist');
    addBulletList(doc, submission, analysis, analysis.documentChecklist, 'No document checklist items were generated.');

    addSectionTitle(doc, submission, analysis, 'Factual Assumptions Used for this Preliminary View');
    addBulletList(doc, submission, analysis, analysis.factualAssumptions, 'No specific factual assumptions were listed.');

    addSectionTitle(doc, submission, analysis, 'Assessment Ratings Snapshot');
    addBulletList(doc, submission, analysis, [
      `Sponsor readiness: ${analysis.ratings?.sponsorReadiness || 'Unknown'}`,
      `Occupation fit: ${analysis.ratings?.occupationFit || 'Unknown'}`,
      `Experience fit: ${analysis.ratings?.experienceFit || 'Unknown'}`,
      `English position: ${analysis.ratings?.englishPosition || 'Unknown'}`,
      `Compliance risk: ${analysis.ratings?.complianceRisk || 'Unknown'}`,
      `Overall readiness: ${analysis.ratings?.overallReadiness || 'Unknown'}`,
    ]);

    addSectionTitle(doc, submission, analysis, 'Questionnaire Record');
    addBulletList(doc, submission, analysis, answers.map(item => `${item.question}: ${item.answer || 'No answer provided'}`), 'No answers received.');

    addSectionTitle(doc, submission, analysis, 'Disclaimer');
    addParagraph(doc, submission, analysis, analysis.disclaimer);
    addParagraph(doc, submission, analysis, `Prepared by ${FIRM_PROFILE.principalName}, ${FIRM_PROFILE.title}.`);
    addParagraph(doc, submission, analysis, `MARN: ${FIRM_PROFILE.marn} | MMIA: ${FIRM_PROFILE.mmia} | CMA: ${FIRM_PROFILE.cma} | JP No: ${FIRM_PROFILE.jpNo}`);

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(i);
      drawFooterOnCurrentPage(doc, i + 1, range.count);
    }

    doc.end();
  });

  return { pdfPath, pdfUrl: `/api/assessment/${encodeURIComponent(submission.id)}/pdf` };
}

function createMailTransport() {
  if (!SMTP_HOST) throw new Error('SMTP_HOST is not configured.');
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

async function trySendAssessmentEmail(submission, pdfPath) {
  const to = submission.client?.email;
  if (!to) return { ok: false, skipped: true, reason: 'No client email on submission' };

  const transport = createMailTransport();
  const outcome = submission.analysis?.analysis?.eligibilityOutcome || 'Preliminary assessment completed';
  const summary = submission.analysis?.analysis?.executiveSummary || submission.analysis?.summary || 'Your assessment has been prepared.';

  const info = await transport.sendMail({
    from: SMTP_FROM,
    to,
    subject: `Your ${submission.visaType || 'Visa'} assessment letter`,
    text: [
      `Dear ${submission.client?.fullName || 'Client'},`,
      '',
      'Please find attached your preliminary visa assessment letter.',
      `Outcome: ${outcome}`,
      '',
      summary,
      '',
      'Kind regards,',
      'Bircan Migration & Education',
    ].join('\n'),
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#172033;line-height:1.6">
        <h2 style="margin:0 0 10px;color:#0b1f3a">Bircan Migration &amp; Education</h2>
        <p>Dear ${submission.client?.fullName || 'Client'},</p>
        <p>Please find attached your preliminary visa assessment letter.</p>
        <p><strong>Outcome:</strong> ${outcome}</p>
        <p>${summary}</p>
        <p>Kind regards,<br>Bircan Migration &amp; Education</p>
      </div>
    `,
    attachments: pdfPath ? [{ filename: path.basename(pdfPath), path: pdfPath }] : [],
  });

  return { ok: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}

async function processSubmission(submissionId) {
  let submission = await getSubmission(submissionId);
  if (!submission) throw new Error(`Submission not found for ${submissionId}`);

  submission = await updateSubmission(submissionId, {
    status: 'processing',
    paymentStatus: 'paid',
    analysisStatus: 'running',
    pdfStatus: 'generating',
    emailStatus: 'pending',
    processingStartedAt: nowIso(),
  });

  try {
    const analysisResult = await runAssessmentAnalysis(submission);
    submission = await updateSubmission(submissionId, {
      analysisStatus: analysisResult.status,
      analysis: analysisResult,
    });

    const pdfResult = await generateProfessionalPdf(submission);
    submission = await updateSubmission(submissionId, {
      pdfStatus: pdfResult?.pdfPath ? 'generated' : 'failed',
      pdfPath: pdfResult?.pdfPath || null,
      pdfUrl: pdfResult?.pdfUrl || null,
    });

    submission = await getSubmission(submissionId);

    try {
      const emailResult = await trySendAssessmentEmail(submission, pdfResult?.pdfPath);
      submission = await updateSubmission(submissionId, {
        emailStatus: emailResult?.ok ? 'sent' : (emailResult?.skipped ? 'skipped' : 'failed'),
        emailResult,
        processedAt: nowIso(),
        status: 'completed',
      });
    } catch (mailError) {
      submission = await updateSubmission(submissionId, {
        emailStatus: 'failed',
        emailError: mailError.message,
        processedAt: nowIso(),
        status: 'completed',
      });
    }

    return submission;
  } catch (error) {
    await updateSubmission(submissionId, {
      processingError: error.message,
      analysisStatus: 'failed',
      pdfStatus: 'failed',
      emailStatus: 'failed',
      processedAt: nowIso(),
      status: 'failed',
    });
    throw error;
  }
}

function adminGuard(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = String(req.header('x-admin-token') || req.query.token || '');
  if (token && token === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized admin access.' });
}

function corsOptionsDelegate(req, callback) {
  const origin = req.header('Origin');
  if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin) || origin === 'null') {
    callback(null, {
      origin: true,
      credentials: true,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
    });
    return;
  }
  callback(null, { origin: false });
}

app.use(express.json({ limit: '10mb' }));
app.use(cors(corsOptionsDelegate));
app.options('*', cors(corsOptionsDelegate));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/admin', express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'bircan-migration-backend', timestamp: nowIso(), env: NODE_ENV });
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bircan-migration-backend',
    hasOpenAiKey: Boolean(OPENAI_API_KEY),
    hasSmtp: Boolean(SMTP_HOST && SMTP_FROM),
    appBaseUrl: APP_BASE_URL,
    allowedOrigins: ALLOWED_ORIGINS,
    timestamp: nowIso(),
    model: OPENAI_MODEL,
    hasAdminToken: Boolean(ADMIN_TOKEN),
  });
});

app.post('/api/assessment/submit', async (req, res, next) => {
  try {
    const payload = extractAssessmentPayload(req.body);
    if (!payload.client.email) return res.status(400).json({ ok: false, error: 'Client email is required.' });

    const submissionId = safeId('sub');
    const submission = {
      id: submissionId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: 'queued',
      paymentStatus: 'paid',
      analysisStatus: 'queued',
      pdfStatus: 'queued',
      emailStatus: 'pending',
      paidAt: nowIso(),
      ...payload,
    };

    await saveSubmission(submission);

    processSubmission(submissionId).catch(async (error) => {
      await updateSubmission(submissionId, {
        processingError: error.message,
        analysisStatus: 'failed',
        pdfStatus: 'failed',
        emailStatus: 'failed',
        status: 'failed',
        processedAt: nowIso(),
      });
      console.error('[submit-processing-error]', error);
    });

    res.status(201).json({
      ok: true,
      submissionId,
      status: 'processing',
      paymentStatus: 'paid',
      message: 'Assessment submitted. AI analysis, PDF generation, and email delivery have started.',
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/assessment/:submissionId/status', async (req, res, next) => {
  try {
    const submission = await getSubmission(req.params.submissionId);
    if (!submission) return res.status(404).json({ ok: false, error: 'Submission not found.' });

    res.json({
      ok: true,
      submissionId: submission.id,
      status: submission.status || 'created',
      paymentStatus: submission.paymentStatus || 'paid',
      analysisStatus: submission.analysisStatus || 'not_started',
      pdfStatus: submission.pdfStatus || 'not_generated',
      emailStatus: submission.emailStatus || 'not_sent',
      pdfUrl: submission.pdfUrl || null,
      processingError: submission.processingError || null,
      emailError: submission.emailError || null,
      model: submission.analysis?.model || null,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/assessment/:submissionId/pdf', async (req, res, next) => {
  try {
    const submission = await getSubmission(req.params.submissionId);
    if (!submission || !submission.pdfPath) return res.status(404).json({ ok: false, error: 'PDF not found.' });
    if (!fs.existsSync(submission.pdfPath)) return res.status(404).json({ ok: false, error: 'PDF file is missing on disk.' });
    res.download(submission.pdfPath, path.basename(submission.pdfPath));
  } catch (error) {
    next(error);
  }
});

app.get('/api/debug/test-email', async (req, res, next) => {
  try {
    const to = String(req.query?.to || 'kenanbircan@gmail.com').trim();
    if (!to) return res.status(400).json({ ok: false, error: 'Recipient email is required.' });

    const transport = createMailTransport();
    const info = await transport.sendMail({
      from: SMTP_FROM,
      to,
      subject: 'Bircan Migration test email',
      text: `This is a live SMTP test from the Bircan Migration backend.\n\nSent at: ${nowIso()}\nSMTP from: ${SMTP_FROM}`,
      html: `<p>This is a live SMTP test from the Bircan Migration backend.</p><p>Sent at: ${nowIso()}</p><p>SMTP from: ${SMTP_FROM}</p>`,
    });

    res.json({ ok: true, to, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/submissions', adminGuard, async (req, res, next) => {
  try {
    const submissions = await getAllSubmissions();
    res.json({
      ok: true,
      items: submissions.slice(0, 200).map(item => ({
        id: item.id,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        status: item.status,
        paymentStatus: item.paymentStatus,
        analysisStatus: item.analysisStatus,
        pdfStatus: item.pdfStatus,
        emailStatus: item.emailStatus,
        emailError: item.emailError || null,
        processingError: item.processingError || null,
        visaType: item.visaType,
        fullName: item.client?.fullName || '',
        email: item.client?.email || '',
        pdfUrl: item.pdfUrl || null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/submissions/:submissionId/resend-email', adminGuard, async (req, res, next) => {
  try {
    const submission = await getSubmission(req.params.submissionId);
    if (!submission) return res.status(404).json({ ok: false, error: 'Submission not found.' });
    if (!submission.pdfPath || !fs.existsSync(submission.pdfPath)) {
      return res.status(400).json({ ok: false, error: 'PDF is not available for this submission.' });
    }
    const result = await trySendAssessmentEmail(submission, submission.pdfPath);
    await updateSubmission(submission.id, {
      emailStatus: result?.ok ? 'sent' : 'failed',
      emailResult: result,
      emailError: result?.ok ? null : (result?.reason || 'Email resend failed'),
    });
    res.json({ ok: true, submissionId: submission.id, result });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  console.error('[server-error]', error);
  const status = Number(error.statusCode || error.status || 500);
  res.status(status).json({ ok: false, error: error.message || 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`Bircan Migration backend listening on port ${PORT}`);
});
