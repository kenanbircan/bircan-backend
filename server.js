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

const PORT = Number(process.env.PORT || 4242);
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || "CHANGE_ME_IN_RENDER";
const STRIPE_MODE = String(process.env.STRIPE_MODE || "test").toLowerCase() === "live" ? "live" : "test";
const STRIPE_SECRET_KEY =
  STRIPE_MODE === "live"
    ? (process.env.STRIPE_SECRET_KEY_LIVE || process.env.STRIPE_SECRET_KEY)
    : (process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY);

if (!STRIPE_SECRET_KEY) console.warn(`[stripe] Missing Stripe secret key for mode=${STRIPE_MODE}`);
const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const APP_BASE_URL = (process.env.APP_BASE_URL || "https://bircanmigration.au").replace(/\/$/, "");
const BACKEND_BASE_URL = (process.env.BACKEND_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const allowedOrigins = (process.env.ALLOWED_ORIGINS ||
  "https://bircanmigration.au,https://www.bircanmigration.au,https://bircanmigration.com.au,https://www.bircanmigration.com.au,https://assessment.bircanmigration.au,http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true
}));
app.use(express.json({ limit: "3mb" }));
app.use(cookieParser());

const usersFile = process.env.USERS_FILE || "./data/users.json";
function ensureDir(filePath) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); }
function loadUsers() {
  ensureDir(usersFile);
  if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify({ users: {} }, null, 2));
  try { return JSON.parse(fs.readFileSync(usersFile, "utf8")); } catch { return { users: {} }; }
}
function saveUsers(db) { ensureDir(usersFile); fs.writeFileSync(usersFile, JSON.stringify(db, null, 2)); }
function publicUser(user) { return { id: user.id || user.sub, email: user.email, fullName: user.fullName || "" }; }
function signToken(user) {
  return jwt.sign({ sub: user.id || user.sub, email: user.email, fullName: user.fullName || "" }, JWT_SECRET, { expiresIn: "30d" });
}
function setAuthCookie(res, token) {
  res.cookie("bm_auth", token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: "/"
  });
}
function clearAuthCookie(res) {
  res.clearCookie("bm_auth", { httpOnly: true, secure: true, sameSite: "lax", path: "/" });
}
function getBearer(req) {
  const h = req.headers.authorization || "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return req.headers["x-auth-token"] || req.cookies?.bm_auth || "";
}
function requireAuth(req, res, next) {
  const token = getBearer(req);
  if (!token) return res.status(401).json({ ok: false, code: "LOGIN_REQUIRED", error: "Login required." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    req.user.email = String(req.user.email || "").trim().toLowerCase();
    next();
  } catch {
    return res.status(401).json({ ok: false, code: "INVALID_LOGIN", error: "Invalid or expired login." });
  }
}
function sameEmail(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}
function canonicalVisaPlan(value) {
  const compact = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (["instant","fastest","fast","immediate","priority","express","sameday","today","urgent","premium"].includes(compact)) return "instant";
  if (["24h","24hr","24hrs","24hour","24hours","recommended","standard","normal","regular"].includes(compact)) return "24h";
  if (["3d","3day","3days","72h","72hours","economy","value","budget","basic"].includes(compact)) return "3d";
  return "";
}
function visaPriceMap() {
  if (STRIPE_MODE === "live") {
    return {
      instant: process.env.STRIPE_PRICE_VISA_INSTANT_LIVE || process.env.STRIPE_PRICE_VISA_INSTANT,
      "24h": process.env.STRIPE_PRICE_VISA_24H_LIVE || process.env.STRIPE_PRICE_VISA_24H,
      "3d": process.env.STRIPE_PRICE_VISA_3D_LIVE || process.env.STRIPE_PRICE_VISA_3D
    };
  }
  return {
    instant: process.env.STRIPE_PRICE_VISA_INSTANT_TEST || process.env.STRIPE_PRICE_VISA_INSTANT,
    "24h": process.env.STRIPE_PRICE_VISA_24H_TEST || process.env.STRIPE_PRICE_VISA_24H,
    "3d": process.env.STRIPE_PRICE_VISA_3D_TEST || process.env.STRIPE_PRICE_VISA_3D
  };
}
function safeFrontendUrl(raw, fallback) {
  const candidate = String(raw || "").trim();
  if (!candidate) return fallback;
  try {
    const url = new URL(candidate);
    const appOrigin = new URL(APP_BASE_URL).origin;
    if (url.origin === appOrigin || allowedOrigins.includes(url.origin)) return url.toString();
  } catch {}
  return fallback;
}
function successUrlFromRequest(req) {
  return safeFrontendUrl(req.body?.successUrl, `${APP_BASE_URL}/account-dashboard.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);
}
function cancelUrlFromRequest(req) {
  return safeFrontendUrl(req.body?.cancelUrl, `${APP_BASE_URL}/account-dashboard.html?checkout=cancelled`);
}

app.get("/api/health", (req, res) => {
  const prices = visaPriceMap();
  res.json({
    ok: true,
    service: "bircan-migration-backend",
    stripeMode: STRIPE_MODE,
    stripeConfigured: Boolean(stripe),
    appBaseUrl: APP_BASE_URL,
    backendBaseUrl: BACKEND_BASE_URL || null,
    allowedOrigins,
    auth: { cookieName: "bm_auth", verifyRequiresLogin: true },
    visaPrices: { instant: Boolean(prices.instant), "24h": Boolean(prices["24h"]), "3d": Boolean(prices["3d"]) }
  });
});

app.post("/api/auth/register", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const fullName = String(req.body?.fullName || "").trim();
  if (!email || !password) return res.status(400).json({ ok: false, error: "Email and password are required." });
  if (password.length < 6) return res.status(400).json({ ok: false, error: "Password must be at least 6 characters." });

  const db = loadUsers();
  if (db.users[email]) return res.status(409).json({ ok: false, error: "An account already exists for this email." });

  const user = { id: `usr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`, email, fullName, passwordHash: await bcrypt.hash(password, 12), createdAt: new Date().toISOString() };
  db.users[email] = user;
  saveUsers(db);
  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ ok: true, token, user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const db = loadUsers();
  const user = db.users[email];
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ ok: false, error: "Invalid email or password." });
  const token = signToken(user);
  setAuthCookie(res, token);
  res.json({ ok: true, token, user: publicUser(user) });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user), id: req.user.sub, email: req.user.email, fullName: req.user.fullName || "" });
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/account/dashboard", requireAuth, (req, res) => {
  const submissions = listSubmissionsByEmail(req.user.email, 100);
  res.json({ ok: true, user: publicUser(req.user), visaAssessments: submissions });
});

app.post("/api/assessment/create-checkout-session", requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: `Stripe is not configured for ${STRIPE_MODE} mode.` });

  const plan = canonicalVisaPlan(req.body?.plan || req.body?.selectedPlan || req.body?.selectedPlanKey || req.body?.planCode || req.body?.assessmentPayload?.plan);
  if (!plan) return res.status(400).json({ ok: false, error: "Invalid visa assessment plan. Use instant, 24h, or 3d." });

  const prices = visaPriceMap();
  const priceId = prices[plan];
  if (!priceId) return res.status(500).json({ ok: false, error: `Missing Stripe Price ID for ${plan} in ${STRIPE_MODE} mode.` });

  const assessmentPayload = req.body?.assessmentPayload || {};
  const submittedEmail = String(assessmentPayload?.client?.email || assessmentPayload?.email || req.user.email).trim().toLowerCase();
  if (submittedEmail && !sameEmail(submittedEmail, req.user.email)) {
    return res.status(403).json({ ok: false, error: "This assessment must be submitted from the same email address as the logged-in account." });
  }

  const submission = createSubmission({
    ...assessmentPayload,
    email: req.user.email,
    fullName: assessmentPayload?.client?.fullName || assessmentPayload?.fullName || req.user.fullName || "",
    visaSubclass: req.body?.subclass || assessmentPayload?.subclass || "",
    selectedPlan: plan,
    metadata: { ...(assessmentPayload?.metadata || {}), userId: req.user.sub, userEmail: req.user.email, selectedPlan: plan, stripeMode: STRIPE_MODE }
  });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: req.user.email,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrlFromRequest(req),
    cancel_url: cancelUrlFromRequest(req),
    metadata: { product: "visa_assessment", plan, selectedPlan: plan, userId: req.user.sub, email: req.user.email, submissionId: submission.id, subclass: String(req.body?.subclass || assessmentPayload?.subclass || "") }
  });

  updateSubmission(submission.id, { checkoutSessionId: session.id, status: "checkout_created", paymentStatus: "pending", stripeCustomerEmail: req.user.email, visa: { ...submission.visa, selectedPlan: plan } });
  res.json({ ok: true, url: session.url, sessionId: session.id, plan, priceId });
});

app.get("/api/stripe/verify-session", requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: `Stripe is not configured for ${STRIPE_MODE} mode.` });
  const sessionId = String(req.query.session_id || "").trim();
  if (!sessionId) return res.status(400).json({ ok: false, error: "Missing session_id." });

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (!session || session.payment_status !== "paid") return res.status(402).json({ ok: false, error: "Payment has not been verified as paid." });

  const email = String(session.customer_details?.email || session.customer_email || session.metadata?.email || "").trim().toLowerCase();
  const metadataUserId = String(session.metadata?.userId || "");
  if (!sameEmail(email, req.user.email) || (metadataUserId && metadataUserId !== req.user.sub)) {
    return res.status(403).json({ ok: false, error: "This Stripe payment does not belong to the logged-in account." });
  }

  const plan = canonicalVisaPlan(session.metadata?.plan || session.metadata?.selectedPlan);
  const product = session.metadata?.product || "visa_assessment";
  const submissionId = session.metadata?.submissionId || "";

  let updated = null;
  const paidPatch = { paymentStatus: "paid", status: "paid", checkoutSessionId: session.id, stripePaymentIntentId: String(session.payment_intent || ""), stripeCustomerEmail: email, paidAt: new Date().toISOString() };
  if (submissionId) updated = updateSubmission(submissionId, paidPatch);
  if (!updated) updated = updateSubmissionByCheckoutSession(session.id, paidPatch);

  res.json({ ok: true, verified: true, product, plan, email, submission: updated, visaAssessments: listSubmissionsByEmail(req.user.email, 100) });
});

app.get("/api/assessment/:id/status", requireAuth, (req, res) => {
  const item = getSubmission(req.params.id);
  if (!item) return res.status(404).json({ ok: false, error: "Assessment was not found." });
  const itemEmail = String(item?.client?.email || item?.stripeCustomerEmail || item?.metadata?.userEmail || "").trim().toLowerCase();
  if (!sameEmail(itemEmail, req.user.email)) return res.status(403).json({ ok: false, error: "This assessment does not belong to your account." });
  res.json({ ok: true, submission: item, ...item });
});

app.listen(PORT, () => console.log(`Bircan backend running on :${PORT} mode=${STRIPE_MODE}`));
