'use strict';

/**
 * Use this logic inside POST /api/payments/finalise.
 * It ensures Stripe payments are persisted as payment records and linked to the right assessment/account.
 */

async function finaliseStripePayment({ req, res, stripe, stores }) {
  try {
    const sessionId = String(req.body?.session_id || req.body?.sessionId || req.query?.session_id || '').trim();
    if (!sessionId || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ ok: false, code: 'INVALID_SESSION_ID', message: 'Invalid Stripe checkout session.' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'line_items.data.price.product']
    });

    if (session.payment_status !== 'paid') {
      return res.status(402).json({ ok: false, code: 'PAYMENT_NOT_PAID', message: 'Stripe payment is not paid yet.' });
    }

    const email = String(
      session.customer_details?.email ||
      session.customer_email ||
      session.metadata?.email ||
      req.user?.email ||
      req.session?.user?.email ||
      ''
    ).trim().toLowerCase();

    const serviceType = session.metadata?.serviceType || session.metadata?.productType || 'visa_assessment';
    const assessmentId = session.metadata?.assessmentId || session.metadata?.submissionId || '';
    const selectedPlan = session.metadata?.selectedPlan || session.metadata?.plan || '';

    const paymentRecord = {
      id: session.payment_intent?.id || session.id,
      checkoutSessionId: session.id,
      paymentIntentId: session.payment_intent?.id || '',
      email,
      serviceType,
      assessmentId,
      selectedPlan,
      activePlan: selectedPlan,
      amount: session.amount_total,
      currency: session.currency || 'aud',
      status: 'paid',
      paidAt: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      rawStripeMode: session.mode
    };

    if (stores?.upsertPayment) await stores.upsertPayment(paymentRecord);

    if (serviceType === 'visa_assessment' && assessmentId && stores?.updateAssessmentAfterPayment) {
      await stores.updateAssessmentAfterPayment(assessmentId, {
        email,
        selectedPlan,
        activePlan: selectedPlan,
        status: 'active',
        paidAt: paymentRecord.paidAt,
        checkoutSessionId: session.id,
        paymentIntentId: paymentRecord.paymentIntentId,
        amount: paymentRecord.amount,
        currency: paymentRecord.currency
      });
    }

    if (serviceType === 'citizenship' && stores?.activateCitizenshipAccess) {
      await stores.activateCitizenshipAccess(email, {
        plan: selectedPlan || session.metadata?.plan || 'citizenship',
        checkoutSessionId: session.id,
        paymentIntentId: paymentRecord.paymentIntentId,
        paidAt: paymentRecord.paidAt
      });
    }

    return res.json({ ok: true, payment: paymentRecord });
  } catch (err) {
    console.error('POST /api/payments/finalise failed', err);
    return res.status(500).json({ ok: false, code: 'PAYMENT_FINALISE_FAILED', message: 'Payment could not be finalised.' });
  }
}

module.exports = { finaliseStripePayment };
