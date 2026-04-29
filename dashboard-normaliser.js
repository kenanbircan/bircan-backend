'use strict';

/**
 * Bircan Migration dashboard backend normalisation patch
 * Purpose:
 * - Make /api/account/dashboard return one strict frontend-safe contract
 * - Fix: payments count = 0 after confirmed Stripe payment
 * - Fix: documents section empty while visa table has PDF links
 * - Fix: Selected plan missing while active plan is present
 * - Fix: applicant name missing where the form submitted name fields exist
 */

function cleanString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  return s || fallback;
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normalisePlan(value) {
  const raw = cleanString(value).toLowerCase();
  if (!raw) return '';
  if (['instant', 'now', 'immediate'].includes(raw)) return 'instant';
  if (['24h', '24hr', '24hrs', '24 hours', '24-hour', 'twenty four hours'].includes(raw)) return '24h';
  if (['3d', '3 days', '3-day', 'three days', '72h', '72 hours'].includes(raw)) return '3d';
  if (raw.includes('24')) return '24h';
  if (raw.includes('3') || raw.includes('72')) return '3d';
  if (raw.includes('instant') || raw.includes('immediate')) return 'instant';
  return raw;
}

function formatApplicantName(source = {}) {
  const direct = cleanString(firstDefined(
    source.applicantName,
    source.fullName,
    source.name,
    source.clientName,
    source.applicant?.fullName,
    source.applicant?.name,
    source.formData?.applicantName,
    source.formData?.fullName,
    source.formData?.name,
    source.answers?.applicantName,
    source.answers?.fullName,
    source.answers?.name
  ));
  if (direct) return direct;

  const first = cleanString(firstDefined(
    source.firstName,
    source.givenName,
    source.applicant?.firstName,
    source.applicant?.givenName,
    source.formData?.firstName,
    source.formData?.givenName,
    source.answers?.firstName,
    source.answers?.givenName
  ));
  const last = cleanString(firstDefined(
    source.lastName,
    source.familyName,
    source.surname,
    source.applicant?.lastName,
    source.applicant?.familyName,
    source.applicant?.surname,
    source.formData?.lastName,
    source.formData?.familyName,
    source.formData?.surname,
    source.answers?.lastName,
    source.answers?.familyName,
    source.answers?.surname
  ));
  return cleanString(`${first} ${last}`) || '—';
}

function getAssessmentEmail(a = {}) {
  return cleanString(firstDefined(
    a.email,
    a.clientEmail,
    a.applicantEmail,
    a.accountEmail,
    a.applicant?.email,
    a.formData?.email,
    a.formData?.clientEmail,
    a.formData?.applicantEmail,
    a.answers?.email,
    a.answers?.clientEmail,
    a.answers?.applicantEmail
  ));
}

function getPdfUrl(a = {}) {
  return cleanString(firstDefined(
    a.pdfUrl,
    a.advicePdfUrl,
    a.documentUrl,
    a.outputPdfUrl,
    a.letterUrl,
    a.pdf?.url,
    a.document?.url,
    a.documents?.[0]?.url
  ));
}

function getPdfIssuedAt(a = {}) {
  return firstDefined(
    a.pdfIssuedAt,
    a.documentIssuedAt,
    a.letterIssuedAt,
    a.completedAt,
    a.pdf?.issuedAt,
    a.document?.issuedAt,
    a.documents?.[0]?.issuedAt
  );
}

function normaliseVisaAssessment(a = {}) {
  const selectedPlan = normalisePlan(firstDefined(
    a.selectedPlan,
    a.requestedPlan,
    a.checkoutPlan,
    a.paymentPlan,
    a.formData?.selectedPlan,
    a.formData?.plan,
    a.answers?.selectedPlan,
    a.answers?.plan
  ));
  const activePlan = normalisePlan(firstDefined(
    a.activePlan,
    a.plan,
    a.activatedPlan,
    a.servicePlan,
    a.stripePlan,
    selectedPlan
  ));
  const pdfUrl = getPdfUrl(a);
  const status = cleanString(firstDefined(
    a.status,
    a.assessmentStatus,
    pdfUrl ? 'completed' : undefined,
    activePlan ? 'active' : undefined,
    'submitted'
  )).toLowerCase();

  return {
    id: cleanString(firstDefined(a.id, a._id, a.assessmentId, a.submissionId, a.reference)),
    type: 'visa_assessment',
    subclass: cleanString(firstDefined(a.subclass, a.visaSubclass, a.visaType, a.type, 'Visa assessment')),
    applicantName: formatApplicantName(a),
    email: getAssessmentEmail(a),
    selectedPlan: selectedPlan || activePlan || '',
    activePlan: activePlan || selectedPlan || '',
    planFidelityOk: !selectedPlan || !activePlan || selectedPlan === activePlan,
    status,
    submittedAt: firstDefined(a.submittedAt, a.createdAt, a.created_at, a.dateSubmitted, a.timestamp),
    paidAt: firstDefined(a.paidAt, a.paymentConfirmedAt, a.stripePaidAt, a.activatedAt),
    pdfUrl,
    pdfIssuedAt: getPdfIssuedAt(a),
    checkoutSessionId: cleanString(firstDefined(a.checkoutSessionId, a.stripeSessionId, a.sessionId)),
    paymentIntentId: cleanString(firstDefined(a.paymentIntentId, a.stripePaymentIntentId)),
    amount: firstDefined(a.amount, a.amountPaid, a.paymentAmount),
    currency: cleanString(firstDefined(a.currency, a.paymentCurrency, 'aud')).toLowerCase()
  };
}

function normalisePayment(p = {}) {
  return {
    id: cleanString(firstDefined(p.id, p._id, p.paymentId, p.paymentIntentId, p.checkoutSessionId, p.sessionId)),
    type: cleanString(firstDefined(p.type, p.productType, p.serviceType, 'service_payment')),
    service: cleanString(firstDefined(p.service, p.description, p.productName, p.title, 'Bircan Migration service')),
    status: cleanString(firstDefined(p.status, p.paymentStatus, 'paid')).toLowerCase(),
    plan: normalisePlan(firstDefined(p.plan, p.selectedPlan, p.activePlan, p.priceLabel)),
    amount: firstDefined(p.amount, p.amountPaid, p.total, p.amount_total),
    currency: cleanString(firstDefined(p.currency, 'aud')).toLowerCase(),
    paidAt: firstDefined(p.paidAt, p.createdAt, p.created, p.paymentConfirmedAt),
    checkoutSessionId: cleanString(firstDefined(p.checkoutSessionId, p.sessionId, p.stripeSessionId)),
    paymentIntentId: cleanString(firstDefined(p.paymentIntentId, p.stripePaymentIntentId))
  };
}

function paymentFromAssessment(a) {
  if (!a.checkoutSessionId && !a.paymentIntentId && !a.paidAt && !a.activePlan) return null;
  return normalisePayment({
    id: a.paymentIntentId || a.checkoutSessionId || `assessment-payment-${a.id}`,
    type: 'visa_assessment',
    service: `${a.subclass || 'Visa assessment'} assessment`,
    status: 'paid',
    plan: a.activePlan || a.selectedPlan,
    amount: a.amount,
    currency: a.currency || 'aud',
    paidAt: a.paidAt || a.submittedAt,
    checkoutSessionId: a.checkoutSessionId,
    paymentIntentId: a.paymentIntentId
  });
}

function documentFromAssessment(a) {
  if (!a.pdfUrl) return null;
  return {
    id: `doc-${a.id}`,
    type: 'Advice letter',
    serviceType: 'visa_assessment',
    title: `${a.subclass || 'Visa'} advice letter`,
    assessmentId: a.id,
    applicantName: a.applicantName || '—',
    version: 'v1',
    issuedAt: a.pdfIssuedAt || a.submittedAt || a.paidAt,
    url: a.pdfUrl,
    linkedPaymentId: a.paymentIntentId || a.checkoutSessionId || ''
  };
}

function dedupeById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items.filter(Boolean)) {
    const id = cleanString(item.id || item.url || JSON.stringify(item));
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

function normaliseDashboardPayload(raw = {}) {
  const user = raw.user || raw.account || raw.client || {};
  const rawAssessments = firstDefined(raw.visaAssessments, raw.assessments, raw.submissions, raw.services?.visaAssessments, []);
  const visaAssessments = Array.isArray(rawAssessments) ? rawAssessments.map(normaliseVisaAssessment) : [];

  const rawPayments = firstDefined(raw.payments, raw.verifiedPayments, raw.stripePayments, raw.services?.payments, []);
  const directPayments = Array.isArray(rawPayments) ? rawPayments.map(normalisePayment) : [];
  const derivedPayments = visaAssessments.map(paymentFromAssessment).filter(Boolean);
  const payments = dedupeById([...directPayments, ...derivedPayments]);

  const rawDocuments = firstDefined(raw.documents, raw.adviceFiles, raw.files, raw.services?.documents, []);
  const directDocuments = Array.isArray(rawDocuments) ? rawDocuments.map(d => ({
    id: cleanString(firstDefined(d.id, d._id, d.documentId, d.url)),
    type: cleanString(firstDefined(d.type, d.documentType, 'Document')),
    serviceType: cleanString(firstDefined(d.serviceType, d.productType, '')),
    title: cleanString(firstDefined(d.title, d.name, d.filename, 'Document')),
    assessmentId: cleanString(firstDefined(d.assessmentId, d.submissionId)),
    applicantName: cleanString(firstDefined(d.applicantName, d.clientName, '—')),
    version: cleanString(firstDefined(d.version, 'v1')),
    issuedAt: firstDefined(d.issuedAt, d.createdAt, d.generatedAt),
    url: cleanString(firstDefined(d.url, d.downloadUrl, d.pdfUrl)),
    linkedPaymentId: cleanString(firstDefined(d.linkedPaymentId, d.paymentId, d.paymentIntentId, d.checkoutSessionId))
  })) : [];
  const derivedDocuments = visaAssessments.map(documentFromAssessment).filter(Boolean);
  const documents = dedupeById([...directDocuments, ...derivedDocuments]);

  const rawCitizenship = firstDefined(raw.citizenship, raw.citizenshipAccess, raw.services?.citizenship, {});
  const citizenshipAccess = {
    active: Boolean(firstDefined(rawCitizenship.active, rawCitizenship.isActive, rawCitizenship.unlocked, false)),
    plan: cleanString(firstDefined(rawCitizenship.plan, rawCitizenship.product, rawCitizenship.package, '')),
    attemptsTotal: Number(firstDefined(rawCitizenship.attemptsTotal, rawCitizenship.totalAttempts, rawCitizenship.attempts, 0)) || 0,
    attemptsUsed: Number(firstDefined(rawCitizenship.attemptsUsed, rawCitizenship.usedAttempts, 0)) || 0,
    attemptsRemaining: Number(firstDefined(rawCitizenship.attemptsRemaining, rawCitizenship.remainingAttempts, 0)) || 0,
    lastScore: firstDefined(rawCitizenship.lastScore, rawCitizenship.score, null),
    lastAttemptAt: firstDefined(rawCitizenship.lastAttemptAt, rawCitizenship.updatedAt, null),
    status: cleanString(firstDefined(rawCitizenship.status, rawCitizenship.active ? 'active' : 'locked')).toLowerCase()
  };

  const activeVisaServices = visaAssessments.filter(a => ['active', 'paid', 'completed', 'in_review', 'review'].includes(a.status) || a.activePlan).length;
  const activeCitizenshipServices = citizenshipAccess.active ? 1 : 0;

  const auditTrail = dedupeById([
    ...visaAssessments.map(a => ({ id: `submitted-${a.id}`, type: 'Assessment submitted', label: a.subclass, at: a.submittedAt })),
    ...visaAssessments.filter(a => a.paidAt).map(a => ({ id: `paid-${a.id}`, type: 'Payment confirmed', label: a.subclass, at: a.paidAt })),
    ...documents.map(d => ({ id: `document-${d.id}`, type: 'Document issued', label: d.title, at: d.issuedAt }))
  ]).filter(x => x.at).sort((a, b) => new Date(b.at) - new Date(a.at));

  return {
    ok: true,
    user: {
      id: cleanString(firstDefined(user.id, user._id, user.userId)),
      email: cleanString(firstDefined(user.email, raw.email, raw.accountEmail)),
      name: cleanString(firstDefined(user.name, user.fullName, user.clientName, '')),
      verified: Boolean(firstDefined(user.verified, raw.verified, true)),
      lastVerifiedAt: firstDefined(user.lastVerifiedAt, raw.lastVerifiedAt, new Date().toISOString())
    },
    summary: {
      activeServices: activeVisaServices + activeCitizenshipServices,
      visaAssessments: visaAssessments.length,
      activeCitizenship: activeCitizenshipServices,
      documents: documents.length,
      payments: payments.length
    },
    visaAssessments,
    citizenshipAccess,
    documents,
    payments,
    auditTrail,
    nextAction: buildNextAction({ visaAssessments, citizenshipAccess, documents, payments })
  };
}

function buildNextAction({ visaAssessments, citizenshipAccess, documents }) {
  const notIssued = visaAssessments.find(a => a.activePlan && !a.pdfUrl);
  if (notIssued) {
    return {
      type: 'await_document',
      title: 'Assessment under preparation',
      message: `${notIssued.subclass} is active. The advice letter has not been issued yet.`,
      href: '#visa-assessments',
      label: 'View visa matter'
    };
  }
  const readyDoc = documents && documents[0];
  if (readyDoc?.url) {
    return {
      type: 'download_document',
      title: 'Download issued advice letter',
      message: 'A completed advice document is available under this account.',
      href: readyDoc.url,
      label: 'Download document'
    };
  }
  if (citizenshipAccess?.active && citizenshipAccess?.attemptsRemaining > 0) {
    return {
      type: 'start_exam',
      title: 'Start citizenship exam practice',
      message: `${citizenshipAccess.attemptsRemaining} attempt(s) remaining.`,
      href: 'paid-citizenship-exam.html',
      label: 'Open paid exam'
    };
  }
  return {
    type: 'start_service',
    title: 'Start or activate a service',
    message: 'No active paid service requires action at this time.',
    href: 'ai-assessments.html',
    label: 'Start assessment'
  };
}

module.exports = {
  normaliseDashboardPayload,
  normaliseVisaAssessment,
  normalisePayment,
  normalisePlan
};
