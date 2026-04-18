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



function normaliseVisaType(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  const directMap = {
    '482': 'Subclass 482',
    'subclass 482': 'Subclass 482',
    'temporary skill shortage visa': 'Subclass 482',
    'skills in demand visa': 'Subclass 482',
    '186': 'Subclass 186',
    'subclass 186': 'Subclass 186',
    'employer nomination scheme visa': 'Subclass 186',
    '190': 'Subclass 190',
    'subclass 190': 'Subclass 190',
    'skilled nominated visa': 'Subclass 190',
    '189': 'Subclass 189',
    'subclass 189': 'Subclass 189',
    'skilled independent visa': 'Subclass 189',
    '491': 'Subclass 491',
    'subclass 491': 'Subclass 491',
    'skilled work regional visa': 'Subclass 491',
    '500': 'Subclass 500',
    'subclass 500': 'Subclass 500',
    'student visa': 'Subclass 500',
    '820': 'Subclass 820',
    'subclass 820': 'Subclass 820',
    '801': 'Subclass 801',
    'subclass 801': 'Subclass 801',
    '309': 'Subclass 309',
    'subclass 309': 'Subclass 309',
    '100': 'Subclass 100',
    'subclass 100': 'Subclass 100',
    'partner visa': 'Partner Visa',
    '485': 'Subclass 485',
    'subclass 485': 'Subclass 485',
    'graduate visa': 'Subclass 485',
    'visitor visa': 'Visitor Visa',
    '600': 'Subclass 600',
    'subclass 600': 'Subclass 600',
    'citizenship': 'Australian Citizenship',
    'citizenship by conferral': 'Australian Citizenship'
  };
  return directMap[lower] || raw || 'Subclass 482';
}

function buildVisaProfiles() {
  return {
    'Subclass 482': {
      stream: 'Employer Sponsored',
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
        { title: 'Nomination Dependency and Employer-Side Exposure', type: 'bullets', key: 'nominationRisks', fallback: 'No employer-side nomination risks were specifically identified.' },
      ],
      checklist: [
        'Sponsor approval or sponsorship status evidence',
        'Nomination position description and organisational chart',
        'Employment contract and salary details',
        'Detailed employment references and payslips',
        'Licence/registration evidence if occupation requires it',
      ]
    },
    'Subclass 186': {
      stream: 'Employer Sponsored Permanent',
      displayName: 'Subclass 186',
      promptFocus: [
        '- Assess whether the facts suggest a Temporary Residence Transition pathway or Direct Entry pathway issue.',
        '- Evaluate the genuineness and permanence of the nominated role and any employer compliance exposure.',
        '- Assess age, English, skills assessment, and work experience issues as possible threshold or waiver issues.',
        '- Make clear whether the client appears ready for permanent employer-sponsored lodgement or should delay.',
      ],
      pdfSections: [
        { title: 'Permanent Employer Sponsorship Position', type: 'paragraph', key: 'sponsorshipAssessment', fallback: 'Permanent employer sponsorship analysis was not generated.' },
        { title: 'Threshold Eligibility Issues', type: 'bullets', key: 'thresholdIssues', fallback: 'No distinct threshold eligibility issues were identified.' },
      ],
      checklist: [
        'Employer nomination and permanent role evidence',
        'Employment history and salary evidence',
        'Skills assessment or exemption basis',
        'English evidence or exemption pathway',
        'Age exemption evidence if relevant',
      ]
    },
    'Subclass 189': {
      stream: 'General Skilled Migration',
      displayName: 'Subclass 189',
      promptFocus: [
        '- Assess points competitiveness, invitation dependence, skills assessment position, and English score leverage.',
        '- Distinguish between present substantive eligibility and realistic invitation prospects.',
        '- Identify if the matter is legally viable but strategically weak due to points ranking.',
      ],
      pdfSections: [
        { title: 'Points Test and Invitation Competitiveness', type: 'paragraph', key: 'pointsAssessment', fallback: 'Points competitiveness analysis was not generated.' },
        { title: 'Invitation Risks', type: 'bullets', key: 'invitationRisks', fallback: 'No invitation-specific risks were identified.' },
      ],
      checklist: [
        'Skills assessment outcome',
        'English test results',
        'Employment evidence for points claims',
        'Qualification evidence',
        'EOI assumptions and claimed points support',
      ]
    },
    'Subclass 190': {
      stream: 'State Nominated',
      displayName: 'Subclass 190',
      promptFocus: [
        '- Assess points position together with state nomination viability and likely state-specific exposure.',
        '- Distinguish state nomination uncertainty from federal visa criteria.',
        '- Explain whether the client should proceed now, change state strategy, or improve profile before lodgement.',
      ],
      pdfSections: [
        { title: 'State Nomination Position', type: 'paragraph', key: 'stateNominationAssessment', fallback: 'State nomination analysis was not generated.' },
        { title: 'Points and Invitation Risks', type: 'bullets', key: 'invitationRisks', fallback: 'No state nomination or invitation risks were specifically identified.' },
      ],
      checklist: [
        'Skills assessment outcome',
        'English results and points evidence',
        'State ties or residency/employment evidence if relevant',
        'Employment references',
        'Qualification and identity evidence',
      ]
    },
    'Subclass 491': {
      stream: 'Regional Skilled',
      displayName: 'Subclass 491',
      promptFocus: [
        '- Assess regional nomination or family sponsorship pathway viability.',
        '- Identify regional residence commitment issues, state nomination criteria, and invitation competitiveness.',
        '- Distinguish between legal eligibility and practical competitiveness.',
      ],
      pdfSections: [
        { title: 'Regional Pathway Position', type: 'paragraph', key: 'stateNominationAssessment', fallback: 'Regional pathway analysis was not generated.' },
        { title: 'Regional and Invitation Risks', type: 'bullets', key: 'invitationRisks', fallback: 'No regional or invitation risks were specifically identified.' },
      ],
      checklist: [
        'Skills assessment outcome',
        'Regional nomination or family sponsor evidence',
        'English and points evidence',
        'Regional commitment and residence planning',
        'Employment and qualification evidence',
      ]
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
        { title: 'Study Plan and Genuine Student Position', type: 'paragraph', key: 'genuineStudentAssessment', fallback: 'Genuine student analysis was not generated.' },
        { title: 'Financial and Credibility Risks', type: 'bullets', key: 'genuineStudentRisks', fallback: 'No specific student credibility risks were identified.' },
      ],
      checklist: [
        'Confirmation of Enrolment or intended course details',
        'Financial capacity evidence',
        'Academic history and transcripts',
        'Statement addressing study rationale and future plans',
        'English evidence and immigration history documents',
      ]
    },
    'Partner Visa': {
      stream: 'Family',
      displayName: 'Partner Visa',
      promptFocus: [
        '- Assess relationship genuineness across financial, social, household, and commitment indicators.',
        '- Distinguish evidence gaps from fatal credibility concerns.',
        '- Identify whether timing, cohabitation evidence, or sponsor history creates elevated refusal exposure.',
      ],
      pdfSections: [
        { title: 'Relationship Evidence Position', type: 'paragraph', key: 'relationshipAssessment', fallback: 'Relationship evidence analysis was not generated.' },
        { title: 'Relationship and Sponsor Risks', type: 'bullets', key: 'relationshipRisks', fallback: 'No relationship-specific risks were identified.' },
      ],
      checklist: [
        'Relationship timeline and statements',
        'Financial co-mingling evidence',
        'Household and cohabitation evidence',
        'Social recognition evidence',
        'Sponsor eligibility and identity documents',
      ]
    },
    'Subclass 820': {
      stream: 'Family',
      displayName: 'Subclass 820',
      aliasOf: 'Partner Visa'
    },
    'Subclass 801': {
      stream: 'Family',
      displayName: 'Subclass 801',
      aliasOf: 'Partner Visa'
    },
    'Subclass 309': {
      stream: 'Family',
      displayName: 'Subclass 309',
      aliasOf: 'Partner Visa'
    },
    'Subclass 100': {
      stream: 'Family',
      displayName: 'Subclass 100',
      aliasOf: 'Partner Visa'
    },
    'Subclass 485': {
      stream: 'Graduate',
      displayName: 'Subclass 485',
      promptFocus: [
        '- Assess course completion position, Australian study requirement issues, English threshold, and timing exposure.',
        '- Identify whether the main issue is eligibility timing, qualification mismatch, or evidence readiness.',
      ],
      pdfSections: [
        { title: 'Graduate Eligibility Position', type: 'paragraph', key: 'graduateAssessment', fallback: 'Graduate visa analysis was not generated.' },
        { title: 'Timing and Evidence Risks', type: 'bullets', key: 'timingRisks', fallback: 'No specific graduate timing risks were identified.' },
      ],
      checklist: [
        'Completion letter and academic transcript',
        'Australian study requirement evidence',
        'English evidence',
        'AFP check / timing readiness',
        'Health insurance and identity documents',
      ]
    },
    'Subclass 600': {
      stream: 'Visitor',
      displayName: 'Subclass 600',
      promptFocus: [
        '- Assess temporary entrant credibility, travel purpose, funding, and home country incentive to depart.',
        '- Identify if refusal risk arises from weak temporary intent, poor funding evidence, or family/employment ties.',
      ],
      pdfSections: [
        { title: 'Temporary Entrant Position', type: 'paragraph', key: 'temporaryEntrantAssessment', fallback: 'Temporary entrant analysis was not generated.' },
        { title: 'Departure and Funding Risks', type: 'bullets', key: 'temporaryEntrantRisks', fallback: 'No specific visitor visa risks were identified.' },
      ],
      checklist: [
        'Travel purpose evidence',
        'Funding evidence',
        'Employment or business ties',
        'Family and home country ties',
        'Travel history documents',
      ]
    },
    'Australian Citizenship': {
      stream: 'Citizenship',
      displayName: 'Australian Citizenship',
      promptFocus: [
        '- Assess residence requirement position, permanent residence timing, character exposure, and eligibility readiness.',
        '- Identify if the matter is immediately ready or requires further wait time or evidence.',
      ],
      pdfSections: [
        { title: 'Residence Requirement Position', type: 'paragraph', key: 'residenceAssessment', fallback: 'Residence requirement analysis was not generated.' },
        { title: 'Character or Timing Risks', type: 'bullets', key: 'timingRisks', fallback: 'No citizenship-specific timing risks were identified.' },
      ],
      checklist: [
        'Travel movement record',
        'PR grant evidence',
        'Identity documents',
        'Character disclosures and court records if relevant',
        'Residency timeline summary',
      ]
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
    checklist: []
  };
  if (profile.aliasOf && VISA_PROFILES[profile.aliasOf]) {
    return { ...VISA_PROFILES[profile.aliasOf], displayName: profile.displayName || normalised };
  }
  return profile;
}

function getSupportedVisaTypes() {
  return Object.keys(VISA_PROFILES);
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
  if (textBlob.includes('experience') || textBlob.includes('employment') || textBlob.includes('work')) additions.push('Detailed employment references, contracts, and remuneration evidence');
  if (textBlob.includes('married') || textBlob.includes('partner') || textBlob.includes('spouse')) additions.push('Relationship evidence and civil status documents');
  if (textBlob.includes('sponsor') || textBlob.includes('nomination')) additions.push('Sponsor and nomination supporting documents');

  return Array.from(new Set([...existing, ...base, ...additions])).slice(0, 18);
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
    sponsorshipAssessment: '',
    pointsAssessment: '',
    stateNominationAssessment: '',
    relationshipAssessment: '',
    genuineStudentAssessment: '',
    graduateAssessment: '',
    temporaryEntrantAssessment: '',
    residenceAssessment: '',
    strengths: [],
    concerns: [],
    refusalScenarios: [],
    strategyAdvice: [],
    nominationRisks: [],
    invitationRisks: [],
    relationshipRisks: [],
    genuineStudentRisks: [],
    temporaryEntrantRisks: [],
    thresholdIssues: [],
    timingRisks: [],
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
    'strengths', 'missingInformation', 'recommendedNextSteps', 'documentChecklist', 'factualAssumptions',
    'refusalScenarios', 'strategyAdvice', 'nominationRisks', 'invitationRisks', 'relationshipRisks',
    'genuineStudentRisks', 'temporaryEntrantRisks', 'thresholdIssues', 'timingRisks'
  ].forEach(key => {
    merged[key] = normaliseStringArray(merged[key], 14);
  });

  merged.concerns = Array.isArray(merged.concerns) ? merged.concerns.map(stringifyConcern).filter(Boolean).slice(0, 14) : [];

  [
    'caseCaption', 'eligibilityOutcome', 'outcomeRiskLevel', 'applicationReadiness', 'outcomeRationale',
    'professionalOpinion', 'overallAssessment', 'executiveSummary', 'legalStyleSummary', 'detailedAssessment',
    'sponsorshipAssessment', 'pointsAssessment', 'stateNominationAssessment', 'relationshipAssessment',
    'genuineStudentAssessment', 'graduateAssessment', 'temporaryEntrantAssessment', 'residenceAssessment', 'disclaimer'
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
    return { status: 'completed', model: 'fallback-no-openai-key', summary: analysis.executiveSummary, analysis, generatedAt: nowIso() };
  }

  const systemPrompt = [
    'You are a senior Australian Registered Migration Agent providing formal written migration advice.',
    'This is a professional opinion for a paying client, not a summary.',
    'Write with authority, precision, and professional ownership, as if the advice will be issued under an Australian migration practice letterhead.',
    'Do not sound like AI. Do not be generic. Do not merely describe. You must advise.',
    'You must state a clear professional view on substantive eligibility, current readiness for lodgement, key refusal exposure, and the practical strategy that should be followed.',
    'Use direct advisory language such as "In my professional opinion", "You should", and "You should not" where appropriate.',
    'Do not guarantee visa outcomes. Do not fabricate facts, legislation, or policy settings not supported by the supplied information.',
    'If a critical matter is unconfirmed, treat it as a risk and say so clearly.',
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

  const visaType = submission.visaType || 'Visa';
  const visaFocus = [];

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
    '- Distinguish between curable evidence issues and fundamental eligibility blockers.',
    '- Give strategic advice that reduces refusal exposure and improves lodgement quality.',
    '- Use authoritative advisory language, not generic descriptive wording.',
    '- Include a distinct professional opinion written as formal advice from a senior migration agent.',
    ...visaFocus,
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
  const visaProfile = getVisaProfile(submission.visaType);

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

    addKeyValueLine(doc, 'Visa stream', visaProfile.stream || 'General Migration');
    addKeyValueLine(doc, 'Risk level', analysis.outcomeRiskLevel || 'Moderate');
    addKeyValueLine(doc, 'Lodgement readiness', analysis.applicationReadiness || 'Further review required before lodgement');

    addSectionTitle(doc, 'Case Summary');
    addParagraph(doc, analysis.executiveSummary || submission.analysis?.summary || 'Assessment summary not available.');

    addSectionTitle(doc, 'Outcome Rationale');
    addParagraph(doc, analysis.outcomeRationale || analysis.legalStyleSummary || analysis.overallAssessment || 'Outcome rationale not available.');

    addSectionTitle(doc, 'Professional Opinion');
    addParagraph(doc, analysis.professionalOpinion || analysis.overallAssessment || 'Professional opinion was not generated.');

    for (const section of (visaProfile.pdfSections || [])) {
      addSectionTitle(doc, section.title);
      if (section.type === 'bullets') addBulletList(doc, analysis[section.key], section.fallback || 'No details available.');
      else addParagraph(doc, analysis[section.key] || section.fallback || 'No details available.');
    }

    addSectionTitle(doc, 'Detailed Assessment');
    addParagraph(doc, analysis.detailedAssessment || analysis.legalStyleSummary || analysis.overallAssessment || 'Detailed assessment was not generated.');

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
    supportedVisaTypes: getSupportedVisaTypes(),
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
