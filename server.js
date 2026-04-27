'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const multer = require('multer');
const Stripe = require('stripe');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

let mammoth = null;
try {
  mammoth = require('mammoth');
} catch (_) {
  mammoth = null;
}

const app = express();

const PORT = Number(process.env.PORT || 10000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_SECRET || crypto.createHash('sha256').update(String(process.env.ADMIN_TOKEN || process.env.STRIPE_SECRET_KEY || 'bircan-dev-secret')).digest('hex');

const PRIMARY_FRONTEND_URL = 'https://bircanmigration.au';
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
const EXTRA_ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(v => String(v || '').trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = Array.from(new Set([...HARDCODED_ALLOWED_ORIGINS, ...EXTRA_ALLOWED_ORIGINS]));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL_ANALYSIS = process.env.OPENAI_MODEL_ANALYSIS || process.env.OPENAI_MODEL || 'gpt-4.1';
const OPENAI_MODEL_HELPER = process.env.OPENAI_MODEL_HELPER || 'gpt-4.1-mini';
const OPENAI_BASE_URL = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || 'no-reply@bircanmigration.com.au';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Stripe mode toggle
// Set STRIPE_MODE=test for test payments, or STRIPE_MODE=live for real payments.
// Test mode only reads *_TEST variables. Live mode reads *_LIVE first, then legacy names.
// This prevents accidentally using live Price IDs with a test secret key.
const STRIPE_MODE = String(process.env.STRIPE_MODE || 'test').trim().toLowerCase() === 'live' ? 'live' : 'test';
const STRIPE_SECRET_KEY = STRIPE_MODE === 'live'
  ? String(process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY || '').trim()
  : String(process.env.STRIPE_SECRET_KEY_TEST || '').trim();
const STRIPE_WEBHOOK_SECRET = STRIPE_MODE === 'live'
  ? String(process.env.STRIPE_WEBHOOK_SECRET_LIVE || process.env.STRIPE_WEBHOOK_SECRET || '').trim()
  : String(process.env.STRIPE_WEBHOOK_SECRET_TEST || process.env.STRIPE_WEBHOOK_SECRET || '').trim();

const STRIPE_PRICE_CITIZENSHIP_20 = STRIPE_MODE === 'live'
  ? String(process.env.STRIPE_PRICE_CITIZENSHIP_20_LIVE || process.env.STRIPE_PRICE_CITIZENSHIP_20 || '').trim()
  : String(process.env.STRIPE_PRICE_CITIZENSHIP_20_TEST || '').trim();
const STRIPE_PRICE_CITIZENSHIP_50 = STRIPE_MODE === 'live'
  ? String(process.env.STRIPE_PRICE_CITIZENSHIP_50_LIVE || process.env.STRIPE_PRICE_CITIZENSHIP_50 || '').trim()
  : String(process.env.STRIPE_PRICE_CITIZENSHIP_50_TEST || '').trim();
const STRIPE_PRICE_CITIZENSHIP_100 = STRIPE_MODE === 'live'
  ? String(process.env.STRIPE_PRICE_CITIZENSHIP_100_LIVE || process.env.STRIPE_PRICE_CITIZENSHIP_100 || '').trim()
  : String(process.env.STRIPE_PRICE_CITIZENSHIP_100_TEST || '').trim();
const STRIPE_PRICE_CITIZENSHIP_UNLIMITED = STRIPE_MODE === 'live'
  ? String(process.env.STRIPE_PRICE_CITIZENSHIP_UNLIMITED_LIVE || process.env.STRIPE_PRICE_CITIZENSHIP_UNLIMITED || '').trim()
  : String(process.env.STRIPE_PRICE_CITIZENSHIP_UNLIMITED_TEST || '').trim();

const STRIPE_SUCCESS_PATH = String(process.env.STRIPE_SUCCESS_PATH || '/account-dashboard.html').trim() || '/account-dashboard.html';
const STRIPE_CANCEL_PATH = String(process.env.STRIPE_CANCEL_PATH || '/account-dashboard.html').trim() || '/account-dashboard.html';

// Visa assessment Stripe checkout settings. These are optional because the route
// can create checkout line items dynamically from the assessment plan price.
const STRIPE_PRICE_VISA_INSTANT = STRIPE_MODE === 'live'
  ? String(process.env.STRIPE_PRICE_VISA_INSTANT_LIVE || process.env.STRIPE_PRICE_VISA_INSTANT || '').trim()
  : String(process.env.STRIPE_PRICE_VISA_INSTANT_TEST || '').trim();
const STRIPE_PRICE_VISA_24H = STRIPE_MODE === 'live'
  ? String(process.env.STRIPE_PRICE_VISA_24H_LIVE || process.env.STRIPE_PRICE_VISA_24H || '').trim()
  : String(process.env.STRIPE_PRICE_VISA_24H_TEST || '').trim();
const STRIPE_PRICE_VISA_3D = STRIPE_MODE === 'live'
  ? String(process.env.STRIPE_PRICE_VISA_3D_LIVE || process.env.STRIPE_PRICE_VISA_3D || '').trim()
  : String(process.env.STRIPE_PRICE_VISA_3D_TEST || '').trim();

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'data');
const SUBMISSIONS_DIR = path.join(STORAGE_DIR, 'submissions');
const PDF_DIR = path.join(STORAGE_DIR, 'pdfs');
const PUBLIC_DIR = path.join(__dirname, 'public');
const KNOWLEDGEBASE_DIR = process.env.KNOWLEDGEBASE_DIR || path.join(__dirname, 'knowledgebase');
const CITIZENSHIP_BANK_PATH = process.env.CITIZENSHIP_BANK_PATH || path.join(__dirname, 'citizenship-question-bank.json');
const CITIZENSHIP_ENTITLEMENTS_PATH = path.join(STORAGE_DIR, 'citizenship-entitlements.json');
const CITIZENSHIP_EXAMS_PATH = path.join(STORAGE_DIR, 'citizenship-exams.json');
const CITIZENSHIP_USERS_PATH = path.join(STORAGE_DIR, 'citizenship-users.json');

const kbUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, KNOWLEDGEBASE_DIR),
    filename: (_req, file, cb) => cb(null, sanitizeFileName(file.originalname || 'upload'))
  }),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 20
  }
});

const KNOWLEDGEBASE_STATE = {
  loadedAt: null,
  files: [],
  chunks: [],
  error: null,
};

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
[STORAGE_DIR, SUBMISSIONS_DIR, PDF_DIR, PUBLIC_DIR, KNOWLEDGEBASE_DIR].forEach(ensureDirSync);

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



function getStripePriceIdForPlan(plan) {
  const code = String(plan || '').trim().toLowerCase();
  if (code === '20') return STRIPE_PRICE_CITIZENSHIP_20;
  if (code === '50') return STRIPE_PRICE_CITIZENSHIP_50;
  if (code === '100') return STRIPE_PRICE_CITIZENSHIP_100;
  if (code === 'unlimited') return STRIPE_PRICE_CITIZENSHIP_UNLIMITED;
  return '';
}

function getStripePlanConfig(plan) {
  const code = String(plan || '').trim().toLowerCase();
  const map = {
    '20': { code: '20', label: '20 exam pack', attempts: 20, priceId: STRIPE_PRICE_CITIZENSHIP_20 },
    '50': { code: '50', label: '50 exam pack', attempts: 50, priceId: STRIPE_PRICE_CITIZENSHIP_50 },
    '100': { code: '100', label: '100 exam pack', attempts: 100, priceId: STRIPE_PRICE_CITIZENSHIP_100 },
    'unlimited': { code: 'unlimited', label: 'Unlimited exam pack', attempts: null, priceId: STRIPE_PRICE_CITIZENSHIP_UNLIMITED },
  };
  return map[code] || null;
}

function buildStripeReturnUrl(pathname, params = {}) {
  const cleanPath = `/${String(pathname || '').replace(/^\/+/, '')}`;
  const base = new URL(cleanPath, APP_BASE_URL);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') base.searchParams.set(key, String(value));
  });
  return base.toString();
}

function assertStripeConfigured() {
  if (!stripe) {
    const error = new Error(`Stripe is not configured. Add ${STRIPE_MODE === 'live' ? 'STRIPE_SECRET_KEY_LIVE' : 'STRIPE_SECRET_KEY_TEST'} to the server environment.`);
    error.statusCode = 500;
    throw error;
  }
}

function assertStripeModeLooksConsistent() {
  if (STRIPE_MODE === 'test' && !STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    const error = new Error('Stripe mode is test, but STRIPE_SECRET_KEY_TEST is not a test secret key.');
    error.statusCode = 500;
    throw error;
  }
  if (STRIPE_MODE === 'live' && !STRIPE_SECRET_KEY.startsWith('sk_live_')) {
    const error = new Error('Stripe mode is live, but the configured secret key is not a live secret key.');
    error.statusCode = 500;
    throw error;
  }
}

function calculateReleaseAt(planInput, baseDate = null) {
  const plan = normalizePlan(planInput && typeof planInput === 'object' ? (planInput.code || planInput.label || planInput.turnaround) : planInput);
  const base = baseDate ? new Date(baseDate) : new Date();
  const ms = Number(base.getTime());
  if (!Number.isFinite(ms)) return nowIso();
  if (plan.code === '3d') return new Date(ms + 72 * 60 * 60 * 1000).toISOString();
  if (plan.code === '24h') return new Date(ms + 24 * 60 * 60 * 1000).toISOString();
  return new Date(ms).toISOString();
}

function getReleaseSnapshot(submission = {}, refDate = null) {
  const now = refDate ? new Date(refDate) : new Date();
  const plan = normalizePlan(submission.plan || submission.assessmentPlan || submission.delivery || submission.package);
  const releaseAt = submission.releaseAt || submission.emailReleaseAt || submission.scheduledEmailAt || calculateReleaseAt(plan, submission.paidAt || submission.createdAt || nowIso());
  const releaseMs = new Date(releaseAt).getTime();
  const nowMs = now.getTime();
  const emailReleased = Boolean(submission.emailReleased || submission.emailReleasedAt || String(submission.emailStatus || '').toLowerCase() === 'sent');
  const countdownMs = Number.isFinite(releaseMs) ? Math.max(0, releaseMs - nowMs) : 0;

  let releaseStatus = 'scheduled';
  if (emailReleased) releaseStatus = 'released';
  else if (!Number.isFinite(releaseMs) || releaseMs <= nowMs) releaseStatus = 'ready';
  else if (plan.code === 'instant') releaseStatus = 'ready';

  return {
    plan,
    releaseAt,
    releaseCountdownMs: countdownMs,
    releaseStatus,
    emailReleased,
    emailReleasedAt: submission.emailReleasedAt || null,
  };
}

function buildReleasePatch(submission = {}, refDate = null) {
  const snapshot = getReleaseSnapshot(submission, refDate);
  return {
    plan: snapshot.plan,
    releaseAt: snapshot.releaseAt,
    emailReleaseAt: snapshot.releaseAt,
    scheduledEmailAt: snapshot.releaseAt,
    releaseStatus: snapshot.releaseStatus,
    releaseCountdownMs: snapshot.releaseCountdownMs,
    emailReleased: snapshot.emailReleased,
    emailReleasedAt: snapshot.emailReleasedAt,
  };
}

function shouldReleaseEmailNow(submission = {}, refDate = null) {
  const snapshot = getReleaseSnapshot(submission, refDate);
  if (snapshot.emailReleased) return false;
  return snapshot.releaseStatus === 'ready';
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



function normaliseVisaType(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  const directMap = {
    '189': 'Subclass 189',
    'subclass 189': 'Subclass 189',
    'skilled independent visa': 'Subclass 189',
    '190': 'Subclass 190',
    'subclass 190': 'Subclass 190',
    'skilled nominated visa': 'Subclass 190',
    '491': 'Subclass 491',
    'subclass 491': 'Subclass 491',
    'skilled work regional visa': 'Subclass 491',
    '191': 'Subclass 191',
    'subclass 191': 'Subclass 191',
    'permanent residence regional visa': 'Subclass 191',

    '482': 'Subclass 482',
    'subclass 482': 'Subclass 482',
    'temporary skill shortage visa': 'Subclass 482',
    'skills in demand visa': 'Subclass 482',
    'sid visa': 'Subclass 482',
    '186': 'Subclass 186',
    'subclass 186': 'Subclass 186',
    'employer nomination scheme visa': 'Subclass 186',
    '187': 'Subclass 187',
    'subclass 187': 'Subclass 187',
    'rsms': 'Subclass 187',
    'regional sponsored migration scheme': 'Subclass 187',
    '494': 'Subclass 494',
    'subclass 494': 'Subclass 494',
    'skilled employer sponsored regional visa': 'Subclass 494',

    '500': 'Subclass 500',
    'subclass 500': 'Subclass 500',
    'student visa': 'Subclass 500',
    '485': 'Subclass 485',
    'subclass 485': 'Subclass 485',
    'temporary graduate visa': 'Subclass 485',
    'graduate visa': 'Subclass 485',

    '820': 'Subclass 820',
    'subclass 820': 'Subclass 820',
    '801': 'Subclass 801',
    'subclass 801': 'Subclass 801',
    '309': 'Subclass 309',
    'subclass 309': 'Subclass 309',
    '100': 'Subclass 100',
    'subclass 100': 'Subclass 100',
    '300': 'Subclass 300',
    'subclass 300': 'Subclass 300',
    'prospective marriage visa': 'Subclass 300',
    'partner visa': 'Partner Visa',

    '103': 'Subclass 103',
    'subclass 103': 'Subclass 103',
    '143': 'Subclass 143',
    'subclass 143': 'Subclass 143',
    '173': 'Subclass 173',
    'subclass 173': 'Subclass 173',
    '804': 'Subclass 804',
    'subclass 804': 'Subclass 804',
    '864': 'Subclass 864',
    'subclass 864': 'Subclass 864',
    '884': 'Subclass 884',
    'subclass 884': 'Subclass 884',
    '870': 'Subclass 870',
    'subclass 870': 'Subclass 870',

    '101': 'Subclass 101',
    'subclass 101': 'Subclass 101',
    '802': 'Subclass 802',
    'subclass 802': 'Subclass 802',
    '445': 'Subclass 445',
    'subclass 445': 'Subclass 445',

    '114': 'Subclass 114',
    'subclass 114': 'Subclass 114',
    '838': 'Subclass 838',
    'subclass 838': 'Subclass 838',
    '116': 'Subclass 116',
    'subclass 116': 'Subclass 116',
    '836': 'Subclass 836',
    'subclass 836': 'Subclass 836',
    '115': 'Subclass 115',
    'subclass 115': 'Subclass 115',
    '835': 'Subclass 835',
    'subclass 835': 'Subclass 835',

    '866': 'Subclass 866',
    'subclass 866': 'Subclass 866',
    'protection visa': 'Subclass 866',
    '200': 'Subclass 200',
    'subclass 200': 'Subclass 200',
    '201': 'Subclass 201',
    'subclass 201': 'Subclass 201',
    '202': 'Subclass 202',
    'subclass 202': 'Subclass 202',
    '203': 'Subclass 203',
    'subclass 203': 'Subclass 203',
    '204': 'Subclass 204',
    'subclass 204': 'Subclass 204',

    '188': 'Subclass 188',
    'subclass 188': 'Subclass 188',
    '888': 'Subclass 888',
    'subclass 888': 'Subclass 888',

    '600': 'Subclass 600',
    'subclass 600': 'Subclass 600',
    'visitor visa': 'Subclass 600',
    '601': 'Subclass 601',
    'subclass 601': 'Subclass 601',
    'electronic travel authority': 'Subclass 601',
    'eta': 'Subclass 601',
    '651': 'Subclass 651',
    'subclass 651': 'Subclass 651',
    'evisitor': 'Subclass 651',

    '407': 'Subclass 407',
    'subclass 407': 'Subclass 407',
    'training visa': 'Subclass 407',
    '408': 'Subclass 408',
    'subclass 408': 'Subclass 408',
    'temporary activity visa': 'Subclass 408',
    '476': 'Subclass 476',
    'subclass 476': 'Subclass 476',
    'skilled recognised graduate visa': 'Subclass 476',
    'recognised graduate visa': 'Subclass 476',

    '010': 'Bridging Visa A',
    '020': 'Bridging Visa B',
    '030': 'Bridging Visa C',
    '040': 'Bridging Visa D',
    '050': 'Bridging Visa E',
    'bridging visa a': 'Bridging Visa A',
    'bridging visa b': 'Bridging Visa B',
    'bridging visa c': 'Bridging Visa C',
    'bridging visa d': 'Bridging Visa D',
    'bridging visa e': 'Bridging Visa E',

    '417': 'Subclass 417',
    'subclass 417': 'Subclass 417',
    'working holiday visa': 'Subclass 417',
    '462': 'Subclass 462',
    'subclass 462': 'Subclass 462',
    'work and holiday visa': 'Subclass 462',
    '489': 'Subclass 489',
    'subclass 489': 'Subclass 489',
    '887': 'Subclass 887',
    'subclass 887': 'Subclass 887',

    'citizenship': 'Australian Citizenship',
    'citizenship by conferral': 'Australian Citizenship'
  };
  return directMap[lower] || raw || 'Subclass 482';
}

function buildVisaProfiles() {
  const protectionSections = [
    { title: 'Protection Claim Basis', type: 'paragraph', key: 'protectionClaimBasis', fallback: 'Protection claim basis analysis was not generated.' },
    { title: 'Convention Ground Analysis', type: 'paragraph', key: 'conventionGroundAssessment', fallback: 'Convention ground analysis was not generated.' },
    { title: 'Complementary Protection Position', type: 'paragraph', key: 'complementaryProtectionAssessment', fallback: 'Complementary protection analysis was not generated.' },
    { title: 'Identity and Credibility Position', type: 'paragraph', key: 'identityCredibilityAssessment', fallback: 'Identity and credibility analysis was not generated.' },
    { title: 'Country Information, State Protection, and Internal Relocation', type: 'paragraph', key: 'countryRiskAssessment', fallback: 'Country information and state protection analysis was not generated.' },
    { title: 'Protection Evidence Gaps', type: 'bullets', key: 'protectionEvidenceGaps', fallback: 'No specific protection evidence gaps were identified.' },
  ];

  const employerMetrics = {
    title: 'Employer-Side Legal Metrics',
    items: [
      { label: 'Sponsor position', key: 'sponsorPosition', fallback: 'Requires review' },
      { label: 'Nomination / role genuineness', key: 'nominationGenuineness', fallback: 'Requires review' },
      { label: 'Occupation alignment', key: 'occupationAlignment', fallback: 'Requires review' },
      { label: 'Salary / threshold position', key: 'salaryThresholdPosition', fallback: 'Requires review' },
      { label: 'English / licensing readiness', key: 'englishLicensingReadiness', fallback: 'Requires review' },
      { label: 'Lodgement readiness', key: 'lodgementReadinessMetric', fallback: 'Requires review' },
    ]
  };

  const pointsTestedMetrics = {
    title: 'Skilled Migration Legal Metrics',
    items: [
      { label: 'Points position', key: 'pointsPosition', fallback: 'Requires review' },
      { label: 'Invitation competitiveness', key: 'invitationCompetitivenessMetric', fallback: 'Requires review' },
      { label: 'Skills assessment position', key: 'skillsAssessmentPositionMetric', fallback: 'Requires review' },
      { label: 'English leverage', key: 'englishLeverage', fallback: 'Requires review' },
      { label: 'Nomination / regional pathway strength', key: 'nominationPathwayStrength', fallback: 'Requires review' },
      { label: 'Lodgement readiness', key: 'lodgementReadinessMetric', fallback: 'Requires review' },
    ]
  };

  const protectionMetrics = {
    title: 'Protection Law Assessment Matrix',
    items: [
      { label: 'Application validity and jurisdiction', key: 'jurisdictionValidity', fallback: 'Requires review' },
      { label: 'Convention ground articulation', key: 'conventionGroundStrength', fallback: 'Requires review' },
      { label: 'Credibility and consistency', key: 'credibilityConsistency', fallback: 'Requires review' },
      { label: 'Corroboration and country information', key: 'corroborationCountryInfo', fallback: 'Requires review' },
      { label: 'State protection / internal relocation', key: 'stateProtectionRelocation', fallback: 'Requires review' },
      { label: 'Complementary protection fallback', key: 'complementaryProtectionFallback', fallback: 'Requires review' },
      { label: 'Lodgement timing', key: 'lodgementTiming', fallback: 'Requires review' },
    ]
  };

  const studentMetrics = {
    title: 'Student Visa Legal Metrics',
    items: [
      { label: 'Genuine student position', key: 'genuineStudentMetric', fallback: 'Requires review' },
      { label: 'Course logic and progression', key: 'courseLogicMetric', fallback: 'Requires review' },
      { label: 'Financial capacity', key: 'financialCapacityMetric', fallback: 'Requires review' },
      { label: 'English readiness', key: 'englishReadinessMetric', fallback: 'Requires review' },
      { label: 'Immigration history and credibility', key: 'immigrationCredibilityMetric', fallback: 'Requires review' },
      { label: 'Lodgement readiness', key: 'lodgementReadinessMetric', fallback: 'Requires review' },
    ]
  };

  const graduateMetrics = {
    title: 'Graduate Visa Legal Metrics',
    items: [
      { label: 'Qualification completion position', key: 'completionPosition', fallback: 'Requires review' },
      { label: 'Stream suitability', key: 'streamSuitability', fallback: 'Requires review' },
      { label: 'Australian study requirement', key: 'studyRequirementMetric', fallback: 'Requires review' },
      { label: 'Timing compliance', key: 'timingComplianceMetric', fallback: 'Requires review' },
      { label: 'English / insurance / AFP readiness', key: 'readinessBundleMetric', fallback: 'Requires review' },
      { label: 'Lodgement readiness', key: 'lodgementReadinessMetric', fallback: 'Requires review' },
    ]
  };

  const familyMetrics = {
    title: 'Family Visa Legal Metrics',
    items: [
      { label: 'Primary eligibility position', key: 'primaryEligibilityMetric', fallback: 'Requires review' },
      { label: 'Relationship / dependency evidence', key: 'relationshipDependencyMetric', fallback: 'Requires review' },
      { label: 'Sponsor / proposer position', key: 'sponsorProposerMetric', fallback: 'Requires review' },
      { label: 'Threshold criteria satisfaction', key: 'thresholdCriteriaMetric', fallback: 'Requires review' },
      { label: 'Evidence strength', key: 'evidenceStrengthMetric', fallback: 'Requires review' },
      { label: 'Lodgement readiness', key: 'lodgementReadinessMetric', fallback: 'Requires review' },
    ]
  };

  const visitorMetrics = {
    title: 'Temporary Entry Legal Metrics',
    items: [
      { label: 'Temporary entrant credibility', key: 'temporaryEntrantMetric', fallback: 'Requires review' },
      { label: 'Travel purpose clarity', key: 'travelPurposeMetric', fallback: 'Requires review' },
      { label: 'Funding position', key: 'fundingMetric', fallback: 'Requires review' },
      { label: 'Home country ties', key: 'homeTiesMetric', fallback: 'Requires review' },
      { label: 'Travel history / compliance', key: 'travelHistoryMetric', fallback: 'Requires review' },
      { label: 'Lodgement readiness', key: 'lodgementReadinessMetric', fallback: 'Requires review' },
    ]
  };

  const temporaryActivityMetrics = {
    title: 'Temporary Visa Legal Metrics',
    items: [
      { label: 'Core pathway position', key: 'corePathwayMetric', fallback: 'Requires review' },
      { label: 'Sponsor / support position', key: 'sponsorSupportMetric', fallback: 'Requires review' },
      { label: 'Temporary purpose credibility', key: 'temporaryPurposeMetric', fallback: 'Requires review' },
      { label: 'Evidence sufficiency', key: 'evidenceStrengthMetric', fallback: 'Requires review' },
      { label: 'Threshold compliance', key: 'thresholdCriteriaMetric', fallback: 'Requires review' },
      { label: 'Lodgement readiness', key: 'lodgementReadinessMetric', fallback: 'Requires review' },
    ]
  };

  const businessMetrics = {
    title: 'Business / Investment Legal Metrics',
    items: [
      { label: 'Business or investment background', key: 'businessBackgroundMetric', fallback: 'Requires review' },
      { label: 'Nomination / invitation position', key: 'nominationPathwayStrength', fallback: 'Requires review' },
      { label: 'Funds / source evidence', key: 'fundsSourceMetric', fallback: 'Requires review' },
      { label: 'Program / transitional eligibility', key: 'programEligibilityMetric', fallback: 'Requires review' },
      { label: 'Evidence sufficiency', key: 'evidenceStrengthMetric', fallback: 'Requires review' },
      { label: 'Lodgement readiness', key: 'lodgementReadinessMetric', fallback: 'Requires review' },
    ]
  };

  const statusMetrics = {
    title: 'Status Visa Legal Metrics',
    items: [
      { label: 'Current status position', key: 'statusPositionMetric', fallback: 'Requires review' },
      { label: 'Dependency on substantive application', key: 'dependencyMetric', fallback: 'Requires review' },
      { label: 'Travel / work / condition exposure', key: 'conditionExposureMetric', fallback: 'Requires review' },
      { label: 'Evidence sufficiency', key: 'evidenceStrengthMetric', fallback: 'Requires review' },
      { label: 'Practical utility', key: 'practicalUtilityMetric', fallback: 'Requires review' },
      { label: 'Readiness for action', key: 'lodgementReadinessMetric', fallback: 'Requires review' },
    ]
  };

  const citizenshipMetrics = {
    title: 'Citizenship Legal Metrics',
    items: [
      { label: 'Residence requirement position', key: 'residenceRequirementMetric', fallback: 'Requires review' },
      { label: 'Permanent residence timing', key: 'prTimingMetric', fallback: 'Requires review' },
      { label: 'Character position', key: 'characterMetric', fallback: 'Requires review' },
      { label: 'Identity readiness', key: 'identityMetric', fallback: 'Requires review' },
      { label: 'Evidence sufficiency', key: 'evidenceStrengthMetric', fallback: 'Requires review' },
      { label: 'Application readiness', key: 'lodgementReadinessMetric', fallback: 'Requires review' },
    ]
  };

  return {
    'Subclass 189': {
      stream: 'Points-Tested Skilled Migration',
      legalMetrics: pointsTestedMetrics,
      displayName: 'Subclass 189',
      promptFocus: [
        '- Assess points competitiveness, invitation dependence, skills assessment position, and English score leverage.',
        '- Distinguish between present substantive eligibility and realistic invitation prospects.',
        '- Identify if the matter is legally viable but strategically weak due to points ranking.',
      ],
      pdfSections: [
        { title: 'Points Test Position', type: 'paragraph', key: 'pointsAssessment', fallback: 'Points competitiveness analysis was not generated.' },
        { title: 'Invitation Competitiveness', type: 'paragraph', key: 'invitationCompetitiveness', fallback: 'Invitation competitiveness analysis was not generated.' },
        { title: 'Invitation Risks', type: 'bullets', key: 'invitationRisks', fallback: 'No invitation-specific risks were identified.' },
      ],
      checklist: ['Skills assessment outcome', 'English test results', 'Employment evidence for points claims', 'Qualification evidence', 'EOI assumptions and claimed points support']
    },
    'Subclass 190': {
      stream: 'State Nominated Skilled Migration',
      legalMetrics: pointsTestedMetrics,
      displayName: 'Subclass 190',
      promptFocus: [
        '- Assess points position together with state nomination viability and likely state-specific exposure.',
        '- Distinguish state nomination uncertainty from federal visa criteria.',
        '- Explain whether the client should proceed now, change state strategy, or improve profile before lodgement.',
      ],
      pdfSections: [
        { title: 'Points Test Position', type: 'paragraph', key: 'pointsAssessment', fallback: 'Points assessment was not generated.' },
        { title: 'State Nomination Position', type: 'paragraph', key: 'stateNominationAssessment', fallback: 'State nomination analysis was not generated.' },
        { title: 'State Nomination and Invitation Risks', type: 'bullets', key: 'invitationRisks', fallback: 'No state nomination or invitation risks were specifically identified.' },
      ],
      checklist: ['Skills assessment outcome', 'English results and points evidence', 'State ties or residency/employment evidence if relevant', 'Employment references', 'Qualification and identity evidence']
    },
    'Subclass 491': {
      stream: 'Regional Skilled Migration',
      legalMetrics: pointsTestedMetrics,
      displayName: 'Subclass 491',
      promptFocus: [
        '- Assess regional nomination or family sponsorship pathway viability.',
        '- Identify regional residence commitment issues, state nomination criteria, and invitation competitiveness.',
        '- Distinguish between legal eligibility and practical competitiveness.',
      ],
      pdfSections: [
        { title: 'Regional Pathway Position', type: 'paragraph', key: 'regionalPathwayAssessment', fallback: 'Regional pathway analysis was not generated.' },
        { title: 'Regional Commitment and Invitation Risks', type: 'bullets', key: 'regionalRisks', fallback: 'No regional or invitation risks were specifically identified.' },
      ],
      checklist: ['Skills assessment outcome', 'Regional nomination or family sponsor evidence', 'English and points evidence', 'Regional commitment and residence planning', 'Employment and qualification evidence']
    },
    'Subclass 191': {
      stream: 'Permanent Residence (Regional)',
      legalMetrics: pointsTestedMetrics,
      displayName: 'Subclass 191',
      promptFocus: [
        '- Assess regional residence history, income threshold compliance, and prior qualifying visa position.',
        '- Identify whether the applicant appears ready for permanent regional residence or requires further qualifying time or records.',
      ],
      pdfSections: [
        { title: 'Regional Residence and Income Position', type: 'paragraph', key: 'regionalResidenceAssessment', fallback: 'Regional residence and income analysis was not generated.' },
        { title: 'Threshold Eligibility Issues', type: 'bullets', key: 'thresholdIssues', fallback: 'No threshold issues were identified.' },
      ],
      checklist: ['Prior qualifying regional visa evidence', 'Regional residence evidence', 'Notice of assessments or income evidence', 'Identity documents', 'Travel records if relevant']
    },

    'Subclass 482': {
      stream: 'Employer Sponsored',
      legalMetrics: employerMetrics,
      displayName: 'Subclass 482',
      promptFocus: [
        '- Assess sponsor lawfulness, trading status, and whether sponsorship appears viable on the supplied facts.',
        '- Assess whether the nominated role appears genuine and aligned with the business need described.',
        '- Assess occupation alignment, work experience relevance, and any licensing or registration exposure.',
        '- Treat nomination approval as a separate legal risk and explain clearly if visa readiness depends on nomination approval.',
        '- Assess English threshold position, salary/TSMIT-type issues if raised by the answers, and location-specific risk where relevant.',
      ],
      pdfSections: [
        { title: 'Sponsorship and Nomination Position', type: 'paragraph', key: 'sponsorshipAssessment', fallback: 'Sponsor and nomination-specific analysis was not generated.' },
        { title: 'Occupation and Role Alignment', type: 'paragraph', key: 'occupationAlignmentAssessment', fallback: 'Occupation and role alignment analysis was not generated.' },
        { title: 'Nomination Dependency and Employer-Side Exposure', type: 'bullets', key: 'nominationRisks', fallback: 'No employer-side nomination risks were specifically identified.' },
      ],
      checklist: ['Sponsor approval or sponsorship status evidence', 'Nomination position description and organisational chart', 'Employment contract and salary details', 'Detailed employment references and payslips', 'Licence/registration evidence if occupation requires it']
    },
    'Subclass 186': {
      stream: 'Employer Sponsored Permanent',
      legalMetrics: employerMetrics,
      displayName: 'Subclass 186',
      promptFocus: [
        '- Assess whether the facts suggest a Temporary Residence Transition pathway or Direct Entry pathway issue.',
        '- Evaluate the genuineness and permanence of the nominated role and any employer compliance exposure.',
        '- Assess age, English, skills assessment, and work experience issues as possible threshold or waiver issues.',
        '- Make clear whether the client appears ready for permanent employer-sponsored lodgement or should delay.',
      ],
      pdfSections: [
        { title: 'Employer Nomination Position', type: 'paragraph', key: 'sponsorshipAssessment', fallback: 'Permanent employer sponsorship analysis was not generated.' },
        { title: 'Pathway Analysis', type: 'paragraph', key: 'ensPathwayAssessment', fallback: 'ENS pathway analysis was not generated.' },
        { title: 'Threshold Eligibility Issues', type: 'bullets', key: 'thresholdIssues', fallback: 'No distinct threshold eligibility issues were identified.' },
      ],
      checklist: ['Employer nomination and permanent role evidence', 'Employment history and salary evidence', 'Skills assessment or exemption basis', 'English evidence or exemption pathway', 'Age exemption evidence if relevant']
    },
    'Subclass 187': {
      stream: 'Regional Sponsored Migration (Legacy)',
      legalMetrics: employerMetrics,
      displayName: 'Subclass 187',
      promptFocus: [
        '- Treat this matter as a legacy or transitional regional employer-sponsored case type.',
        '- Assess whether the applicant appears capable of meeting transitional or grandfathered requirements on the stated facts.',
        '- Identify any regional employer, nomination, or legacy pathway risks clearly and conservatively.',
      ],
      pdfSections: [
        { title: 'Legacy Pathway Position', type: 'paragraph', key: 'legacyEligibilityAssessment', fallback: 'Legacy subclass eligibility analysis was not generated.' },
        { title: 'Regional Employer Position', type: 'paragraph', key: 'regionalEmployerAssessment', fallback: 'Regional employer analysis was not generated.' },
        { title: 'Legacy / Transitional Risks', type: 'bullets', key: 'legacyRisks', fallback: 'No legacy or transitional risks were specifically identified.' },
      ],
      checklist: ['Regional employer nomination evidence', 'Regional location evidence', 'Legacy pathway eligibility documents', 'Employment references', 'Skills assessment or exemption basis', 'English evidence']
    },
    'Subclass 494': {
      stream: 'Regional Employer Sponsored',
      displayName: 'Subclass 494',
      promptFocus: [
        '- Assess regional employer sponsorship viability, occupation alignment, salary compliance, and licensing exposure.',
        '- Identify regional role genuineness, labour market and employer-side risks where relevant on the supplied facts.',
      ],
      pdfSections: [
        { title: 'Regional Employer Sponsorship Position', type: 'paragraph', key: 'sponsorshipAssessment', fallback: 'Regional employer sponsorship analysis was not generated.' },
        { title: 'Regional Role and Salary Position', type: 'paragraph', key: 'regionalPositionAssessment', fallback: 'Regional role and salary analysis was not generated.' },
        { title: 'Regional Employer Risks', type: 'bullets', key: 'regionalRisks', fallback: 'No regional employer risks were identified.' },
      ],
      checklist: ['Regional employer nomination evidence', 'Regional position description and salary details', 'Skills assessment evidence', 'Employment references', 'Licensing or registration evidence if required']
    },

    'Subclass 500': {
      stream: 'Student',
      displayName: 'Subclass 500',
      promptFocus: [
        '- Assess genuine student profile, course logic, financial capacity, and immigration history risk on the stated facts.',
        '- Evaluate whether the proposed study plan appears credible and proportionate to the applicant’s background.',
        '- Clearly identify if the problem is evidence quality, course strategy, or credibility risk.',
      ],
      pdfSections: [
        { title: 'Genuine Student Position', type: 'paragraph', key: 'genuineStudentAssessment', fallback: 'Genuine student analysis was not generated.' },
        { title: 'Study Plan and Financial Capacity Position', type: 'paragraph', key: 'studyPlanAssessment', fallback: 'Study plan analysis was not generated.' },
        { title: 'Financial and Credibility Risks', type: 'bullets', key: 'genuineStudentRisks', fallback: 'No specific student credibility risks were identified.' },
      ],
      checklist: ['Confirmation of Enrolment or intended course details', 'Financial capacity evidence', 'Academic history and transcripts', 'Statement addressing study rationale and future plans', 'English evidence and immigration history documents']
    },
    'Subclass 485': {
      stream: 'Temporary Graduate',
      displayName: 'Subclass 485',
      promptFocus: [
        '- Assess course completion position, Australian study requirement issues, English threshold, and timing exposure.',
        '- Identify the likely stream, including post-vocational education work or post-higher education work, based on the supplied facts.',
        '- Identify whether the main issue is eligibility timing, qualification mismatch, or evidence readiness.',
      ],
      pdfSections: [
        { title: 'Graduate Eligibility Position', type: 'paragraph', key: 'graduateAssessment', fallback: 'Graduate visa analysis was not generated.' },
        { title: 'Graduate Stream Analysis', type: 'paragraph', key: 'graduateStreamAssessment', fallback: 'Graduate stream analysis was not generated.' },
        { title: 'Timing and Evidence Risks', type: 'bullets', key: 'timingRisks', fallback: 'No specific graduate timing risks were identified.' },
      ],
      checklist: ['Completion letter and academic transcript', 'Australian study requirement evidence', 'English evidence', 'AFP check / timing readiness', 'Health insurance and identity documents']
    },

    'Partner Visa': {
      stream: 'Partner and Family',
      displayName: 'Partner Visa',
      promptFocus: [
        '- Assess relationship genuineness across financial, social, household, and commitment indicators.',
        '- Distinguish evidence gaps from fatal credibility concerns.',
        '- Identify whether timing, cohabitation evidence, or sponsor history creates elevated refusal exposure.',
      ],
      pdfSections: [
        { title: 'Relationship Evidence Position', type: 'paragraph', key: 'relationshipAssessment', fallback: 'Relationship evidence analysis was not generated.' },
        { title: 'Four-Limbs Relationship Analysis', type: 'paragraph', key: 'fourLimbsAssessment', fallback: 'Four-limbs analysis was not generated.' },
        { title: 'Relationship and Sponsor Risks', type: 'bullets', key: 'relationshipRisks', fallback: 'No relationship-specific risks were identified.' },
      ],
      checklist: ['Relationship timeline and statements', 'Financial co-mingling evidence', 'Household and cohabitation evidence', 'Social recognition evidence', 'Sponsor eligibility and identity documents']
    },
    'Subclass 820': { stream: 'Partner (Onshore)', legalMetrics: familyMetrics, displayName: 'Subclass 820', aliasOf: 'Partner Visa' },
    'Subclass 801': { stream: 'Partner (Onshore Permanent)', displayName: 'Subclass 801', aliasOf: 'Partner Visa' },
    'Subclass 309': { stream: 'Partner (Offshore)', legalMetrics: familyMetrics, displayName: 'Subclass 309', aliasOf: 'Partner Visa' },
    'Subclass 100': { stream: 'Partner (Offshore Permanent)', displayName: 'Subclass 100', aliasOf: 'Partner Visa' },
    'Subclass 300': {
      stream: 'Prospective Marriage',
      displayName: 'Subclass 300',
      promptFocus: [
        '- Assess intention to marry, relationship genuineness, meeting requirement, and sponsor eligibility.',
        '- Identify timing, evidence, and sponsor history risks.',
      ],
      pdfSections: [
        { title: 'Prospective Marriage Position', type: 'paragraph', key: 'relationshipAssessment', fallback: 'Prospective marriage analysis was not generated.' },
        { title: 'Engagement, Meeting, and Sponsor Risks', type: 'bullets', key: 'relationshipRisks', fallback: 'No subclass 300-specific risks were identified.' },
      ],
      checklist: ['Evidence of intention to marry', 'Evidence parties have met in person', 'Relationship history evidence', 'Sponsor identity and eligibility evidence', 'Civil documents']
    },

    'Subclass 103': { stream: 'Parent', legalMetrics: familyMetrics, displayName: 'Subclass 103', promptFocus: ['- Assess parent eligibility, sponsor position, balance of family exposure, and queue implications.'], pdfSections: [{ title: 'Parent Eligibility Position', type: 'paragraph', key: 'parentAssessment', fallback: 'Parent visa analysis was not generated.' }, { title: 'Parent Visa Risks', type: 'bullets', key: 'parentRisks', fallback: 'No parent visa-specific risks were identified.' }], checklist: ['Sponsor eligibility evidence', 'Balance of family evidence', 'Identity and civil documents', 'Parent-child relationship evidence'] },
    'Subclass 143': { stream: 'Contributory Parent', displayName: 'Subclass 143', aliasOf: 'Subclass 103' },
    'Subclass 173': { stream: 'Contributory Parent (Temporary)', displayName: 'Subclass 173', aliasOf: 'Subclass 103' },
    'Subclass 804': { stream: 'Aged Parent', displayName: 'Subclass 804', aliasOf: 'Subclass 103' },
    'Subclass 864': { stream: 'Contributory Aged Parent', displayName: 'Subclass 864', aliasOf: 'Subclass 103' },
    'Subclass 884': { stream: 'Contributory Aged Parent (Temporary)', displayName: 'Subclass 884', aliasOf: 'Subclass 103' },
    'Subclass 870': { stream: 'Sponsored Parent (Temporary)', displayName: 'Subclass 870', aliasOf: 'Subclass 103' },

    'Subclass 101': { stream: 'Child (Offshore)', legalMetrics: familyMetrics, displayName: 'Subclass 101', promptFocus: ['- Assess child relationship, age or dependency position, parental responsibility, and custody or consent risks.'], pdfSections: [{ title: 'Child Eligibility Position', type: 'paragraph', key: 'childAssessment', fallback: 'Child visa analysis was not generated.' }, { title: 'Dependency and Consent Risks', type: 'bullets', key: 'childRisks', fallback: 'No child visa-specific risks were identified.' }], checklist: ['Birth certificate', 'Parent-child relationship evidence', 'Custody or consent documents', 'Dependency evidence if relevant'] },
    'Subclass 802': { stream: 'Child (Onshore)', displayName: 'Subclass 802', aliasOf: 'Subclass 101' },
    'Subclass 445': { stream: 'Dependent Child', displayName: 'Subclass 445', aliasOf: 'Subclass 101' },

    'Subclass 114': { stream: 'Aged Dependent Relative', legalMetrics: familyMetrics, displayName: 'Subclass 114', promptFocus: ['- Assess relative dependency, sponsor eligibility, and practical long-term dependency evidence.'], pdfSections: [{ title: 'Relative Dependency Position', type: 'paragraph', key: 'relativeAssessment', fallback: 'Relative visa analysis was not generated.' }, { title: 'Dependency and Sponsor Risks', type: 'bullets', key: 'relativeRisks', fallback: 'No relative visa-specific risks were identified.' }], checklist: ['Dependency evidence', 'Sponsor eligibility evidence', 'Identity and civil documents', 'Financial support history'] },
    'Subclass 838': { stream: 'Aged Dependent Relative (Onshore)', displayName: 'Subclass 838', aliasOf: 'Subclass 114' },
    'Subclass 116': { stream: 'Carer', legalMetrics: familyMetrics, displayName: 'Subclass 116', promptFocus: ['- Assess care need, medical evidence, sponsor position, and whether care cannot reasonably be obtained in Australia.'], pdfSections: [{ title: 'Care Need Position', type: 'paragraph', key: 'carerNeedAssessment', fallback: 'Carer visa analysis was not generated.' }, { title: 'Medical and Care Risks', type: 'bullets', key: 'carerRisks', fallback: 'No carer visa-specific risks were identified.' }], checklist: ['Medical evidence of care need', 'Evidence care cannot reasonably be obtained', 'Sponsor eligibility evidence', 'Identity and civil documents'] },
    'Subclass 836': { stream: 'Carer (Onshore)', displayName: 'Subclass 836', aliasOf: 'Subclass 116' },
    'Subclass 115': { stream: 'Remaining Relative', legalMetrics: familyMetrics, displayName: 'Subclass 115', promptFocus: ['- Assess remaining relative threshold criteria, sponsor eligibility, and family composition evidence.'], pdfSections: [{ title: 'Remaining Relative Position', type: 'paragraph', key: 'relativeAssessment', fallback: 'Remaining relative analysis was not generated.' }, { title: 'Family Composition Risks', type: 'bullets', key: 'relativeRisks', fallback: 'No remaining relative risks were identified.' }], checklist: ['Family composition evidence', 'Sponsor eligibility evidence', 'Identity and civil documents'] },
    'Subclass 835': { stream: 'Remaining Relative (Onshore)', displayName: 'Subclass 835', aliasOf: 'Subclass 115' },

    'Subclass 866': { stream: 'Protection Visa (Onshore)', legalMetrics: protectionMetrics, displayName: 'Subclass 866', promptFocus: ['- Assess Convention ground exposure including race, religion, nationality, political opinion, or particular social group.', '- Assess credibility, identity, country information, harm on return, and availability of state protection.', '- Assess complementary protection risk and evidentiary weaknesses.', '- State clearly whether immediate lodgement is recommended or whether evidence strengthening is required first.'], pdfSections: protectionSections, checklist: ['Valid passport and national identity card', 'Birth certificate or statutory declaration', 'Detailed personal statement and incident chronology', 'Medical and psychological expert reports', 'Witness statements and affidavits', 'Country information reports relevant to applicant’s region', 'Evidence of family intimidation and risk', 'Bridging visa documentation'] },
    'Subclass 200': { stream: 'Refugee and Humanitarian', displayName: 'Subclass 200', aliasOf: 'Subclass 866' },
    'Subclass 201': { stream: 'In-country Special Humanitarian', displayName: 'Subclass 201', aliasOf: 'Subclass 866' },
    'Subclass 202': { stream: 'Global Special Humanitarian', displayName: 'Subclass 202', aliasOf: 'Subclass 866' },
    'Subclass 203': { stream: 'Emergency Rescue', displayName: 'Subclass 203', aliasOf: 'Subclass 866' },
    'Subclass 204': { stream: 'Woman at Risk', displayName: 'Subclass 204', aliasOf: 'Subclass 866' },

    'Subclass 188': { stream: 'Business Innovation and Investment (Provisional)', legalMetrics: businessMetrics, displayName: 'Subclass 188', promptFocus: ['- Assess business or investment background, nomination position, and provisional eligibility exposure based on the supplied facts.', '- Identify whether the matter appears transitional, legacy, or dependent on prior program settings.'], pdfSections: [{ title: 'Business and Investment Position', type: 'paragraph', key: 'businessBackgroundAssessment', fallback: 'Business background analysis was not generated.' }, { title: 'Business or Investment Risks', type: 'bullets', key: 'businessRisks', fallback: 'No business or investment risks were identified.' }], checklist: ['Business ownership evidence', 'Financial statements', 'Source of funds evidence', 'Nomination or invitation evidence', 'Identity documents'] },
    'Subclass 888': { stream: 'Business Innovation and Investment (Permanent)', displayName: 'Subclass 888', aliasOf: 'Subclass 188' },

    'Subclass 600': { stream: 'Visitor', legalMetrics: visitorMetrics, displayName: 'Subclass 600', promptFocus: ['- Assess temporary entrant credibility, travel purpose, funding, and home country incentive to depart.', '- Identify if refusal risk arises from weak temporary intent, poor funding evidence, or family/employment ties.'], pdfSections: [{ title: 'Temporary Entrant Position', type: 'paragraph', key: 'temporaryEntrantAssessment', fallback: 'Temporary entrant analysis was not generated.' }, { title: 'Departure and Funding Risks', type: 'bullets', key: 'temporaryEntrantRisks', fallback: 'No specific visitor visa risks were identified.' }], checklist: ['Travel purpose evidence', 'Funding evidence', 'Employment or business ties', 'Family and home country ties', 'Travel history documents'] },
    'Subclass 601': { stream: 'Electronic Travel Authority', displayName: 'Subclass 601', aliasOf: 'Subclass 600' },
    'Subclass 651': { stream: 'eVisitor', displayName: 'Subclass 651', aliasOf: 'Subclass 600' },

    'Subclass 407': { stream: 'Training', legalMetrics: temporaryActivityMetrics, displayName: 'Subclass 407', promptFocus: ['- Assess training plan credibility, sponsor position, occupational relevance, and temporary intent exposure.'], pdfSections: [{ title: 'Training Plan Position', type: 'paragraph', key: 'trainingPlanAssessment', fallback: 'Training plan analysis was not generated.' }, { title: 'Training and Sponsorship Risks', type: 'bullets', key: 'trainingRisks', fallback: 'No training visa-specific risks were identified.' }], checklist: ['Training plan', 'Sponsor approval evidence', 'Occupational relevance evidence', 'Identity and temporary entrant evidence'] },
    'Subclass 408': { stream: 'Temporary Activity', legalMetrics: temporaryActivityMetrics, displayName: 'Subclass 408', promptFocus: ['- Assess the nominated activity stream, temporary purpose, sponsor or event support, and evidence quality.'], pdfSections: [{ title: 'Temporary Activity Position', type: 'paragraph', key: 'temporaryActivityAssessment', fallback: 'Temporary activity analysis was not generated.' }, { title: 'Activity and Evidence Risks', type: 'bullets', key: 'temporaryActivityRisks', fallback: 'No temporary activity risks were identified.' }], checklist: ['Activity invitation or support evidence', 'Event or sponsor evidence', 'Identity documents', 'Temporary purpose evidence'] },
    'Subclass 476': { stream: 'Skilled Recognised Graduate', legalMetrics: graduateMetrics, displayName: 'Subclass 476', promptFocus: ['- Assess recognised institution position, engineering qualification timing, age, English, and recent graduation exposure.'], pdfSections: [{ title: 'Recognised Graduate Position', type: 'paragraph', key: 'graduateAssessment', fallback: 'Recognised graduate analysis was not generated.' }, { title: 'Qualification and Timing Risks', type: 'bullets', key: 'timingRisks', fallback: 'No recognised graduate timing risks were identified.' }], checklist: ['Qualification evidence', 'Institution recognition evidence', 'English evidence', 'Identity documents'] },

    'Bridging Visa A': { stream: 'Bridging and Status Visa', legalMetrics: statusMetrics, displayName: 'Bridging Visa A', promptFocus: ['- Provide only limited status-based assessment and identify the substantive application or migration status dependency clearly.'], pdfSections: [{ title: 'Status and Dependency Position', type: 'paragraph', key: 'statusVisaAssessment', fallback: 'Status visa analysis was not generated.' }, { title: 'Practical Risks and Limitations', type: 'bullets', key: 'statusVisaRisks', fallback: 'No specific status visa risks were identified.' }], checklist: ['Current visa grant evidence', 'Substantive application evidence', 'Department correspondence', 'Identity documents'] },
    'Bridging Visa B': { stream: 'Bridging and Status Visa', displayName: 'Bridging Visa B', aliasOf: 'Bridging Visa A' },
    'Bridging Visa C': { stream: 'Bridging and Status Visa', displayName: 'Bridging Visa C', aliasOf: 'Bridging Visa A' },
    'Bridging Visa D': { stream: 'Bridging and Status Visa', displayName: 'Bridging Visa D', aliasOf: 'Bridging Visa A' },
    'Bridging Visa E': { stream: 'Bridging and Status Visa', displayName: 'Bridging Visa E', aliasOf: 'Bridging Visa A' },

    'Subclass 417': { stream: 'Working Holiday', legalMetrics: visitorMetrics, displayName: 'Subclass 417', promptFocus: ['- Assess age, nationality, previous working holiday history, and temporary purpose issues.'], pdfSections: [{ title: 'Working Holiday Position', type: 'paragraph', key: 'temporaryEntrantAssessment', fallback: 'Working holiday analysis was not generated.' }, { title: 'Working Holiday Risks', type: 'bullets', key: 'temporaryEntrantRisks', fallback: 'No working holiday risks were identified.' }], checklist: ['Passport', 'Nationality evidence', 'Previous visa history', 'Funds evidence'] },
    'Subclass 462': { stream: 'Work and Holiday', displayName: 'Subclass 462', aliasOf: 'Subclass 417' },
    'Subclass 489': { stream: 'Skilled Regional (Legacy)', legalMetrics: pointsTestedMetrics, displayName: 'Subclass 489', promptFocus: ['- Treat this as a legacy regional skilled matter and assess only on the supplied transitional or historical facts.'], pdfSections: [{ title: 'Legacy Regional Skilled Position', type: 'paragraph', key: 'legacyEligibilityAssessment', fallback: 'Legacy regional skilled analysis was not generated.' }, { title: 'Legacy Regional Risks', type: 'bullets', key: 'legacyRisks', fallback: 'No legacy regional skilled risks were identified.' }], checklist: ['Prior regional visa evidence', 'Nomination or sponsorship evidence', 'Residence records', 'Identity documents'] },
    'Subclass 887': { stream: 'Skilled Regional (Permanent)', displayName: 'Subclass 887', aliasOf: 'Subclass 489' },

    'Australian Citizenship': {
      stream: 'Citizenship',
      legalMetrics: citizenshipMetrics,
      displayName: 'Australian Citizenship',
      promptFocus: [
        '- Assess residence requirement position, permanent residence timing, character exposure, and eligibility readiness.',
        '- Identify if the matter is immediately ready or requires further wait time or evidence.',
      ],
      pdfSections: [
        { title: 'Residence Requirement Position', type: 'paragraph', key: 'residenceAssessment', fallback: 'Residence requirement analysis was not generated.' },
        { title: 'Character or Timing Risks', type: 'bullets', key: 'timingRisks', fallback: 'No citizenship-specific timing risks were identified.' },
      ],
      checklist: ['Travel movement record', 'PR grant evidence', 'Identity documents', 'Character disclosures and court records if relevant', 'Residency timeline summary']
    },
    'Visitor Visa': { aliasOf: 'Subclass 600', displayName: 'Visitor Visa', stream: 'Visitor' }
  };
}
const VISA_PROFILES = buildVisaProfiles();

function getVisaProfile(visaType) {
  const normalised = normaliseVisaType(visaType);
  const profile = VISA_PROFILES[normalised] || {
    stream: 'General Migration',
    displayName: normalised,
    promptFocus: [
      '- Assess this matter according to the substantive legal requirements commonly applicable to this visa pathway.',
      '- Identify threshold eligibility, evidence gaps, and strategic timing considerations.',
      '- Distinguish curable evidence weakness from substantive ineligibility.'
    ],
    pdfSections: [],
    checklist: [],
    legalMetrics: null
  };
  if (profile.aliasOf && VISA_PROFILES[profile.aliasOf]) {
    return { ...VISA_PROFILES[profile.aliasOf], ...profile, displayName: profile.displayName || normalised };
  }
  return profile;
}

function getSupportedVisaTypes() {
  return Object.keys(VISA_PROFILES);
}


function getDecisionCriteria(profile = {}, visaType = '') {
  const visa = String(visaType || profile.displayName || '').toLowerCase();
  const stream = String(profile.stream || '').toLowerCase();

  if (visa.includes('866') || stream.includes('protection') || /refugee|humanitarian/.test(stream)) {
    return [
      'Application validity and jurisdiction',
      'Identity and claimed profile',
      'Credibility and consistency',
      'Convention ground nexus',
      'Forward-looking risk of serious harm',
      'State protection',
      'Internal relocation',
      'Complementary protection',
      'Evidence sufficiency and lodgement timing'
    ];
  }
  if (visa.includes('482') || visa.includes('186') || visa.includes('494') || visa.includes('187') || stream.includes('employer')) {
    return [
      'Sponsor position',
      'Nomination genuineness',
      'Occupation alignment',
      'Skills and employment background',
      'English or licensing threshold',
      'Salary and employment conditions',
      'Lodgement readiness'
    ];
  }
  if (visa.includes('189') || visa.includes('190') || visa.includes('491') || visa.includes('191') || stream.includes('skilled')) {
    return [
      'Core pathway eligibility',
      'Points or threshold position',
      'Skills assessment position',
      'English position',
      'Invitation, nomination, or regional pathway strength',
      'Evidence sufficiency',
      'Lodgement readiness'
    ];
  }
  if (visa.includes('500') || stream.includes('student')) {
    return [
      'Core student pathway position',
      'Genuine student assessment',
      'Course logic and progression',
      'Financial capacity',
      'English readiness',
      'Immigration history and credibility',
      'Lodgement readiness'
    ];
  }
  if (visa.includes('485') || visa.includes('476') || stream.includes('graduate')) {
    return [
      'Qualification completion position',
      'Correct stream or pathway fit',
      'Australian study or recognition requirement',
      'Timing compliance',
      'English, insurance, and police checks',
      'Evidence sufficiency',
      'Lodgement readiness'
    ];
  }
  if (stream.includes('partner') || stream.includes('family') || /partner|parent|child|relative|carer/.test(visa)) {
    return [
      'Core relationship or family criterion',
      'Sponsor or proposer position',
      'Threshold statutory requirements',
      'Credibility and consistency of family evidence',
      'Evidence sufficiency',
      'Adverse factors or refusal exposure',
      'Lodgement readiness'
    ];
  }
  if (stream.includes('visitor') || visa.includes('600') || visa.includes('601') || visa.includes('651') || visa.includes('417') || visa.includes('462')) {
    return [
      'Temporary purpose',
      'Temporary entrant credibility',
      'Funding position',
      'Home country ties and departure incentive',
      'Travel history and compliance',
      'Evidence sufficiency',
      'Lodgement readiness'
    ];
  }
  if (stream.includes('citizenship') || visa.includes('citizenship')) {
    return [
      'Residence requirement',
      'Permanent residence timing',
      'Identity',
      'Character position',
      'Evidence sufficiency',
      'Application readiness'
    ];
  }
  return [
    'Primary eligibility criterion',
    'Threshold statutory requirements',
    'Evidence sufficiency',
    'Credibility and consistency',
    'Adverse factors or refusal exposure',
    'Lodgement readiness'
  ];
}


function extractSubclassCodes(value = '') {
  const matches = String(value || '').match(/\b\d{3}\b/g) || [];
  return Array.from(new Set(matches));
}

function normaliseForMatch(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function getKnowledgebaseScope(profile = {}, visaType = '') {
  const visa = String(visaType || profile.displayName || '').toLowerCase();
  const stream = String(profile.stream || '').toLowerCase();
  const exactCodes = extractSubclassCodes(`${visaType} ${profile.displayName || ''}`);
  const scope = {
    exactCodes,
    familyCodes: [...exactCodes],
    allowTokens: [],
  };

  if (visa.includes('866') || stream.includes('protection') || /refugee|humanitarian/.test(stream)) {
    scope.familyCodes = Array.from(new Set([...exactCodes, '866', '200', '201', '202', '203', '204']));
    scope.allowTokens = ['protection', 'refugee', 'humanitarian', 'complementary', 'persecution'];
    return scope;
  }
  if (visa.includes('482') || visa.includes('186') || visa.includes('494') || visa.includes('187') || stream.includes('employer')) {
    scope.allowTokens = ['employer', 'sponsor', 'sponsorship', 'nomination', 'occupation', 'ens', 'sid', 'tss', 'regional sponsored migration scheme'];
    return scope;
  }
  if (visa.includes('189') || visa.includes('190') || visa.includes('491') || visa.includes('191') || visa.includes('489') || visa.includes('887') || stream.includes('skilled')) {
    scope.allowTokens = ['skilled', 'points', 'invitation', 'skills assessment', 'regional', 'state nominated', 'state nomination'];
    return scope;
  }
  if (visa.includes('500') || stream.includes('student')) {
    scope.allowTokens = ['student', 'genuine student', 'financial capacity', 'course', 'enrolment', 'coe'];
    return scope;
  }
  if (visa.includes('485') || visa.includes('476') || stream.includes('graduate')) {
    scope.allowTokens = ['graduate', 'temporary graduate', 'australian study', 'completion', 'recognised graduate'];
    return scope;
  }
  if (stream.includes('partner') || /partner|spouse|prospective marriage/.test(visa)) {
    scope.familyCodes = Array.from(new Set([...exactCodes, '820', '801', '309', '100', '300']));
    scope.allowTokens = ['partner', 'spouse', 'relationship', 'prospective marriage', 'de facto'];
    return scope;
  }
  if (stream.includes('parent')) {
    scope.familyCodes = Array.from(new Set([...exactCodes, '103', '143', '173', '804', '864', '884', '870']));
    scope.allowTokens = ['parent', 'balance of family', 'contributory parent', 'aged parent'];
    return scope;
  }
  if (stream.includes('child')) {
    scope.familyCodes = Array.from(new Set([...exactCodes, '101', '802', '445']));
    scope.allowTokens = ['child', 'dependent child', 'custody', 'parental responsibility'];
    return scope;
  }
  if (stream.includes('relative') || stream.includes('carer') || /relative|carer/.test(visa)) {
    scope.familyCodes = Array.from(new Set([...exactCodes, '114', '838', '116', '836', '115', '835']));
    scope.allowTokens = ['relative', 'carer', 'dependency', 'remaining relative', 'aged dependent relative'];
    return scope;
  }
  if (stream.includes('visitor') || visa.includes('600') || visa.includes('601') || visa.includes('651') || visa.includes('417') || visa.includes('462')) {
    scope.allowTokens = ['visitor', 'temporary entrant', 'travel', 'holiday', 'eta', 'evisitor'];
    return scope;
  }
  if (stream.includes('temporary activity') || visa.includes('407') || visa.includes('408')) {
    scope.allowTokens = ['temporary activity', 'training', 'activity', 'event', 'occupational training'];
    return scope;
  }
  if (stream.includes('business') || visa.includes('188') || visa.includes('888')) {
    scope.allowTokens = ['business', 'investment', 'investor', 'innovation', 'nomination'];
    return scope;
  }
  if (stream.includes('bridging') || visa.includes('bridging') || /\b010\b|\b020\b|\b030\b|\b040\b|\b050\b/.test(visa)) {
    scope.allowTokens = ['bridging', 'status', 'substantive application', 'conditions'];
    return scope;
  }
  if (stream.includes('citizenship') || visa.includes('citizenship')) {
    scope.allowTokens = ['citizenship', 'residence', 'character', 'conferral'];
    return scope;
  }
  return scope;
}

function isChunkRelevantToScope(chunk, scope = {}) {
  const hay = normaliseForMatch(`${chunk.fileName} ${chunk.relativePath} ${chunk.section}`);
  const chunkCodes = extractSubclassCodes(`${chunk.fileName} ${chunk.relativePath}`);
  const exactSet = new Set(scope.exactCodes || []);
  const familySet = new Set(scope.familyCodes || []);

  if (chunkCodes.length) {
    if (scope.exactCodes && scope.exactCodes.length) {
      if (chunkCodes.some(code => exactSet.has(code))) return true;
    }
    if (chunkCodes.some(code => familySet.has(code))) return true;
    return false;
  }

  return Array.isArray(scope.allowTokens) && scope.allowTokens.some(token => hay.includes(normaliseForMatch(token)));
}

function filterKnowledgebaseChunksByScope(chunks = [], scope = {}) {
  const relevant = (Array.isArray(chunks) ? chunks : []).filter(chunk => isChunkRelevantToScope(chunk, scope));
  return relevant.length ? relevant : (Array.isArray(chunks) ? chunks : []);
}

function summariseDecisionOutcome(item = {}) {
  const text = `${item.assessment || ''} ${item.professionalView || ''}`.toLowerCase();
  const risk = String(item.riskLevel || '').toLowerCase();
  if (/do not lodge|not recommended|not presently recommended|not satisfied|not met|bar to application|ineligible/.test(text)) return 'Not presently satisfied';
  if (/meets|satisfied|criterion satisfied|likely satisfied|broadly established/.test(text) && !/further|but|however|provided/.test(text)) return 'Likely satisfied';
  if (/likely satisfied|likely met|capable of being satisfied|plausible|arguable|potentially satisfied|potentially available/.test(text)) return 'Arguable but needs strengthening';
  if (/incomplete|insufficient|further evidence|required|clarification|underdeveloped|not yet fully satisfied/.test(text)) return 'Requires strengthening';
  if (risk === 'low') return 'Generally satisfactory';
  if (risk === 'moderate') return 'Requires strengthening';
  if (risk === 'high') return 'High risk / adverse';
  return 'Requires review';
}

function findDecisionFrameworkMatch(decisionFramework = [], patterns = []) {
  const list = Array.isArray(decisionFramework) ? decisionFramework : [];
  const regexes = (Array.isArray(patterns) ? patterns : []).map(pattern => new RegExp(pattern, 'i'));
  return list.find(item => regexes.some(regex => regex.test(String(item.criterion || ''))));
}

function buildLegalMetricsFromDecisionFramework(profile = {}, analysis = {}) {
  const config = profile.legalMetrics;
  if (!config || !Array.isArray(config.items) || !config.items.length) return analysis.legalMetrics || {};
  const existing = (analysis && typeof analysis.legalMetrics === 'object' && !Array.isArray(analysis.legalMetrics)) ? { ...analysis.legalMetrics } : {};
  const decisionFramework = Array.isArray(analysis.decisionFramework) ? analysis.decisionFramework : [];
  const visa = String(profile.displayName || '').toLowerCase();
  const stream = String(profile.stream || '').toLowerCase();

  const patternMap = {};
  if (visa.includes('866') || stream.includes('protection') || /refugee|humanitarian/.test(stream)) {
    Object.assign(patternMap, {
      jurisdictionValidity: ['application validity', 'jurisdiction'],
      conventionGroundStrength: ['convention ground', 'nexus'],
      credibilityConsistency: ['credibility', 'consistency'],
      corroborationCountryInfo: ['forward-looking risk', 'evidence sufficiency', 'country'],
      stateProtectionRelocation: ['state protection', 'internal relocation'],
      complementaryProtectionFallback: ['complementary protection'],
      lodgementTiming: ['lodgement timing', 'evidence sufficiency']
    });
  } else if (visa.includes('482') || visa.includes('186') || visa.includes('494') || visa.includes('187') || stream.includes('employer')) {
    Object.assign(patternMap, {
      sponsorPosition: ['sponsor position'],
      nominationGenuineness: ['nomination genuineness'],
      occupationAlignment: ['occupation alignment'],
      salaryThresholdPosition: ['salary', 'employment conditions'],
      englishLicensingReadiness: ['english', 'licensing'],
      lodgementReadinessMetric: ['lodgement readiness']
    });
  } else if (visa.includes('189') || visa.includes('190') || visa.includes('491') || visa.includes('191') || visa.includes('489') || visa.includes('887') || stream.includes('skilled')) {
    Object.assign(patternMap, {
      pointsPosition: ['points', 'threshold'],
      invitationCompetitivenessMetric: ['invitation', 'nomination', 'regional pathway'],
      skillsAssessmentPositionMetric: ['skills assessment'],
      englishLeverage: ['english position'],
      nominationPathwayStrength: ['invitation', 'nomination', 'regional pathway'],
      lodgementReadinessMetric: ['lodgement readiness']
    });
  } else if (visa.includes('500') || stream.includes('student')) {
    Object.assign(patternMap, {
      genuineStudentMetric: ['genuine student'],
      courseLogicMetric: ['course logic', 'progression'],
      financialCapacityMetric: ['financial capacity'],
      englishReadinessMetric: ['english readiness'],
      immigrationCredibilityMetric: ['immigration history', 'credibility'],
      lodgementReadinessMetric: ['lodgement readiness']
    });
  } else if (visa.includes('485') || visa.includes('476') || stream.includes('graduate')) {
    Object.assign(patternMap, {
      completionPosition: ['qualification completion'],
      streamSuitability: ['stream', 'pathway fit'],
      studyRequirementMetric: ['study', 'recognition requirement'],
      timingComplianceMetric: ['timing compliance'],
      readinessBundleMetric: ['english', 'insurance', 'police checks'],
      lodgementReadinessMetric: ['lodgement readiness']
    });
  } else if (stream.includes('partner') || stream.includes('family') || /partner|parent|child|relative|carer/.test(visa)) {
    Object.assign(patternMap, {
      primaryEligibilityMetric: ['core relationship', 'core pathway', 'core family', 'primary eligibility'],
      relationshipDependencyMetric: ['credibility and consistency', 'relationship', 'dependency'],
      sponsorProposerMetric: ['sponsor', 'proposer'],
      thresholdCriteriaMetric: ['threshold statutory'],
      evidenceStrengthMetric: ['evidence sufficiency'],
      lodgementReadinessMetric: ['lodgement readiness']
    });
  } else if (stream.includes('visitor') || stream.includes('working holiday') || visa.includes('600') || visa.includes('601') || visa.includes('651') || visa.includes('417') || visa.includes('462')) {
    Object.assign(patternMap, {
      temporaryEntrantMetric: ['temporary entrant credibility'],
      travelPurposeMetric: ['temporary purpose'],
      fundingMetric: ['funding position'],
      homeTiesMetric: ['home country ties', 'departure incentive'],
      travelHistoryMetric: ['travel history', 'compliance'],
      lodgementReadinessMetric: ['lodgement readiness']
    });
  } else if (stream.includes('temporary activity') || visa.includes('407') || visa.includes('408')) {
    Object.assign(patternMap, {
      corePathwayMetric: ['core pathway', 'temporary activity', 'training plan'],
      sponsorSupportMetric: ['sponsor', 'support'],
      temporaryPurposeMetric: ['temporary purpose'],
      evidenceStrengthMetric: ['evidence sufficiency'],
      thresholdCriteriaMetric: ['threshold statutory'],
      lodgementReadinessMetric: ['lodgement readiness']
    });
  } else if (stream.includes('business') || visa.includes('188') || visa.includes('888')) {
    Object.assign(patternMap, {
      businessBackgroundMetric: ['business', 'investment background'],
      nominationPathwayStrength: ['nomination', 'invitation'],
      fundsSourceMetric: ['funds', 'source'],
      programEligibilityMetric: ['program', 'transitional eligibility'],
      evidenceStrengthMetric: ['evidence sufficiency'],
      lodgementReadinessMetric: ['lodgement readiness']
    });
  } else if (stream.includes('bridging') || stream.includes('status')) {
    Object.assign(patternMap, {
      statusPositionMetric: ['current status'],
      dependencyMetric: ['dependency'],
      conditionExposureMetric: ['conditions', 'travel', 'work'],
      evidenceStrengthMetric: ['evidence sufficiency'],
      practicalUtilityMetric: ['practical utility'],
      lodgementReadinessMetric: ['readiness']
    });
  } else if (stream.includes('citizenship') || visa.includes('citizenship')) {
    Object.assign(patternMap, {
      residenceRequirementMetric: ['residence requirement'],
      prTimingMetric: ['permanent residence timing'],
      characterMetric: ['character position'],
      identityMetric: ['identity'],
      evidenceStrengthMetric: ['evidence sufficiency'],
      lodgementReadinessMetric: ['application readiness', 'lodgement readiness']
    });
  }

  for (const item of config.items) {
    const current = String(existing[item.key] || '').trim();
    if (current && !/^requires review$/i.test(current)) continue;
    const match = findDecisionFrameworkMatch(decisionFramework, patternMap[item.key] || []);
    if (match) existing[item.key] = summariseDecisionOutcome(match);
    else if (!current) existing[item.key] = item.fallback || 'Requires review';
  }

  return existing;
}

function buildFallbackDecisionFramework(submission = {}, profile = {}) {
  const answerPairs = pickQuestionAnswerPairs(extractAnswerMap(submission.answers || []), 3);
  const factLines = answerPairs.length
    ? answerPairs.map(item => `${item.question}: ${item.answer}`)
    : ['The presently available questionnaire material is limited.'];
  return getDecisionCriteria(profile, submission.visaType).slice(0, 7).map((criterion, index) => ({
    criterion,
    legalTest: `Whether the presently available facts are sufficient to support ${criterion.toLowerCase()}.`,
    availableFacts: index === 0 ? factLines : ['Further subclass-specific facts and supporting evidence are required.'],
    assessment: 'The presently available material permits only a preliminary view and does not yet support a conclusive positive finding.',
    riskLevel: index < 2 ? 'Moderate' : 'Requires review',
    deficiencies: ['Supporting evidence is incomplete or not yet verified.'],
    evidenceRequired: ['Subclass-specific documentary evidence should be assembled before lodgement.'],
    professionalView: 'Proceed only after the factual record and supporting evidence are strengthened.'
  }));
}


function getFrameworkAssessments(decisionFramework = [], patterns = []) {
  const matches = [];
  const regexes = (Array.isArray(patterns) ? patterns : []).map(pattern => new RegExp(pattern, 'i'));
  for (const item of Array.isArray(decisionFramework) ? decisionFramework : []) {
    const criterion = String(item?.criterion || '');
    if (regexes.some(regex => regex.test(criterion))) matches.push(item);
  }
  return matches;
}

function joinFrameworkNarrative(items = [], field = 'assessment') {
  const parts = [];
  for (const item of Array.isArray(items) ? items : []) {
    const value = String(item?.[field] || '').trim();
    if (value && !parts.includes(value)) parts.push(value);
  }
  return parts.join(' ');
}

function collectFrameworkBullets(items = [], fields = ['deficiencies', 'evidenceRequired'], limit = 10) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    for (const field of fields) {
      const values = Array.isArray(item?.[field]) ? item[field] : [];
      for (const value of values) {
        const clean = String(value || '').trim();
        if (clean && !out.includes(clean)) out.push(clean);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function buildPdfSectionsFromDecisionFramework(profile = {}, analysis = {}) {
  const df = Array.isArray(analysis.decisionFramework) ? analysis.decisionFramework : [];
  if (!df.length) return analysis;

  const visa = String(profile.displayName || '').toLowerCase();
  const stream = String(profile.stream || '').toLowerCase();
  const next = { ...analysis };

  const setParagraph = (key, items, fallbackFields = ['professionalView', 'assessment']) => {
    if (String(next[key] || '').trim()) return;
    const parts = [];
    for (const field of fallbackFields) {
      const joined = joinFrameworkNarrative(items, field);
      if (joined) parts.push(joined);
    }
    if (parts.length) next[key] = parts.join(' ').trim();
  };

  const setBullets = (key, items, preferredFields = ['deficiencies', 'evidenceRequired']) => {
    if (Array.isArray(next[key]) && next[key].length) return;
    const bullets = collectFrameworkBullets(items, preferredFields, 10);
    if (bullets.length) next[key] = bullets;
  };

  if (visa.includes('866') || stream.includes('protection') || /refugee|humanitarian/.test(stream)) {
    const claim = getFrameworkAssessments(df, ['forward-looking risk', 'serious harm', '^application validity', '^identity']);
    const convention = getFrameworkAssessments(df, ['convention ground', 'nexus']);
    const complementary = getFrameworkAssessments(df, ['complementary protection']);
    const identityCred = getFrameworkAssessments(df, ['identity', 'credibility', 'consistency']);
    const country = getFrameworkAssessments(df, ['forward-looking risk', 'state protection', 'internal relocation']);
    const evidence = getFrameworkAssessments(df, ['evidence sufficiency', 'lodgement timing', 'country']);

    setParagraph('protectionClaimBasis', claim, ['assessment', 'professionalView']);
    setParagraph('conventionGroundAssessment', convention, ['assessment', 'professionalView']);
    setParagraph('complementaryProtectionAssessment', complementary, ['assessment', 'professionalView']);
    setParagraph('identityCredibilityAssessment', identityCred, ['assessment', 'professionalView']);
    setParagraph('countryRiskAssessment', [...country, ...evidence], ['assessment', 'professionalView']);
    setBullets('protectionEvidenceGaps', [...convention, ...complementary, ...identityCred, ...country, ...evidence], ['deficiencies', 'evidenceRequired']);
  }

  if (stream.includes('partner') || /partner|spouse|prospective marriage/.test(visa)) {
    const relationship = getFrameworkAssessments(df, ['core relationship', 'primary eligibility', 'credibility', 'consistency', 'evidence sufficiency']);
    const sponsor = getFrameworkAssessments(df, ['sponsor', 'proposer']);
    const threshold = getFrameworkAssessments(df, ['threshold statutory', 'adverse factors', 'refusal exposure']);

    setParagraph('relationshipAssessment', [...relationship, ...sponsor], ['assessment', 'professionalView']);
    setParagraph('fourLimbsAssessment', relationship, ['assessment', 'professionalView']);
    setBullets('relationshipRisks', [...relationship, ...sponsor, ...threshold], ['deficiencies', 'evidenceRequired']);
  }

  if (stream.includes('parent')) {
    const items = getFrameworkAssessments(df, ['primary eligibility', 'core family', 'sponsor', 'threshold', 'evidence']);
    setParagraph('parentAssessment', items, ['assessment', 'professionalView']);
    setBullets('parentRisks', items, ['deficiencies', 'evidenceRequired']);
  }

  if (stream.includes('child')) {
    const items = getFrameworkAssessments(df, ['primary eligibility', 'core family', 'custody', 'dependency', 'evidence']);
    setParagraph('childAssessment', items, ['assessment', 'professionalView']);
    setBullets('childRisks', items, ['deficiencies', 'evidenceRequired']);
  }

  if (stream.includes('relative')) {
    const items = getFrameworkAssessments(df, ['primary eligibility', 'dependency', 'sponsor', 'threshold', 'evidence']);
    setParagraph('relativeAssessment', items, ['assessment', 'professionalView']);
    setBullets('relativeRisks', items, ['deficiencies', 'evidenceRequired']);
  }

  if (stream.includes('carer')) {
    const items = getFrameworkAssessments(df, ['primary eligibility', 'care', 'medical', 'sponsor', 'threshold', 'evidence']);
    setParagraph('carerNeedAssessment', items, ['assessment', 'professionalView']);
    setBullets('carerRisks', items, ['deficiencies', 'evidenceRequired']);
  }

  if (visa.includes('482') || visa.includes('186') || visa.includes('494') || visa.includes('187') || stream.includes('employer')) {
    const sponsor = getFrameworkAssessments(df, ['sponsor', 'nomination']);
    const occupation = getFrameworkAssessments(df, ['occupation', 'skills', 'employment background']);
    const readiness = getFrameworkAssessments(df, ['salary', 'english', 'licensing', 'lodgement readiness', 'threshold']);

    setParagraph('sponsorshipAssessment', sponsor, ['assessment', 'professionalView']);
    setParagraph('occupationAlignmentAssessment', occupation, ['assessment', 'professionalView']);
    setParagraph('ensPathwayAssessment', readiness, ['assessment', 'professionalView']);
    setParagraph('regionalEmployerAssessment', sponsor, ['assessment', 'professionalView']);
    setParagraph('regionalPositionAssessment', [...occupation, ...readiness], ['assessment', 'professionalView']);
    setBullets('nominationRisks', [...sponsor, ...occupation, ...readiness], ['deficiencies', 'evidenceRequired']);
    setBullets('thresholdIssues', readiness, ['deficiencies', 'evidenceRequired']);
    setBullets('regionalRisks', [...sponsor, ...occupation, ...readiness], ['deficiencies', 'evidenceRequired']);
    setBullets('legacyRisks', [...sponsor, ...occupation, ...readiness], ['deficiencies', 'evidenceRequired']);
  }

  if (visa.includes('189') || visa.includes('190') || visa.includes('491') || visa.includes('191') || visa.includes('489') || visa.includes('887') || stream.includes('skilled')) {
    const points = getFrameworkAssessments(df, ['points', 'threshold']);
    const invitation = getFrameworkAssessments(df, ['invitation', 'nomination', 'regional pathway']);
    const regional = getFrameworkAssessments(df, ['regional', 'residence']);
    const readiness = getFrameworkAssessments(df, ['evidence sufficiency', 'lodgement readiness']);

    setParagraph('pointsAssessment', points, ['assessment', 'professionalView']);
    setParagraph('invitationCompetitiveness', invitation, ['assessment', 'professionalView']);
    setParagraph('stateNominationAssessment', invitation, ['assessment', 'professionalView']);
    setParagraph('regionalPathwayAssessment', [...invitation, ...regional], ['assessment', 'professionalView']);
    setParagraph('regionalResidenceAssessment', regional, ['assessment', 'professionalView']);
    setBullets('invitationRisks', [...points, ...invitation, ...readiness], ['deficiencies', 'evidenceRequired']);
    setBullets('regionalRisks', [...regional, ...readiness], ['deficiencies', 'evidenceRequired']);
    setBullets('thresholdIssues', [...points, ...readiness], ['deficiencies', 'evidenceRequired']);
    setBullets('legacyRisks', [...regional, ...readiness], ['deficiencies', 'evidenceRequired']);
  }

  if (visa.includes('500') || stream.includes('student')) {
    const genuine = getFrameworkAssessments(df, ['genuine student']);
    const study = getFrameworkAssessments(df, ['course logic', 'progression', 'financial capacity', 'english readiness']);
    const credibility = getFrameworkAssessments(df, ['immigration history', 'credibility', 'lodgement readiness']);

    setParagraph('genuineStudentAssessment', [...genuine, ...credibility], ['assessment', 'professionalView']);
    setParagraph('studyPlanAssessment', study, ['assessment', 'professionalView']);
    setBullets('genuineStudentRisks', [...genuine, ...study, ...credibility], ['deficiencies', 'evidenceRequired']);
  }

  if (visa.includes('485') || visa.includes('476') || stream.includes('graduate')) {
    const graduate = getFrameworkAssessments(df, ['qualification completion', 'study', 'recognition']);
    const streamFit = getFrameworkAssessments(df, ['stream', 'pathway fit', 'timing compliance', 'english', 'insurance', 'police']);
    const readiness = getFrameworkAssessments(df, ['evidence sufficiency', 'lodgement readiness']);

    setParagraph('graduateAssessment', graduate, ['assessment', 'professionalView']);
    setParagraph('graduateStreamAssessment', [...streamFit, ...readiness], ['assessment', 'professionalView']);
    setBullets('timingRisks', [...streamFit, ...readiness], ['deficiencies', 'evidenceRequired']);
  }

  if (stream.includes('visitor') || stream.includes('working holiday') || /\b600\b|\b601\b|\b651\b|\b417\b|\b462\b/.test(visa)) {
    const temp = getFrameworkAssessments(df, ['temporary purpose', 'temporary entrant', 'funding', 'home country ties', 'travel history', 'lodgement readiness']);
    setParagraph('temporaryEntrantAssessment', temp, ['assessment', 'professionalView']);
    setBullets('temporaryEntrantRisks', temp, ['deficiencies', 'evidenceRequired']);
  }

  if (stream.includes('temporary activity') || /\b407\b|\b408\b/.test(visa)) {
    const training = getFrameworkAssessments(df, ['training plan', 'core pathway', 'temporary activity', 'temporary purpose']);
    const activity = getFrameworkAssessments(df, ['temporary activity', 'sponsor', 'support', 'evidence', 'threshold']);
    setParagraph('trainingPlanAssessment', training, ['assessment', 'professionalView']);
    setParagraph('temporaryActivityAssessment', activity, ['assessment', 'professionalView']);
    setBullets('trainingRisks', training, ['deficiencies', 'evidenceRequired']);
    setBullets('temporaryActivityRisks', activity, ['deficiencies', 'evidenceRequired']);
  }

  if (stream.includes('business') || /\b188\b|\b888\b/.test(visa)) {
    const items = getFrameworkAssessments(df, ['business', 'investment', 'nomination', 'funds', 'source', 'program', 'lodgement readiness']);
    setParagraph('businessBackgroundAssessment', items, ['assessment', 'professionalView']);
    setBullets('businessRisks', items, ['deficiencies', 'evidenceRequired']);
  }

  if (stream.includes('bridging') || stream.includes('status')) {
    const items = getFrameworkAssessments(df, ['current status', 'dependency', 'conditions', 'travel', 'work', 'practical utility', 'readiness']);
    setParagraph('statusVisaAssessment', items, ['assessment', 'professionalView']);
    setBullets('statusVisaRisks', items, ['deficiencies', 'evidenceRequired']);
  }

  if (stream.includes('citizenship') || visa.includes('citizenship')) {
    const items = getFrameworkAssessments(df, ['residence requirement', 'permanent residence timing', 'identity', 'character position', 'application readiness']);
    setParagraph('residenceAssessment', items, ['assessment', 'professionalView']);
    setBullets('timingRisks', items, ['deficiencies', 'evidenceRequired']);
  }

  return next;
}

function normaliseDecisionFramework(list, submission = {}, profile = {}) {
  const source = Array.isArray(list) ? list : [];
  const cleaned = source.map(item => {
    if (!item || typeof item !== 'object') return null;
    const criterion = String(item.criterion || item.title || '').trim();
    if (!criterion) return null;
    const availableFacts = normaliseStringArray(item.availableFacts || item.facts || [], 8);
    const deficiencies = normaliseStringArray(item.deficiencies || item.risks || [], 8);
    const evidenceRequired = normaliseStringArray(item.evidenceRequired || item.documents || [], 8);
    return {
      criterion,
      legalTest: String(item.legalTest || item.test || '').trim(),
      availableFacts: availableFacts.length ? availableFacts : ['No clear supporting facts were extracted from the current material.'],
      assessment: String(item.assessment || '').trim(),
      riskLevel: String(item.riskLevel || item.risk || 'Requires review').trim(),
      deficiencies: deficiencies.length ? deficiencies : ['No specific deficiency was identified in structured form.'],
      evidenceRequired: evidenceRequired.length ? evidenceRequired : ['Further evidence should be gathered before lodgement.'],
      professionalView: String(item.professionalView || item.view || '').trim(),
    };
  }).filter(Boolean).slice(0, 10);

  return cleaned.length ? cleaned : buildFallbackDecisionFramework(submission, profile);
}

function stringifyConcern(item) {
  if (!item) return '';
  if (typeof item === 'string') return item.trim();
  const issue = String(item.issue || '').trim();
  const impact = String(item.impact || '').trim();
  const requiredAction = String(item.requiredAction || '').trim();
  return [issue, impact && `Impact: ${impact}`, requiredAction && `Action required: ${requiredAction}`].filter(Boolean).join(' — ');
}

function normaliseStringArray(list, limit = 14) {
  if (!Array.isArray(list)) return [];
  return list.map(item => String(item || '').trim()).filter(Boolean).slice(0, limit);
}

function buildDynamicDocumentChecklist(analysis = {}, submission = {}, profile = {}) {
  const existing = normaliseStringArray(analysis.documentChecklist || [], 20);
  const base = normaliseStringArray(profile.checklist || [], 10);
  const facts = submission.answers || [];
  const textBlob = facts.map(item => `${item.question} ${item.answer}`).join(' ').toLowerCase();
  const additions = [];

  if (textBlob.includes('english') || textBlob.includes('pte') || textBlob.includes('ielts')) additions.push('English language evidence');

  if (['Employer Sponsored', 'Employer Sponsored Permanent', 'Regional Employer Sponsored', 'Regional Sponsored Migration (Legacy)'].includes(String(profile.stream || '')) && (textBlob.includes('experience') || textBlob.includes('employment') || textBlob.includes('work'))) {
    additions.push('Detailed employment references, contracts, and remuneration evidence');
  }

  if (String(profile.stream || '').includes('Partner') || String(profile.stream || '').includes('Parent') || String(profile.stream || '').includes('Child') || String(profile.stream || '').includes('Relative') || String(profile.stream || '').includes('Carer')) {
    if (textBlob.includes('married') || textBlob.includes('partner') || textBlob.includes('spouse') || textBlob.includes('relationship')) additions.push('Relationship evidence and civil status documents');
  }

  if ((textBlob.includes('sponsor') || textBlob.includes('nomination')) && String(profile.stream || '').toLowerCase().includes('sponsor')) additions.push('Sponsor and nomination supporting documents');

  return Array.from(new Set([...existing, ...base, ...additions])).slice(0, 18);
}



function safeSnippet(value, maxLen = 2400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function stripHtmlTags(value) {
  return String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
}

function flattenJsonToText(value, prefix = '') {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return `${prefix} ${String(value)}`.trim();
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => flattenJsonToText(item, `${prefix} ${index + 1}`)).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => flattenJsonToText(item, `${prefix} ${key}`)).filter(Boolean).join('\n');
  }
  return '';
}

function listFilesRecursiveSync(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

async function readKnowledgebaseFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.docx') {
    if (!mammoth) return '';
    const result = await mammoth.extractRawText({ path: filePath });
    return String(result?.value || '').trim();
  }
  const raw = await fsp.readFile(filePath, 'utf8').catch(() => '');
  if (!raw) return '';
  if (ext === '.html' || ext === '.htm') return stripHtmlTags(raw);
  if (ext === '.json') {
    try { return flattenJsonToText(JSON.parse(raw)); } catch (_) { return raw; }
  }
  if (ext === '.csv') return raw.replace(/,/g, ' | ');
  return raw;
}

function detectSectionLabel(fileName, chunkText, index) {
  const lines = String(chunkText || '').split(/\n+/).map(line => line.trim()).filter(Boolean);
  const headingLine = lines.find(line => line.length >= 4 && line.length <= 120 && !/[.!?]$/.test(line));
  return headingLine || `Section ${index + 1} (${fileName})`;
}

function chunkKnowledgebaseText(text, meta = {}) {
  const cleaned = String(text || '').replace(/\r/g, '\n').replace(/\t/g, ' ').replace(/\u00a0/g, ' ');
  const paragraphs = cleaned.split(/\n{2,}/).map(item => item.trim()).filter(Boolean);
  const chunks = [];
  let current = [];
  let currentLen = 0;
  let sectionSeed = '';
  const maxChars = 1800;

  const pushChunk = () => {
    if (!current.length) return;
    const body = current.join('\n\n').trim();
    if (!body) return;
    chunks.push({
      ...meta,
      section: detectSectionLabel(meta.fileName || 'Knowledgebase', sectionSeed || body, chunks.length),
      text: body,
    });
    current = [];
    currentLen = 0;
    sectionSeed = '';
  };

  paragraphs.forEach((para) => {
    const likelyHeading = para.length <= 120 && !/[.!?]$/.test(para);
    if (likelyHeading && current.length) pushChunk();
    if (likelyHeading) sectionSeed = para;
    if (currentLen + para.length > maxChars && current.length) pushChunk();
    current.push(para);
    currentLen += para.length;
  });
  pushChunk();

  return chunks.map((chunk, index) => ({ ...chunk, chunkIndex: index }));
}

function extractKnowledgebaseKeywords(profile = {}, submission = {}) {
  const rawTerms = [
    submission.visaType,
    profile.displayName,
    profile.stream,
    profile.category,
    submission.client?.nationality,
    submission.notes,
    ...(profile.promptFocus || []),
    ...((submission.answers || []).flatMap(item => [item.question, item.answer])),
  ].filter(Boolean).join(' ').toLowerCase();

  const tokens = rawTerms.match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
  const stop = new Set(['with','from','that','this','have','will','your','about','their','which','they','them','into','under','after','before','where','while','would','could','there','these','those','being','other','should','because','against','through','application','applicant','client','assessment','position','evidence','review','requires','require','visa','subclass','migration','australia','australian']);
  const boosted = {};
  for (const token of tokens) {
    if (stop.has(token)) continue;
    boosted[token] = (boosted[token] || 0) + 1;
  }

  const visa = String(submission.visaType || '').toLowerCase();
  if (visa.includes('866') || String(profile.stream || '').toLowerCase().includes('protection')) {
    ['protection','refugee','complementary','credibility','relocation','state','jurisdiction','country','harm','persecution','convention','political','religion','nationality','social','group'].forEach(t => boosted[t] = (boosted[t] || 0) + 3);
  }
  if (visa.includes('482') || visa.includes('186') || visa.includes('494') || visa.includes('187')) {
    ['nomination','sponsor','occupation','salary','genuine','tsmit','employer','licensing'].forEach(t => boosted[t] = (boosted[t] || 0) + 3);
  }
  if (visa.includes('500')) {
    ['student','course','genuine','financial','capacity','history','enrolment'].forEach(t => boosted[t] = (boosted[t] || 0) + 3);
  }
  if (visa.includes('485')) {
    ['graduate','study','completion','afp','insurance','stream','timing'].forEach(t => boosted[t] = (boosted[t] || 0) + 3);
  }
  return boosted;
}

function scoreKnowledgebaseChunk(chunk, keywords = {}, profile = {}, submission = {}) {
  const hay = `${chunk.fileName} ${chunk.relativePath} ${chunk.section} ${chunk.text}`.toLowerCase();
  let score = 0;

  for (const [token, weight] of Object.entries(keywords)) {
    if (!token) continue;
    const pattern = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const matches = hay.match(pattern);
    if (matches) score += Math.min(matches.length, 4) * weight;
  }

  const visaTokens = String(submission.visaType || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const token of visaTokens) {
    if (token && hay.includes(token)) score += 6;
  }

  const stream = String(profile.stream || '').toLowerCase();
  if (stream && hay.includes(stream)) score += 5;

  const rel = String(chunk.relativePath || '').toLowerCase();
  if (stream.includes('protection') && /protect|refugee|humanitarian/.test(rel)) score += 8;
  if (stream.includes('student') && /student|genuine/.test(rel)) score += 8;
  if (stream.includes('employer') && /employer|sponsor|482|186|494|187/.test(rel)) score += 8;
  if (stream.includes('partner') || stream.includes('family')) {
    if (/partner|family|parent|child|relative|carer/.test(rel)) score += 8;
  }
  if (stream.includes('citizenship') && /citizen|residence|character/.test(rel)) score += 8;

  const section = String(chunk.section || '').toLowerCase();
  if (/policy|guideline|direction|assessment|criteria|credibility|nomination|genuine|eligibility|jurisdiction/.test(section)) score += 4;

  score += Math.min(String(chunk.text || '').length / 800, 3);

  return score;
}

async function loadKnowledgebaseIndex(force = false) {
  if (!force && KNOWLEDGEBASE_STATE.loadedAt && Array.isArray(KNOWLEDGEBASE_STATE.chunks)) return KNOWLEDGEBASE_STATE;

  const allowed = new Set(['.docx', '.txt', '.md', '.json', '.csv', '.html', '.htm']);
  const files = listFilesRecursiveSync(KNOWLEDGEBASE_DIR).filter(filePath => allowed.has(path.extname(filePath).toLowerCase()));
  const allChunks = [];
  const fileRows = [];

  for (const filePath of files) {
    const relativePath = path.relative(KNOWLEDGEBASE_DIR, filePath) || path.basename(filePath);
    const fileName = path.basename(filePath);
    try {
      const text = await readKnowledgebaseFile(filePath);
      if (!text || !text.trim()) continue;
      const chunks = chunkKnowledgebaseText(text, { filePath, relativePath, fileName });
      allChunks.push(...chunks);
      fileRows.push({ fileName, relativePath, chunkCount: chunks.length, charCount: text.length });
    } catch (error) {
      fileRows.push({ fileName, relativePath, chunkCount: 0, charCount: 0, error: error.message });
    }
  }

  KNOWLEDGEBASE_STATE.loadedAt = nowIso();
  KNOWLEDGEBASE_STATE.files = fileRows;
  KNOWLEDGEBASE_STATE.chunks = allChunks;
  KNOWLEDGEBASE_STATE.error = null;
  return KNOWLEDGEBASE_STATE;
}

async function selectKnowledgebaseContext(submission = {}) {
  const profile = getVisaProfile(submission.visaType);
  const state = await loadKnowledgebaseIndex(false);
  const scope = getKnowledgebaseScope(profile, submission.visaType);
  const scopedChunks = filterKnowledgebaseChunksByScope(state.chunks || [], scope);
  const keywords = extractKnowledgebaseKeywords(profile, submission);
  const scored = scopedChunks.map(chunk => ({ ...chunk, score: scoreKnowledgebaseChunk(chunk, keywords, profile, submission) }))
    .filter(chunk => chunk.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  const perFile = {};
  for (const chunk of scored) {
    const key = chunk.relativePath || chunk.fileName;
    perFile[key] = perFile[key] || 0;
    if (perFile[key] >= 3) continue;
    selected.push(chunk);
    perFile[key] += 1;
    if (selected.length >= 8) break;
  }

  return {
    scope,
    selectedChunks: selected,
    citations: selected.map(chunk => `[KB: ${chunk.fileName} > ${chunk.section}]`),
    promptBlock: selected.length ? selected.map((chunk, index) => `Source ${index + 1}: ${chunk.fileName} | Section: ${chunk.section}\n${safeSnippet(chunk.text, 1600)}`).join('\n\n') : 'No relevant knowledgebase excerpts were retrieved.',
  };
}
function extractAnswerMap(answers = []) {
  const map = {};
  for (const item of answers) {
    const q = String(item?.question || '').trim();
    if (!q) continue;
    map[q] = String(item?.answer || '').trim();
  }
  return map;
}

function pickQuestionAnswerPairs(answerMap = {}, maxItems = 10) {
  return Object.entries(answerMap).slice(0, maxItems).map(([question, answer]) => ({ question, answer }));
}

function extractAssessmentPayload(body = {}) {
  const plan = normalizePlan(body.plan || body.package || body.delivery);
  const client = body.client || {};
  const answers = normalizeAnswers(Array.isArray(body.answers) ? body.answers : body.responses || body.questions || []);
  return {
    visaType: normaliseVisaType(body.visaType || body.subclass || 'Subclass 482'),
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

function normaliseRiskLevel(value = '') {
  const text = String(value || '').toLowerCase();
  if (/high|severe|critical/.test(text)) return 'High';
  if (/low|minimal/.test(text)) return 'Low';
  return 'Moderate';
}

function uniqueStrings(values = [], limit = 12) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const clean = String(value || '').trim();
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function isLikelyBlockerText(value = '') {
  const text = String(value || '').toLowerCase();
  return /bar to application|jurisdictional barrier|not presently satisfied|fatal|cannot be met|ineligible|not met|invalid application|no bar to application/.test(text)
    ? !/no bar to application/.test(text)
    : /bar to application|jurisdictional barrier|not presently satisfied|fatal|cannot be met|ineligible|not met|invalid application/.test(text);
}

function buildEvidenceAndRefusalEngine(profile = {}, analysis = {}, submission = {}) {
  const decisionFramework = Array.isArray(analysis.decisionFramework) ? analysis.decisionFramework : [];
  const deficiencies = uniqueStrings(decisionFramework.flatMap(item => item.deficiencies || []), 16);
  const evidenceRequired = uniqueStrings(decisionFramework.flatMap(item => item.evidenceRequired || []), 18);
  const refusalExposure = uniqueStrings([...(analysis.refusalExposure || []), ...(analysis.refusalScenarios || [])], 16);
  const lowCount = decisionFramework.filter(item => normaliseRiskLevel(item.riskLevel) === 'Low').length;
  const highCount = decisionFramework.filter(item => normaliseRiskLevel(item.riskLevel) === 'High').length;
  const moderateCount = decisionFramework.filter(item => normaliseRiskLevel(item.riskLevel) === 'Moderate').length;

  const blockerItems = [];
  const curableItems = [];
  const refusalRiskEngine = [];

  for (const item of decisionFramework) {
    const criterion = String(item.criterion || '').trim() || 'Unspecified criterion';
    const riskLevel = normaliseRiskLevel(item.riskLevel);
    const issueText = uniqueStrings([...(item.deficiencies || []), ...(item.evidenceRequired || [])], 4).join(' ');
    const blocker = isLikelyBlockerText(`${item.assessment} ${item.professionalView} ${issueText}`);
    const riskLabel = blocker ? 'Fundamental blocker' : (riskLevel === 'High' ? 'Severe refusal exposure' : riskLevel === 'Moderate' ? 'Curable refusal exposure' : 'Manageable exposure');
    const line = `${criterion}: ${riskLabel} — ${String(item.assessment || item.professionalView || 'Further assessment required.').trim()}`;
    if (!refusalRiskEngine.includes(line)) refusalRiskEngine.push(line);

    const itemIssues = uniqueStrings([...(item.deficiencies || []), ...(item.evidenceRequired || [])], 4);
    if (blocker) blockerItems.push(...itemIssues.length ? itemIssues : [criterion]);
    else if (riskLevel !== 'Low') curableItems.push(...itemIssues.length ? itemIssues : [criterion]);
  }

  const evidenceCriticalGaps = uniqueStrings(deficiencies.slice(0, 10), 10);
  const evidenceBlockers = uniqueStrings([...(analysis.evidenceBlockers || []), ...blockerItems], 10);
  const evidenceCurableIssues = uniqueStrings([...(analysis.evidenceCurableIssues || []), ...curableItems, ...evidenceRequired], 12);

  let evidenceScore = 78;
  evidenceScore -= (highCount * 18);
  evidenceScore -= (moderateCount * 8);
  evidenceScore -= Math.min(evidenceCriticalGaps.length * 2, 14);
  evidenceScore += Math.min(lowCount * 2, 8);
  evidenceScore = Math.max(18, Math.min(92, evidenceScore));

  const evidenceBand = evidenceScore >= 78 ? 'strong' : evidenceScore >= 58 ? 'mixed but curable' : evidenceScore >= 40 ? 'currently weak' : 'presently inadequate';
  const blockerSentence = evidenceBlockers.length
    ? ` The present record also shows potential threshold blockers that should be resolved before lodgement, including ${evidenceBlockers.slice(0, 3).join('; ')}.`
    : '';

  const evidenceAssessment = analysis.evidenceAssessment || `The current evidentiary position for ${profile.displayName || submission.visaType || 'this matter'} is ${evidenceBand}. The file presently contains ${lowCount} lower-risk criterion findings, ${moderateCount} criterion findings requiring strengthening, and ${highCount} higher-risk criterion findings. The dominant issues are ${evidenceCriticalGaps.slice(0, 3).join('; ') || 'the need for fuller supporting evidence and a clearer factual record'}. The matter should be treated as ${evidenceScore >= 58 ? 'potentially lodgable after targeted evidence work' : 'not ready for lodgement until the record is materially strengthened'}.${blockerSentence}`;

  const refusalRiskSummary = analysis.refusalRiskSummary || `If lodged now, the main refusal exposure arises from ${refusalExposure.slice(0, 3).join('; ') || 'the presently under-developed evidentiary record'}. ${evidenceBlockers.length ? 'At least one issue has the character of a threshold or structural blocker rather than a mere evidentiary gap.' : 'Most current weaknesses appear curable through stronger evidence, clearer narrative presentation, and tighter criterion-by-criterion support.'}`;

  const mergedRefusalExposure = uniqueStrings([...(analysis.refusalExposure || []), ...refusalExposure, ...refusalRiskEngine], 16);
  const mergedMissingInformation = uniqueStrings([...(analysis.missingInformation || []), ...evidenceRequired, ...evidenceCriticalGaps], 18);
  const mergedRecommendedNextSteps = uniqueStrings([
    ...(analysis.recommendedNextSteps || []),
    ...evidenceRequired.map(item => `Obtain and organise: ${item}`),
    ...(evidenceBlockers.length ? ['Resolve identified threshold or blocker issues before any lodgement decision.'] : []),
    ...(moderateCount || highCount ? ['Conduct a final refusal-risk review against each criterion before lodgement.'] : [])
  ], 18);

  return {
    evidenceAssessment,
    refusalRiskSummary,
    evidenceCriticalGaps,
    evidenceCurableIssues,
    evidenceBlockers,
    refusalRiskEngine: uniqueStrings([...(analysis.refusalRiskEngine || []), ...refusalRiskEngine], 18),
    refusalExposure: mergedRefusalExposure,
    missingInformation: mergedMissingInformation,
    recommendedNextSteps: mergedRecommendedNextSteps,
  };
}

function normaliseAnalysisShape(ai = {}, submission = {}) {
  const profile = getVisaProfile(submission.visaType);
  const fallbackSummary = `Preliminary ${submission.visaType || 'visa'} assessment prepared for ${submission.client?.fullName || 'the client'}.`;
  const fallback = {
    caseCaption: `${profile.displayName || submission.visaType || 'Migration'} Preliminary Assessment`,
    eligibilityOutcome: 'Needs professional review',
    outcomeRiskLevel: 'Moderate',
    applicationReadiness: 'Further review required before lodgement',
    outcomeRationale: fallbackSummary,
    professionalOpinion: fallbackSummary,
    overallAssessment: fallbackSummary,
    executiveSummary: fallbackSummary,
    legalStyleSummary: fallbackSummary,
    detailedAssessment: fallbackSummary,
    decisionFramework: [],
    refusalExposure: [],
    sponsorshipAssessment: '',
    pointsAssessment: '',
    invitationCompetitiveness: '',
    stateNominationAssessment: '',
    regionalPathwayAssessment: '',
    regionalResidenceAssessment: '',
    occupationAlignmentAssessment: '',
    ensPathwayAssessment: '',
    legacyEligibilityAssessment: '',
    regionalEmployerAssessment: '',
    regionalPositionAssessment: '',
    relationshipAssessment: '',
    fourLimbsAssessment: '',
    parentAssessment: '',
    childAssessment: '',
    relativeAssessment: '',
    carerNeedAssessment: '',
    protectionClaimBasis: '',
    conventionGroundAssessment: '',
    complementaryProtectionAssessment: '',
    identityCredibilityAssessment: '',
    countryRiskAssessment: '',
    genuineStudentAssessment: '',
    studyPlanAssessment: '',
    graduateAssessment: '',
    graduateStreamAssessment: '',
    temporaryEntrantAssessment: '',
    trainingPlanAssessment: '',
    temporaryActivityAssessment: '',
    businessBackgroundAssessment: '',
    statusVisaAssessment: '',
    residenceAssessment: '',
    evidenceAssessment: '',
    refusalRiskSummary: '',
    evidenceCriticalGaps: [],
    evidenceCurableIssues: [],
    evidenceBlockers: [],
    refusalRiskEngine: [],
    strengths: [],
    concerns: [],
    refusalScenarios: [],
    strategyAdvice: [],
    nominationRisks: [],
    invitationRisks: [],
    regionalRisks: [],
    legacyRisks: [],
    relationshipRisks: [],
    parentRisks: [],
    childRisks: [],
    relativeRisks: [],
    carerRisks: [],
    protectionEvidenceGaps: [],
    genuineStudentRisks: [],
    temporaryEntrantRisks: [],
    trainingRisks: [],
    temporaryActivityRisks: [],
    businessRisks: [],
    statusVisaRisks: [],
    thresholdIssues: [],
    timingRisks: [],
    missingInformation: [],
    recommendedNextSteps: [],
    documentChecklist: [],
    factualAssumptions: [],
    disclaimer:
      'This letter is a preliminary assessment only. Final visa eligibility depends on documentary evidence, sponsorship and nomination outcomes, health and character checks, and departmental assessment at the time of decision.',
    legalMetrics: {},
    knowledgebaseUsed: [],
    knowledgebaseCitations: [],
    ratings: {
      sponsorReadiness: 'Unknown',
      occupationFit: 'Unknown',
      experienceFit: 'Unknown',
      englishPosition: 'Unknown',
      complianceRisk: 'Unknown',
      overallReadiness: 'Unknown',
    },
  };

  const merged = {
    ...fallback,
    ...ai,
    ratings: { ...fallback.ratings, ...(ai.ratings || {}) },
    legalMetrics: (ai && typeof ai.legalMetrics === 'object' && !Array.isArray(ai.legalMetrics)) ? ai.legalMetrics : {},
    knowledgebaseUsed: Array.isArray(ai?.knowledgebaseUsed) ? ai.knowledgebaseUsed : [],
    knowledgebaseCitations: Array.isArray(ai?.knowledgebaseCitations) ? ai.knowledgebaseCitations : [],
  };

  [
    'strengths', 'missingInformation', 'recommendedNextSteps', 'documentChecklist', 'factualAssumptions', 'refusalExposure',
    'evidenceCriticalGaps', 'evidenceCurableIssues', 'evidenceBlockers', 'refusalRiskEngine',
    'refusalScenarios', 'strategyAdvice', 'nominationRisks', 'invitationRisks', 'regionalRisks', 'legacyRisks', 'relationshipRisks',
    'parentRisks', 'childRisks', 'relativeRisks', 'carerRisks', 'protectionEvidenceGaps', 'genuineStudentRisks', 'temporaryEntrantRisks',
    'trainingRisks', 'temporaryActivityRisks', 'businessRisks', 'statusVisaRisks', 'thresholdIssues', 'timingRisks'
  ].forEach(key => {
    merged[key] = normaliseStringArray(merged[key], 14);
  });

  merged.concerns = Array.isArray(merged.concerns) ? merged.concerns.map(stringifyConcern).filter(Boolean).slice(0, 14) : [];
  merged.knowledgebaseUsed = Array.isArray(merged.knowledgebaseUsed) ? merged.knowledgebaseUsed.slice(0, 12) : [];
  merged.knowledgebaseCitations = Array.isArray(merged.knowledgebaseCitations) ? merged.knowledgebaseCitations.slice(0, 16).map(item => String(item || '').trim()).filter(Boolean) : [];
  merged.legalMetrics = Object.fromEntries(
    Object.entries(merged.legalMetrics || {}).map(([key, value]) => [String(key).trim(), String(value || '').trim()]).filter(([key, value]) => key && value)
  );
  merged.decisionFramework = normaliseDecisionFramework(merged.decisionFramework, submission, profile);
  merged.legalMetrics = buildLegalMetricsFromDecisionFramework(profile, merged);
  Object.assign(merged, buildPdfSectionsFromDecisionFramework(profile, merged));
  Object.assign(merged, buildEvidenceAndRefusalEngine(profile, merged, submission));

  [
    'caseCaption', 'eligibilityOutcome', 'outcomeRiskLevel', 'applicationReadiness', 'outcomeRationale',
    'professionalOpinion', 'overallAssessment', 'executiveSummary', 'legalStyleSummary', 'detailedAssessment',
    'sponsorshipAssessment', 'pointsAssessment', 'invitationCompetitiveness', 'stateNominationAssessment', 'regionalPathwayAssessment',
    'regionalResidenceAssessment', 'occupationAlignmentAssessment', 'ensPathwayAssessment', 'legacyEligibilityAssessment', 'regionalEmployerAssessment',
    'regionalPositionAssessment', 'relationshipAssessment', 'fourLimbsAssessment', 'parentAssessment', 'childAssessment', 'relativeAssessment',
    'carerNeedAssessment', 'protectionClaimBasis', 'conventionGroundAssessment', 'complementaryProtectionAssessment', 'identityCredibilityAssessment', 'countryRiskAssessment', 'genuineStudentAssessment',
    'studyPlanAssessment', 'graduateAssessment', 'graduateStreamAssessment', 'temporaryEntrantAssessment', 'trainingPlanAssessment', 'temporaryActivityAssessment',
    'businessBackgroundAssessment', 'statusVisaAssessment', 'residenceAssessment', 'evidenceAssessment', 'refusalRiskSummary', 'disclaimer'
  ].forEach(key => {
    merged[key] = String(merged[key] || fallback[key] || '').trim() || String(fallback[key] || '').trim();
  });

  merged.documentChecklist = buildDynamicDocumentChecklist(merged, submission, profile);
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
    return { status: 'completed', model: 'fallback-no-openai-key', helperModel: OPENAI_MODEL_HELPER, summary: analysis.executiveSummary, analysis, generatedAt: nowIso() };
  }

  const visaType = submission.visaType || 'Visa';
  const profile = getVisaProfile(visaType);
  const visaFocus = Array.isArray(profile.promptFocus) ? profile.promptFocus : [];
  const decisionCriteria = getDecisionCriteria(profile, visaType);
  const kbContext = await selectKnowledgebaseContext(submission);

  const systemPrompt = [
    'You are a senior Australian Registered Migration Agent providing formal written migration advice in a Department-style decision reasoning format.',
    'This is a professional opinion for a paying client, not a summary.',
    'Write with authority, precision, and professional ownership, as if the advice will be issued under an Australian migration practice letterhead.',
    'Do not sound like AI. Do not be generic. Do not merely describe. You must advise.',
    'You must state a clear professional view on substantive eligibility, current readiness for lodgement, key refusal exposure, and the practical strategy that should be followed.',
    'Analyse the matter criterion by criterion, using only the facts available from the answers and the supplied knowledgebase extracts.',
    'For each criterion, identify the legal test, available facts, assessment, deficiencies, evidence required, and your professional view.',
    'Do not guarantee visa outcomes. Do not fabricate facts, legislation, policy settings, or citations not supported by the supplied information.',
    'If a critical matter is unconfirmed, treat it as a risk and say so clearly.',
    'Always populate legalMetrics with visa-specific legal assessment metrics relevant to the selected visa subclass rather than generic sponsor/occupation labels unless those metrics actually apply.',
    'When knowledgebase excerpts are provided, use them as primary internal policy guidance and cite them inline in outcomeRationale, professionalOpinion, detailedAssessment, and strategyAdvice using the exact format [KB: file > section].',
    'Do not invent knowledgebase citations. Only cite a knowledgebase section if it was included in the supplied excerpts.',
    'Return STRICT JSON only with this exact top-level shape:',
    '{',
    '  "caseCaption": string,',
    '  "eligibilityOutcome": string,',
    '  "outcomeRiskLevel": "Low" | "Moderate" | "High",',
    '  "applicationReadiness": string,',
    '  "outcomeRationale": string,',
    '  "professionalOpinion": string,',
    '  "overallAssessment": string,',
    '  "executiveSummary": string,',
    '  "legalStyleSummary": string,',
    '  "detailedAssessment": string,',
    '  "decisionFramework": [{',
    '    "criterion": string,',
    '    "legalTest": string,',
    '    "availableFacts": string[],',
    '    "assessment": string,',
    '    "riskLevel": string,',
    '    "deficiencies": string[],',
    '    "evidenceRequired": string[],',
    '    "professionalView": string',
    '  }],',
    '  "refusalExposure": string[],',
    '  "legalMetrics": { [metricKey: string]: string },',
    '  "strengths": string[],',
    '  "concerns": [{ "issue": string, "impact": string, "requiredAction": string }],',
    '  "refusalScenarios": string[],',
    '  "strategyAdvice": string[],',
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
    `Matter: ${visaType} preliminary assessment`,
    `Service plan: ${submission.plan?.label || ''}`,
    `Client name: ${submission.client?.fullName || ''}`,
    `Client nationality: ${submission.client?.nationality || ''}`,
    `Client DOB: ${submission.client?.dob || ''}`,
    '',
    'Instructions:',
    '- Assess this matter like a real Australian migration agent advising a paying client.',
    '- Give a clear outcome and risk level.',
    '- State clearly whether the client should lodge now or not, and why.',
    '- Identify realistic refusal scenarios and explain why each one matters.',
    '- Distinguish evidence problems that are curable from threshold problems that operate like blockers.',
    '- Produce an evidenceAssessment and refusalRiskSummary that read like practical migration-agent advice, not generic commentary.',
    '- Distinguish between curable evidence issues and fundamental eligibility blockers.',
    '- Give strategic advice that reduces refusal exposure and improves lodgement quality.',
    '- Use authoritative advisory language, not generic descriptive wording.',
    '- Include a distinct professional opinion written as formal advice from a senior migration agent.',
    '- Populate legalMetrics with subclass-appropriate legal assessment labels and findings.',
    '- Write detailedAssessment as numbered legal subsections using the exact format "1. Heading: text" then "2. Heading: text" and so on.',
    '- Populate decisionFramework using the exact criteria supplied below, unless a criterion is clearly inapplicable on the facts.',
    '- Every decisionFramework item must contain criterion, legalTest, availableFacts, assessment, riskLevel, deficiencies, evidenceRequired, and professionalView.',
    ...visaFocus,
    '',
    'Required criteria to assess:',
    ...decisionCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    '',
    'Knowledgebase policy excerpts:',
    kbContext.promptBlock,
    '',
    'Important knowledgebase citation rule:',
    'Where a knowledgebase excerpt materially informs the reasoning, cite it inline using the exact citation format [KB: file > section].',
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
      model: OPENAI_MODEL_ANALYSIS,
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
  } catch (e) {
    console.error('[openai-raw-content]', content);
    throw new Error('Failed to parse OpenAI JSON response.');
  }

  const analysis = normaliseAnalysisShape(parsed, submission);
  const allowedCitations = new Set(kbContext.citations);
  analysis.knowledgebaseUsed = kbContext.selectedChunks.map(chunk => ({
    file: chunk.fileName,
    relativePath: chunk.relativePath,
    section: chunk.section,
    score: Number(chunk.score || 0),
  }));
  analysis.knowledgebaseCitations = (Array.isArray(parsed.knowledgebaseCitations) ? parsed.knowledgebaseCitations : [])
    .map(item => String(item || '').trim())
    .filter(item => allowedCitations.has(item));
  if (!analysis.knowledgebaseCitations.length) analysis.knowledgebaseCitations = kbContext.citations;

  return {
    status: 'completed',
    model: OPENAI_MODEL_ANALYSIS,
    helperModel: OPENAI_MODEL_HELPER,
    summary: analysis.executiveSummary,
    analysis,
    generatedAt: nowIso(),
    knowledgebaseSummary: {
      retrievedChunkCount: kbContext.selectedChunks.length,
      citations: kbContext.citations,
      criteria: decisionCriteria,
    },
  };
}


function drawFirstPageHeader(doc) {
  const letterheadPath = path.join(PUBLIC_DIR, 'letterhead.png');
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const startX = doc.page.margins.left;
  const startY = 24;

  doc.save();

  if (fs.existsSync(letterheadPath)) {
    try {
      const image = doc.openImage(letterheadPath);
      const scaledHeight = image.height * (contentWidth / image.width);
      doc.image(letterheadPath, startX, startY, { width: contentWidth });
      doc.y = startY + scaledHeight + 20;
    } catch (_) {
      doc.y = 72;
    }
  } else {
    doc.y = 72;
  }

  doc.restore();
  doc.fillColor('#172033');
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

function parseNumberedAssessmentBlocks(text) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return [];

  const colonStyleMatches = [...raw.replace(/\n+/g, ' ').matchAll(/(?:^|\s)(\d+)\.\s+([^:]{2,120}):\s*([\s\S]*?)(?=(?:\s\d+\.\s+[^:]{2,120}:)|$)/g)];
  if (colonStyleMatches.length) {
    return colonStyleMatches.map(match => ({
      number: String(match[1] || '').trim(),
      heading: String(match[2] || '').trim(),
      body: String(match[3] || '').trim(),
    })).filter(item => item.number && item.heading && item.body);
  }

  const lineStyleSegments = raw.split(/\n(?=\d+\.?\s+)/).map(item => item.trim()).filter(Boolean);
  const lineBlocks = lineStyleSegments.map(segment => {
    const match = segment.match(/^(\d+)\.?\s+([^\n:]{2,120})(?::|\n)([\s\S]*)$/);
    if (!match) return null;
    return {
      number: String(match[1] || '').trim(),
      heading: String(match[2] || '').trim(),
      body: String(match[3] || '').replace(/\s+/g, ' ').trim(),
    };
  }).filter(Boolean);

  if (lineBlocks.length) return lineBlocks;

  return [];
}

function addLegalSubsectionBlocks(doc, text, fallbackText = 'Detailed assessment was not generated.') {
  const blocks = parseNumberedAssessmentBlocks(text);
  if (!blocks.length) {
    addParagraph(doc, fallbackText);
    return;
  }

  blocks.forEach((block, index) => {
    ensureSpace(doc, 675);

    const boxX = 40;
    const boxY = doc.y;
    const boxWidth = 515;
    const numberBoxWidth = 34;
    const headerHeight = 26;
    const bodyPadding = 12;
    const bodyTextWidth = boxWidth - bodyPadding * 2;

    const bodyHeight = doc.heightOfString(block.body, {
      width: bodyTextWidth,
      lineGap: 3,
      align: 'left',
    });

    const boxHeight = headerHeight + bodyPadding + bodyHeight + bodyPadding;

    if (boxY + boxHeight > 760) {
      doc.addPage();
      drawLaterPageHeader(doc);
    }

    const currentY = doc.y;

    doc.save();
    doc.roundedRect(boxX, currentY, boxWidth, boxHeight, 8).fillAndStroke('#f8fafc', '#d9e2ef');
    doc.roundedRect(boxX, currentY, numberBoxWidth, headerHeight, 8).fill('#0f2747');
    doc.rect(boxX + numberBoxWidth - 8, currentY, 8, headerHeight).fill('#0f2747');
    doc.rect(boxX + numberBoxWidth, currentY, boxWidth - numberBoxWidth, headerHeight).fill('#eef4fb');
    doc.moveTo(boxX, currentY + headerHeight).lineTo(boxX + boxWidth, currentY + headerHeight).strokeColor('#d9e2ef').lineWidth(1).stroke();
    doc.restore();

    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11)
      .text(block.number, boxX, currentY + 7, { width: numberBoxWidth, align: 'center' });

    doc.fillColor('#0f2747').font('Helvetica-Bold').fontSize(10.8)
      .text(block.heading, boxX + numberBoxWidth + 12, currentY + 7, { width: boxWidth - numberBoxWidth - 24, align: 'left' });

    doc.fillColor('#172033').font('Helvetica').fontSize(10.4)
      .text(block.body, boxX + bodyPadding, currentY + headerHeight + bodyPadding - 1, {
        width: bodyTextWidth,
        lineGap: 3,
        align: 'left',
      });

    doc.y = currentY + boxHeight + (index === blocks.length - 1 ? 8 : 10);
  });
}


function addDecisionFrameworkSection(doc, framework = []) {
  const rows = Array.isArray(framework) ? framework : [];
  if (!rows.length) {
    addParagraph(doc, 'No criterion-by-criterion framework was generated.');
    return;
  }

  rows.forEach((item, index) => {
    ensureSpace(doc, 610);
    const boxX = 40;
    const boxWidth = 515;
    const contentWidth = boxWidth - 24;
    const title = `${index + 1}. ${item.criterion || 'Criterion'}`;
    const legalTest = String(item.legalTest || '').trim() || 'Legal test not stated.';
    const assessment = String(item.assessment || '').trim() || 'Assessment not stated.';
    const professionalView = String(item.professionalView || '').trim() || 'Professional view not stated.';
    const riskLevel = String(item.riskLevel || 'Requires review').trim();
    const factsText = normaliseStringArray(item.availableFacts || [], 8).join('\n• ');
    const deficienciesText = normaliseStringArray(item.deficiencies || [], 8).join('\n• ');
    const evidenceText = normaliseStringArray(item.evidenceRequired || [], 8).join('\n• ');
    const body = [
      `Legal test: ${legalTest}`,
      `Available facts:\n• ${factsText || 'No clear facts identified.'}`,
      `Assessment: ${assessment}`,
      `Risk / deficiency (${riskLevel}):\n• ${deficienciesText || 'No specific deficiency stated.'}`,
      `Evidence required:\n• ${evidenceText || 'Further evidence required.'}`,
      `Professional view: ${professionalView}`,
    ].join('\n\n');

    const bodyHeight = doc.heightOfString(body, { width: contentWidth, lineGap: 3, align: 'left' });
    const boxHeight = 34 + bodyHeight + 18;
    if (doc.y + boxHeight > 760) {
      doc.addPage();
      drawLaterPageHeader(doc);
    }
    const currentY = doc.y;

    doc.save();
    doc.roundedRect(boxX, currentY, boxWidth, boxHeight, 8).fillAndStroke('#ffffff', '#d9e2ef');
    doc.roundedRect(boxX, currentY, boxWidth, 26, 8).fill('#eef4fb');
    doc.rect(boxX, currentY + 18, boxWidth, 8).fill('#eef4fb');
    doc.restore();

    doc.fillColor('#0f2747').font('Helvetica-Bold').fontSize(10.8)
      .text(title, boxX + 12, currentY + 7, { width: 360, align: 'left' });
    doc.fillColor('#0f2747').font('Helvetica-Bold').fontSize(9.8)
      .text(`Risk: ${riskLevel}`, boxX + 380, currentY + 8, { width: 120, align: 'right' });

    doc.fillColor('#172033').font('Helvetica').fontSize(10.2)
      .text(body, boxX + 12, currentY + 34, { width: contentWidth, lineGap: 3, align: 'left' });

    doc.y = currentY + boxHeight + 10;
  });
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

function buildMetricPairs(visaProfile = {}, analysis = {}) {
  const config = visaProfile.legalMetrics || null;
  const metrics = analysis.legalMetrics || {};
  if (config && Array.isArray(config.items) && config.items.length) {
    return config.items.map(item => ({
      label: item.label,
      value: metrics[item.key] || item.fallback || 'Requires review',
    })).filter(item => item.label && item.value);
  }

  return [
    { label: 'Sponsor readiness', value: analysis.ratings?.sponsorReadiness || 'Unknown' },
    { label: 'Occupation fit', value: analysis.ratings?.occupationFit || 'Unknown' },
    { label: 'Experience fit', value: analysis.ratings?.experienceFit || 'Unknown' },
    { label: 'English position', value: analysis.ratings?.englishPosition || 'Unknown' },
    { label: 'Compliance risk', value: analysis.ratings?.complianceRisk || 'Unknown' },
    { label: 'Overall readiness', value: analysis.ratings?.overallReadiness || 'Unknown' },
  ];
}

function addLegalMetricsSection(doc, title, items = []) {
  const list = Array.isArray(items) ? items.filter(item => item && item.label && item.value) : [];
  if (!list.length) return;

  list.forEach(item => {
    ensureSpace(doc, 735);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#172033').text(`${item.label}:`, 40, doc.y, { continued: true });
    doc.font('Helvetica').fontSize(10.5).fillColor('#172033').text(` ${item.value}`, { width: 470, lineGap: 2 });
    doc.moveDown(0.25);
  });
}

async function generateProfessionalPdf(submission) {
  const pdfFileName = `${sanitizeFileName(submission.id)}.pdf`;
  const pdfPath = path.join(PDF_DIR, pdfFileName);
  const analysis = submission.analysis?.analysis || {};
  const visaProfile = getVisaProfile(submission.visaType);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, autoFirstPage: true });
    const stream = fs.createWriteStream(pdfPath);
    let settled = false;
    const safeResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const safeReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    doc.on('error', safeReject);
    stream.on('error', safeReject);
    doc.pipe(stream);
    stream.on('finish', safeResolve);

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

    addKeyValueLine(doc, 'Visa stream', visaProfile.stream || 'General Migration');
    addKeyValueLine(doc, 'Risk level', analysis.outcomeRiskLevel || 'Moderate');
    addKeyValueLine(doc, 'Lodgement readiness', analysis.applicationReadiness || 'Further review required before lodgement');

    addSectionTitle(doc, 'Case Summary');
    addParagraph(doc, analysis.executiveSummary || submission.analysis?.summary || 'Assessment summary not available.');

    addSectionTitle(doc, 'Outcome Rationale');
    addParagraph(doc, analysis.outcomeRationale || analysis.legalStyleSummary || analysis.overallAssessment || 'Outcome rationale not available.');

    addSectionTitle(doc, 'Professional Opinion');
    addParagraph(doc, analysis.professionalOpinion || analysis.overallAssessment || 'Professional opinion was not generated.');

    addSectionTitle(doc, 'Department-Style Decision Framework');
    addDecisionFrameworkSection(doc, analysis.decisionFramework || []);

    addSectionTitle(doc, 'Refusal Exposure if Lodged Now');
    addBulletList(doc, analysis.refusalExposure, 'No structured refusal exposure items were generated.');

    addSectionTitle(doc, 'Evidence Position');
    addParagraph(doc, analysis.evidenceAssessment || 'The evidence position was not generated.');

    addSectionTitle(doc, 'Critical Evidence Gaps');
    addBulletList(doc, analysis.evidenceCriticalGaps, 'No critical evidence gaps were identified in structured form.');

    addSectionTitle(doc, 'Curable Issues Before Lodgement');
    addBulletList(doc, analysis.evidenceCurableIssues, 'No curable pre-lodgement issues were identified in structured form.');

    addSectionTitle(doc, 'Threshold or Blocker Issues');
    addBulletList(doc, analysis.evidenceBlockers, 'No threshold blocker issues were identified in structured form.');

    addSectionTitle(doc, 'Refusal-Risk Engine');
    addParagraph(doc, analysis.refusalRiskSummary || 'The refusal-risk summary was not generated.');
    addBulletList(doc, analysis.refusalRiskEngine, 'No structured refusal-risk engine items were generated.');

    for (const section of (visaProfile.pdfSections || [])) {
      addSectionTitle(doc, section.title);
      if (section.type === 'bullets') addBulletList(doc, analysis[section.key], section.fallback || 'No details available.');
      else addParagraph(doc, analysis[section.key] || section.fallback || 'No details available.');
    }

    addSectionTitle(doc, 'Detailed Assessment');
    addLegalSubsectionBlocks(
      doc,
      analysis.detailedAssessment,
      analysis.legalStyleSummary || analysis.overallAssessment || 'Detailed assessment was not generated.'
    );

    addSectionTitle(doc, 'Strengths Supporting the Case');
    addBulletList(doc, analysis.strengths, 'No material strengths were identified from the currently available information.');

    addSectionTitle(doc, 'Key Risks, Limitations, or Concerns');
    addBulletList(doc, analysis.concerns, 'No material concerns were identified from the currently available information.');

    addSectionTitle(doc, 'Refusal Scenarios');
    addBulletList(doc, analysis.refusalScenarios, 'No specific refusal scenarios were generated.');

    addSectionTitle(doc, 'Strategy Advice');
    addBulletList(doc, analysis.strategyAdvice, 'No strategy advice was generated.');

    addSectionTitle(doc, 'Further Information or Evidence Required');
    addBulletList(doc, analysis.missingInformation, 'No additional information items were identified.');

    addSectionTitle(doc, 'Recommended Next Steps');
    addBulletList(doc, analysis.recommendedNextSteps, 'No specific next steps were generated.');

    addSectionTitle(doc, 'Suggested Supporting Document Checklist');
    addBulletList(doc, analysis.documentChecklist, 'No document checklist items were generated.');


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


async function markSubmissionStage(submissionId, patch = {}) {
  return updateSubmission(submissionId, {
    ...patch,
    updatedAt: nowIso(),
    lastHeartbeatAt: nowIso(),
  });
}

async function processSubmission(submissionId) {
  let submission = await getSubmission(submissionId);
  if (!submission) throw new Error(`Submission not found for ${submissionId}`);

  submission = await markSubmissionStage(submissionId, {
    status: 'processing',
    paymentStatus: 'paid',
    analysisStatus: 'running',
    pdfStatus: 'generating',
    emailStatus: 'pending',
    processingStartedAt: nowIso(),
  });

  try {
    const analysisResult = await runAssessmentAnalysis(submission);
    submission = await markSubmissionStage(submissionId, {
      analysisStatus: analysisResult.status,
      analysis: analysisResult,
    });

    const pdfResult = await generateProfessionalPdf(submission);
    submission = await markSubmissionStage(submissionId, {
      pdfStatus: pdfResult?.pdfPath ? 'generated' : 'failed',
      pdfPath: pdfResult?.pdfPath || null,
      pdfUrl: pdfResult?.pdfUrl || null,
    });

    submission = await getSubmission(submissionId);

    const releasePatch = buildReleasePatch(submission);
    submission = await markSubmissionStage(submissionId, {
      ...releasePatch,
      processingError: null,
      processedAt: nowIso(),
      status: 'completed',
    });

    submission = await getSubmission(submissionId);

    if (shouldReleaseEmailNow(submission)) {
      try {
        const emailResult = await trySendAssessmentEmail(submission, pdfResult?.pdfPath);
        submission = await markSubmissionStage(submissionId, {
          emailStatus: emailResult?.ok ? 'sent' : (emailResult?.skipped ? 'skipped' : 'failed'),
          emailResult,
          emailError: emailResult?.ok ? null : (emailResult?.reason || null),
          emailReleased: Boolean(emailResult?.ok),
          emailReleasedAt: emailResult?.ok ? nowIso() : null,
          releaseStatus: emailResult?.ok ? 'released' : 'ready',
          releaseCountdownMs: 0,
          processedAt: nowIso(),
          status: 'completed',
        });
      } catch (mailError) {
        submission = await markSubmissionStage(submissionId, {
          emailStatus: 'failed',
          emailError: mailError.message,
          releaseStatus: 'ready',
          releaseCountdownMs: 0,
          processedAt: nowIso(),
          status: 'completed',
        });
      }
    } else {
      submission = await markSubmissionStage(submissionId, {
        emailStatus: 'scheduled',
        emailError: null,
        processedAt: nowIso(),
        status: 'completed',
      });
    }

    return submission;
  } catch (error) {
    await markSubmissionStage(submissionId, {
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


let EMAIL_RELEASE_PASS_RUNNING = false;

async function releaseScheduledEmailForSubmission(submission, options = {}) {
  const force = Boolean(options.force);
  if (!submission || !submission.id) return { ok: false, skipped: true, reason: 'Invalid submission' };
  const latest = (await getSubmission(submission.id)) || submission;
  const snapshot = getReleaseSnapshot(latest);
  const pdfPath = latest.pdfPath;

  if (!pdfPath || !fs.existsSync(pdfPath)) return { ok: false, skipped: true, reason: 'PDF is not available for scheduled release' };
  if (!force && snapshot.emailReleased) return { ok: true, skipped: true, reason: 'Email already released' };
  if (!force && snapshot.releaseStatus !== 'ready') return { ok: false, skipped: true, reason: 'Release time has not been reached yet' };

  try {
    const result = await trySendAssessmentEmail(latest, pdfPath);
    await markSubmissionStage(latest.id, {
      emailStatus: result?.ok ? 'sent' : (result?.skipped ? 'skipped' : 'failed'),
      emailResult: result,
      emailError: result?.ok ? null : (result?.reason || null),
      emailReleased: Boolean(result?.ok),
      emailReleasedAt: result?.ok ? nowIso() : null,
      releaseStatus: result?.ok ? 'released' : 'ready',
      releaseCountdownMs: 0,
      status: 'completed',
      processedAt: latest.processedAt || nowIso(),
    });
    return result;
  } catch (error) {
    await markSubmissionStage(latest.id, {
      emailStatus: 'failed',
      emailError: error.message,
      releaseStatus: 'ready',
      releaseCountdownMs: 0,
      status: 'completed',
    });
    throw error;
  }
}

async function runScheduledEmailReleasePass() {
  if (EMAIL_RELEASE_PASS_RUNNING) return;
  EMAIL_RELEASE_PASS_RUNNING = true;
  try {
    const submissions = await getAllSubmissions();
    for (const submission of submissions) {
      const snapshot = getReleaseSnapshot(submission);
      const emailStatus = String(submission.emailStatus || '').toLowerCase();
      const eligibleState = ['scheduled', 'pending', 'not_sent', 'failed'].includes(emailStatus) || snapshot.releaseStatus === 'ready';
      if (!eligibleState || snapshot.emailReleased) continue;
      if (!submission.pdfPath || !fs.existsSync(submission.pdfPath)) continue;
      if (snapshot.releaseStatus !== 'ready') continue;
      try {
        await releaseScheduledEmailForSubmission(submission);
      } catch (error) {
        console.error('[scheduled-email-release-error]', submission.id, error.message);
      }
    }
  } finally {
    EMAIL_RELEASE_PASS_RUNNING = false;
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

app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(cors(corsOptionsDelegate));
app.options('*', cors(corsOptionsDelegate));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use('/admin', express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'bircan-migration-backend', timestamp: nowIso(), env: NODE_ENV });
});



app.get('/api/meta/supported-visas', (_req, res) => {
  res.json({
    ok: true,
    visas: getSupportedVisaTypes().map(key => {
      const profile = getVisaProfile(key);
      return {
        visaType: key,
        displayName: profile.displayName || key,
        stream: profile.stream || 'General Migration'
      };
    })
  });
});

app.get('/api/meta/knowledgebase', async (_req, res, next) => {
  try {
    const state = await loadKnowledgebaseIndex(false);
    res.json({
      ok: true,
      directory: KNOWLEDGEBASE_DIR,
      loadedAt: state.loadedAt,
      mammothAvailable: Boolean(mammoth),
      fileCount: Array.isArray(state.files) ? state.files.length : 0,
      chunkCount: Array.isArray(state.chunks) ? state.chunks.length : 0,
      files: state.files || [],
    });
  } catch (error) {
    next(error);
  }
});



/* ============================================================================
   Production citizenship exam engine
============================================================================ */
function readCitizenshipStore(filePath, fallback) {
  try { ensureDirSync(path.dirname(filePath)); if (!fs.existsSync(filePath)) return fallback; return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}
async function writeCitizenshipStore(filePath, data) { ensureDirSync(path.dirname(filePath)); await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8'); }
function getCitizenshipBank() { const bank = readCitizenshipStore(CITIZENSHIP_BANK_PATH, []); return Array.isArray(bank) ? bank.filter(q => q && q.question && Array.isArray(q.options) && q.options.length >= 3) : []; }
function makeCitizenshipAccessToken(sessionId) { return crypto.createHash('sha256').update('citizenship:' + sessionId + ':' + (STRIPE_SECRET_KEY || ADMIN_TOKEN || 'bircan')).digest('hex'); }
function sanitizeCitizenshipQuestion(q, index) { return { id: q.id || index + 1, question: q.question, options: q.options, category: q.category || 'General', isValue: Boolean(q.isValue) }; }
function questionKey(q) { return String(q && (q.id || q.question || '')).trim(); }
function pickCitizenshipExamQuestions(excludeIds = []) {
  const bank = getCitizenshipBank();
  const excluded = new Set((Array.isArray(excludeIds) ? excludeIds : []).map(v => String(v)));
  const shuffleLocal = arr => [...arr].sort(() => Math.random() - 0.5);
  function choose(pool, count) {
    const fresh = pool.filter(q => !excluded.has(questionKey(q)));
    const primary = fresh.length >= count ? fresh : pool;
    return shuffleLocal(primary).slice(0, count);
  }
  const values = bank.filter(q => q.isValue);
  const general = bank.filter(q => !q.isValue);
  const selected = shuffleLocal([...choose(values, 5), ...choose(general, 15)]).slice(0, 20);
  if (selected.length < 20) throw new Error('Citizenship question bank must contain at least 20 usable questions.');
  return selected;
}
function evaluateCitizenshipExam(questions, answers) {
  const normalAnswers = Array.isArray(answers) ? answers : []; let score = 0; let valuesCorrect = 0; let valuesTotal = 0; const categories = {};
  const review = questions.map((q, index) => { const selected = Number.isInteger(normalAnswers[index]) ? normalAnswers[index] : null; const correctIndex = Number(q.answer || 0); const correct = selected === correctIndex; if (correct) score += 1; if (q.isValue) { valuesTotal += 1; if (correct) valuesCorrect += 1; } const cat = q.category || 'General'; if (!categories[cat]) categories[cat] = { total: 0, correct: 0 }; categories[cat].total += 1; if (correct) categories[cat].correct += 1; return { index, id: q.id || index + 1, question: q.question, options: q.options, selected, selectedText: selected === null ? null : q.options[selected], correctIndex, correctText: q.options[correctIndex], correct, isValue: Boolean(q.isValue), category: cat, explanation: q.explanation || ('Correct answer: ' + q.options[correctIndex] + '.') }; });
  const passedOverall = score >= 15; const passedValues = valuesCorrect === valuesTotal; const passed = passedOverall && passedValues; const reasons = [];
  if (!passedOverall) reasons.push('Overall score was ' + score + '/20. The required score is at least 15/20.');
  if (!passedValues) reasons.push('Australian values score was ' + valuesCorrect + '/' + valuesTotal + '. All Australian values questions must be correct.');
  if (passed) reasons.push('The test met both requirements: at least 15/20 overall and all Australian values questions correct.');
  return { score, total: questions.length, valuesCorrect, valuesTotal, passed, passedOverall, passedValues, reasons, categories, review };
}
function getEntitlementsStore() {
  const store = readCitizenshipStore(CITIZENSHIP_ENTITLEMENTS_PATH, { entitlements: {}, byUserId: {} });
  if (!store.entitlements) store.entitlements = {};
  if (!store.byUserId) store.byUserId = {};
  return store;
}
async function saveEntitlementsStore(store) { await writeCitizenshipStore(CITIZENSHIP_ENTITLEMENTS_PATH, store); }
function normaliseLoginKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normaliseUsernameKey(value) {
  return normaliseLoginKey(value).replace(/[^a-z0-9._-]/g, '');
}

function rebuildUsersStoreIndexes(input) {
  // Backward-compatible normalisation for old user-store shapes.
  let rawUsers = [];
  if (Array.isArray(input)) {
    rawUsers = input;
  } else if (input && typeof input === 'object') {
    if (Array.isArray(input.users)) rawUsers = input.users;
    else if (input.users && typeof input.users === 'object') rawUsers = Object.values(input.users);
    else rawUsers = Object.values(input).filter(v => v && typeof v === 'object' && (v.email || v.username || v.userEmail || v.userName || v.passwordHash || v.password));
  }
  const store = { users: {}, byEmail: {}, byUsername: {} };
  rawUsers.forEach((user, index) => {
    if (!user || typeof user !== 'object') return;
    const legacySeed = JSON.stringify(user).slice(0, 500);
    const id = String(user.id || user.userId || user._id || `usr_legacy_${index}_${crypto.createHash('sha1').update(legacySeed).digest('hex').slice(0, 10)}`);
    const emailKey = normaliseLoginKey(user.email || user.emailAddress || user.userEmail || user.customerEmail);
    const usernameKey = normaliseUsernameKey(user.username || user.userName || user.name || (emailKey ? emailKey.split('@')[0] : ''));
    const nextUser = { ...user, id };
    if (emailKey) nextUser.email = emailKey;
    if (usernameKey) nextUser.username = usernameKey;
    store.users[id] = nextUser;
    if (emailKey) store.byEmail[emailKey] = id;
    if (usernameKey) store.byUsername[usernameKey] = id;
  });
  return store;
}

function getUsersStore() {
  const store = readCitizenshipStore(CITIZENSHIP_USERS_PATH, { users: {}, byEmail: {}, byUsername: {} });
  return rebuildUsersStoreIndexes(store);
}

async function saveUsersStore(store) {
  await writeCitizenshipStore(CITIZENSHIP_USERS_PATH, rebuildUsersStoreIndexes(store));
}

function findCitizenshipUserForLogin(store, login) {
  const key = normaliseLoginKey(login);
  const usernameKey = normaliseUsernameKey(login);
  if (!key) return null;

  const indexedId = (store.byEmail && store.byEmail[key]) || (store.byUsername && store.byUsername[usernameKey]) || null;
  if (indexedId && store.users[indexedId]) return store.users[indexedId];

  return Object.values(store.users || {}).find(user => {
    if (!user) return false;
    return normaliseLoginKey(user.email || user.emailAddress || user.userEmail) === key
      || normaliseUsernameKey(user.username || user.userName || user.name) === usernameKey;
  }) || null;
}

async function verifyCitizenshipPasswordAndMigrate(user, password) {
  if (!user || !password) return false;

  const possibleHashes = [user.passwordHash, user.password_hash, user.hash, user.passwordDigest, user.password_hash_bcrypt]
    .filter(v => typeof v === 'string' && v.trim());

  for (const hash of possibleHashes) {
    try {
      if (await bcrypt.compare(password, hash)) {
        if (!user.passwordHash || user.passwordHash !== hash) user.passwordHash = hash;
        return true;
      }
    } catch (_) {}
  }

  // Backward compatibility only for accounts created before bcrypt passwordHash was added.
  const possiblePlain = [user.password, user.plainPassword, user.pass]
    .filter(v => typeof v === 'string' && v.length);
  if (possiblePlain.some(v => v === password)) {
    user.passwordHash = await bcrypt.hash(password, 12);
    delete user.password;
    delete user.plainPassword;
    delete user.pass;
    return true;
  }

  return false;
}
function getExamStore() { const store = readCitizenshipStore(CITIZENSHIP_EXAMS_PATH, { exams: {}, freeAttempts: {} }); if (!store.exams) store.exams = {}; if (!store.freeAttempts) store.freeAttempts = {}; return store; }
async function saveExamStore(store) { await writeCitizenshipStore(CITIZENSHIP_EXAMS_PATH, store); }
function freeClientKey(raw) { const token = String(raw || '').trim().slice(0, 120); return token || 'anonymous'; }
function publicUser(user) { return user ? { id: user.id, username: user.username, email: user.email, createdAt: user.createdAt } : null; }
function signCitizenshipUser(user) { return jwt.sign({ sub: user.id, email: user.email, product: 'citizenship_exam' }, JWT_SECRET, { expiresIn: '30d' }); }
function makeDashboardReturnToken(user) { return signCitizenshipUser(user); }
function getBearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const headerToken = String(req.headers['x-auth-token'] || req.headers['x-access-token'] || '').trim();
  if (headerToken) return headerToken;
  const bodyToken = String(req.body?.token || req.body?.authToken || req.body?.jwt || req.body?.accessToken || '').trim();
  if (bodyToken) return bodyToken;
  const queryToken = String(req.query?.token || req.query?.authToken || req.query?.jwt || req.query?.accessToken || '').trim();
  if (queryToken) return queryToken;
  const cookie = String(req.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)(?:token|authToken|bm_token|citizenshipToken)=([^;]+)/);
  return match ? decodeURIComponent(match[1]).trim() : '';
}
function getUserFromRequest(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  const payload = jwt.verify(token, JWT_SECRET);
  const users = getUsersStore();
  return users.users[payload.sub] || null;
}
function requireCitizenshipAuth(req, res, next) {
  try {
    const user = getUserFromRequest(req);
    if (!user) return res.status(401).json({ ok: false, error: 'Login required.' });
    req.user = user;
    return next();
  } catch (_) {
    return res.status(401).json({ ok: false, error: 'Login expired. Please login again.' });
  }
}
function optionalCitizenshipAuth(req) { try { return getUserFromRequest(req); } catch (_) { return null; } }
async function upsertCitizenshipEntitlementFromSession(session) {
  const plan = String(session.metadata?.plan || '').trim().toLowerCase(); const config = getStripePlanConfig(plan); if (!config) return null; const paid = session.payment_status === 'paid' || session.status === 'complete'; if (!paid) return null;
  const token = makeCitizenshipAccessToken(session.id); const store = getEntitlementsStore(); const sessionEmail = session.customer_details?.email || session.customer_email || session.metadata?.email || null; const fallbackUser = findCitizenshipUserByEmail(sessionEmail); const userId = String(session.metadata?.userId || (fallbackUser ? fallbackUser.id : '') || '').trim() || null; const existingByUser = userId && store.byUserId[userId] ? store.entitlements[store.byUserId[userId]] : null; const existing = store.entitlements[token] || existingByUser || {}; const added = Number(config.attempts || 0); const previousTotal = Number(existing.total || 0); const isSameSession = String(existing.sessionId || '') === String(session.id || ''); const total = isSameSession ? Math.max(previousTotal, added) : previousTotal + added; const used = Number(existing.used || 0);
  const entitlement = { token, userId, plan: config.code, planLabel: config.label, total, used: Math.min(used, total), remaining: Math.max(0, total - Math.min(used, total)), sessionId: session.id, customerEmail: sessionEmail || existing.customerEmail || null, amountTotal: session.amount_total || existing.amountTotal || null, currency: session.currency || existing.currency || null, paymentStatus: session.payment_status || existing.paymentStatus || null, createdAt: existing.createdAt || nowIso(), updatedAt: nowIso(), mode: STRIPE_MODE, results: Array.isArray(existing.results) ? existing.results : [], lastQuestionIds: Array.isArray(existing.lastQuestionIds) ? existing.lastQuestionIds : [] };
  store.entitlements[token] = entitlement;
  if (userId) store.byUserId[userId] = token;
  await saveEntitlementsStore(store); return entitlement;
}
function findUserEntitlement(userId) { const store = getEntitlementsStore(); const token = store.byUserId && store.byUserId[userId]; return token ? store.entitlements[token] || null : null; }
function findCitizenshipUserByEmail(email) { const clean = String(email || '').trim().toLowerCase(); if (!clean) return null; const users = getUsersStore(); const id = users.byEmail && users.byEmail[clean]; return id ? users.users[id] || null : null; }
function publicEntitlement(ent) { if (!ent) return null; const unlimited = ent.total === null || ent.total === undefined || String(ent.plan || '').toLowerCase() === 'unlimited'; const used = Number(ent.used || 0); return { plan: ent.plan, planLabel: ent.planLabel, total: unlimited ? null : Number(ent.total || 0), used, remaining: unlimited ? null : Math.max(0, Number(ent.total || 0) - used), unlimited, customerEmail: ent.customerEmail || null, userId: ent.userId || null, createdAt: ent.createdAt, updatedAt: ent.updatedAt, results: Array.isArray(ent.results) ? ent.results.slice(-10) : [] }; }

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (username.length < 3) return res.status(400).json({ ok: false, error: 'Username must be at least 3 characters.' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ ok: false, error: 'Valid email required.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
    const store = getUsersStore();
    if (findCitizenshipUserForLogin(store, email) || findCitizenshipUserForLogin(store, username)) return res.status(409).json({ ok: false, error: 'Account already exists. Please login.' });
    const id = safeId('usr');
    const passwordHash = await bcrypt.hash(password, 12);
    const user = { id, username, email, passwordHash, createdAt: nowIso(), updatedAt: nowIso() };
    store.users[id] = user; store.byEmail[email] = id; store.byUsername[username] = id;
    await saveUsersStore(store);
    return res.json({ ok: true, user: publicUser(user), token: signCitizenshipUser(user), entitlement: publicEntitlement(findUserEntitlement(id)) });
  } catch (error) { return next(error); }
});
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const login = req.body?.login || req.body?.email || req.body?.username || '';
    const password = String(req.body?.password || '');
    const store = getUsersStore();
    const user = findCitizenshipUserForLogin(store, login);

    if (!user || !(await verifyCitizenshipPasswordAndMigrate(user, password))) {
      return res.status(401).json({ ok: false, error: 'Invalid login details.' });
    }

    user.email = normaliseLoginKey(user.email || user.emailAddress || user.userEmail);
    user.username = normaliseUsernameKey(user.username || user.userName || user.name || user.email);
    user.lastLoginAt = nowIso();
    user.updatedAt = nowIso();
    store.users[user.id] = user;
    await saveUsersStore(store);

    return res.json({ ok: true, user: publicUser(user), token: signCitizenshipUser(user), entitlement: publicEntitlement(findUserEntitlement(user.id)) });
  } catch (error) { return next(error); }
});
app.get('/api/auth/me', requireCitizenshipAuth, (req, res) => res.json({ ok: true, user: publicUser(req.user), entitlement: publicEntitlement(findUserEntitlement(req.user.id)) }));
app.get('/api/citizenship/my-entitlement', requireCitizenshipAuth, async (req, res, next) => {
  try {
    let entitlement = findUserEntitlement(req.user.id);
    const sessionId = String(req.query?.session_id || req.query?.sessionId || '').trim();
    if (!entitlement && sessionId && stripe) {
      const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price', 'payment_intent'] });
      const sessionUserId = String(session.metadata?.userId || '').trim();
      const sessionEmail = String(session.customer_details?.email || session.customer_email || session.metadata?.email || '').trim().toLowerCase();
      const sameUser = (sessionUserId && sessionUserId === req.user.id) || (sessionEmail && sessionEmail === String(req.user.email || '').toLowerCase());
      if (sameUser && (session.payment_status === 'paid' || session.status === 'complete')) {
        entitlement = await upsertCitizenshipEntitlementFromSession(session);
      }
    }
    if (!entitlement) return res.status(404).json({ ok: false, error: 'No paid exam pack is attached to this account.' });
    return res.json({ ok: true, entitlement: publicEntitlement(entitlement) });
  } catch (error) { return next(error); }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bircan-migration-backend',
    hasOpenAiKey: Boolean(OPENAI_API_KEY),
    hasSmtp: Boolean(SMTP_HOST && SMTP_FROM),
    appBaseUrl: APP_BASE_URL,
    allowedOrigins: ALLOWED_ORIGINS,
    stripeMode: STRIPE_MODE,
    stripeConfigured: Boolean(STRIPE_SECRET_KEY),
    stripeKeyType: STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : (STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'test' : 'unknown'),
    webhookConfigured: Boolean(STRIPE_WEBHOOK_SECRET),
    stripePrices: {
      '20': Boolean(STRIPE_PRICE_CITIZENSHIP_20),
      '50': Boolean(STRIPE_PRICE_CITIZENSHIP_50),
      '100': Boolean(STRIPE_PRICE_CITIZENSHIP_100),
      unlimited: Boolean(STRIPE_PRICE_CITIZENSHIP_UNLIMITED),
      visaInstant: Boolean(STRIPE_PRICE_VISA_INSTANT),
      visa24h: Boolean(STRIPE_PRICE_VISA_24H),
      visa3d: Boolean(STRIPE_PRICE_VISA_3D),
    },
    stripePricePrefixes: {
      '20': STRIPE_PRICE_CITIZENSHIP_20 ? STRIPE_PRICE_CITIZENSHIP_20.slice(0, 12) + '...' : null,
      '50': STRIPE_PRICE_CITIZENSHIP_50 ? STRIPE_PRICE_CITIZENSHIP_50.slice(0, 12) + '...' : null,
      '100': STRIPE_PRICE_CITIZENSHIP_100 ? STRIPE_PRICE_CITIZENSHIP_100.slice(0, 12) + '...' : null,
      unlimited: STRIPE_PRICE_CITIZENSHIP_UNLIMITED ? STRIPE_PRICE_CITIZENSHIP_UNLIMITED.slice(0, 12) + '...' : null,
      visaInstant: STRIPE_PRICE_VISA_INSTANT ? STRIPE_PRICE_VISA_INSTANT.slice(0, 12) + '...' : null,
      visa24h: STRIPE_PRICE_VISA_24H ? STRIPE_PRICE_VISA_24H.slice(0, 12) + '...' : null,
      visa3d: STRIPE_PRICE_VISA_3D ? STRIPE_PRICE_VISA_3D.slice(0, 12) + '...' : null,
    },
    timestamp: nowIso(),
    model: OPENAI_MODEL_ANALYSIS,
    helperModel: OPENAI_MODEL_HELPER,
    hasAdminToken: Boolean(ADMIN_TOKEN),
    supportedVisaTypes: getSupportedVisaTypes(),
    knowledgebase: {
      directory: KNOWLEDGEBASE_DIR,
      loadedAt: KNOWLEDGEBASE_STATE.loadedAt,
      fileCount: Array.isArray(KNOWLEDGEBASE_STATE.files) ? KNOWLEDGEBASE_STATE.files.length : 0,
      chunkCount: Array.isArray(KNOWLEDGEBASE_STATE.chunks) ? KNOWLEDGEBASE_STATE.chunks.length : 0,
      mammothAvailable: Boolean(mammoth),
    },
  });
});



function normalizeVisaCheckoutPlan(input) {
  // Canonical visa assessment plans used across frontend cards, login handoff,
  // Stripe metadata, webhook processing, dashboard release timing, and PDFs.
  // This deliberately accepts old UI labels so a page that sends “fastest” or
  // “recommended” cannot accidentally fall back to the 24 hour plan.
  const raw = String(input || '').trim().toLowerCase().replace(/_/g, '-');
  const compact = raw.replace(/[^a-z0-9]+/g, '');
  const aliases = {
    instant: 'instant',
    fastest: 'instant',
    fast: 'instant',
    immediate: 'instant',
    priority: 'instant',
    express: 'instant',
    sameday: 'instant',
    today: 'instant',
    urgent: 'instant',
    premium: 'instant',
    recommended: '24h',
    standard: '24h',
    normal: '24h',
    regular: '24h',
    '24h': '24h',
    '24hr': '24h',
    '24hrs': '24h',
    '24hour': '24h',
    '24hours': '24h',
    economy: '3d',
    value: '3d',
    budget: '3d',
    basic: '3d',
    '3d': '3d',
    '3day': '3d',
    '3days': '3d',
    '72h': '3d',
    '72hours': '3d',
  };
  const canonical = aliases[raw] || aliases[compact] || '';
  if (canonical) return normalizePlan(canonical);
  return normalizePlan(raw || '24h');
}

function findVisaPlanInput(body = {}) {
  const payload = body && typeof body.assessmentPayload === 'object' && body.assessmentPayload ? body.assessmentPayload : {};
  const metadata = payload && typeof payload.metadata === 'object' && payload.metadata ? payload.metadata : {};
  const candidates = [
    body.plan,
    body.selectedPlan,
    body.selectedPlanKey,
    body.planCode,
    body.planId,
    body.deliveryPlan,
    body.assessmentPlan,
    body.turnaround,
    body.serviceLevel,
    body.package,
    body.pricePlan,
    metadata.selectedPlanKey,
    metadata.selectedPlan,
    metadata.plan,
    metadata.planCode,
    payload.plan,
    payload.selectedPlan,
    payload.selectedPlanKey,
    payload.planCode,
    payload.planId,
    payload.deliveryPlan,
    payload.assessmentPlan,
    payload.turnaround,
    payload.serviceLevel,
    payload.package,
    payload.pricePlan,
  ];
  return candidates.find(value => String(value || '').trim()) || '';
}

function getVisaStripePriceIdForPlan(planCode) {
  const code = String(planCode || '').trim().toLowerCase();
  if (code === 'instant') return STRIPE_PRICE_VISA_INSTANT;
  if (code === '24h') return STRIPE_PRICE_VISA_24H;
  if (code === '3d') return STRIPE_PRICE_VISA_3D;
  return '';
}

function makeStripeSafeUrl(value, fallbackPath = '/') {
  const fallback = new URL(fallbackPath, APP_BASE_URL).toString();
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw, APP_BASE_URL);
    const allowed = parsed.origin === new URL(APP_BASE_URL).origin || ALLOWED_ORIGINS.includes(parsed.origin) || ALLOWED_ORIGINS.includes('*');
    return allowed ? parsed.toString() : fallback;
  } catch (_) {
    return fallback;
  }
}

function makeVisaAssessmentToken(sessionId) {
  return crypto.createHash('sha256')
    .update('visa-assessment:' + sessionId + ':' + (STRIPE_SECRET_KEY || ADMIN_TOKEN || JWT_SECRET || 'bircan'))
    .digest('hex');
}

async function createVisaAssessmentFromPaidSession(session, existingPayload = null) {
  const metadata = session.metadata || {};
  if (String(metadata.product || '') !== 'visa_assessment') return null;
  const paid = session.payment_status === 'paid' || session.status === 'complete';
  if (!paid) return null;

  const token = makeVisaAssessmentToken(session.id);
  const submissionIdFromMeta = String(metadata.submissionId || '').trim();
  const existingSubmission = submissionIdFromMeta ? await getSubmission(submissionIdFromMeta) : null;
  if (existingSubmission && existingSubmission.paymentStatus === 'paid') return existingSubmission;

  const payloadTokenFromMeta = String(metadata.payloadToken || '').trim();
  const payload = existingPayload
    || (payloadTokenFromMeta ? readJsonSafe(path.join(STORAGE_DIR, 'visa-checkout-payloads', `${sanitizeFileName(payloadTokenFromMeta)}.json`), null) : null)
    || readJsonSafe(path.join(STORAGE_DIR, 'visa-checkout-payloads', `${sanitizeFileName(token)}.json`), null);
  if (!payload || typeof payload !== 'object') return null;

  const extracted = extractAssessmentPayload(payload.assessmentPayload || payload);
  if (!extracted.client.email) {
    extracted.client.email = String(session.customer_details?.email || session.customer_email || metadata.email || '').trim().toLowerCase();
  }
  if (!extracted.client.email) return null;

  const plan = normalizeVisaCheckoutPlan(metadata.plan || extracted.plan || payload.plan);
  const submissionId = submissionIdFromMeta || safeId('sub');
  const releaseAt = calculateReleaseAt(plan, nowIso());
  const submission = {
    id: submissionId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: 'queued',
    paymentStatus: 'paid',
    productType: 'visa_assessment',
    userId: String(metadata.userId || payload.userId || '').trim() || null,
    accountEmail: String(metadata.email || payload.email || session.customer_details?.email || session.customer_email || '').trim().toLowerCase() || null,
    stripeSessionId: session.id,
    stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent?.id || null),
    stripeCustomerEmail: session.customer_details?.email || session.customer_email || metadata.email || null,
    stripeAmountTotal: session.amount_total || null,
    stripeCurrency: session.currency || null,
    analysisStatus: 'queued',
    pdfStatus: 'queued',
    emailStatus: 'pending',
    paidAt: nowIso(),
    releaseAt,
    emailReleaseAt: releaseAt,
    scheduledEmailAt: releaseAt,
    releaseStatus: plan.code === 'instant' ? 'ready' : 'scheduled',
    releaseCountdownMs: Math.max(0, new Date(releaseAt).getTime() - Date.now()),
    emailReleased: false,
    emailReleasedAt: null,
    ...extracted,
    plan,
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
    console.error('[visa-paid-session-processing-error]', error);
  });
  return submission;
}

app.post(['/create-visa-checkout-session', '/create-assessment-checkout-session', '/api/assessment/create-checkout-session', '/api/assessments/create-checkout-session', '/api/visa/create-checkout-session', '/api/checkout/visa'], async (req, res, next) => {
  try {
    assertStripeConfigured();
    assertStripeModeLooksConsistent();

    const user = optionalCitizenshipAuth(req);
    if (!user) return res.status(401).json({ ok: false, error: 'Login required before Stripe checkout.' });

    const assessmentPayload = req.body?.assessmentPayload || {};
    const subclass = String(req.body?.subclass || assessmentPayload.subclass || assessmentPayload.visaType || '').trim() || 'Visa assessment';
    const requestedPlanInput = findVisaPlanInput(req.body);
    const plan = normalizeVisaCheckoutPlan(requestedPlanInput || '24h');
    const priceId = getVisaStripePriceIdForPlan(plan.code);
    console.log('[visa-checkout-plan]', { received: requestedPlanInput || null, normalized: plan.code, label: plan.label, hasConfiguredPriceId: Boolean(priceId) });

    const successRaw = makeStripeSafeUrl(req.body?.successUrl || req.body?.success_url, '/account-dashboard.html');
    const dashboardReturnToken = encodeURIComponent(makeDashboardReturnToken(user));
    const successUrl = successRaw.includes('{CHECKOUT_SESSION_ID}')
      ? (successRaw.includes('auth_return=') ? successRaw : `${successRaw}${successRaw.includes('?') ? '&' : '?'}auth_return=${dashboardReturnToken}`)
      : `${successRaw}${successRaw.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}&visa_paid=1&auth_return=${dashboardReturnToken}`;
    const cancelUrl = makeStripeSafeUrl(req.body?.cancelUrl || req.body?.cancel_url, '/account-dashboard.html');

    const payloadTokenSeed = safeId('visa_payload');
    const payloadToken = crypto.createHash('sha256').update(payloadTokenSeed + ':' + user.id + ':' + Date.now()).digest('hex');
    const payloadDir = path.join(STORAGE_DIR, 'visa-checkout-payloads');
    ensureDirSync(payloadDir);
    await writeJson(path.join(payloadDir, `${sanitizeFileName(payloadToken)}.json`), {
      createdAt: nowIso(),
      userId: user.id,
      email: user.email,
      subclass,
      plan: plan.code,
      planLabel: plan.label,
      planInput: requestedPlanInput || null,
      assessmentPayload: {
        ...assessmentPayload,
        plan: plan.code,
        selectedPlan: plan.code,
        selectedPlanKey: plan.code,
        planLabel: plan.label,
      },
    });

    const lineItem = priceId
      ? { price: priceId, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: 'aud',
            unit_amount: Number(plan.price || 0),
            product_data: {
              name: `${subclass} assessment - ${plan.label}`,
              description: `${plan.turnaround || plan.label} professional visa assessment service`,
            },
          },
        };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: user.email,
      line_items: [lineItem],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        product: 'visa_assessment',
        subclass,
        plan: plan.code,
        selectedPlan: plan.code,
        planLabel: plan.label,
        planInput: requestedPlanInput || '',
        userId: user.id,
        email: user.email,
        payloadToken,
      },
      payment_intent_data: {
        metadata: {
          product: 'visa_assessment',
          subclass,
          plan: plan.code,
          planLabel: plan.label,
          userId: user.id,
          email: user.email,
          payloadToken,
        },
      },
    });

    return res.json({ ok: true, url: session.url, sessionId: session.id, plan: plan.code, successUrl, cancelUrl });
  } catch (error) { return next(error); }
});

app.get(['/checkout/verify-visa-session', '/api/assessment/verify-session', '/api/assessment/verify-checkout-session'], async (req, res, next) => {
  try {
    assertStripeConfigured();
    assertStripeModeLooksConsistent();
    const sessionId = String(req.query?.session_id || req.query?.sessionId || '').trim();
    const requestedPlanRaw = String(req.query?.plan || '').trim();
    const requestedPlan = requestedPlanRaw ? normalizeVisaCheckoutPlan(requestedPlanRaw).code : '';
    if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing session_id.' });

    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price', 'payment_intent'] });
    const metadata = session.metadata || {};
    const paid = session.payment_status === 'paid' || session.status === 'complete';
    const productOk = String(metadata.product || '') === 'visa_assessment';
    const plan = normalizeVisaCheckoutPlan(metadata.plan || requestedPlan || '24h');
    const planMatches = !requestedPlan || requestedPlan === plan.code;

    const user = optionalCitizenshipAuth(req);
    const sessionUserId = String(metadata.userId || '').trim();
    if (sessionUserId && user && sessionUserId !== user.id) return res.status(403).json({ ok: false, error: 'This payment belongs to a different account.' });

    const verified = paid && productOk && planMatches;
    let submission = null;
    if (verified) {
      const payloadToken = String(metadata.payloadToken || '').trim();
      const payload = payloadToken ? readJsonSafe(path.join(STORAGE_DIR, 'visa-checkout-payloads', `${sanitizeFileName(payloadToken)}.json`), null) : null;
      submission = await createVisaAssessmentFromPaidSession(session, payload);
    }
    return res.json({
      ok: verified,
      paid,
      verified,
      product: metadata.product || null,
      subclass: metadata.subclass || null,
      plan: plan.code,
      sessionId: session.id,
      customerEmail: session.customer_details?.email || session.customer_email || null,
      amountTotal: session.amount_total || null,
      currency: session.currency || null,
      paymentStatus: session.payment_status || null,
      status: session.status || null,
      submissionId: submission?.id || null,
      assessment: submission ? publicDashboardAssessment(submission) : null,
    });
  } catch (error) { return next(error); }
});

app.post('/create-checkout-session', async (req, res, next) => {
  try {
    assertStripeConfigured(); assertStripeModeLooksConsistent();
    const user = optionalCitizenshipAuth(req);
    const plan = String(req.body?.plan || '').trim().toLowerCase();
    const config = getStripePlanConfig(plan);
    if (!config || !config.priceId) return res.status(400).json({ ok: false, error: 'Invalid plan.' });
    if (!user) return res.status(401).json({ ok: false, error: 'Login required before Stripe checkout.' });
    const successBaseUrl = buildStripeReturnUrl(STRIPE_SUCCESS_PATH, { plan: config.code, paid: '1' });
    const dashboardReturnToken = encodeURIComponent(makeDashboardReturnToken(user));
    const successUrl = `${successBaseUrl}${successBaseUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}&auth_return=${dashboardReturnToken}`;
    const cancelUrl = buildStripeReturnUrl(STRIPE_CANCEL_PATH, { canceled: '1' });
    const session = await stripe.checkout.sessions.create({ mode: 'payment', customer_email: user.email, line_items: [{ price: config.priceId, quantity: 1 }], success_url: successUrl, cancel_url: cancelUrl, metadata: { product: 'citizenship_exam', plan: config.code, planLabel: config.label, userId: user.id, email: user.email }, payment_intent_data: { metadata: { product: 'citizenship_exam', plan: config.code, planLabel: config.label, userId: user.id, email: user.email } } });
    return res.json({ ok: true, url: session.url, sessionId: session.id, plan: config.code, successUrl, cancelUrl });
  } catch (error) { return next(error); }
});

app.get('/checkout/verify-session', async (req, res, next) => {
  try {
    assertStripeConfigured();
    assertStripeModeLooksConsistent();
    const sessionId = String(req.query?.session_id || req.query?.sessionId || '').trim();
    const plan = String(req.query?.plan || '').trim().toLowerCase();
    if (!sessionId) {
      return res.status(400).json({ ok: false, error: 'Missing session_id.' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items.data.price', 'payment_intent']
    });

    const paid = session.payment_status === 'paid' || session.status === 'complete';
    const metadataPlan = String(session.metadata?.plan || '').trim().toLowerCase();
    const requestedPlan = plan || metadataPlan;
    const expectedPriceId = getStripePriceIdForPlan(requestedPlan);
    const paidPriceId = session.line_items?.data?.[0]?.price?.id || '';
    const productOk = String(session.metadata?.product || '') === 'citizenship_exam';
    const planMatches = !requestedPlan || metadataPlan === requestedPlan;
    const priceMatches = !expectedPriceId || paidPriceId === expectedPriceId;

    const user = optionalCitizenshipAuth(req);
    const sessionUserId = String(session.metadata?.userId || '').trim();
    if (sessionUserId && user && sessionUserId !== user.id) return res.status(403).json({ ok: false, error: 'This payment belongs to a different account.' });
    const verified = paid && productOk && planMatches && priceMatches;
    const entitlement = verified ? await upsertCitizenshipEntitlementFromSession(session) : null;
    return res.json({ ok: verified, paid, verified, plan: metadataPlan || requestedPlan || null, accessToken: entitlement ? entitlement.token : null, entitlement: publicEntitlement(entitlement), user: user ? publicUser(user) : null, sessionId: session.id, customerEmail: session.customer_details?.email || session.customer_email || null, amountTotal: session.amount_total || null, currency: session.currency || null, paymentStatus: session.payment_status || null, status: session.status || null });
  } catch (error) {
    return next(error);
  }
});


// -----------------------------------------------------------------------------
// Production Stripe -> account continuity helpers
// These routes do not change existing visa/PDF/admin routes. They only bind a
// completed Stripe Checkout Session back to the citizenship user stored in the
// session metadata so the paid page can recognise an already-created account
// after returning from Stripe.
// -----------------------------------------------------------------------------
async function verifyCitizenshipCheckoutSessionForAccount(sessionId, reqUser = null, requestedPlan = '') {
  assertStripeConfigured();
  assertStripeModeLooksConsistent();

  const cleanSessionId = String(sessionId || '').trim();
  if (!cleanSessionId) {
    const error = new Error('Missing session_id.');
    error.statusCode = 400;
    throw error;
  }

  const session = await stripe.checkout.sessions.retrieve(cleanSessionId, {
    expand: ['line_items.data.price', 'payment_intent']
  });

  const paid = session.payment_status === 'paid' || session.status === 'complete';
  const metadata = session.metadata || {};
  const metadataPlan = String(metadata.plan || '').trim().toLowerCase();
  const plan = String(requestedPlan || metadataPlan || '').trim().toLowerCase();
  const productOk = String(metadata.product || '') === 'citizenship_exam';
  const expectedPriceId = getStripePriceIdForPlan(plan);
  const paidPriceId = session.line_items?.data?.[0]?.price?.id || '';
  const planMatches = !plan || !metadataPlan || metadataPlan === plan;
  const priceMatches = !expectedPriceId || !paidPriceId || paidPriceId === expectedPriceId;

  if (!paid || !productOk || !planMatches || !priceMatches) {
    const error = new Error('Stripe payment could not be verified for this account.');
    error.statusCode = 403;
    error.details = { paid, productOk, planMatches, priceMatches };
    throw error;
  }

  let user = null;
  const sessionUserId = String(metadata.userId || '').trim();
  const sessionEmail = String(session.customer_details?.email || session.customer_email || metadata.email || '').trim().toLowerCase();
  const users = getUsersStore();

  if (reqUser) {
    const sameUser = (sessionUserId && sessionUserId === reqUser.id)
      || (sessionEmail && sessionEmail === String(reqUser.email || '').toLowerCase());
    if (!sameUser) {
      const error = new Error('This Stripe payment belongs to a different account.');
      error.statusCode = 403;
      throw error;
    }
    user = reqUser;
  } else if (sessionUserId && users.users[sessionUserId]) {
    user = users.users[sessionUserId];
  } else if (sessionEmail) {
    user = findCitizenshipUserByEmail(sessionEmail);
  }

  if (!user) {
    const error = new Error('The paid Stripe session could not be matched to an existing account.');
    error.statusCode = 404;
    throw error;
  }

  // Ensure the entitlement is stored server-side against the matched account.
  session.metadata = { ...metadata, userId: user.id, email: user.email || sessionEmail };
  const entitlement = await upsertCitizenshipEntitlementFromSession(session);
  if (!entitlement) {
    const error = new Error('Paid entitlement could not be created from the Stripe session.');
    error.statusCode = 500;
    throw error;
  }

  return { session, user, entitlement, token: signCitizenshipUser(user) };
}

app.get('/api/verify-session', async (req, res, next) => {
  try {
    const reqUser = optionalCitizenshipAuth(req);
    const result = await verifyCitizenshipCheckoutSessionForAccount(
      req.query?.session_id || req.query?.sessionId,
      reqUser,
      req.query?.plan || ''
    );

    return res.json({
      ok: true,
      verified: true,
      paid: true,
      user: publicUser(result.user),
      token: result.token,
      accessToken: result.entitlement.token,
      entitlement: publicEntitlement(result.entitlement),
      sessionId: result.session.id,
      plan: result.entitlement.plan,
      paymentStatus: result.session.payment_status || null,
      status: result.session.status || null
    });
  } catch (error) { return next(error); }
});

app.get('/api/citizenship/claim-paid-session', async (req, res, next) => {
  try {
    const reqUser = optionalCitizenshipAuth(req);
    const result = await verifyCitizenshipCheckoutSessionForAccount(
      req.query?.session_id || req.query?.sessionId,
      reqUser,
      req.query?.plan || ''
    );

    return res.json({
      ok: true,
      verified: true,
      user: publicUser(result.user),
      token: result.token,
      accessToken: result.entitlement.token,
      entitlement: publicEntitlement(result.entitlement),
      sessionId: result.session.id
    });
  } catch (error) { return next(error); }
});



// -----------------------------------------------------------------------------
// Stripe return -> account session restoration
// -----------------------------------------------------------------------------
app.get('/api/auth/restore-from-session', async (req, res, next) => {
  try {
    const result = await verifyCitizenshipCheckoutSessionForAccount(
      req.query?.session_id || req.query?.sessionId,
      null,
      req.query?.plan || ''
    );
    return res.json({
      ok: true,
      restored: true,
      verified: true,
      paid: true,
      token: result.token,
      user: publicUser(result.user),
      accessToken: result.entitlement.token,
      entitlement: publicEntitlement(result.entitlement),
      sessionId: result.session.id,
      plan: result.entitlement.plan,
      paymentStatus: result.session.payment_status || null,
      status: result.session.status || null
    });
  } catch (error) { return next(error); }
});

app.get('/api/citizenship/debug-session', requireCitizenshipAuth, async (req, res, next) => {
  try {
    assertStripeConfigured();
    const sessionId = String(req.query?.session_id || req.query?.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing session_id.' });
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price'] });
    return res.json({
      ok: true,
      paid: session.payment_status === 'paid' || session.status === 'complete',
      paymentStatus: session.payment_status || null,
      status: session.status || null,
      metadata: session.metadata || {},
      loggedInUserId: user?.id || null,
      sessionUserId: session.metadata?.userId || null,
      customerEmail: session.customer_details?.email || session.customer_email || null,
      plan: session.metadata?.plan || null,
      priceId: session.line_items?.data?.[0]?.price?.id || null,
      assessment: submission ? publicDashboardAssessment(submission) : null,
      entitlement: user ? publicEntitlement(findUserEntitlement(user.id)) : null,
    });
  } catch (error) { return next(error); }
});

app.post('/stripe/webhook', async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Stripe webhook is not configured.');
  }

  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error('[stripe-webhook-signature-error]', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const rawSession = event.data.object || {};
      const session = rawSession.id && stripe
        ? await stripe.checkout.sessions.retrieve(rawSession.id, { expand: ['line_items.data.price', 'payment_intent'] })
        : rawSession;
      if (String(session.metadata?.product || '') === 'visa_assessment') {
        const payloadToken = String(session.metadata?.payloadToken || '').trim();
        const payload = payloadToken ? readJsonSafe(path.join(STORAGE_DIR, 'visa-checkout-payloads', `${sanitizeFileName(payloadToken)}.json`), null) : null;
        await createVisaAssessmentFromPaidSession(session, payload);
      } else {
        await upsertCitizenshipEntitlementFromSession(session);
      }
      console.log('[stripe-webhook-checkout-completed]', {
        sessionId: session.id,
        plan: session.metadata?.plan || null,
        customerEmail: session.customer_details?.email || session.customer_email || null,
        paymentStatus: session.payment_status || null,
      });
    }
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object || {};
      console.log('[stripe-webhook-payment-succeeded]', {
        paymentIntentId: intent.id,
        plan: intent.metadata?.plan || null,
        amount: intent.amount || null,
        currency: intent.currency || null,
      });
    }
    return res.json({ received: true });
  } catch (error) {
    console.error('[stripe-webhook-handler-error]', error);
    return res.status(500).json({ received: false, error: error.message || 'Webhook handling failed.' });
  }
});




// -----------------------------------------------------------------------------
// Unified account dashboard API (citizenship + visa assessments)
// -----------------------------------------------------------------------------
function publicDashboardAssessment(submission = {}) {
  const release = getReleaseSnapshot(submission);
  return {
    id: submission.id || null,
    product: 'visa_assessment',
    visaType: submission.visaType || submission.subclass || submission.assessmentType || submission?.metadata?.subclass || 'Visa assessment',
    subclass: submission.subclass || submission.visaType || submission.assessmentType || null,
    clientName: submission.client?.name || submission.clientName || submission.fullName || null,
    clientEmail: submission.client?.email || submission.clientEmail || submission.email || submission.accountEmail || submission.stripeCustomerEmail || null,
    userId: submission.userId || null,
    plan: submission.plan || null,
    paymentStatus: submission.paymentStatus || 'unpaid',
    status: submission.status || null,
    analysisStatus: submission.analysisStatus || null,
    pdfStatus: submission.pdfStatus || null,
    emailStatus: submission.emailStatus || null,
    paidAt: submission.paidAt || null,
    createdAt: submission.createdAt || null,
    updatedAt: submission.updatedAt || null,
    stripeSessionId: submission.stripeSessionId || null,
    amountTotal: submission.stripeAmountTotal || null,
    currency: submission.stripeCurrency || null,
    releaseAt: release.releaseAt,
    releaseStatus: release.releaseStatus,
    releaseCountdownMs: release.releaseCountdownMs,
    downloadUrl: submission.pdfUrl || submission.downloadUrl || (submission.pdfFileName ? `/pdfs/${submission.pdfFileName}` : null),
  };
}

async function getVisaAssessmentsForDashboard(user) {
  const all = await getAllSubmissions();
  const userId = String(user?.id || '').trim();
  const email = String(user?.email || '').trim().toLowerCase();
  return all
    .filter(item => {
      const itemUserId = String(item.userId || item.accountUserId || item.customerUserId || '').trim();
      const emails = [item.accountEmail, item.stripeCustomerEmail, item.customerEmail, item.clientEmail, item.email, item.client && item.client.email]
        .map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
      return (userId && itemUserId === userId) || (email && emails.includes(email));
    })
    .map(publicDashboardAssessment)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

app.get('/api/account/session-from-checkout', async (req, res, next) => {
  try {
    assertStripeConfigured();
    assertStripeModeLooksConsistent();
    const sessionId = String(req.query?.session_id || req.query?.sessionId || '').trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing session_id.' });
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
    const paid = session.payment_status === 'paid' || session.status === 'complete';
    const userId = String(session.metadata?.userId || '').trim();
    const users = getUsersStore();
    const user = userId ? users.users[userId] : null;
    if (!paid || !user) return res.status(401).json({ ok: false, error: 'Unable to restore the logged-in account from this Stripe session.' });
    return res.json({ ok: true, token: makeDashboardReturnToken(user), user: publicUser(user), product: session.metadata?.product || null, sessionId: session.id });
  } catch (error) { return next(error); }
});

app.get('/api/account/dashboard', requireCitizenshipAuth, async (req, res, next) => {
  try {
    const sessionId = String(req.query?.session_id || req.query?.sessionId || '').trim();
    let verifiedPayment = null;
    if (sessionId && stripe) {
      const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items.data.price', 'payment_intent'] });
      const product = String(session.metadata?.product || '').trim();
      if (product === 'visa_assessment') {
        const sessionUserId = String(session.metadata?.userId || '').trim();
        if (sessionUserId && sessionUserId !== req.user.id) return res.status(403).json({ ok: false, error: 'This payment belongs to a different account.' });
        const payloadToken = String(session.metadata?.payloadToken || '').trim();
        const payload = payloadToken ? readJsonSafe(path.join(STORAGE_DIR, 'visa-checkout-payloads', `${sanitizeFileName(payloadToken)}.json`), null) : null;
        const submission = await createVisaAssessmentFromPaidSession(session, payload);
        verifiedPayment = { product: 'visa_assessment', paid: session.payment_status === 'paid' || session.status === 'complete', sessionId: session.id, assessment: submission ? publicDashboardAssessment(submission) : null };
      } else {
        const ent = await upsertCitizenshipEntitlementFromSession(session);
        verifiedPayment = { product: 'citizenship_exam', paid: session.payment_status === 'paid' || session.status === 'complete', sessionId: session.id, entitlement: publicEntitlement(ent || findUserEntitlement(req.user.id)) };
      }
    }
    const entitlement = findUserEntitlement(req.user.id);
    const visaAssessments = await getVisaAssessmentsForDashboard(req.user);
    return res.json({ ok: true, user: publicUser(req.user), verifiedPayment, citizenship: { entitlement: publicEntitlement(entitlement) }, visaAssessments, assessments: visaAssessments });
  } catch (error) { return next(error); }
});

app.get('/api/account/assessments', requireCitizenshipAuth, async (req, res, next) => {
  try {
    const visaAssessments = await getVisaAssessmentsForDashboard(req.user);
    return res.json({ ok: true, assessments: visaAssessments, visaAssessments });
  } catch (error) { return next(error); }
});

app.get('/api/citizenship/questions/meta', (_req, res) => { const bank = getCitizenshipBank(); const values = bank.filter(q => q.isValue).length; const categories = Array.from(new Set(bank.map(q => q.category || 'General'))); res.json({ ok: true, count: bank.length, valuesCount: values, categories }); });
app.get('/api/citizenship/entitlement', async (req, res) => { const token = String(req.query?.accessToken || req.query?.token || '').trim(); const store = getEntitlementsStore(); const entitlement = store.entitlements[token] || null; if (!entitlement) return res.status(404).json({ ok: false, error: 'Paid entitlement was not found.' }); return res.json({ ok: true, entitlement: publicEntitlement(entitlement) }); });
app.post('/api/citizenship/start-free', async (req, res, next) => { try { const clientToken = freeClientKey(req.body?.clientToken); const store = getExamStore(); const free = store.freeAttempts[clientToken] || { used: 0, total: 3, results: [], lastQuestionIds: [] }; if (Number(free.used || 0) >= 3) return res.status(403).json({ ok: false, error: 'No free attempts remaining.' }); const questions = pickCitizenshipExamQuestions(free.lastQuestionIds || []); const examId = safeId('citfree'); store.exams[examId] = { id: examId, type: 'free', clientToken, questions, answers: null, status: 'started', createdAt: nowIso(), expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }; store.freeAttempts[clientToken] = free; await saveExamStore(store); res.json({ ok: true, examId, total: 20, timeLimitSeconds: 45 * 60, attempts: { total: 3, used: free.used, remaining: Math.max(0, 3 - free.used) }, questions: questions.map(sanitizeCitizenshipQuestion) }); } catch (error) { next(error); } });
app.post('/api/citizenship/start-paid', async (req, res, next) => { try { const user = optionalCitizenshipAuth(req); const accessToken = String(req.body?.accessToken || '').trim(); const plan = String(req.body?.plan || '').trim().toLowerCase(); const entStore = getEntitlementsStore(); let entitlement = null; let entitlementToken = accessToken; if (user) { entitlement = findUserEntitlement(user.id); entitlementToken = entitlement ? entitlement.token : accessToken; } if (!entitlement && accessToken) entitlement = entStore.entitlements[accessToken] || null; if (!entitlement) return res.status(403).json({ ok: false, error: 'Paid entitlement was not found or has not been verified.' }); if (user && entitlement.userId && entitlement.userId !== user.id) return res.status(403).json({ ok: false, error: 'This paid exam pack belongs to a different account.' }); if (plan && entitlement.plan !== plan) return res.status(400).json({ ok: false, error: 'Plan does not match paid entitlement.' }); const unlimited = entitlement.total === null || entitlement.total === undefined || String(entitlement.plan || '').toLowerCase() === 'unlimited'; const remaining = unlimited ? Infinity : Math.max(0, Number(entitlement.total || 0) - Number(entitlement.used || 0)); if (!unlimited && remaining <= 0) return res.status(403).json({ ok: false, error: 'No paid attempts remaining.' }); const questions = pickCitizenshipExamQuestions(entitlement.lastQuestionIds || []); const examId = safeId('citpaid'); const store = getExamStore(); store.exams[examId] = { id: examId, type: 'paid', accessToken: entitlementToken, userId: entitlement.userId || (user ? user.id : null), plan: entitlement.plan, questions, answers: null, status: 'started', createdAt: nowIso(), expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }; await saveExamStore(store); res.json({ ok: true, examId, total: 20, timeLimitSeconds: 45 * 60, entitlement: publicEntitlement(entitlement), questions: questions.map(sanitizeCitizenshipQuestion) }); } catch (error) { next(error); } });
app.post('/api/citizenship/submit-exam', async (req, res, next) => { try { const examId = String(req.body?.examId || '').trim(); const answers = Array.isArray(req.body?.answers) ? req.body.answers : []; const store = getExamStore(); const exam = store.exams[examId] || null; if (!exam) return res.status(404).json({ ok: false, error: 'Exam was not found.' }); if (exam.status === 'submitted') return res.status(409).json({ ok: false, error: 'This exam has already been submitted.' }); const result = evaluateCitizenshipExam(exam.questions || [], answers); exam.answers = answers; exam.result = result; exam.status = 'submitted'; exam.submittedAt = nowIso(); let entitlement = null; let attempts = null; if (exam.type === 'free') { const clientToken = freeClientKey(exam.clientToken); const free = store.freeAttempts[clientToken] || { used: 0, total: 3, results: [] }; free.used = Math.min(3, Number(free.used || 0) + 1); free.results = Array.isArray(free.results) ? free.results : []; free.results.push({ examId, score: result.score, valuesCorrect: result.valuesCorrect, passed: result.passed, at: nowIso() }); free.lastQuestionIds = (exam.questions || []).map(questionKey); store.freeAttempts[clientToken] = free; attempts = { total: 3, used: free.used, remaining: Math.max(0, 3 - free.used), results: free.results.slice(-10) }; } else if (exam.type === 'paid') { const entStore = getEntitlementsStore(); entitlement = entStore.entitlements[exam.accessToken] || null; if (!entitlement && exam.userId && entStore.byUserId && entStore.byUserId[exam.userId]) entitlement = entStore.entitlements[entStore.byUserId[exam.userId]] || null; if (!entitlement) return res.status(403).json({ ok: false, error: 'Paid entitlement was not found.' }); const unlimited = entitlement.total === null || entitlement.total === undefined || String(entitlement.plan || '').toLowerCase() === 'unlimited'; entitlement.used = unlimited ? (Number(entitlement.used || 0) + 1) : Math.min(Number(entitlement.total || 0), Number(entitlement.used || 0) + 1); entitlement.remaining = unlimited ? null : Math.max(0, Number(entitlement.total || 0) - Number(entitlement.used || 0)); entitlement.results = Array.isArray(entitlement.results) ? entitlement.results : []; entitlement.results.push({ examId, score: result.score, valuesCorrect: result.valuesCorrect, passed: result.passed, at: nowIso() }); entitlement.lastQuestionIds = (exam.questions || []).map(questionKey); entitlement.updatedAt = nowIso(); entStore.entitlements[entitlement.token || exam.accessToken] = entitlement; if (entitlement.userId) entStore.byUserId[entitlement.userId] = entitlement.token || exam.accessToken; await saveEntitlementsStore(entStore); } await saveExamStore(store); res.json({ ok: true, result, attempts, entitlement: publicEntitlement(entitlement) }); } catch (error) { next(error); } });


/* ==========================================================================
   Full backend citizenship exam product API
   Non-breaking aliases and analytics layer for dashboard/product use.
========================================================================== */
function citizenshipExamSummary(exam = {}) {
  const result = exam.result || {};
  return {
    id: exam.id,
    type: exam.type,
    status: exam.status || 'started',
    plan: exam.plan || null,
    createdAt: exam.createdAt || null,
    submittedAt: exam.submittedAt || null,
    score: Number.isFinite(Number(result.score)) ? Number(result.score) : null,
    total: Number.isFinite(Number(result.total)) ? Number(result.total) : 20,
    valuesCorrect: Number.isFinite(Number(result.valuesCorrect)) ? Number(result.valuesCorrect) : null,
    valuesTotal: Number.isFinite(Number(result.valuesTotal)) ? Number(result.valuesTotal) : 5,
    passed: typeof result.passed === 'boolean' ? result.passed : null,
    passedOverall: typeof result.passedOverall === 'boolean' ? result.passedOverall : null,
    passedValues: typeof result.passedValues === 'boolean' ? result.passedValues : null,
    categories: result.categories || {},
  };
}

function getUserCitizenshipExamHistory(userId) {
  const store = getExamStore();
  return Object.values(store.exams || {})
    .filter(exam => exam && String(exam.userId || '') === String(userId || ''))
    .sort((a, b) => String(b.submittedAt || b.createdAt || '').localeCompare(String(a.submittedAt || a.createdAt || '')))
    .map(citizenshipExamSummary);
}

function calculateCitizenshipReadiness(history = []) {
  const submitted = (Array.isArray(history) ? history : []).filter(row => row.status === 'submitted' && Number.isFinite(Number(row.score)));
  if (!submitted.length) {
    return { examsTaken: 0, averageScore: 0, bestScore: 0, passRate: 0, readiness: 0, status: 'Not started', weakAreas: [], categoryBreakdown: {} };
  }
  const avg = submitted.reduce((sum, row) => sum + Number(row.score || 0), 0) / submitted.length;
  const best = Math.max(...submitted.map(row => Number(row.score || 0)));
  const passRate = Math.round((submitted.filter(row => row.passed).length / submitted.length) * 100);
  const categoryTotals = {};
  submitted.forEach(row => {
    Object.entries(row.categories || {}).forEach(([category, value]) => {
      if (!categoryTotals[category]) categoryTotals[category] = { correct: 0, total: 0 };
      categoryTotals[category].correct += Number(value.correct || 0);
      categoryTotals[category].total += Number(value.total || 0);
    });
  });
  const categoryBreakdown = {};
  Object.entries(categoryTotals).forEach(([category, value]) => {
    categoryBreakdown[category] = { ...value, percent: value.total ? Math.round((value.correct / value.total) * 100) : 0 };
  });
  const weakAreas = Object.entries(categoryBreakdown)
    .filter(([, value]) => value.total >= 2 && value.percent < 75)
    .sort((a, b) => a[1].percent - b[1].percent)
    .map(([category, value]) => ({ category, percent: value.percent, correct: value.correct, total: value.total }));
  const readiness = Math.max(0, Math.min(100, Math.round((avg / 20) * 100)));
  let status = 'Not ready';
  if (readiness >= 90 && submitted[0] && submitted[0].passed) status = 'Exam ready';
  else if (readiness >= 75) status = 'Ready';
  else if (readiness >= 60) status = 'Borderline';
  return { examsTaken: submitted.length, averageScore: Number(avg.toFixed(1)), bestScore: best, passRate, readiness, status, weakAreas, categoryBreakdown };
}

function startCitizenshipExamForUser(user, body = {}) {
  const accessToken = String(body.accessToken || '').trim();
  const plan = String(body.plan || '').trim().toLowerCase();
  const entStore = getEntitlementsStore();
  let entitlement = user ? findUserEntitlement(user.id) : null;
  let entitlementToken = entitlement ? entitlement.token : accessToken;
  if (!entitlement && accessToken) entitlement = entStore.entitlements[accessToken] || null;
  if (!entitlement) {
    const error = new Error('Paid entitlement was not found or has not been verified.');
    error.statusCode = 403;
    throw error;
  }
  if (user && entitlement.userId && entitlement.userId !== user.id) {
    const error = new Error('This paid exam pack belongs to a different account.');
    error.statusCode = 403;
    throw error;
  }
  if (plan && entitlement.plan && entitlement.plan !== plan) {
    const error = new Error('Plan does not match paid entitlement.');
    error.statusCode = 400;
    throw error;
  }
  const unlimited = entitlement.total === null || entitlement.total === undefined || String(entitlement.plan || '').toLowerCase() === 'unlimited';
  const remaining = unlimited ? Infinity : Math.max(0, Number(entitlement.total || 0) - Number(entitlement.used || 0));
  if (!unlimited && remaining <= 0) {
    const error = new Error('No paid attempts remaining.');
    error.statusCode = 403;
    throw error;
  }
  const questions = pickCitizenshipExamQuestions(entitlement.lastQuestionIds || []);
  const examId = safeId('citpaid');
  const store = getExamStore();
  store.exams[examId] = {
    id: examId,
    type: 'paid',
    accessToken: entitlementToken,
    userId: entitlement.userId || (user ? user.id : null),
    plan: entitlement.plan,
    questions,
    answers: null,
    status: 'started',
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  return { store, exam: store.exams[examId], entitlement, questions };
}

app.post('/api/exam/start', requireCitizenshipAuth, async (req, res, next) => {
  try {
    const started = startCitizenshipExamForUser(req.user, req.body || {});
    await saveExamStore(started.store);
    return res.json({
      ok: true,
      examId: started.exam.id,
      total: 20,
      timeLimitSeconds: 45 * 60,
      entitlement: publicEntitlement(started.entitlement),
      questions: started.questions.map(sanitizeCitizenshipQuestion),
    });
  } catch (error) { next(error); }
});

app.post('/api/exam/submit', requireCitizenshipAuth, async (req, res, next) => {
  try {
    const examId = String(req.body?.examId || '').trim();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const store = getExamStore();
    const exam = store.exams[examId] || null;
    if (!exam) return res.status(404).json({ ok: false, error: 'Exam was not found.' });
    if (exam.userId && exam.userId !== req.user.id) return res.status(403).json({ ok: false, error: 'This exam belongs to a different account.' });
    if (exam.status === 'submitted') return res.status(409).json({ ok: false, error: 'This exam has already been submitted.' });
    const result = evaluateCitizenshipExam(exam.questions || [], answers);
    exam.answers = answers;
    exam.result = result;
    exam.status = 'submitted';
    exam.submittedAt = nowIso();
    exam.userId = exam.userId || req.user.id;

    const entStore = getEntitlementsStore();
    let entitlement = exam.accessToken ? entStore.entitlements[exam.accessToken] || null : null;
    if (!entitlement && exam.userId && entStore.byUserId && entStore.byUserId[exam.userId]) entitlement = entStore.entitlements[entStore.byUserId[exam.userId]] || null;
    if (exam.type === 'paid') {
      if (!entitlement) return res.status(403).json({ ok: false, error: 'Paid entitlement was not found.' });
      const unlimited = entitlement.total === null || entitlement.total === undefined || String(entitlement.plan || '').toLowerCase() === 'unlimited';
      entitlement.used = unlimited ? Number(entitlement.used || 0) + 1 : Math.min(Number(entitlement.total || 0), Number(entitlement.used || 0) + 1);
      entitlement.remaining = unlimited ? null : Math.max(0, Number(entitlement.total || 0) - Number(entitlement.used || 0));
      entitlement.results = Array.isArray(entitlement.results) ? entitlement.results : [];
      entitlement.results.push({ examId, score: result.score, valuesCorrect: result.valuesCorrect, valuesTotal: result.valuesTotal, passed: result.passed, at: nowIso(), categories: result.categories });
      entitlement.lastQuestionIds = (exam.questions || []).map(questionKey);
      entitlement.updatedAt = nowIso();
      entStore.entitlements[entitlement.token || exam.accessToken] = entitlement;
      if (entitlement.userId) entStore.byUserId[entitlement.userId] = entitlement.token || exam.accessToken;
      await saveEntitlementsStore(entStore);
    }
    await saveExamStore(store);
    const history = getUserCitizenshipExamHistory(req.user.id);
    return res.json({ ok: true, result, entitlement: publicEntitlement(entitlement), history: history.slice(0, 20), readiness: calculateCitizenshipReadiness(history) });
  } catch (error) { next(error); }
});

app.get('/api/exam/history', requireCitizenshipAuth, (req, res) => {
  const history = getUserCitizenshipExamHistory(req.user.id);
  return res.json({ ok: true, history, readiness: calculateCitizenshipReadiness(history), entitlement: publicEntitlement(findUserEntitlement(req.user.id)) });
});

app.get('/api/exam/readiness', requireCitizenshipAuth, (req, res) => {
  const history = getUserCitizenshipExamHistory(req.user.id);
  return res.json({ ok: true, readiness: calculateCitizenshipReadiness(history), history: history.slice(0, 10), entitlement: publicEntitlement(findUserEntitlement(req.user.id)) });
});

app.get('/api/exam/certificate/:examId', requireCitizenshipAuth, (req, res, next) => {
  try {
    const examId = String(req.params.examId || '').trim();
    const store = getExamStore();
    const exam = store.exams[examId] || null;
    if (!exam) return res.status(404).json({ ok: false, error: 'Exam was not found.' });
    if (exam.userId && exam.userId !== req.user.id) return res.status(403).json({ ok: false, error: 'This exam belongs to a different account.' });
    if (exam.status !== 'submitted' || !exam.result) return res.status(400).json({ ok: false, error: 'Certificate is only available after submission.' });
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="citizenship-mock-result-${sanitizeFileName(examId)}.pdf"`);
    doc.pipe(res);
    doc.fontSize(22).fillColor('#0b1f4d').text('Bircan Migration', { align: 'center' });
    doc.moveDown(0.5).fontSize(18).text('Australian Citizenship Mock Exam Result', { align: 'center' });
    doc.moveDown(1.5).fontSize(12).fillColor('#10203a');
    doc.text(`Candidate: ${req.user.username || req.user.email || 'Client'}`);
    doc.text(`Email: ${req.user.email || 'Not provided'}`);
    doc.text(`Exam ID: ${exam.id}`);
    doc.text(`Submitted: ${exam.submittedAt || todayHuman()}`);
    doc.moveDown(1);
    doc.fontSize(16).fillColor(exam.result.passed ? '#0d7a43' : '#c63b3b').text(exam.result.passed ? 'PASS' : 'NOT YET PASSED');
    doc.moveDown(0.5).fontSize(12).fillColor('#10203a');
    doc.text(`Overall score: ${exam.result.score}/${exam.result.total}`);
    doc.text(`Australian values score: ${exam.result.valuesCorrect}/${exam.result.valuesTotal}`);
    doc.moveDown(1);
    doc.text('Result notes:');
    (exam.result.reasons || []).forEach(reason => doc.text(`• ${reason}`));
    doc.moveDown(1.5).fontSize(9).fillColor('#5f6f8d').text('This is a practice/mock result only. It is not an official Department of Home Affairs citizenship test outcome.', { align: 'center' });
    doc.end();
  } catch (error) { next(error); }
});

app.post('/api/assessment/submit', async (req, res, next) => {
  try {
    const payload = extractAssessmentPayload(req.body);
    if (!payload.client.email) return res.status(400).json({ ok: false, error: 'Client email is required.' });

    const submissionId = safeId('sub');
    const releaseAt = calculateReleaseAt(payload.plan, nowIso());
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
      releaseAt,
      emailReleaseAt: releaseAt,
      scheduledEmailAt: releaseAt,
      releaseStatus: normalizePlan(payload.plan).code === 'instant' ? 'ready' : 'scheduled',
      releaseCountdownMs: Math.max(0, new Date(releaseAt).getTime() - Date.now()),
      emailReleased: false,
      emailReleasedAt: null,
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
      plan: submission.plan,
      releaseAt: submission.releaseAt,
      releaseStatus: submission.releaseStatus,
      message: 'Assessment submitted. AI analysis and PDF generation have started. Email will be released according to the selected plan.',
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
      releaseAt: getReleaseSnapshot(submission).releaseAt,
      releaseStatus: getReleaseSnapshot(submission).releaseStatus,
      releaseCountdownMs: getReleaseSnapshot(submission).releaseCountdownMs,
      emailReleased: getReleaseSnapshot(submission).emailReleased,
      emailReleasedAt: getReleaseSnapshot(submission).emailReleasedAt,
      plan: submission.plan || null,
      model: submission.analysis?.model || null,
      helperModel: submission.analysis?.helperModel || null,
      lastHeartbeatAt: submission.lastHeartbeatAt || submission.updatedAt || null,
      knowledgebase: {
        citations: submission.analysis?.analysis?.knowledgebaseCitations || [],
        used: submission.analysis?.analysis?.knowledgebaseUsed || [],
        retrievedChunkCount: submission.analysis?.knowledgebaseSummary?.retrievedChunkCount || 0,
      },
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
        plan: item.plan || null,
        releaseAt: getReleaseSnapshot(item).releaseAt,
        releaseStatus: getReleaseSnapshot(item).releaseStatus,
        releaseCountdownMs: getReleaseSnapshot(item).releaseCountdownMs,
        emailReleased: getReleaseSnapshot(item).emailReleased,
        emailReleasedAt: getReleaseSnapshot(item).emailReleasedAt,
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
      emailReleased: Boolean(result?.ok),
      emailReleasedAt: result?.ok ? nowIso() : null,
      releaseStatus: result?.ok ? 'released' : 'ready',
      releaseCountdownMs: 0,
    });
    res.json({ ok: true, submissionId: submission.id, result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/knowledgebase/upload', adminGuard, (req, res, next) => {
  kbUpload.any()(req, res, async uploadError => {
    try {
      if (uploadError) {
        uploadError.statusCode = Number(uploadError.statusCode || 400);
        throw uploadError;
      }

      const uploadedFiles = Array.isArray(req.files) ? req.files : [];
      const accepted = uploadedFiles.filter(file => {
        const field = String(file.fieldname || '').trim().toLowerCase();
        return field === 'files' || field === 'file';
      });

      const uniqueByStoredName = new Map();
      for (const file of accepted) {
        if (file && file.filename) uniqueByStoredName.set(file.filename, file);
      }
      const files = Array.from(uniqueByStoredName.values());

      if (!files.length) {
        return res.status(400).json({ ok: false, error: 'No files uploaded.' });
      }

      await loadKnowledgebaseIndex(true);

      return res.json({
        ok: true,
        items: files.map(file => ({
          fileName: file.filename,
          originalName: file.originalname,
          size: file.size,
          mimetype: file.mimetype,
          path: file.path,
        })),
        knowledgebase: {
          directory: KNOWLEDGEBASE_DIR,
          loadedAt: KNOWLEDGEBASE_STATE.loadedAt,
          fileCount: Array.isArray(KNOWLEDGEBASE_STATE.files) ? KNOWLEDGEBASE_STATE.files.length : 0,
          chunkCount: Array.isArray(KNOWLEDGEBASE_STATE.chunks) ? KNOWLEDGEBASE_STATE.chunks.length : 0,
          error: KNOWLEDGEBASE_STATE.error || null,
        }
      });
    } catch (error) {
      return next(error);
    }
  });
});



app.get('/api/routes/checkout-health', (_req, res) => {
  res.json({
    ok: true,
    frontendUrl: APP_BASE_URL,
    stripeConfigured: Boolean(stripe),
    stripeMode: STRIPE_MODE,
    checkoutRoutes: [
      'POST /create-visa-checkout-session',
      'POST /create-assessment-checkout-session',
      'POST /api/assessment/create-checkout-session',
      'POST /api/assessments/create-checkout-session',
      'POST /api/visa/create-checkout-session',
      'POST /api/checkout/visa'
    ],
    dashboardRoutes: [
      'GET /api/account/dashboard',
      'GET /api/account/assessments'
    ],
    expectedFrontendSuccess: buildStripeReturnUrl('/account-dashboard.html', { session_id: '{CHECKOUT_SESSION_ID}', visa_paid: 1 })
  });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((error, _req, res, _next) => {
  console.error('[server-error]', error);
  const status = Number(error.statusCode || error.status || 500);
  res.status(status).json({ ok: false, error: error.message || 'Internal Server Error' });
});


process.on('unhandledRejection', (error) => {
  console.error('[unhandled-rejection]', error);
});

process.on('uncaughtException', (error) => {
  console.error('[uncaught-exception]', error);
});

loadKnowledgebaseIndex(false).catch(error => {
  KNOWLEDGEBASE_STATE.error = error.message;
  console.error('[knowledgebase-load-error]', error);
});

setInterval(() => {
  runScheduledEmailReleasePass().catch(error => {
    console.error('[scheduled-email-release-pass-error]', error);
  });
}, 60 * 1000);

runScheduledEmailReleasePass().catch(error => {
  console.error('[scheduled-email-release-pass-error]', error);
});

app.listen(PORT, () => {
  console.log(`Bircan Migration backend listening on port ${PORT}`);
});
