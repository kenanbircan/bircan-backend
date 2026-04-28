import fs from "fs";
import path from "path";

const defaultStorageFile = process.env.STORAGE_FILE || "./data/submissions.json";

function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadDb(storageFile = defaultStorageFile) {
  ensureDirFor(storageFile);
  if (!fs.existsSync(storageFile)) {
    fs.writeFileSync(storageFile, JSON.stringify({ submissions: {}, documents: {}, auditLog: [] }, null, 2), "utf8");
  }
  const raw = fs.readFileSync(storageFile, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.submissions || typeof parsed.submissions !== "object") {
      return { submissions: {}, documents: {}, auditLog: [] };
    }
    return parsed;
  } catch {
    return { submissions: {}, documents: {}, auditLog: [] };
  }
}

function saveDb(db, storageFile = defaultStorageFile) {
  ensureDirFor(storageFile);
  fs.writeFileSync(storageFile, JSON.stringify(db, null, 2), "utf8");
}

export function createSubmission(payload) {
  const db = loadDb();
  const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  db.submissions[id] = {
    id,
    createdAt: now,
    updatedAt: now,
    paymentStatus: "unpaid",
    status: "draft",
    analysisStatus: "not_started",
    pdfStatus: "not_generated",
    emailStatus: "not_sent",
    checkoutSessionId: null,
    stripePaymentIntentId: null,
    stripeCustomerEmail: payload?.email || null,
    client: {
      fullName: payload?.fullName || "",
      email: payload?.email || "",
      phone: payload?.phone || ""
    },
    visa: {
      subclass: payload?.visaSubclass || "",
      selectedPlan: payload?.selectedPlan || "",
      deliveryLabel: payload?.deliveryLabel || "",
      amount: payload?.amount || 0
    },
    answers: payload?.answers || {},
    analysis: null,
    pdf: null,
    emailLog: [],
    notes: [],
    metadata: payload?.metadata || {}
  };

  saveDb(db);
  return db.submissions[id];
}

export function getSubmission(id) {
  const db = loadDb();
  return db.submissions[id] || null;
}

export function updateSubmission(id, patch) {
  const db = loadDb();
  const existing = db.submissions[id];
  if (!existing) return null;

  db.submissions[id] = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  saveDb(db);
  return db.submissions[id];
}

export function appendEmailLog(id, item) {
  const db = loadDb();
  const existing = db.submissions[id];
  if (!existing) return null;
  existing.emailLog = Array.isArray(existing.emailLog) ? existing.emailLog : [];
  existing.emailLog.push({
    at: new Date().toISOString(),
    ...item
  });
  existing.updatedAt = new Date().toISOString();
  saveDb(db);
  return existing;
}

export function listSubmissions(limit = 50) {
  const db = loadDb();
  return Object.values(db.submissions)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}


export function listSubmissionsByEmail(email, limit = 50) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return [];
  const db = loadDb();
  return Object.values(db.submissions)
    .filter((item) => {
      const clientEmail = String(item?.client?.email || item?.stripeCustomerEmail || "").trim().toLowerCase();
      return clientEmail === normalized;
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit);
}

export function findSubmissionByCheckoutSession(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  const db = loadDb();
  return Object.values(db.submissions).find((item) => item.checkoutSessionId === sid) || null;
}

export function updateSubmissionByCheckoutSession(sessionId, patch) {
  const existing = findSubmissionByCheckoutSession(sessionId);
  if (!existing) return null;
  return updateSubmission(existing.id, patch);
}


function nowIso() {
  return new Date().toISOString();
}

export function audit(event, details = {}) {
  const db = loadDb();
  db.auditLog = Array.isArray(db.auditLog) ? db.auditLog : [];
  const item = {
    id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: nowIso(),
    event,
    ...details
  };
  db.auditLog.push(item);
  saveDb(db);
  return item;
}

export function upsertDocument(doc = {}) {
  const db = loadDb();
  db.documents = db.documents || {};
  const id = doc.id || `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const existing = db.documents[id] || {};
  db.documents[id] = {
    ...existing,
    ...doc,
    id,
    updatedAt: nowIso(),
    createdAt: existing.createdAt || doc.createdAt || nowIso()
  };
  saveDb(db);
  return db.documents[id];
}

export function getDocument(id) {
  const db = loadDb();
  return db.documents?.[id] || null;
}

export function getDocumentForSubmission(submissionId) {
  const sid = String(submissionId || '').trim();
  if (!sid) return null;
  const db = loadDb();
  return Object.values(db.documents || {}).find((doc) => String(doc.submissionId || '') === sid && (doc.type || '').includes('assessment')) || null;
}

export function listDocumentsByUser(user, limit = 50) {
  const submissions = listSubmissionsByEmail(user?.email || user, 1000);
  const ids = new Set(submissions.map((item) => item.id));
  const userId = String(user?.sub || user?.id || user?.userId || '').trim();
  const email = String(user?.email || user || '').trim().toLowerCase();
  const db = loadDb();
  return Object.values(db.documents || {})
    .filter((doc) => ids.has(doc.submissionId) || (userId && String(doc.userId || '') === userId) || (email && String(doc.email || '').trim().toLowerCase() === email))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, limit);
}

export function attachSubmissionPdf(submissionId, pdf = {}) {
  const existing = getSubmission(submissionId);
  if (!existing) return null;
  const doc = upsertDocument({
    submissionId,
    userId: existing.userId || existing.metadata?.userId || pdf.userId || '',
    email: existing.client?.email || existing.stripeCustomerEmail || pdf.email || '',
    type: 'assessment_pdf',
    status: pdf.status || 'ready',
    filename: pdf.filename || `bircan-assessment-${submissionId}.pdf`,
    filePath: pdf.filePath || pdf.path || pdf.pdfPath || '',
    storagePath: pdf.storagePath || '',
    url: pdf.url || pdf.downloadUrl || '',
    base64: pdf.base64 || ''
  });
  updateSubmission(submissionId, {
    pdfStatus: doc.status || 'ready',
    pdf: {
      ...(existing.pdf || {}),
      documentId: doc.id,
      filename: doc.filename,
      filePath: doc.filePath || doc.storagePath || '',
      url: doc.url || '',
      base64: doc.base64 || ''
    }
  });
  return doc;
}
