'use strict';

const fetch = globalThis.fetch;
if (typeof fetch !== 'function') {
  throw new Error('Global fetch is not available. Use Node 18+ or add a compatible fetch polyfill.');
}

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
  } catch (e) {
    console.error('[openai-raw-content]', content);
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


const PAGE_MARGIN = 40;
const CONTENT_X = 40;
const CONTENT_WIDTH = 515;
const FOOTER_Y_OFFSET = 34;
const BODY_TOP_Y = 170;
const PAGE_BOTTOM_LIMIT = 720;

function resetCursor(doc, y = doc.y) {
  doc.x = CONTENT_X;
  doc.y = y;
}

function drawHeader(doc, submission = null, analysis = null) {
  doc.save();
  doc.roundedRect(PAGE_MARGIN, 28, CONTENT_WIDTH, 84, 14).fill('#0b1f3a');

  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22)
    .text('Bircan Migration & Education', 56, 46, { width: 260, lineBreak: false });
  doc.fillColor('#dbe7ff').font('Helvetica').fontSize(10)
    .text('Migration advice and professional visa assessment services', 56, 76, { width: 260 });

  const rightX = 330;
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
    .text('Kenan Bircan JP', rightX, 44, { width: 180, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(9)
    .text('Registered Migration Agent', rightX, 59, { width: 180, align: 'right', lineBreak: false })
    .text('MARN: 1463685 | MMIA: 10497', rightX, 73, { width: 180, align: 'right', lineBreak: false })
    .text('CMA: 20156912 | JP No: 218851', rightX, 87, { width: 180, align: 'right', lineBreak: false });

  doc.restore();

  doc.fillColor('#0b1f3a').font('Helvetica-Bold').fontSize(18)
    .text(submission?.visaType ? `${submission.visaType} Preliminary Assessment & Advice` : 'Preliminary Visa Assessment & Advice', CONTENT_X, 126, {
      width: CONTENT_WIDTH,
      align: 'center'
    });

  if (analysis?.eligibilityOutcome) {
    doc.fillColor('#475467').font('Helvetica').fontSize(10.5)
      .text(`Outcome: ${analysis.eligibilityOutcome}`, CONTENT_X, 150, {
        width: CONTENT_WIDTH,
        align: 'center'
      });
  }

  doc.moveTo(CONTENT_X, 164).lineTo(CONTENT_X + CONTENT_WIDTH, 164).strokeColor('#dce4ef').stroke();
  doc.fillColor('#172033');
  resetCursor(doc, BODY_TOP_Y);
}

function drawFooterOnCurrentPage(doc) {
  const footerY = doc.page.height - FOOTER_Y_OFFSET;
  doc.save();
  doc.moveTo(CONTENT_X, footerY - 12).lineTo(CONTENT_X + CONTENT_WIDTH, footerY - 12).strokeColor('#dce4ef').stroke();
  doc.fillColor('#5f6b7d').font('Helvetica').fontSize(9)
    .text('Bircan Migration & Education | www.bircanmigration.com.au | kenan@bircanmigration.com.au | 0421 618 522', CONTENT_X, footerY, {
      width: CONTENT_WIDTH,
      align: 'center',
      lineBreak: false,
    });
  doc.restore();
  doc.fillColor('#172033');
}

function nextPage(doc, submission = null, analysis = null) {
  drawFooterOnCurrentPage(doc);
  doc.addPage({ margin: PAGE_MARGIN });
  drawHeader(doc, submission, analysis);
}

function ensureSpace(doc, submission, analysis, threshold = PAGE_BOTTOM_LIMIT) {
  if (doc.y > threshold) {
    nextPage(doc, submission, analysis);
  }
}

function addSectionTitle(doc, title, submission, analysis) {
  ensureSpace(doc, submission, analysis, 690);
  const y = doc.y + 6;
  doc.roundedRect(CONTENT_X, y - 2, CONTENT_WIDTH, 22, 6).fill('#f4f7fb');
  doc.fillColor('#0b1f3a').font('Helvetica-Bold').fontSize(12.5)
    .text(String(title || ''), CONTENT_X + 10, y + 4, { width: CONTENT_WIDTH - 20, lineGap: 0 });
  resetCursor(doc, y + 26);
  doc.fillColor('#172033');
}

function addParagraph(doc, text, submission, analysis) {
  ensureSpace(doc, submission, analysis, 725);
  const y = doc.y;
  doc.font('Helvetica').fontSize(10.5).fillColor('#172033')
    .text(String(text || ''), CONTENT_X, y, {
      width: CONTENT_WIDTH,
      lineGap: 3,
      align: 'left',
    });
  resetCursor(doc, doc.y + 8);
}

function addBulletList(doc, items, fallbackText, submission, analysis) {
  const list = Array.isArray(items) && items.length ? items : [fallbackText || 'Not provided.'];
  list.forEach(item => {
    ensureSpace(doc, submission, analysis, 730);
    const y = doc.y;
    doc.fillColor('#2f6fed').font('Helvetica-Bold').fontSize(12)
      .text('•', CONTENT_X + 4, y, { width: 10, lineBreak: false });
    doc.fillColor('#172033').font('Helvetica').fontSize(10.5)
      .text(String(item || ''), CONTENT_X + 18, y, {
        width: CONTENT_WIDTH - 18,
        lineGap: 3,
      });
    resetCursor(doc, doc.y + 4);
  });
  resetCursor(doc, doc.y + 2);
}

function addMetaGrid(doc, rows, submission, analysis) {
  rows.forEach((row, index) => {
    ensureSpace(doc, submission, analysis, 730);
    const y = doc.y;
    doc.roundedRect(CONTENT_X, y, CONTENT_WIDTH, 24, 4).fill(index % 2 === 0 ? '#f6f9fc' : '#ffffff');
    doc.fillColor('#0b1f3a').font('Helvetica-Bold').fontSize(10)
      .text(String(row[0] || ''), CONTENT_X + 10, y + 7, { width: 150, lineBreak: false });
    doc.fillColor('#172033').font('Helvetica').fontSize(10)
      .text(String(row[1] || ''), CONTENT_X + 170, y + 7, { width: 335, align: 'left' });
    resetCursor(doc, y + 28);
  });
  resetCursor(doc, doc.y + 4);
}

async function generateProfessionalPdf(submission) {
  const pdfFileName = `${sanitizeFileName(submission.id)}.pdf`;
  const pdfPath = path.join(PDF_DIR, pdfFileName);
  const analysis = submission.analysis?.analysis || {};
  const answers = normalizeAnswers(submission.answers || []);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, autoFirstPage: true });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);

    drawHeader(doc, submission, analysis);

    doc.fillColor('#0b1f3a').font('Helvetica-Bold').fontSize(15.5)
      .text(analysis.caseCaption || 'Preliminary Migration Assessment', CONTENT_X, doc.y, {
        width: CONTENT_WIDTH,
        align: 'left',
      });
    resetCursor(doc, doc.y + 10);

    addMetaGrid(doc, [
      ['Assessment date', todayHuman()],
      ['Submission ID', submission.id],
      ['Client', submission.client?.fullName || 'Client'],
      ['Client email', submission.client?.email || 'Not provided'],
      ['Nationality', submission.client?.nationality || 'Not provided'],
      ['Service plan', submission.plan?.label || 'Not provided'],
    ], submission, analysis);

    addSectionTitle(doc, 'Case Summary', submission, analysis);
    addParagraph(doc, analysis.executiveSummary || submission.analysis?.summary || 'Assessment summary not available.', submission, analysis);

    addSectionTitle(doc, 'Preliminary Advice', submission, analysis);
    addParagraph(doc, analysis.legalStyleSummary || analysis.overallAssessment || 'Preliminary advice not available.', submission, analysis);

    addSectionTitle(doc, 'Strengths Supporting the Case', submission, analysis);
    addBulletList(doc, analysis.strengths, 'No material strengths were identified from the currently available information.', submission, analysis);

    addSectionTitle(doc, 'Key Risks, Limitations, or Concerns', submission, analysis);
    addBulletList(doc, analysis.concerns, 'No material concerns were identified from the currently available information.', submission, analysis);

    addSectionTitle(doc, 'Further Information or Evidence Required', submission, analysis);
    addBulletList(doc, analysis.missingInformation, 'No additional information items were identified.', submission, analysis);

    addSectionTitle(doc, 'Recommended Next Steps', submission, analysis);
    addBulletList(doc, analysis.recommendedNextSteps, 'No specific next steps were generated.', submission, analysis);

    addSectionTitle(doc, 'Suggested Supporting Document Checklist', submission, analysis);
    addBulletList(doc, analysis.documentChecklist, 'No document checklist items were generated.', submission, analysis);

    addSectionTitle(doc, 'Factual Assumptions Used for this Preliminary View', submission, analysis);
    addBulletList(doc, analysis.factualAssumptions, 'No specific factual assumptions were listed.', submission, analysis);

    addSectionTitle(doc, 'Assessment Ratings Snapshot', submission, analysis);
    addBulletList(doc, [
      `Sponsor readiness: ${analysis.ratings?.sponsorReadiness || 'Unknown'}`,
      `Occupation fit: ${analysis.ratings?.occupationFit || 'Unknown'}`,
      `Experience fit: ${analysis.ratings?.experienceFit || 'Unknown'}`,
      `English position: ${analysis.ratings?.englishPosition || 'Unknown'}`,
      `Compliance risk: ${analysis.ratings?.complianceRisk || 'Unknown'}`,
      `Overall readiness: ${analysis.ratings?.overallReadiness || 'Unknown'}`,
    ], null, submission, analysis);

    addSectionTitle(doc, 'Questionnaire Record', submission, analysis);
    addBulletList(doc, answers.map(item => `${item.question}: ${item.answer || 'No answer provided'}`), 'No answers received.', submission, analysis);

    addSectionTitle(doc, 'Important Notice', submission, analysis);
    addParagraph(doc, analysis.disclaimer, submission, analysis);

    addParagraph(doc, 'Yours faithfully,', submission, analysis);
    addParagraph(doc, 'Kenan Bircan JP', submission, analysis);
    addParagraph(doc, 'Registered Migration Agent | MARN: 1463685', submission, analysis);
    addParagraph(doc, 'Bircan Migration & Education', submission, analysis);

    drawFooterOnCurrentPage(doc);
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
