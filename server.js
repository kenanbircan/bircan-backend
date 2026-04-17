import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import OpenAI from "openai";
import fs from "fs";
import {
  createSubmission,
  getSubmission,
  updateSubmission,
  appendEmailLog,
  listSubmissions
} from "./storage.js";
import { generateAssessmentPdf } from "./pdf.js";
import { sendAssessmentEmail } from "./mailer.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn("Missing STRIPE_SECRET_KEY");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const rawWebhookPath = "/api/payments/webhook";

function allowedOrigins() {
  return String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const corsOptions = {
  origin(origin, callback) {
    const list = allowedOrigins();
    if (!origin || !list.length || list.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  }
};

app.use((req, res, next) => {
  if (req.path === rawWebhookPath) return next();
  express.json({ limit: "2mb" })(req, res, next);
});

app.use(cors(corsOptions));

function sanitizePlan(plan) {
  const key = String(plan || "").toLowerCase().trim();
  const plans = {
    instant: { amount: 300, label: "Instant" },
    "24 hours": { amount: 250, label: "24 Hours" },
    "3 days": { amount: 150, label: "3 Days" }
  };
  return plans[key] || null;
}

function buildAssessmentPrompt(submission) {
  return `
You are preparing a professional internal visa assessment analysis for Bircan Migration & Education in Australia.

Rules:
- Use only the submitted facts.
- Do not invent missing information.
- Be clear, cautious, and practical.
- Return valid JSON only.
- Keep the tone professional and client-friendly.
- The final client letter draft must be written in plain English and must not guarantee an outcome.

Return exactly this JSON shape:
{
  "summary": "string",
  "strengths": ["string"],
  "concerns": ["string"],
  "missingInformation": ["string"],
  "nextSteps": ["string"],
  "riskLevel": "low|medium|high",
  "clientLetterDraft": "string"
}

Submission:
${JSON.stringify({
  visaSubclass: submission?.visa?.subclass,
  selectedPlan: submission?.visa?.selectedPlan,
  client: submission?.client,
  answers: submission?.answers
}, null, 2)}
`.trim();
}

async function runAnalysis(submission) {
  const prompt = buildAssessmentPrompt(submission);

  const result = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    input: prompt
  });

  const text = result.output_text?.trim() || "";

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("OpenAI did not return valid JSON.");
  }

  return parsed;
}

async function processPaidSubmission(submissionId) {
  const existing = getSubmission(submissionId);
  if (!existing) {
    throw new Error(`Submission not found: ${submissionId}`);
  }

  if (
    existing.analysisStatus === "completed" &&
    existing.pdfStatus === "generated" &&
    existing.emailStatus === "sent"
  ) {
    return existing;
  }

  updateSubmission(submissionId, {
    status: "processing",
    analysisStatus: "running"
  });

  const latest = getSubmission(submissionId);
  const analysis = await runAnalysis(latest);

  updateSubmission(submissionId, {
    analysis,
    analysisStatus: "completed",
    status: "generating_pdf"
  });

  const withAnalysis = getSubmission(submissionId);
  const pdfPath = await generateAssessmentPdf(withAnalysis);

  updateSubmission(submissionId, {
    pdf: {
      path: pdfPath,
      generatedAt: new Date().toISOString()
    },
    pdfStatus: "generated",
    status: "emailing"
  });

  const ready = getSubmission(submissionId);
  const clientName = ready?.client?.fullName || "Client";
  const visaSubclass = ready?.visa?.subclass || "visa assessment";

  const text = [
    `Dear ${clientName},`,
    "",
    `Thank you for your assessment request with Bircan Migration & Education.`,
    `Your ${visaSubclass} assessment letter is attached to this email.`,
    "",
    "Please note that this document is based on the information you submitted online and should be reviewed together with any supporting documents before relying on it for a formal application strategy.",
    "",
    "Kind regards,",
    "Bircan Migration & Education"
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6;">
      <p>Dear ${clientName},</p>
      <p>Thank you for your assessment request with Bircan Migration &amp; Education.</p>
      <p>Your <strong>${visaSubclass}</strong> assessment letter is attached to this email.</p>
      <p>Please note that this document is based on the information you submitted online and should be reviewed together with any supporting documents before relying on it for a formal application strategy.</p>
      <p>Kind regards,<br/>Bircan Migration &amp; Education</p>
    </div>
  `;

  const info = await sendAssessmentEmail({
    to: ready.client.email,
    subject: `Your Bircan Migration Assessment Letter`,
    text,
    html,
    attachmentPath: ready?.pdf?.path || pdfPath,
    attachmentFilename: `${submissionId}-assessment-letter.pdf`
  });

  appendEmailLog(submissionId, {
    messageId: info?.messageId || null,
    to: ready.client.email,
    subject: "Your Bircan Migration Assessment Letter",
    status: "sent"
  });

  return updateSubmission(submissionId, {
    emailStatus: "sent",
    status: "completed"
  });
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "bircan-migration-backend",
    appBaseUrl: process.env.APP_BASE_URL || null,
    hasStripeKey: Boolean(process.env.STRIPE_SECRET_KEY),
    hasStripeWebhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    hasOpenAI: Boolean(process.env.OPENAI_API_KEY),
    hasSmtp: Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  });
});

app.get("/api/stripe-test", async (req, res) => {
  try {
    const account = await stripe.accounts.retrieve();
    res.json({
      ok: true,
      accountId: account.id
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error.message,
      type: error.type,
      code: error.code
    });
  }
});

app.post("/api/assessment/submit", (req, res) => {
  try {
    const {
      fullName,
      email,
      phone,
      visaSubclass,
      selectedPlan,
      deliveryLabel,
      amount,
      answers,
      metadata
    } = req.body || {};

    if (!fullName || !email || !visaSubclass || !selectedPlan || !answers || typeof answers !== "object") {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields."
      });
    }

    const submission = createSubmission({
      fullName,
      email,
      phone,
      visaSubclass,
      selectedPlan,
      deliveryLabel,
      amount,
      answers,
      metadata
    });

    return res.json({
      ok: true,
      submissionId: submission.id,
      status: submission.status
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to create submission."
    });
  }
});

app.post("/api/payments/create-checkout-session", async (req, res) => {
  try {
    const { submissionId, selectedPlan } = req.body || {};
    const submission = getSubmission(submissionId);

    if (!submission) {
      return res.status(404).json({ ok: false, error: "Submission not found." });
    }

    const plan = sanitizePlan(selectedPlan || submission?.visa?.selectedPlan);
    if (!plan) {
      return res.status(400).json({ ok: false, error: "Invalid payment plan." });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Missing STRIPE_SECRET_KEY in backend environment."
      });
    }

    if (!process.env.FRONTEND_URL) {
      return res.status(500).json({
        ok: false,
        error: "Missing FRONTEND_URL in backend environment."
      });
    }

    const email = submission?.client?.email?.trim();
    if (!email) {
      return res.status(400).json({
        ok: false,
        error: "Client email is missing from submission."
      });
    }

    const currency = (process.env.STRIPE_CURRENCY || "aud").toLowerCase();
    const unitAmount = Math.round(Number(plan.amount) * 100);

    if (!unitAmount || unitAmount < 50) {
      return res.status(400).json({
        ok: false,
        error: "Invalid plan amount."
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: email,
      payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: unitAmount,
            product_data: {
              name: `Bircan Migration Visa Assessment - ${submission.visa.subclass || "482"}`,
              description: `${plan.label} service delivery`
            }
          }
        }
      ],
      metadata: {
        submissionId: submission.id,
        selectedPlan: plan.label,
        visaSubclass: submission?.visa?.subclass || "482"
      },
      success_url: `${process.env.FRONTEND_URL}/success.html?submissionId=${submission.id}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel.html?submissionId=${submission.id}`
    });

    updateSubmission(submission.id, {
      checkoutSessionId: session.id,
      status: "payment_pending",
      visa: {
        ...submission.visa,
        selectedPlan: plan.label,
        amount: plan.amount
      }
    });

    return res.json({
      ok: true,
      url: session.url,
      sessionId: session.id
    });
  } catch (error) {
    console.error("Stripe create-checkout-session error:", {
      message: error?.message,
      type: error?.type,
      code: error?.code,
      raw: error?.raw?.message,
      stack: error?.stack
    });

    return res.status(500).json({
      ok: false,
      error: error?.raw?.message || error?.message || "Stripe session could not be created."
    });
  }
});

app.post(rawWebhookPath, express.raw({ type: "application/json" }), async (req, res) => {
  let event;

  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const submissionId = session?.metadata?.submissionId;

      if (submissionId) {
        const existing = getSubmission(submissionId);
        if (existing) {
          updateSubmission(submissionId, {
            paymentStatus: "paid",
            stripePaymentIntentId: session.payment_intent || null,
            status: "paid"
          });

          await processPaidSubmission(submissionId);
        }
      }
    }

    return res.json({ received: true });
  } catch (error) {
    console.error("Webhook processing failed:", error);
    return res.status(500).json({ received: false, error: error.message });
  }
});

app.post("/api/payments/confirm", async (req, res) => {
  try {
    const { submissionId, sessionId } = req.body || {};
    const submission = getSubmission(submissionId);

    if (!submission) {
      return res.status(404).json({ ok: false, error: "Submission not found." });
    }

    if (!sessionId) {
      return res.status(400).json({ ok: false, error: "Missing sessionId." });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== "paid") {
      return res.status(400).json({
        ok: false,
        error: "Payment has not completed yet."
      });
    }

    updateSubmission(submissionId, {
      paymentStatus: "paid",
      stripePaymentIntentId: session.payment_intent || null,
      status: "paid"
    });

    const processed = await processPaidSubmission(submissionId);

    return res.json({
      ok: true,
      submissionId,
      status: processed.status,
      paymentStatus: processed.paymentStatus,
      pdfStatus: processed.pdfStatus,
      emailStatus: processed.emailStatus
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Payment confirmation failed."
    });
  }
});

app.get("/api/assessment/:submissionId/status", (req, res) => {
  const submission = getSubmission(req.params.submissionId);
  if (!submission) {
    return res.status(404).json({ ok: false, error: "Submission not found." });
  }

  return res.json({
    ok: true,
    submissionId: submission.id,
    status: submission.status,
    paymentStatus: submission.paymentStatus,
    analysisStatus: submission.analysisStatus,
    pdfStatus: submission.pdfStatus,
    emailStatus: submission.emailStatus
  });
});

app.get("/api/assessment/:submissionId/result", (req, res) => {
  const submission = getSubmission(req.params.submissionId);
  if (!submission) {
    return res.status(404).json({ ok: false, error: "Submission not found." });
  }

  return res.json({
    ok: true,
    submission
  });
});

app.get("/api/admin/submissions", (req, res) => {
  const items = listSubmissions(100);
  return res.json({
    ok: true,
    count: items.length,
    submissions: items
  });
});

app.get("/api/assessment/:submissionId/pdf", (req, res) => {
  const submission = getSubmission(req.params.submissionId);
  const filePath = submission?.pdf?.path;

  if (!submission || !filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: "PDF not found." });
  }

  return res.download(filePath, `${submission.id}-assessment-letter.pdf`);
});

app.use((err, req, res, next) => {
  console.error(err);
  return res.status(500).json({
    ok: false,
    error: err.message || "Internal server error."
  });
});

app.listen(port, () => {
  console.log(`Bircan backend listening on port ${port}`);
});
