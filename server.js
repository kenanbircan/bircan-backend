import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import Stripe from "stripe";
import {
  createSubmission,
  getSubmission,
  updateSubmission,
  listSubmissionsByEmail,
  updateSubmissionByCheckoutSession
} from "./storage.js";

const app = express();
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 4242);
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || "CHANGE_ME_IN_RENDER";
const STRIPE_MODE = String(process.env.STRIPE_MODE || "test").toLowerCase() === "live" ? "live" : "test";
const STRIPE_SECRET_KEY = STRIPE_MODE === "live"
  ? (process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY)
  : (process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY);
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const APP_BASE_URL = (process.env.APP_BASE_URL || "https://bircanmigration.au").replace(/\/$/, "");
const BACKEND_BASE_URL = (process.env.BACKEND_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "https://bircanmigration.au,https://www.bircanmigration.au,https://bircanmigration.com.au,https://www.bircanmigration.com.au,https://assessment.bircanmigration.au,http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000,http://127.0.0.1:3000")
  .split(",").map((v) => v.trim()).filter(Boolean);

app.use(cors({ origin(origin, cb) { if (!origin || allowedOrigins.includes(origin)) return cb(null, true); return cb(new Error(`CORS blocked origin: ${origin}`)); }, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

const usersFile = process.env.USERS_FILE || "./data/users.json";
function ensureDir(filePath) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
function loadUsers() { ensureDir(usersFile); if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify({ users: {} }, null, 2)); try { return JSON.parse(fs.readFileSync(usersFile, "utf8")); } catch { return { users: {} }; } }
function saveUsers(db) { ensureDir(usersFile); fs.writeFileSync(usersFile, JSON.stringify(db, null, 2)); }
function normalizeEmail(value) { return String(value || "").trim().toLowerCase(); }
function publicUser(user) { return { id: user.id || user.sub, email: normalizeEmail(user.email), fullName: user.fullName || "" }; }
function signToken(user) { return jwt.sign({ sub: user.id || user.sub, email: normalizeEmail(user.email), fullName: user.fullName || "" }, JWT_SECRET, { expiresIn: "30d" }); }
function setAuthCookie(res, token) { res.cookie("bm_auth", token, { httpOnly: true, secure: true, sameSite: "none", path: "/", maxAge: 30 * 24 * 60 * 60 * 1000 }); }
function clearAuthCookie(res) { res.clearCookie("bm_auth", { httpOnly: true, secure: true, sameSite: "none", path: "/" }); }
function getBearer(req) { const h = req.headers.authorization || ""; if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim(); return req.headers["x-auth-token"] || req.cookies?.bm_auth || ""; }
function requireAuth(req, res, next) { const token = getBearer(req); if (!token) return res.status(401).json({ ok: false, error: "Login required." }); try { req.user = jwt.verify(token, JWT_SECRET); next(); } catch { return res.status(401).json({ ok: false, error: "Invalid or expired login." }); } }
function canonicalVisaPlan(value) { const compact = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); if (["instant","fastest","fast","immediate","priority","express","sameday","today","urgent","premium"].includes(compact)) return "instant"; if (["24h","24hr","24hrs","24hour","24hours","recommended","standard","normal","regular"].includes(compact)) return "24h"; if (["3d","3day","3days","72h","72hours","economy","value","budget","basic"].includes(compact)) return "3d"; return ""; }
function visaPriceMap() { if (STRIPE_MODE === "live") return { instant: process.env.STRIPE_PRICE_VISA_INSTANT_LIVE || process.env.STRIPE_PRICE_VISA_INSTANT, "24h": process.env.STRIPE_PRICE_VISA_24H_LIVE || process.env.STRIPE_PRICE_VISA_24H, "3d": process.env.STRIPE_PRICE_VISA_3D_LIVE || process.env.STRIPE_PRICE_VISA_3D }; return { instant: process.env.STRIPE_PRICE_VISA_INSTANT_TEST || process.env.STRIPE_PRICE_VISA_INSTANT, "24h": process.env.STRIPE_PRICE_VISA_24H_TEST || process.env.STRIPE_PRICE_VISA_24H, "3d": process.env.STRIPE_PRICE_VISA_3D_TEST || process.env.STRIPE_PRICE_VISA_3D }; }
function safeReturnUrl(raw, fallback) { const value = String(raw || "").trim(); if (!value) return fallback; try { const parsed = new URL(value); if (allowedOrigins.includes(parsed.origin)) return value; } catch {} return fallback; }
function successUrlFromRequest(req) { return safeReturnUrl(req.body?.successUrl, `${APP_BASE_URL}/account-dashboard.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`); }
function cancelUrlFromRequest(req) { return safeReturnUrl(req.body?.cancelUrl, `${APP_BASE_URL}/account-dashboard.html?checkout=cancelled`); }
function extractApplicantEmail(payload = {}, body = {}) { return normalizeEmail(payload?.client?.email || payload?.applicant?.email || payload?.applicantEmail || payload?.email || body?.clientEmail || body?.applicantEmail || body?.email || ""); }
function extractApplicantName(payload = {}, body = {}) { return String(payload?.client?.fullName || payload?.applicant?.fullName || payload?.fullName || body?.fullName || "").trim(); }
function assertSameClientEmail(req, res, applicantEmail) { const accountEmail = normalizeEmail(req.user?.email); if (!applicantEmail) { res.status(400).json({ ok: false, code: "APPLICANT_EMAIL_REQUIRED", error: "Applicant email address is required before payment." }); return false; } if (accountEmail !== applicantEmail) { res.status(403).json({ ok: false, code: "EMAIL_MISMATCH", error: "This assessment must be submitted from the same email address as the logged-in account.", applicantEmail, accountEmail }); return false; } return true; }
function pdfEscape(value) { return String(value || "").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
function makeSimplePdf(lines) {
  const safeLines = lines.slice(0, 42).map((line) => pdfEscape(line));
  const content = ["BT", "/F1 12 Tf", "50 790 Td", "16 TL"].concat(safeLines.map((line) => "(" + line + ") Tj T*")).concat(["ET"]).join("\n");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Length " + Buffer.byteLength(content) + " >>\nstream\n" + content + "\nendstream"];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += (i + 1) + " 0 obj\n" + obj + "\nendobj\n"; });
  const xref = Buffer.byteLength(pdf); pdf += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  offsets.slice(1).forEach((off) => { pdf += String(off).padStart(10, "0") + " 00000 n \n"; });
  pdf += "trailer << /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF";
  return Buffer.from(pdf, "binary");
}
function verifySubmissionOwner(req, item) { const itemEmail = normalizeEmail(item?.client?.email || item?.stripeCustomerEmail || item?.metadata?.clientEmail || item?.metadata?.applicantEmail); return itemEmail && itemEmail === normalizeEmail(req.user.email); }

app.get("/api/health", (req, res) => { const prices = visaPriceMap(); res.json({ ok: true, service: "bircan-migration-backend", stripeMode: STRIPE_MODE, stripeConfigured: Boolean(stripe), appBaseUrl: APP_BASE_URL, backendBaseUrl: BACKEND_BASE_URL || null, allowedOrigins, auth: "httpOnly-cookie-plus-authorization-fallback", visaPrices: { instant: Boolean(prices.instant), "24h": Boolean(prices["24h"]), "3d": Boolean(prices["3d"]) } }); });

app.post("/api/auth/register", async (req, res) => { const email = normalizeEmail(req.body?.email); const password = String(req.body?.password || ""); const fullName = String(req.body?.fullName || "").trim(); const expectedEmail = normalizeEmail(req.body?.expectedEmail || req.body?.applicantEmail || ""); if (!email || !password) return res.status(400).json({ ok: false, error: "Email and password are required." }); if (expectedEmail && email !== expectedEmail) return res.status(403).json({ ok: false, code: "EMAIL_MISMATCH", error: "Please create the account using the same email address entered in the assessment form.", expectedEmail, accountEmail: email }); const db = loadUsers(); if (db.users[email]) return res.status(409).json({ ok: false, error: "An account already exists for this email." }); const user = { id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, email, fullName, passwordHash: await bcrypt.hash(password, 10), createdAt: new Date().toISOString() }; db.users[email] = user; saveUsers(db); const token = signToken(user); setAuthCookie(res, token); res.json({ ok: true, token, user: publicUser(user) }); });
app.post("/api/auth/login", async (req, res) => { const email = normalizeEmail(req.body?.email); const password = String(req.body?.password || ""); const expectedEmail = normalizeEmail(req.body?.expectedEmail || req.body?.applicantEmail || ""); if (expectedEmail && email !== expectedEmail) return res.status(403).json({ ok: false, code: "EMAIL_MISMATCH", error: "Please log in using the same email address entered in the assessment form.", expectedEmail, accountEmail: email }); const db = loadUsers(); const user = db.users[email]; if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ ok: false, error: "Invalid email or password." }); const token = signToken(user); setAuthCookie(res, token); res.json({ ok: true, token, user: publicUser(user) }); });
app.get("/api/auth/me", requireAuth, (req, res) => res.json({ ok: true, user: publicUser(req.user) }));
app.post("/api/auth/logout", (req, res) => { clearAuthCookie(res); res.json({ ok: true }); });

app.get("/api/account/dashboard", requireAuth, (req, res) => res.json({ ok: true, user: publicUser(req.user), visaAssessments: listSubmissionsByEmail(req.user.email, 100) }));

app.post("/api/assessment/create-checkout-session", requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: `Stripe is not configured for ${STRIPE_MODE} mode.` });
  const assessmentPayload = req.body?.assessmentPayload || {};
  const applicantEmail = extractApplicantEmail(assessmentPayload, req.body);
  if (!assertSameClientEmail(req, res, applicantEmail)) return;
  const plan = canonicalVisaPlan(req.body?.plan || req.body?.selectedPlan || req.body?.selectedPlanKey || req.body?.planCode || assessmentPayload?.plan || assessmentPayload?.selectedPlan);
  if (!plan) return res.status(400).json({ ok: false, error: "Invalid visa assessment plan. Use instant, 24h, or 3d." });
  const prices = visaPriceMap(); const priceId = prices[plan];
  if (!priceId) return res.status(500).json({ ok: false, error: `Missing Stripe Price ID for ${plan} in ${STRIPE_MODE} mode.` });
  const fullName = extractApplicantName(assessmentPayload, req.body) || req.user.fullName || "";
  const submission = createSubmission({ ...assessmentPayload, email: applicantEmail, fullName, visaSubclass: req.body?.subclass || assessmentPayload?.subclass || assessmentPayload?.visaSubclass || "", selectedPlan: plan, metadata: { ...(assessmentPayload?.metadata || {}), userId: req.user.sub, accountEmail: normalizeEmail(req.user.email), clientEmail: applicantEmail, applicantEmail, selectedPlan: plan, stripeMode: STRIPE_MODE } });
  const session = await stripe.checkout.sessions.create({ mode: "payment", customer_email: applicantEmail, line_items: [{ price: priceId, quantity: 1 }], success_url: successUrlFromRequest(req), cancel_url: cancelUrlFromRequest(req), metadata: { product: "visa_assessment", plan, selectedPlan: plan, userId: req.user.sub, email: applicantEmail, accountEmail: normalizeEmail(req.user.email), submissionId: submission.id, subclass: String(req.body?.subclass || assessmentPayload?.subclass || assessmentPayload?.visaSubclass || "") } });
  updateSubmission(submission.id, { checkoutSessionId: session.id, status: "checkout_created", paymentStatus: "pending", stripeCustomerEmail: applicantEmail, visa: { ...submission.visa, selectedPlan: plan } });
  res.json({ ok: true, url: session.url, sessionId: session.id, plan, applicantEmail, priceId });
});

app.get("/api/stripe/verify-session", requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: `Stripe is not configured for ${STRIPE_MODE} mode.` });
  const sessionId = String(req.query.session_id || "").trim(); if (!sessionId) return res.status(400).json({ ok: false, error: "Missing session_id." });
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (!session || session.payment_status !== "paid") return res.status(402).json({ ok: false, error: "Payment has not been verified as paid." });
  const sessionEmail = normalizeEmail(session.customer_details?.email || session.customer_email || session.metadata?.email || "");
  if (!assertSameClientEmail(req, res, sessionEmail)) return;
  const plan = canonicalVisaPlan(session.metadata?.plan || session.metadata?.selectedPlan); const product = session.metadata?.product || "visa_assessment"; const submissionId = session.metadata?.submissionId || "";
  const paymentPatch = { paymentStatus: "paid", status: "paid", checkoutSessionId: session.id, stripePaymentIntentId: String(session.payment_intent || ""), stripeCustomerEmail: sessionEmail, paidAt: new Date().toISOString() };
  let updated = submissionId ? updateSubmission(submissionId, paymentPatch) : null; if (!updated) updated = updateSubmissionByCheckoutSession(session.id, paymentPatch);
  res.json({ ok: true, verified: true, product, plan, email: sessionEmail, submission: updated, visaAssessments: listSubmissionsByEmail(req.user.email, 100) });
});


app.get("/api/assessment/:id/pdf", requireAuth, (req, res) => {
  const item = getSubmission(req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "Assessment was not found." });
  if (!verifySubmissionOwner(req, item)) return res.status(403).json({ ok: false, error: "This assessment does not belong to the logged-in account." });
  if (item.paymentStatus !== "paid" && item.status !== "paid") return res.status(402).json({ ok: false, error: "Assessment PDF is available after payment is verified." });
  const lines = ["Bircan Migration - Visa Assessment Receipt / Summary", "", "Assessment ID: " + item.id, "Client: " + (item.client?.fullName || ""), "Email: " + (item.client?.email || item.stripeCustomerEmail || ""), "Visa subclass: " + (item.visa?.subclass || item.metadata?.subclass || ""), "Selected plan: " + (item.visa?.selectedPlan || item.metadata?.selectedPlan || ""), "Payment status: " + (item.paymentStatus || item.status || ""), "Paid at: " + (item.paidAt || ""), "", "This file is attached to the logged-in client account that owns the assessment.", "Replace this summary route with your final AI/legal letter generator when ready."];
  const pdf = makeSimplePdf(lines);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=\"" + item.id + "-visa-assessment.pdf\"");
  res.send(pdf);
});

app.get("/api/assessment/:id/status", requireAuth, (req, res) => { const item = getSubmission(req.params.id); if (!item) return res.status(404).json({ ok: false, error: "Assessment was not found." }); if (!verifySubmissionOwner(req, item)) return res.status(403).json({ ok: false, error: "This assessment does not belong to the logged-in account." }); res.json({ ok: true, submission: item, ...item }); });

app.listen(PORT, () => console.log(`Bircan backend running on :${PORT} mode=${STRIPE_MODE}`));
