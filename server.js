/*
BACKEND ROUTES PATCH FOR server.js
Add these compatibility routes if your backend currently uses different Stripe endpoint names.

They make all frontend pages use one consistent contract:
POST /api/public/visa-assessment/checkout
POST /api/public/appeals-assessment/checkout
POST /api/public/citizenship/checkout

Each route should return: { ok: true, url: stripeCheckoutUrl }
*/

function normalisePlan(plan) {
  const p = String(plan || '').toLowerCase().trim();
  if (['instant','fastest','priority','300'].includes(p)) return 'instant';
  if (['24','24h','24_hours','24-hours','recommended','250'].includes(p)) return '24_hours';
  if (['3','3d','72','72h','3_days','3-days','value','150'].includes(p)) return '3_days';
  if (['20','50','100'].includes(p)) return p;
  return p || 'instant';
}

function requireClientEmail(req, res, next) {
  const email = String(req.body?.email || req.user?.email || '').trim().toLowerCase();
  if (!email) return res.status(400).json({ ok:false, error:'Client email is required before checkout.' });
  req.clientEmail = email;
  next();
}

app.post('/api/public/visa-assessment/checkout', requireClientEmail, async (req, res) => {
  try {
    const plan = normalisePlan(req.body.plan);
    const assessmentId = req.body.assessmentId || req.body.submissionId;
    if (!assessmentId) return res.status(400).json({ ok:false, error:'Visa assessment ID is required before checkout.' });

    // Replace this with your existing Stripe helper if named differently.
    const url = await createVisaAssessmentCheckout({
      email: req.clientEmail,
      plan,
      assessmentId,
      successUrl: req.body.successUrl,
      cancelUrl: req.body.cancelUrl
    });

    res.json({ ok:true, url });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message || 'Visa checkout failed.' });
  }
});

app.post('/api/public/appeals-assessment/checkout', requireClientEmail, async (req, res) => {
  try {
    const plan = normalisePlan(req.body.plan);
    const assessmentId = req.body.assessmentId || req.body.submissionId;

    // Do NOT validate appeal grounds here. Assessment validation belongs on the appeal form only.
    const url = await createAppealsAssessmentCheckout({
      email: req.clientEmail,
      plan,
      assessmentId,
      successUrl: req.body.successUrl,
      cancelUrl: req.body.cancelUrl
    });

    res.json({ ok:true, url });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message || 'Appeals checkout failed.' });
  }
});

app.post('/api/public/citizenship/checkout', requireClientEmail, async (req, res) => {
  try {
    const plan = normalisePlan(req.body.plan);
    if (!['20','50','100'].includes(plan)) {
      return res.status(400).json({ ok:false, error:'Valid citizenship pack is required.' });
    }

    const url = await createCitizenshipCheckout({
      email: req.clientEmail,
      plan,
      successUrl: req.body.successUrl,
      cancelUrl: req.body.cancelUrl
    });

    res.json({ ok:true, url });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message || 'Citizenship checkout failed.' });
  }
});
