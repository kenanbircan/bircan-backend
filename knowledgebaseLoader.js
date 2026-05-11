'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const ROOT = path.join(__dirname, 'knowledgebase');
const MAX_DOCS_IN_PROMPT = Number(process.env.KB_MAX_DOCS_IN_PROMPT || 14);
const MAX_CHARS_PER_DOC = Number(process.env.KB_MAX_CHARS_PER_DOC || 14000);
const MAX_TOTAL_CHARS = Number(process.env.KB_MAX_TOTAL_CHARS || 90000);
const CACHE = new Map();

function norm(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function subclassOf(v) { return String(v || '').replace(/[^0-9]/g, ''); }
function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function flattenForSubclass(input, out = []) {
  if (input === undefined || input === null) return out;
  if (typeof input === 'string' || typeof input === 'number') { out.push(String(input)); return out; }
  if (Array.isArray(input)) { input.forEach(v => flattenForSubclass(v, out)); return out; }
  if (isPlainObject(input)) {
    for (const [k, v] of Object.entries(input)) {
      if (/password|token|authorization|bm_session/i.test(k)) continue;
      out.push(String(k));
      flattenForSubclass(v, out);
    }
  }
  return out;
}
function extractVisaSubclass(assessment = {}) {
  const direct = subclassOf(assessment.visa_type || assessment.visaType || assessment.subclass || assessment.visaSubclass || assessment.visa_subclass || '');
  if (direct) return direct;
  const payloads = [assessment.form_payload, assessment.formPayload, assessment.answers, assessment.rawSubmission, assessment];
  const text = flattenForSubclass(payloads).join(' ');
  const keyed = text.match(/(?:subclass|visa\s*type|visa\s*subclass|visaType|visaSubclass)[^0-9]{0,24}(\d{3})/i);
  if (keyed) return keyed[1];
  const standalone = text.match(/\b(101|103|115|116|173|186|187|188|189|190|300|309|407|482|491|494|500|600|820|866)\b/);
  return standalone ? standalone[1] : '';
}
function extractSelectedStream(assessment = {}) {
  const text = flattenForSubclass([assessment.form_payload, assessment.formPayload, assessment.answers, assessment.rawSubmission, assessment]).join(' ').toLowerCase();
  if (/labou?r\s+agreement|\bdama\b/.test(text)) return 'Labour Agreement';
  if (/temporary\s+residence\s+transition|\btrt\b/.test(text)) return 'Temporary Residence Transition';
  if (/direct\s+entry|\bde\b/.test(text)) return 'Direct Entry';
  if (/graduate|postgraduate/.test(text)) return 'Graduate';
  if (/training|occupational\s+training/.test(text)) return 'Training';
  if (/partner|spouse|de\s*facto|defacto/.test(text)) return 'Partner';
  return '';
}
function classifyLegalAuthority(file) {
  const rel = norm(file.rel || file.path || file.name);
  const name = norm(file.name || file.path || '');
  if (/\bact\b|acts|migration act|c2026|c20\d{2}/i.test(rel + ' ' + name)) return 'ACT';
  if (/regulation|regulations|migration regulations|f2026|f20\d{2}/i.test(rel + ' ' + name)) return 'REGULATIONS';
  if (/instrument|instruments|lin | immi | legislative instrument|determination|specification/i.test(rel + ' ' + name)) return 'INSTRUMENTS';
  if (/pam|policy|subclass|procedure advice manual/i.test(rel + ' ' + name)) return 'PAMS';
  return 'OTHER';
}
const LEGAL_AUTHORITY_ORDER = ['ACT', 'REGULATIONS', 'INSTRUMENTS', 'PAMS', 'OTHER'];
function authorityRank(authority) { const i = LEGAL_AUTHORITY_ORDER.indexOf(authority); return i === -1 ? 99 : i; }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function buildLegalVersionLock({ extracted = [], subclass = '', selectedStream = '', assessmentKind = 'MIGRATION' } = {}) {
  const checkedAt = new Date().toISOString();
  const sourceHashes = (Array.isArray(extracted) ? extracted : []).map(s => ({
    authority: s.authority || 'OTHER',
    path: s.path || '',
    sha256: s.sha256 || '',
    modified: s.modified || null,
    chars: Number(s.chars || 0)
  })).filter(s => s.path && s.sha256);
  const aggregateInput = sourceHashes
    .map(s => [s.authority, s.path, s.sha256, s.modified || '', s.chars].join('|'))
    .join('\n');
  const latestSourceModifiedAt = sourceHashes
    .map(s => s.modified)
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || null;
  return {
    checkedAt,
    effectiveAsAt: checkedAt,
    timezone: 'UTC',
    assessmentKind,
    subclass,
    selectedStream: selectedStream || '',
    legalAuthorityOrder: LEGAL_AUTHORITY_ORDER,
    sourceCount: sourceHashes.length,
    sourceHashes,
    latestSourceModifiedAt,
    sourceHashAggregate: crypto.createHash('sha256').update(aggregateInput || checkedAt).digest('hex'),
    note: 'This version lock records the knowledgebase sources and hashes supplied to the advice engine at generation time.'
  };
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (/\.(pdf|docx|txt|md)$/i.test(name)) out.push({ full, rel: path.relative(ROOT, full), name, stat });
  }
  return out;
}

function inferAssessmentKind(assessment = {}) {
  const blob = norm(JSON.stringify(assessment));
  // Visa subclass extraction is the first gate. A visa subclass means this is a migration
  // assessment unless the service type itself is expressly appeals/citizenship.
  const explicitService = norm(assessment.service_type || assessment.serviceType || assessment.assessment_type || assessment.assessmentType || '');
  if (/citizenship|conferral|citizenship test|pledge/.test(explicitService)) return 'CITIZENSHIP';
  if (/appeal|aart|tribunal|merits review/.test(explicitService)) return 'APPEALS';
  if (extractVisaSubclass(assessment)) return 'MIGRATION';
  if (/citizenship|conferral|citizenship test|pledge/.test(blob)) return 'CITIZENSHIP';
  if (/appeal|aart|tribunal|merits review/.test(blob)) return 'APPEALS';
  return 'MIGRATION';
}

function buildSearchTerms(assessment = {}) {
  const code = subclassOf(assessment.visa_type || assessment.subclass || assessment.visaSubclass || '');
  const flat = norm(JSON.stringify(assessment.form_payload || assessment.answers || assessment));
  const terms = new Set(['migration', 'visa', 'criterion', 'schedule', 'regulation']);
  if (code) terms.add(code), terms.add(`subclass ${code}`);
  for (const t of ['nomination','sponsor','skills','english','points','partner','relationship','health','character','genuine','student','protection','refusal','cancellation','citizenship','appeal','review']) {
    if (flat.includes(t)) terms.add(t);
  }
  return [...terms].filter(Boolean);
}

function scoreFile(file, assessment = {}) {
  const rel = norm(file.rel);
  const name = norm(file.name);
  const code = extractVisaSubclass(assessment);
  const stream = norm(extractSelectedStream(assessment));
  const kind = inferAssessmentKind(assessment);
  const authority = classifyLegalAuthority(file);
  let score = 0;
  if (rel.includes(kind.toLowerCase())) score += 50;
  if (authority === 'ACT') score += 80;
  if (authority === 'REGULATIONS') score += 90;
  if (authority === 'INSTRUMENTS') score += 70;
  if (authority === 'PAMS') score += 85;
  if (code && (name.includes(`subclass ${code}`) || name.includes(code) || rel.includes(`subclass ${code}`) || rel.includes(code))) score += 160;
  if (stream && (rel.includes(stream) || name.includes(stream))) score += 35;
  if (/migration\/acts/i.test(file.rel)) score += 40;
  if (/migration\/regulations/i.test(file.rel)) score += 50;
  if (/migration\/instruments/i.test(file.rel)) score += 45;
  if (/migration\/pams/i.test(file.rel)) score += 55;
  return score;
}

async function extractText(file) {
  const buf = fs.readFileSync(file.full);
  const hash = sha256(buf);
  const key = `${file.rel}:${file.stat.mtimeMs}:${hash}`;
  if (CACHE.has(key)) return CACHE.get(key);
  let text = '';
  if (/\.pdf$/i.test(file.name)) {
    const parsed = await pdfParse(buf);
    text = parsed.text || '';
  } else if (/\.docx$/i.test(file.name)) {
    const parsed = await mammoth.extractRawText({ buffer: buf });
    text = parsed.value || '';
  } else {
    text = buf.toString('utf8');
  }
  text = text.replace(/\s+/g, ' ').trim();
  const out = { ...file, hash, chars: text.length, text };
  CACHE.set(key, out);
  return out;
}

function clip(text, max) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, Math.floor(max * 0.65)) + '\n[...source extract clipped for prompt length...]\n' + text.slice(-Math.floor(max * 0.35));
}

async function buildKnowledgebaseLegalPack(assessment = {}) {
  const files = walk(ROOT).filter(f => !/^A$/i.test(f.name));
  if (!files.length) throw new Error('Knowledgebase folder is missing or empty. Refusing to generate advice letter.');

  // FIRST GATE: identify visa subclass and selected stream before selecting legal sources.
  const subclass = extractVisaSubclass(assessment);
  const selectedStream = extractSelectedStream(assessment);
  const assessmentKind = inferAssessmentKind({ ...assessment, visa_type: subclass });
  if (assessmentKind === 'MIGRATION' && !subclass) {
    throw new Error('Visa subclass could not be identified. Knowledgebase-enforced advice generation blocked.');
  }

  const allAuthoritiesAvailable = LEGAL_AUTHORITY_ORDER.reduce((acc, key) => ({ ...acc, [key]: false }), {});
  for (const f of files) allAuthoritiesAvailable[classifyLegalAuthority(f)] = true;

  const scored = files
    .map(f => ({ ...f, authority: classifyLegalAuthority(f), score: scoreFile(f, { ...assessment, visa_type: subclass }) }))
    .sort((a, b) => authorityRank(a.authority) - authorityRank(b.authority) || b.score - a.score || b.stat.mtimeMs - a.stat.mtimeMs);

  const byAuthority = new Map();
  for (const f of scored.filter(f => f.score > 0)) {
    if (!byAuthority.has(f.authority)) byAuthority.set(f.authority, []);
    byAuthority.get(f.authority).push(f);
  }

  // Select in legal authority order: Act -> Regulations -> Instruments -> PAMs.
  const selected = [];
  for (const authority of LEGAL_AUTHORITY_ORDER) {
    const candidates = (byAuthority.get(authority) || []).slice(0, authority === 'PAMS' ? 4 : authority === 'INSTRUMENTS' ? 3 : 3);
    selected.push(...candidates);
  }
  const selectedLimited = selected.slice(0, MAX_DOCS_IN_PROMPT);
  if (!selectedLimited.length) throw new Error('No relevant legal knowledgebase documents were selected. Refusing to generate advice letter.');

  const hasSubclassSource = subclass && selectedLimited.some(f => {
    const combined = norm(`${f.rel} ${f.name}`);
    return combined.includes(`subclass ${subclass}`) || combined.includes(subclass);
  });
  if (assessmentKind === 'MIGRATION' && !hasSubclassSource) {
    throw new Error(`Subclass ${subclass} legal/PAM source is missing from the knowledgebase selection. Refusing to generate advice letter.`);
  }

  const strictInstruments = String(process.env.KB_REQUIRE_INSTRUMENTS || '').toLowerCase() === 'true';
  const hasAvailableInstruments = allAuthoritiesAvailable.INSTRUMENTS;
  const hasSelectedInstruments = selectedLimited.some(f => f.authority === 'INSTRUMENTS');
  if (assessmentKind === 'MIGRATION' && strictInstruments && !hasSelectedInstruments) {
    throw new Error('Legislative Instruments source was not loaded from knowledgebase. Advice generation blocked.');
  }
  if (assessmentKind === 'MIGRATION' && hasAvailableInstruments && !hasSelectedInstruments) {
    throw new Error('Knowledgebase contains Instruments but none were selected for the subclass. Advice generation blocked.');
  }

  const extracted = [];
  let total = 0;
  for (const f of selectedLimited) {
    const e = await extractText(f);
    const remaining = MAX_TOTAL_CHARS - total;
    if (remaining <= 0) break;
    const excerpt = clip(e.text, Math.min(MAX_CHARS_PER_DOC, remaining));
    total += excerpt.length;
    extracted.push({ authority: f.authority, path: e.rel, sha256: e.hash, modified: e.stat.mtime.toISOString(), chars: e.chars, excerpt });
  }

  const hierarchy = LEGAL_AUTHORITY_ORDER.map(authority => ({
    authority,
    loaded: extracted.filter(s => s.authority === authority).map(s => ({ path: s.path, sha256: s.sha256, modified: s.modified, chars: s.chars })),
    availableInKnowledgebase: !!allAuthoritiesAvailable[authority]
  }));

  const legalVersionLock = buildLegalVersionLock({ extracted, subclass, selectedStream, assessmentKind });
  const manifest = scored.map(f => ({ path: f.rel, authority: f.authority, score: f.score, modified: f.stat.mtime.toISOString(), bytes: f.stat.size }));
  return {
    loadedAt: new Date().toISOString(),
    root: 'knowledgebase',
    assessmentKind,
    subclass,
    selectedStream,
    subclassExtraction: { subclass, selectedStream, source: 'assessment-first-gate' },
    legalAuthorityOrder: LEGAL_AUTHORITY_ORDER,
    hierarchyEnforced: true,
    legalVersionLock,
    documentCountScanned: files.length,
    documentCountLoaded: extracted.length,
    searchTerms: buildSearchTerms({ ...assessment, visa_type: subclass }),
    manifest,
    hierarchy,
    sources: extracted.sort((a,b) => authorityRank(a.authority) - authorityRank(b.authority)),
  };
}

function assertKnowledgebasePack(pack) {
  if (!pack || !Array.isArray(pack.sources) || pack.sources.length < 2) {
    throw new Error('Knowledgebase legal-source pack was not loaded. Advice generation blocked.');
  }
  if (pack.assessmentKind === 'MIGRATION' && !pack.subclass) {
    throw new Error('Visa subclass was not extracted before knowledgebase loading. Advice generation blocked.');
  }
  if (pack.assessmentKind === 'MIGRATION' && !pack.sources.some(s => s.authority === 'ACT')) {
    throw new Error('Migration Act source was not loaded from knowledgebase. Advice generation blocked.');
  }
  if (pack.assessmentKind === 'MIGRATION' && !pack.sources.some(s => s.authority === 'REGULATIONS')) {
    throw new Error('Migration Regulations source was not loaded from knowledgebase. Advice generation blocked.');
  }
  if (pack.assessmentKind === 'MIGRATION' && !pack.sources.some(s => s.authority === 'PAMS' || /subclass/i.test(String(s.path || '')))) {
    throw new Error('Subclass PAM/legal source was not loaded from knowledgebase. Advice generation blocked.');
  }
  if (!pack.hierarchyEnforced || !Array.isArray(pack.legalAuthorityOrder)) {
    throw new Error('Legal authority hierarchy was not enforced. Advice generation blocked.');
  }
  if (!pack.legalVersionLock || !pack.legalVersionLock.checkedAt || !pack.legalVersionLock.sourceHashAggregate) {
    throw new Error('Legal version lock is missing from knowledgebase pack. Advice generation blocked.');
  }
  const ranks = pack.sources.map(s => authorityRank(s.authority));
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] < ranks[i - 1]) throw new Error('Legal sources are not ordered by authority. Advice generation blocked.');
  }
  return true;
}

module.exports = { buildKnowledgebaseLegalPack, assertKnowledgebasePack, extractVisaSubclass, extractSelectedStream, classifyLegalAuthority, LEGAL_AUTHORITY_ORDER, buildLegalVersionLock };
