import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const WEBSITE_URL = process.env.WEBSITE_URL || 'https://www.bircanmigration.au';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

/*
  In-memory demo storage for now.
  This keeps the backend working immediately.
  Later you can replace this with database storage.
*/
const submissions = new Map();

function makeId(prefix = 'sub') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/* -----------------------------
   Health
----------------------------- */
app.get('/', (_req, res) => {
  res.send('Bircan Migration Backend Running');
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'bircan-backend',
    website: WEBSITE_URL,
    message: 'Backend is running',
    endpoints: {
      health: '/api/health',
      contact: '/api/contact',
      assessmentSubmit: '/api/assessment/submit',
      assessmentPdf: '/api/assessment/pdf',
      upload: '/api/upload',
      checkoutSession: '/api/payments/checkout-session',
      markPaid: '/api/payments/mark-paid'
    },
    timestamp: new Date().toISOString()
  });
});

/* -----------------------------
   Contact
----------------------------- */
app.post('/api/contact', async (req, res) => {
  try {
    const data = req.body || {};
    const id = makeId('contact');

    submissions.set(id, {
      id,
      type: 'contact',
      status: 'new',
      createdAt: new Date().toISOString(),
      payload: data
    });

    res.json({
      ok: true,
      message: 'Contact request received',
      id
    });
  } catch (error) {
    console.error('Contact error:', error);
    res.status(500).json({
      ok: false,
      message: 'Failed to process contact request'
    });
  }
});

/* -----------------------------
   Assessment submit
----------------------------- */
app.post('/api/assessment/submit', async (req, res) => {
  try {
    const data = req.body || {};
    const id = makeId('assessment');

    submissions.set(id, {
      id,
      type: 'assessment',
      status: 'submitted',
      paymentStatus: 'unpaid',
      createdAt: new Date().toISOString(),
      payload: data
    });

    res.json({
      ok: true,
      message: 'Assessment submitted successfully',
      submissionId: id
    });
  } catch (error) {
    console.error('Assessment submit error:', error);
    res.status(500).json({
      ok: false,
      message: 'Failed to submit assessment'
    });
  }
});

/* -----------------------------
   Assessment PDF placeholder
----------------------------- */
app.post('/api/assessment/pdf', async (req, res) => {
  try {
    const data = req.body || {};
    const submissionId = data.submissionId || makeId('pdf');

    res.json({
      ok: true,
      message: 'PDF generation placeholder ready',
      submissionId,
      pdfUrl: `${APP_BASE_URL}/api/assessment/pdf/${submissionId}`
    });
  } catch (error) {
    console.error('Assessment PDF error:', error);
    res.status(500).json({
      ok: false,
      message: 'Failed to generate PDF'
    });
  }
});

app.get('/api/assessment/pdf/:id', async (req, res) => {
  res.json({
    ok: true,
    message: 'PDF file endpoint placeholder',
    id: req.params.id
  });
});

/* -----------------------------
   Upload placeholder
----------------------------- */
app.post('/api/upload', async (_req, res) => {
  res.json({
    ok: true,
    message: 'Upload endpoint ready'
  });
});

/* -----------------------------
   Payments / Checkout Session
----------------------------- */
app.post('/api/payments/checkout-session', async (req, res) => {
  try {
    const {
      productKey,
      submissionId,
      customerEmail,
      customerName,
      amount
    } = req.body || {};

    /*
      This is a working placeholder response so the frontend
      stops failing and has a usable checkout URL.
      Later you can replace this with real Stripe session creation.
    */

    const resolvedProduct = productKey || 'citizenship_review';
    const resolvedSubmissionId = submissionId || makeId('order');

    if (!submissions.has(resolvedSubmissionId)) {
      submissions.set(resolvedSubmissionId, {
        id: resolvedSubmissionId,
        type: 'payment-intent',
        status: 'created',
        paymentStatus: 'pending',
        createdAt: new Date().toISOString(),
        payload: {
          productKey: resolvedProduct,
          customerEmail: customerEmail || '',
          customerName: customerName || '',
          amount: amount || null
        }
      });
    } else {
      const existing = submissions.get(resolvedSubmissionId);
      existing.paymentStatus = 'pending';
      existing.productKey = resolvedProduct;
      existing.customerEmail = customerEmail || existing.customerEmail || '';
      existing.customerName = customerName || existing.customerName || '';
      submissions.set(resolvedSubmissionId, existing);
    }

    /*
      For now, simulate a checkout success URL back to the website.
      Replace this later with Stripe Checkout session.url
    */
    const successUrl =
      `${WEBSITE_URL}/success.html` +
      `?submissionId=${encodeURIComponent(resolvedSubmissionId)}` +
      `&productKey=${encodeURIComponent(resolvedProduct)}`;

    res.json({
      ok: true,
      message: 'Checkout session created',
      mock: true,
      submissionId: resolvedSubmissionId,
      url: successUrl
    });
  } catch (error) {
    console.error('Checkout session error:', error);
    res.status(500).json({
      ok: false,
      message: 'Failed to create checkout session'
    });
  }
});

/* -----------------------------
   Mark paid
----------------------------- */
app.post('/api/payments/mark-paid', async (req, res) => {
  try {
    const { submissionId, productKey } = req.body || {};

    if (!submissionId) {
      return res.status(400).json({
        ok: false,
        message: 'submissionId is required'
      });
    }

    const existing = submissions.get(submissionId) || {
      id: submissionId,
      type: 'payment',
      createdAt: new Date().toISOString(),
      payload: {}
    };

    existing.status = 'paid';
    existing.paymentStatus = 'paid';
    existing.paidAt = new Date().toISOString();
    existing.productKey = productKey || existing.productKey || null;

    submissions.set(submissionId, existing);

    res.json({
      ok: true,
      message: 'Payment marked as paid',
      submissionId,
      productKey: existing.productKey || null
    });
  } catch (error) {
    console.error('Mark paid error:', error);
    res.status(500).json({
      ok: false,
      message: 'Failed to mark payment as paid'
    });
  }
});

/* -----------------------------
   Simple admin/debug route
----------------------------- */
app.get('/api/debug/submissions', (_req, res) => {
  res.json({
    ok: true,
    count: submissions.size,
    items: Array.from(submissions.values())
  });
});

/* -----------------------------
   Start server
----------------------------- */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
