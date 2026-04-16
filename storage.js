import fs from "fs";
import path from "path";

const dataDir = path.join(process.cwd(), "data");
const dataFile = path.join(dataDir, "submissions.json");

async function ensureStore() {
  await fs.promises.mkdir(dataDir, { recursive: true });
  try {
    await fs.promises.access(dataFile);
  } catch {
    await fs.promises.writeFile(dataFile, "[]", "utf8");
  }
}

async function readAll() {
  await ensureStore();
  const raw = await fs.promises.readFile(dataFile, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(records) {
  await ensureStore();
  await fs.promises.writeFile(dataFile, JSON.stringify(records, null, 2), "utf8");
}

export async function createSubmission(record) {
  const records = await readAll();
  records.unshift(record);
  await writeAll(records);
  return record;
}

export async function getSubmissionById(id) {
  const records = await readAll();
  return records.find((item) => item.id === id) || null;
}

export async function getSubmissionBySessionId(sessionId) {
  const records = await readAll();
  return records.find((item) => item.checkoutSessionId === sessionId) || null;
}

export async function updateSubmission(id, patch) {
  const records = await readAll();
  const index = records.findIndex((item) => item.id === id);

  if (index === -1) return null;

  const updated = {
    ...records[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };

  records[index] = updated;
  await writeAll(records);
  return updated;
}

export async function listSubmissions(limit = 50) {
  const records = await readAll();
  return records.slice(0, limit);
}
