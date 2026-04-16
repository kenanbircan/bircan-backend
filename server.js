import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import Stripe from "stripe";
import PDFDocument from "pdfkit";

const app = express();
const PORT = process.env.PORT || 10000;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:4173",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "https://www.bircanmigration.au",
  "https://bircanmigration.au",
  "https://www.bircanmigration.com.au",
  "https://bircanmigration.com.au"
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);

      console.warn(`CORS blocked for origin: ${origin}`);
      return callback(null, true);
    },
    credentials: true
  })
);

const submissions = new Map();

const PRODUCT_CONFIG = {
  partner_report: {
    name: "Bircan Migration Partner Visa Assessment Report",
    amount: 9900,
    currency: "aud"
  },
  assessment_unlock: {
    name: "Bircan Migration Assessment Unlock",
    amount: 9900,
    currency: "aud"
  }
};

function normalizeBaseUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function resolveFrontendBase(req, requestedSiteUrl) {
  const productionDefault =
    process.env.FRONTEND_URL || "https://www.bircanmigration.com.au";

  const normalizedRequested = normalizeBaseUrl(requestedSiteUrl);
  if (normalizedRequested && allowedOrigins.includes(normalizedRequested)) {
    return normalizedRequested;
  }

  const originHeader = normalizeBaseUrl(req.headers.origin);
  if (originHeader && allowedOrigins.includes(originHeader)) {
    return originHeader;
  }

  const refererHeader = normalizeBaseUrl(req.headers.referer);
  if (refererHeader && allowedOrigins.includes(refererHeader)) {
    return refererHeader;
  }

  return productionDefault;
}

function makeSubmissionId() {
  return `assessment_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeText(value, fallback = "") {
  if (value == null) return fallback;
  return String(value).trim();
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "bircan-backend",
    website: "https://www.bircanmigration.com.au",
    websiteAlt: "https://www.bircanmigration.au",
    message: "Backend is running",
    endpoints: {
      health: "/api/health",
      contact: "/api/contact",
      assessmentSubmit: "/api/assessment/submit",
      assessmentGet: "/api/assessment/:submissionId",
      assessmentPdf: "/api/assessment/pdf/:submissionId",
      checkoutSession: "/api/payments/checkout-session",
      paymentMarkPaid: "/api/payments/mark-paid"
    },
    stripeConfigured: !!stripe,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "bircan-backend",
    website: "https://www.bircanmigration.com.au",
    stripeConfigured: !!stripe,
    hasFrontendUrl: !!process.env.FRONTEND_URL,
    timestamp: new Date().toISOString()
  });
});

app.post("/api/contact", (req, res) => {
  try {
    const name = sanitizeText(req.body?.name);
    const email = sanitizeText(req.body?.email);
    const phone = sanitizeText(req.body?.phone);
    const message = sanitizeText(req.body?.message);

    if (!name || !email || !message) {
      return res.status(400).json({
        ok: false,
        error: "Name, email, and message are required"
      });
    }

    return res.json({
      ok: true,
      message: "Contact enquiry received",
      contact: {
        name,
        email,
        phone,
        message
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to process contact request"
    });
  }
});

app.post("/api/assessment/submit", (req, res) => {
  try {
    const body = req.body || {};
    const submissionId = sanitizeText(body.submissionId) || makeSubmissionId();

    const fullName =
      sanitizeText(body.fullName) ||
      sanitizeText(body.name) ||
      sanitizeText(body.clientName);

    const email =
      sanitizeText(body.email) ||
      sanitizeText(body.clientEmail);

    const productKey =
      sanitizeText(body.productKey) || "partner_report";

    const visaSubclass =
      sanitizeText(body.visaSubclass) ||
      sanitizeText(body.subclass) ||
      sanitizeText(body.visaType);

    const saved = {
      submissionId,
      productKey,
      fullName,
      email,
      visaSubclass,
      paid: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      raw: body
    };

    submissions.set(submissionId, saved);

    return res.json({
      ok: true,
      message: "Assessment saved successfully",
      submissionId,
      id: submissionId,
      saved: {
        submissionId,
        productKey,
        fullName,
        email,
        visaSubclass,
        paid: false
      }
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to save assessment"
    });
  }
});

app.get("/api/assessment/:submissionId", (req, res) => {
  const submissionId = sanitizeText(req.params.submissionId);
  const submission = submissions.get(submissionId);

  if (!submission) {
    return res.status(404).json({
      ok: false,
      error: "Submission not found"
    });
  }

  return res.json({
    ok: true,
    submission
  });
});

app.post("/api/payments/checkout-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        ok: false,
        error: "Stripe is not configured. Add STRIPE_SECRET_KEY to environment variables."
      });
    }

    const {
      submissionId,
      productKey = "partner_report",
      customerEmail = "",
      customerName = "",
      siteUrl = ""
    } = req.body || {};

    if (!submissionId) {
      return res.status(400).json({
        ok: false,
        error: "Missing submissionId"
      });
    }

    const submission = submissions.get(submissionId);
    if (!submission) {
      return res.status(404).json({
        ok: false,
        error: "Submission not found. Save assessment before starting payment."
      });
    }

    const product = PRODUCT_CONFIG[productKey] || PRODUCT_CONFIG.partner_report;
    const frontendBase = resolveFrontendBase(req, siteUrl);

    const successUrl =
      `${frontendBase}/success.html` +
      `?submissionId=${encodeURIComponent(submissionId)}` +
      `&productKey=${encodeURIComponent(productKey)}` +
      `&session_id={CHECKOUT_SESSION_ID}`;

    const cancelUrl =
      `${frontendBase}/cancel.html` +
      `?submissionId=${encodeURIComponent(submissionId)}` +
      `&productKey=${encodeURIComponent(productKey)}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: customerEmail || submission.email || undefined,
      line_items: [
        {
          price_data: {
            currency: product.currency,
            product_data: {
              name: product.name,
              description: `Submission: ${submissionId}${
                customerName || submission.fullName
                  ? ` | Client: ${customerName || submission.fullName}`
                  : ""
              }`
            },
            unit_amount: product.amount
          },
          quantity: 1
        }
      ],
      metadata: {
        submissionId,
        productKey,
        customerName: customerName || submission.fullName || "",
        customerEmail: customerEmail || submission.email || ""
      },
      success_url: successUrl,
      cancel_url: cancelUrl
    });

    submission.updatedAt = new Date().toISOString();
    submission.checkoutSessionId = session.id;
    submissions.set(submissionId, submission);

    return res.json({
      ok: true,
      url: session.url,
      sessionId: session.id,
      successUrl,
      cancelUrl,
      frontendBase
    });
  } catch (error) {
    console.error("checkout-session error:", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to create checkout session"
    });
  }
});

app.post("/api/payments/mark-paid", async (req, res) => {
  try {
    const { submissionId, sessionId = "" } = req.body || {};

    if (!submissionId) {
      return res.status(400).json({
        ok: false,
        error: "Missing submissionId"
      });
    }

    const submission = submissions.get(submissionId);
    if (!submission) {
      return res.status(404).json({
        ok: false,
        error: "Submission not found"
      });
    }

    let paid = false;
    let paymentStatus = "unverified";

    if (stripe && sessionId) {
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        paymentStatus = session.payment_status || "unknown";
        paid = session.payment_status === "paid";
      } catch (err) {
        console.error("Stripe verify error:", err.message);
      }
    }

    if (!sessionId) {
      paid = true;
      paymentStatus = "marked_paid_without_session_check";
    }

    submission.paid = paid;
    submission.paymentStatus = paymentStatus;
    submission.updatedAt = new Date().toISOString();
    submission.paidAt = paid ? new Date().toISOString() : submission.paidAt || null;

    submissions.set(submissionId, submission);

    return res.json({
      ok: true,
      submissionId,
      paid,
      paymentStatus
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to mark payment"
    });
  }
});

app.get("/api/assessment/pdf/:submissionId", (req, res) => {
  try {
    const submissionId = sanitizeText(req.params.submissionId);
    const submission = submissions.get(submissionId);

    if (!submission) {
      return res.status(404).json({
        ok: false,
        error: "Submission not found"
      });
    }

    if (!submission.paid) {
      return res.status(403).json({
        ok: false,
        error: "Payment required before PDF generation"
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${submissionId}.pdf"`
    );

    const doc = new PDFDocument({
      margin: 50,
      size: "A4"
    });

    doc.pipe(res);

    doc.fontSize(20).text("Bircan Migration Assessment Report", {
      align: "center"
    });

    doc.moveDown();
    doc.fontSize(12).text(`Submission ID: ${submission.submissionId}`);
    doc.text(`Client Name: ${submission.fullName || "Not provided"}`);
    doc.text(`Client Email: ${submission.email || "Not provided"}`);
    doc.text(`Visa Subclass: ${submission.visaSubclass || "Not provided"}`);
    doc.text(`Product: ${submission.productKey || "Not provided"}`);
    doc.text(`Paid: ${submission.paid ? "Yes" : "No"}`);
    doc.text(`Created At: ${submission.createdAt || "Not available"}`);
    doc.text(`Updated At: ${submission.updatedAt || "Not available"}`);

    if (submission.paidAt) {
      doc.text(`Paid At: ${submission.paidAt}`);
    }

    if (submission.paymentStatus) {
      doc.text(`Payment Status: ${submission.paymentStatus}`);
    }

    doc.moveDown();
    doc.fontSize(14).text("Assessment Data", { underline: true });
    doc.moveDown(0.5);

    const rawData = JSON.stringify(submission.raw || {}, null, 2);
    doc.fontSize(9).text(rawData, {
      width: 500,
      align: "left"
    });

    doc.end();
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to generate PDF"
    });
  }
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    ok: false,
    error: err.message || "Internal server error"
  });
});

app.listen(PORT, () => {
  console.log(`Bircan backend running on port ${PORT}`);
});
