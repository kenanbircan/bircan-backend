import fs from "fs";
import path from "path";

const defaultStorageFile = process.env.STORAGE_FILE || "./data/submissions.json";

function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadDb(storageFile = defaultStorageFile) {
  ensureDirFor(storageFile);
  if (!fs.existsSync(storageFile)) {
    fs.writeFileSync(storageFile, JSON.stringify({ submissions: {} }, null, 2), "utf8");
  }
  const raw = fs.readFileSync(storageFile, "utf8");
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.submissions || typeof parsed.submissions !== "object") {
      return { submissions: {} };
    }
    return parsed;
  } catch {
    return { submissions: {} };
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
