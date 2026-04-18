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


function drawFirstPageHeader(doc) {
  const logoPath = path.join(PUBLIC_DIR, 'logo.png');
  const hasLogo = fs.existsSync(logoPath);

  doc.save();
  doc.rect(40, 32, 515, 108).fill('#ffffff');
  if (hasLogo) {
    try {
      doc.image(logoPath, 40, 40, { fit: [88, 88], align: 'left', valign: 'top' });
    } catch (_) {}
  }

  const textX = hasLogo ? 138 : 40;
  doc.fillColor('#172033').font('Helvetica-Bold').fontSize(18)
    .text('Bircan Migration & Education', textX, 40, { width: 410 });
  doc.fillColor('#4b5563').font('Helvetica').fontSize(10)
    .text('Migration advice and professional visa assessment services', textX, 63, { width: 410 });
  doc.fillColor('#172033').font('Helvetica-Bold').fontSize(10.5)
    .text('Kenan Bircan JP', textX, 84, { width: 410 });
  doc.fillColor('#172033').font('Helvetica').fontSize(10)
    .text('Registered Migration Agent', textX, 99, { width: 410 });
  doc.text('MARN: 1463685 | MMIA: 10497', textX, 114, { width: 410 });
  doc.text('CMA: 20156912 | JP No: 218851', textX, 128, { width: 410 });

  doc.moveTo(40, 150).lineTo(555, 150).strokeColor('#d7deea').lineWidth(1).stroke();
  doc.restore();
  doc.fillColor('#172033');
  doc.y = 166;
}

function drawLaterPageHeader(doc) {
  const headerTitle = doc._runningHeaderTitle || 'Bircan Migration & Education Preliminary Assessment';
  doc.save();
  doc.moveTo(40, 42).lineTo(555, 42).strokeColor('#e2e8f0').lineWidth(1).stroke();
  doc.fillColor('#172033').font('Helvetica-Bold').fontSize(10.5)
    .text(headerTitle, 40, 24, { width: 515, align: 'left' });
  doc.restore();
  doc.fillColor('#172033');
  doc.y = 58;
}

function ensureSpace(doc, threshold = 720) {
  if (doc.y > threshold) {
    doc.addPage();
    drawLaterPageHeader(doc);
  }
}

function addSectionTitle(doc, title) {
  ensureSpace(doc, 700);
  doc.moveDown(0.35);
  doc.font('Helvetica-Bold').fontSize(12.5).fillColor('#0f2747').text(title, 40, doc.y, {
    width: 515,
  });
  doc.moveTo(40, doc.y + 2).lineTo(555, doc.y + 2).strokeColor('#d9e2ef').lineWidth(1).stroke();
  doc.moveDown(0.45);
}

function addParagraph(doc, text) {
  ensureSpace(doc, 730);
  doc.font('Helvetica').fontSize(10.5).fillColor('#172033').text(String(text || ''), 40, doc.y, {
    width: 515,
    lineGap: 3,
    align: 'left',
  });
  doc.moveDown(0.55);
}

function addBulletList(doc, items, fallbackText = 'Not provided.') {
  const list = Array.isArray(items) && items.length ? items : [fallbackText];
  list.forEach(item => {
    ensureSpace(doc, 735);
    doc.font('Helvetica').fontSize(10.5).fillColor('#172033')
      .text(`• ${String(item || '')}`, 40, doc.y, {
        width: 515,
        indent: 12,
        lineGap: 3,
      });
    doc.moveDown(0.25);
  });
  doc.moveDown(0.2);
}

function addKeyValueLine(doc, label, value) {
  ensureSpace(doc, 735);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#172033').text(`${label}`, 40, doc.y, {
    continued: true,
  });
  doc.font('Helvetica').text(` ${value}`, {
    width: 470,
    lineGap: 2,
  });
  doc.moveDown(0.25);
}

function addRatingsList(doc, ratings = {}) {
  addBulletList(doc, [
    `Sponsor readiness: ${ratings.sponsorReadiness || 'Unknown'}`,
    `Occupation fit: ${ratings.occupationFit || 'Unknown'}`,
    `Experience fit: ${ratings.experienceFit || 'Unknown'}`,
    `English position: ${ratings.englishPosition || 'Unknown'}`,
    `Compliance risk: ${ratings.complianceRisk || 'Unknown'}`,
    `Overall readiness: ${ratings.overallReadiness || 'Unknown'}`,
  ]);
}

async function generateProfessionalPdf(submission) {
  const pdfFileName = `${sanitizeFileName(submission.id)}.pdf`;
  const pdfPath = path.join(PDF_DIR, pdfFileName);
  const analysis = submission.analysis?.analysis || {};

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    stream.on('finish', resolve);
    stream.on('error', reject);

    doc._runningHeaderTitle = `Bircan Migration & Education ${submission.visaType || 'Visa'} Preliminary Assessment`;

    drawFirstPageHeader(doc);

    doc.font('Helvetica-Bold').fontSize(15).fillColor('#172033')
      .text(`${submission.visaType || 'Visa'} Preliminary Assessment & Advice`, 40, doc.y, { width: 515 });
    doc.moveDown(0.35);
    doc.font('Helvetica-Bold').fontSize(11.5).fillColor('#172033')
      .text(`Outcome: ${analysis.eligibilityOutcome || 'Needs professional review'}`, 40, doc.y, { width: 515 });
    doc.moveDown(0.55);

    addKeyValueLine(doc, 'Assessment date', todayHuman());
    addKeyValueLine(doc, 'Submission ID', submission.id);
    addKeyValueLine(doc, 'Client', submission.client?.fullName || 'Client');
    addKeyValueLine(doc, 'Client email', submission.client?.email || 'Not provided');
    addKeyValueLine(doc, 'Nationality', submission.client?.nationality || 'Not provided');
    addKeyValueLine(doc, 'Service plan', submission.plan?.label || 'Not provided');

    addSectionTitle(doc, 'Case Summary');
    addParagraph(doc, analysis.executiveSummary || submission.analysis?.summary || 'Assessment summary not available.');

    addSectionTitle(doc, 'Preliminary Advice');
    addParagraph(doc, analysis.legalStyleSummary || analysis.overallAssessment || 'Preliminary advice not available.');

    addSectionTitle(doc, 'Strengths Supporting the Case');
    addBulletList(doc, analysis.strengths, 'No material strengths were identified from the currently available information.');

    addSectionTitle(doc, 'Key Risks, Limitations, or Concerns');
    addBulletList(doc, analysis.concerns, 'No material concerns were identified from the currently available information.');

    addSectionTitle(doc, 'Further Information or Evidence Required');
    addBulletList(doc, analysis.missingInformation, 'No additional information items were identified.');

    addSectionTitle(doc, 'Recommended Next Steps');
    addBulletList(doc, analysis.recommendedNextSteps, 'No specific next steps were generated.');

    addSectionTitle(doc, 'Suggested Supporting Document Checklist');
    addBulletList(doc, analysis.documentChecklist, 'No document checklist items were generated.');

    addSectionTitle(doc, 'Assessment Ratings Snapshot');
    addRatingsList(doc, analysis.ratings || {});

    addSectionTitle(doc, 'Important Notice');
    addParagraph(doc, analysis.disclaimer);

    ensureSpace(doc, 745);
    doc.moveDown(0.5);
    addParagraph(doc, 'Yours faithfully,');
    addParagraph(doc, 'Kenan Bircan JP');
    addParagraph(doc, 'Registered Migration Agent | MARN: 1463685');
    addParagraph(doc, 'Bircan Migration & Education');

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
