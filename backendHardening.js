'use strict';

/**
 * backendHardening.js
 * Bircan Migration — Production Reliability Layer
 * Drop-in helper for Express/Render/Postgres/Stripe/PDF pipelines.
 *
 * Purpose:
 * - Fail fast on missing critical environment variables.
 * - Register routes in one visible registry so "Route not found" is diagnosable.
 * - Provide stable async error handling and JSON error responses.
 * - Add startup self-checks for database, Stripe configuration, PDF engine exports and decision engine exports.
 * - Provide payment/PDF guards so a paid client never receives a false "ready" state.
 */

const crypto = require('crypto');

function mask(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 10) return `${s.slice(0, 3)}***`;
  return `${s.slice(0, 6)}***${s.slice(-4)}`;
}

function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(v).toLowerCase());
}

function requiredEnv(names, opts = {}) {
  const allowMissingInDev = opts.allowMissingInDev !== false;
  const isProd = process.env.NODE_ENV === 'production' || envBool('RENDER');
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length && (isProd || !allowMissingInDev)) {
    const err = new Error(`Missing required environment variables: ${missing.join(', ')}`);
    err.code = 'MISSING_ENV';
    err.missing = missing;
    throw err;
  }
  return { ok: true, missing };
}

function makeRequestId() {
  return `req_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function requestIdMiddleware(req, res, next) {
  req.requestId = req.headers['x-request-id'] || makeRequestId();
  res.setHeader('X-Request-Id', req.requestId);
  next();
}

function asyncRoute(fn) {
  return function wrappedAsyncRoute(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function normalisePath(path) {
  return String(path || '').replace(/\/+$/, '') || '/';
}

function createRouteRegistry(app) {
  const routes = [];
  function add(method, path, ...handlers) {
    const m = method.toLowerCase();
    const p = normalisePath(path);
    routes.push({ method: m.toUpperCase(), path: p });
    app[m](p, ...handlers);
  }
  function expose(basePath = '/api/routes') {
    app.get(basePath, (_req, res) => res.json({ ok: true, count: routes.length, routes }));
  }
  function notFoundHandler(req, res) {
    res.status(404).json({
      ok: false,
      code: 'ROUTE_NOT_FOUND',
      error: `Route not found: ${req.method} ${req.path}`,
      requestId: req.requestId || null,
      hint: 'Check /api/routes to confirm the route is registered in the deployed server.'
    });
  }
  return { add, expose, routes, notFoundHandler };
}

function publicError(err) {
  const msg = err && err.message ? String(err.message) : 'Server error.';
  if (/duplicate key/i.test(msg)) return 'Duplicate record.';
  if (/password|secret|token|api key/i.test(msg)) return 'Server configuration error.';
  return msg;
}

function errorHandler(err, req, res, _next) {
  const status = err.statusCode || err.status || (err.code === 'MISSING_ENV' ? 500 : 500);
  const payload = {
    ok: false,
    code: err.code || 'SERVER_ERROR',
    error: publicError(err),
    requestId: req.requestId || null
  };
  console.error('[backend-error]', {
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    code: payload.code,
    message: err.message,
    stack: err.stack
  });
  res.status(status).json(payload);
}

async function checkDatabase(query) {
  if (typeof query !== 'function') return { ok: false, error: 'query function not supplied' };
  try {
    await query('SELECT 1 AS ok');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function checkStripeConfig() {
  const key = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_TEST || process.env.STRIPE_SECRET_KEY_LIVE;
  const prices = {
    visaInstant: process.env.STRIPE_PRICE_VISA_INSTANT || process.env.STRIPE_PRICE_VISA_INSTANT_TEST || process.env.STRIPE_PRICE_VISA_INSTANT_LIVE,
    visa24h: process.env.STRIPE_PRICE_VISA_24H || process.env.STRIPE_PRICE_VISA_24H_TEST || process.env.STRIPE_PRICE_VISA_24H_LIVE,
    visa3d: process.env.STRIPE_PRICE_VISA_3D || process.env.STRIPE_PRICE_VISA_3D_TEST || process.env.STRIPE_PRICE_VISA_3D_LIVE
  };
  return {
    ok: Boolean(key),
    key: mask(key),
    mode: key && key.startsWith('sk_live_') ? 'live' : key && key.startsWith('sk_test_') ? 'test' : 'unknown',
    pricesConfigured: Object.fromEntries(Object.entries(prices).map(([k, v]) => [k, Boolean(v)]))
  };
}

function checkPdfModule(pdfModule) {
  return {
    ok: Boolean(pdfModule && typeof pdfModule.buildAssessmentPdfBuffer === 'function' && typeof pdfModule.sha256 === 'function'),
    hasBuildAssessmentPdfBuffer: Boolean(pdfModule && typeof pdfModule.buildAssessmentPdfBuffer === 'function'),
    hasSha256: Boolean(pdfModule && typeof pdfModule.sha256 === 'function')
  };
}

function checkDecisionEngine(engineModule) {
  return {
    ok: Boolean(engineModule && typeof engineModule.buildDelegateSimulatorPdfInputs === 'function' && typeof engineModule.supportedDelegateSimulatorSubclasses === 'function'),
    engineVersion: engineModule && engineModule.ENGINE_VERSION,
    hasBuildDelegateSimulatorPdfInputs: Boolean(engineModule && typeof engineModule.buildDelegateSimulatorPdfInputs === 'function'),
    hasSupportedSubclasses: Boolean(engineModule && typeof engineModule.supportedDelegateSimulatorSubclasses === 'function'),
    supportedSubclasses: engineModule && typeof engineModule.supportedDelegateSimulatorSubclasses === 'function'
      ? engineModule.supportedDelegateSimulatorSubclasses()
      : []
  };
}

async function buildReadinessReport({ query, pdfModule, decisionEngineModule, routes = [] } = {}) {
  const db = await checkDatabase(query);
  const stripe = checkStripeConfig();
  const pdf = checkPdfModule(pdfModule);
  const decisionEngine = checkDecisionEngine(decisionEngineModule);
  const ok = Boolean(db.ok && stripe.ok && pdf.ok && decisionEngine.ok);
  return {
    ok,
    service: 'bircan-backend-readiness',
    timestamp: new Date().toISOString(),
    database: db,
    stripe,
    pdf,
    decisionEngine,
    routeCount: routes.length
  };
}

function requireUsableAssessmentPayload(payload) {
  const count = countAnswers(payload);
  if (count < 3) {
    const err = new Error('Assessment answers were not received or are too incomplete for advice generation.');
    err.code = 'ASSESSMENT_PAYLOAD_MISSING';
    err.status = 400;
    err.answerCount = count;
    throw err;
  }
  return true;
}

function countAnswers(payload) {
  const obj = payload && typeof payload === 'object' ? payload : {};
  const answers = obj.answers || obj.formPayload || obj.form_payload || obj.formData || obj.data || obj;
  return flatten(answers).filter(([k, v]) => !/password|token|auth/i.test(k) && v !== null && v !== undefined && String(v).trim() !== '').length;
}

function flatten(obj, prefix = '') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v, key));
    else out.push([key, v]);
  }
  return out;
}

function hasIssuedPdfBytes(value) {
  if (!value) return false;
  const len = Buffer.isBuffer(value) ? value.length : value.byteLength || 0;
  return len > 1024;
}

async function assertPdfSaved({ query, assessmentId }) {
  const { rows } = await query('SELECT id, status, pdf_bytes FROM assessments WHERE id=$1 LIMIT 1', [assessmentId]);
  const row = rows[0];
  if (!row || !hasIssuedPdfBytes(row.pdf_bytes)) {
    const err = new Error('PDF generation failed: final PDF was not saved or is empty.');
    err.code = 'PDF_NOT_SAVED';
    err.status = 500;
    throw err;
  }
  return true;
}

module.exports = {
  asyncRoute,
  requestIdMiddleware,
  createRouteRegistry,
  errorHandler,
  requiredEnv,
  buildReadinessReport,
  checkDatabase,
  checkStripeConfig,
  checkPdfModule,
  checkDecisionEngine,
  requireUsableAssessmentPayload,
  hasIssuedPdfBytes,
  assertPdfSaved
};
