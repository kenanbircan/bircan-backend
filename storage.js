import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const storageDir = path.join(__dirname, '..', 'storage');
const submissionsDir = path.join(storageDir, 'submissions');

if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });
if (!fs.existsSync(submissionsDir)) fs.mkdirSync(submissionsDir, { recursive: true });

function submissionFile(id) {
  return path.join(submissionsDir, `${id}.json`);
}

export function createSubmission(data) {
  const id = nanoid(12);
  const now = new Date().toISOString();
  const record = {
    id,
    createdAt: now,
    updatedAt: now,
    ...data
  };
  fs.writeFileSync(submissionFile(id), JSON.stringify(record, null, 2));
  return record;
}

export function getSubmission(id) {
  const file = submissionFile(id);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function listSubmissions(filters = {}) {
  const files = fs.readdirSync(submissionsDir).filter(f => f.endsWith('.json'));
  const items = files.map(file => JSON.parse(fs.readFileSync(path.join(submissionsDir, file), 'utf8')));
  return items
    .filter(item => !filters.type || item.type === filters.type)
    .filter(item => !filters.status || item.status === filters.status)
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function updateSubmission(id, patch) {
  const existing = getSubmission(id);
  if (!existing) return null;
  const updated = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(submissionFile(id), JSON.stringify(updated, null, 2));
  return updated;
}

export function getStats() {
  const items = listSubmissions({});
  const paid = items.filter(i => i.paymentStatus === 'paid').length;
  return {
    total: items.length,
    paid,
    unpaid: items.filter(i => i.paymentStatus === 'unpaid').length,
    byType: items.reduce((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {}),
    recent: items.slice(0, 10)
  };
}
