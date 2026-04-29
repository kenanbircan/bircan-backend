'use strict';

/**
 * Add this to server.js after your auth/session middleware and after Stripe is configured.
 * Adjust the storage lookups to your existing arrays/database collections.
 */

const { normaliseDashboardPayload } = require('./dashboard-normaliser');

function getCurrentEmail(req) {
  return (
    req.user?.email ||
    req.session?.user?.email ||
    req.session?.email ||
    req.headers['x-user-email'] ||
    ''
  ).toString().trim().toLowerCase();
}

function requireDashboardUser(req, res, next) {
  const email = getCurrentEmail(req);
  if (!email) {
    return res.status(401).json({ ok: false, code: 'LOGIN_REQUIRED', message: 'Login required.' });
  }
  req.dashboardEmail = email;
  return next();
}

function sameEmail(item, email) {
  const values = [
    item.email,
    item.clientEmail,
    item.applicantEmail,
    item.accountEmail,
    item.userEmail,
    item.formData?.email,
    item.formData?.clientEmail,
    item.formData?.applicantEmail,
    item.answers?.email,
    item.answers?.clientEmail,
    item.answers?.applicantEmail
  ].filter(Boolean).map(v => String(v).trim().toLowerCase());
  return values.includes(email);
}

async function attachDashboardRoutes(app, stores = {}) {
  const {
    getAssessments,
    getPayments,
    getDocuments,
    getCitizenshipAccess,
    getUserByEmail
  } = stores;

  app.get('/api/account/dashboard', requireDashboardUser, async (req, res) => {
    try {
      const email = req.dashboardEmail;

      const [user, assessmentsRaw, paymentsRaw, documentsRaw, citizenshipRaw] = await Promise.all([
        getUserByEmail ? getUserByEmail(email) : Promise.resolve({ email, verified: true }),
        getAssessments ? getAssessments(email) : Promise.resolve(global.assessmentSubmissions || global.assessments || []),
        getPayments ? getPayments(email) : Promise.resolve(global.payments || global.verifiedPayments || []),
        getDocuments ? getDocuments(email) : Promise.resolve(global.documents || global.adviceFiles || []),
        getCitizenshipAccess ? getCitizenshipAccess(email) : Promise.resolve(global.citizenshipAccess?.[email] || {})
      ]);

      const assessments = Array.isArray(assessmentsRaw) ? assessmentsRaw.filter(a => sameEmail(a, email)) : [];
      const payments = Array.isArray(paymentsRaw) ? paymentsRaw.filter(p => sameEmail(p, email) || String(p.email || p.customerEmail || '').toLowerCase() === email) : [];
      const documents = Array.isArray(documentsRaw) ? documentsRaw.filter(d => sameEmail(d, email) || String(d.email || d.clientEmail || '').toLowerCase() === email) : [];

      return res.json(normaliseDashboardPayload({
        user: user || { email, verified: true },
        visaAssessments: assessments,
        payments,
        documents,
        citizenshipAccess: citizenshipRaw || {}
      }));
    } catch (err) {
      console.error('GET /api/account/dashboard failed', err);
      return res.status(500).json({ ok: false, code: 'DASHBOARD_FAILED', message: 'Dashboard could not be loaded.' });
    }
  });
}

module.exports = { attachDashboardRoutes, requireDashboardUser, getCurrentEmail };
