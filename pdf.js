'use strict';

/**
 * Bircan Migration pdf.js — engine-design compliant renderer bridge v38
 *
 * Contract remains unchanged:
 *   - buildAssessmentPdfBuffer(assessment, adviceBundle)
 *   - buildAppealAdvicePdfBuffer(assessment, adviceBundle)
 *   - sha256(buffer)
 *
 * Architecture rule:
 *   PDF renderer formats the client advice object only.
 *   It must not create legal criteria, subclass findings, or fallback advice.
 */

const crypto = require('crypto');
const htmlRenderer = require('./adviceHtmlPdfRenderer');
const legacyRenderer = require('./pdfkitRenderer');

const RENDERER_VERSION = 'pdf-renderer-bridge-v38-engine-design-client-advice-only';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function withRendererFallback(fnName, assessment, adviceBundle) {
  try {
    return await htmlRenderer[fnName](assessment, adviceBundle);
  } catch (err) {
    const allowFallback = String(process.env.PDFKIT_LEGACY_FALLBACK || 'true').toLowerCase() !== 'false';
    if (!allowFallback) {
      err.message = `HTML PDF renderer failed and legacy fallback is disabled: ${err.message}`;
      throw err;
    }
    console.error(`[pdf.js] HTML renderer failed; using strict PDFKit fallback: ${err.message}`);
    return legacyRenderer[fnName](assessment, adviceBundle);
  }
}

async function buildAssessmentPdfBuffer(assessment = {}, adviceBundle = {}) {
  return withRendererFallback('buildAssessmentPdfBuffer', assessment, adviceBundle);
}

async function buildAppealAdvicePdfBuffer(assessment = {}, adviceBundle = {}) {
  return withRendererFallback('buildAppealAdvicePdfBuffer', assessment, adviceBundle);
}

module.exports = {
  buildAssessmentPdfBuffer,
  buildAppealAdvicePdfBuffer,
  sha256,
  RENDERER_VERSION
};
