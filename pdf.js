'use strict';

/**
 * Bircan Migration pdf.js — HTML-to-PDF renderer bridge v120
 *
 * Server contract remains unchanged:
 *   - buildAssessmentPdfBuffer(assessment, adviceBundle)
 *   - buildAppealAdvicePdfBuffer(assessment, adviceBundle)
 *   - sha256(buffer)
 *
 * Primary renderer: Playwright/Chromium HTML print-to-PDF.
 * Legacy fallback: pdfkitRenderer.js, only if Chromium is unavailable.
 */

const crypto = require('crypto');
const htmlRenderer = require('./adviceHtmlPdfRenderer');
const legacyRenderer = require('./pdfkitRenderer');

const RENDERER_VERSION = 'pdf-html-playwright-renderer-v120-20260522-rma-controlled-advice-letter';

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
    console.error(`[pdf.js] HTML PDF renderer failed; using legacy PDFKit fallback: ${err.message}`);
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
