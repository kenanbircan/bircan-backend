"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const Stripe = require("stripe");

const app = express();
const PORT = Number(process.env.PORT || 3000);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const WEBSITE_URL = (process.env.WEBSITE_URL || "https://bircanmigration.com.au").replace(/\/+$/, "");
const FRONTEND_SUCCESS_URL =
  (process.env.FRONTEND_SUCCESS_URL || `${WEBSITE_URL}/payment-success.html`).replace(/\/+$/, "");
const FRONTEND_CANCEL_URL =
  (process.env.FRONTEND_CANCEL_URL || `${WEBSITE_URL}/payment-cancelled.html`).replace(/\/+$/, "");
const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || "aud").toLowerCase();
const ASSESSMENT_PRICE_CENTS = Number(process.env.ASSESSMENT_PRICE_CENTS || 9900);
const NODE_ENV = process.env.NODE_ENV || "development";

if (!STRIPE_SECRET_KEY) {
  console.warn("WARNING: STRIPE_SECRET_KEY is missing.");
}

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2025-02-24.acacia"
});

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DRAFTS_DIR = path.join(DATA_DIR, "drafts");
const PDFS_DIR = path.join(DATA_DIR, "pdfs");

for (const dir of [PUBLIC_DIR, DATA_DIR, DRAFTS_DIR, PDFS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const allowedOrigins = (process.env.BM_ALLOWED_ORIGINS || WEBSITE_URL)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!STRIPE_WEBHOOK_SECRET) {
        return res.status(500).json({ ok: false, error: "Missing STRIPE_WEBHOOK_SECRET" });
      }

      const signature = req.headers["stripe-signature"];
      const event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const draftId = session.metadata?.draft_id;
        if (draftId) {
          markDraftPaid(draftId, session.id);
          await ensurePdfExists(draftId);
        }
      }

      return res.json({ received: true });
    } catch (error) {
      console.error("Stripe webhook error:", error.message);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }
  }
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "bircan-migration-payment-backend",
    env: NODE_ENV,
    websiteUrl: WEBSITE_URL,
    hasStripeKey: Boolean(STRIPE_SECRET_KEY),
    hasWebhookSecret: Boolean(STRIPE_WEBHOOK_SECRET),
    allowedOrigins
  });
});

app.post("/api/payment/create-checkout-session", async (req, res) => {
  try {
    if (!STRIPE_SECRET_KEY) {
      return res.status(500).json({ ok: false, error: "Stripe is not configured." });
    }

    const payload = sanitizeAssessmentPayload(req.body || {});
    const draftId = createDraft(payload);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      success_url: `${FRONTEND_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}&draft_id=${encodeURIComponent(
        draftId
      )}`,
      cancel_url: `${FRONTEND_CANCEL_URL}?draft_id=${encodeURIComponent(draftId)}`,
      customer_email: payload.email || undefined,
      metadata: {
        draft_id: draftId,
        applicant_name: payload.fullName || "",
        visa_type: payload.visaType || ""
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: STRIPE_CURRENCY,
            unit_amount: ASSESSMENT_PRICE_CENTS,
            product_data: {
              name: "Bircan Migration Eligibility Assessment",
              description: "Professional migration assessment and downloadable PDF report"
            }
          }
        }
      ]
    });

    updateDraft(draftId, {
      stripeCheckoutSessionId: session.id,
      checkoutCreatedAt: new Date().toISOString()
    });

    return res.json({
      ok: true,
      draftId,
      sessionId: session.id,
      checkoutUrl: session.url
    });
  } catch (error) {
    console.error("Create checkout session error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Unable to create checkout session."
    });
  }
});

app.get("/api/payment/verify-session", async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || "").trim();
    const draftId = String(req.query.draft_id || "").trim();

    if (!sessionId || !draftId) {
      return res.status(400).json({
        ok: false,
        error: "Missing session_id or draft_id."
      });
    }

    const draft = readDraft(draftId);
    if (!draft) {
      return res.status(404).json({ ok: false, error: "Draft not found." });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (
      session.payment_status !== "paid" ||
      session.metadata?.draft_id !== draftId
    ) {
      return res.status(400).json({
        ok: false,
        error: "Payment not verified."
      });
    }

    markDraftPaid(draftId, session.id);
    const pdfPath = await ensurePdfExists(draftId);
    const pdfUrl = `/api/assessment/pdf/${encodeURIComponent(draftId)}`;

    return res.json({
      ok: true,
      paid: true,
      draftId,
      sessionId: session.id,
      pdfUrl,
      fileName: path.basename(pdfPath)
    });
  } catch (error) {
    console.error("Verify session error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Unable to verify payment session."
    });
  }
});

app.get("/api/assessment/pdf/:draftId", async (req, res) => {
  try {
    const draftId = String(req.params.draftId || "").trim();
    if (!draftId) {
      return res.status(400).json({ ok: false, error: "Missing draftId." });
    }

    const draft = readDraft(draftId);
    if (!draft) {
      return res.status(404).json({ ok: false, error: "Draft not found." });
    }

    if (!draft.paymentVerified) {
      return res.status(403).json({
        ok: false,
        error: "Payment required before PDF download."
      });
    }

    const pdfPath = await ensurePdfExists(draftId);
    return res.download(pdfPath, path.basename(pdfPath));
  } catch (error) {
    console.error("PDF download error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Unable to download PDF."
    });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "assessment-payment-demo.html"));
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`
  });
});

app.listen(PORT, () => {
  console.log(`Bircan Migration backend running on port ${PORT}`);
});

function sanitizeAssessmentPayload(input) {
  return {
    fullName: cleanText(input.fullName),
    email: cleanEmail(input.email),
    phone: cleanText(input.phone),
    visaType: cleanText(input.visaType),
    country: cleanText(input.country),
    age: cleanText(input.age),
    occupation: cleanText(input.occupation),
    notes: cleanText(input.notes, 3000),
    submittedAt: new Date().toISOString()
  };
}

function cleanText(value, maxLength = 300) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

function createDraft(payload) {
  const draftId = crypto.randomUUID();
  const record = {
    id: draftId,
    ...payload,
    paymentVerified: false,
    stripeCheckoutSessionId: null,
    paymentVerifiedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const filePath = getDraftPath(draftId);
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
  return draftId;
}

function readDraft(draftId) {
  const filePath = getDraftPath(draftId);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function updateDraft(draftId, patch) {
  const current = readDraft(draftId);
  if (!current) return null;

  const updated = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(getDraftPath(draftId), JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

function markDraftPaid(draftId, sessionId) {
  return updateDraft(draftId, {
    paymentVerified: true,
    stripeCheckoutSessionId: sessionId,
    paymentVerifiedAt: new Date().toISOString()
  });
}

function getDraftPath(draftId) {
  return path.join(DRAFTS_DIR, `${draftId}.json`);
}

function getPdfPath(draftId) {
  return path.join(PDFS_DIR, `${draftId}.pdf`);
}

async function ensurePdfExists(draftId) {
  const pdfPath = getPdfPath(draftId);
  if (fs.existsSync(pdfPath)) return pdfPath;

  const draft = readDraft(draftId);
  if (!draft) throw new Error("Draft not found for PDF generation.");
  if (!draft.paymentVerified) throw new Error("Draft is not marked as paid.");

  await generateAssessmentPdf(draft, pdfPath);
  return pdfPath;
}

function generateAssessmentPdf(draft, outputPath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    doc.fontSize(20).text("Bircan Migration", { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(14).text("Eligibility Assessment Report");
    doc.moveDown(1);

    doc.fontSize(10).text(`Report ID: ${draft.id}`);
    doc.text(`Generated: ${new Date().toLocaleString()}`);
    doc.moveDown();

    addField(doc, "Full Name", draft.fullName || "-");
    addField(doc, "Email", draft.email || "-");
    addField(doc, "Phone", draft.phone || "-");
    addField(doc, "Visa Type", draft.visaType || "-");
    addField(doc, "Country", draft.country || "-");
    addField(doc, "Age", draft.age || "-");
    addField(doc, "Occupation", draft.occupation || "-");

    doc.moveDown();
    doc.fontSize(12).text("Applicant Notes", { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(10).text(draft.notes || "No additional notes supplied.", {
      align: "left"
    });

    doc.moveDown(1.2);
    doc.fontSize(12).text("Important Notice", { underline: true });
    doc.moveDown(0.4);
    doc
      .fontSize(10)
      .text(
        "This document is an initial assessment summary generated after successful payment. Final migration advice should only be provided after a full professional review of the applicant’s complete circumstances and supporting documents.",
        { align: "left" }
      );

    doc.end();

    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

function addField(doc, label, value) {
  doc.fontSize(10).text(`${label}: ${value}`);
}
