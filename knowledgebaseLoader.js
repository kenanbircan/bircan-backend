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
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

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
  if (/appeal|aart|tribunal|refusal|cancellation|review/.test(blob)) return 'APPEALS';
  if (/citizenship|conferral|citizenship test|pledge/.test(blob)) return 'CITIZENSHIP';
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
  const code = subclassOf(assessment.visa_type || assessment.subclass || assessment.visaSubclass || '');
  const kind = inferAssessmentKind(assessment);
  let score = 0;
  if (rel.includes(kind.toLowerCase())) score += 50;
  if (rel.includes('acts')) score += 25;
  if (rel.includes('regulations')) score += 35;
  if (rel.includes('pams')) score += 30;
  if (rel.includes('instruments')) score += 15;
  if (code && (name.includes(`subclass ${code}`) || name.includes(code))) score += 120;
  if (/migration\/acts/i.test(file.rel)) score += 30;
  if (/migration\/regulations/i.test(file.rel)) score += 40;
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

  const subclass = subclassOf(assessment.visa_type || assessment.subclass || assessment.visaSubclass || '');
  const scored = files
    .map(f => ({ ...f, score: scoreFile(f, assessment) }))
    .sort((a, b) => b.score - a.score || b.stat.mtimeMs - a.stat.mtimeMs);

  const selected = scored.filter(f => f.score > 0).slice(0, MAX_DOCS_IN_PROMPT);
  if (!selected.length) throw new Error('No relevant legal knowledgebase documents were selected. Refusing to generate advice letter.');
  if (subclass && !selected.some(f => norm(f.name).includes(`subclass ${subclass}`) || norm(f.name).includes(subclass))) {
    throw new Error(`Subclass ${subclass} PAM/legal source is missing from knowledgebase selection. Refusing to generate advice letter.`);
  }

  const extracted = [];
  let total = 0;
  for (const f of selected) {
    const e = await extractText(f);
    const remaining = MAX_TOTAL_CHARS - total;
    if (remaining <= 0) break;
    const excerpt = clip(e.text, Math.min(MAX_CHARS_PER_DOC, remaining));
    total += excerpt.length;
    extracted.push({ path: e.rel, sha256: e.hash, modified: e.stat.mtime.toISOString(), chars: e.chars, excerpt });
  }

  const manifest = scored.map(f => ({ path: f.rel, score: f.score, modified: f.stat.mtime.toISOString(), bytes: f.stat.size }));
  return {
    loadedAt: new Date().toISOString(),
    root: 'knowledgebase',
    assessmentKind: inferAssessmentKind(assessment),
    subclass,
    documentCountScanned: files.length,
    documentCountLoaded: extracted.length,
    searchTerms: buildSearchTerms(assessment),
    manifest,
    sources: extracted,
  };
}

function assertKnowledgebasePack(pack) {
  if (!pack || !Array.isArray(pack.sources) || pack.sources.length < 2) {
    throw new Error('Knowledgebase legal-source pack was not loaded. Advice generation blocked.');
  }
  if (!pack.sources.some(s => /REGULATIONS/i.test(s.path)) && pack.assessmentKind === 'MIGRATION') {
    throw new Error('Migration Regulations source was not loaded from knowledgebase. Advice generation blocked.');
  }
  return true;
}

module.exports = { buildKnowledgebaseLegalPack, assertKnowledgebasePack };
