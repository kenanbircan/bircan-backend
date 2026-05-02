'use strict';

/**
 * clientJourneyEngine.js
 * Bircan Migration — Automated Client Journey System
 * Backend add-on: state machine + routes for post-assessment client progression.
 * Safe to place beside server.js. Requires your existing db query/tx and auth middleware.
 */

const JOURNEY_STAGE = Object.freeze({
  ASSESSMENT_COMPLETE: 'assessment_complete',
  AWAITING_PAYMENT: 'awaiting_payment',
  PAID: 'paid',
  AWAITING_DOCUMENTS: 'awaiting_documents',
  REVIEW_IN_PROGRESS: 'review_in_progress',
  READY_FOR_LODGEMENT: 'ready_for_lodgement',
  CLOSED: 'closed'
});

const SERVICE_TYPE = Object.freeze({
  ASSESSMENT: 'assessment',
  DOCUMENT_REVIEW: 'document_review',
  STRATEGY_CONSULTATION: 'strategy_consultation',
  LODGEMENT_PREPARATION: 'lodgement_preparation'
});

function normaliseEmail(email) { return String(email || '').trim().toLowerCase(); }
function safeJson(value, fallback) { return value && typeof value === 'object' ? value : fallback; }
function uniq(values) { return Array.from(new Set((values || []).filter(Boolean).map(v => String(v).trim()).filter(Boolean))); }
function nowIso() { return new Date().toISOString(); }

function nextStageFromAssessment(assessment) {
  if (!assessment) return JOURNEY_STAGE.ASSESSMENT_COMPLETE;
  if (assessment.payment_status !== 'paid') return JOURNEY_STAGE.AWAITING_PAYMENT;
  if (!assessment.pdf_generated_at && !assessment.pdf_bytes) return JOURNEY_STAGE.PAID;
  return JOURNEY_STAGE.AWAITING_DOCUMENTS;
}

function evidenceFromAssessment(assessment) {
  const payload = safeJson(assessment && assessment.form_payload, {});
  const ev = payload.evidenceValidation || payload.evidence_validation || null;
  const fromEv = [];
  if (ev && Array.isArray(ev.checks)) {
    for (const c of ev.checks) {
      if (c && c.label && c.status !== 'VERIFIED' && c.status !== 'NOT_APPLICABLE') fromEv.push(c.label);
    }
  }
  const fallbackBySubclass = {
    '190': ['Passport biodata page', 'SkillSelect invitation', 'State or territory nomination', 'Skills assessment', 'English evidence', 'Points claim evidence', 'VEVO/current visa status', 'Police certificates if required'],
    '491': ['Passport biodata page', 'SkillSelect invitation', 'Regional nomination or eligible family sponsor evidence', 'Skills assessment', 'English evidence', 'Points claim evidence', 'VEVO/current visa status'],
    '482': ['Passport biodata page', 'Sponsor approval evidence', 'Nomination evidence', 'Position description', 'Employment contract', 'Market salary evidence', 'Employment references', 'English evidence', 'LMT evidence or exemption'],
    '186': ['Passport biodata page', 'Employer nomination evidence', 'Employment contract', 'Skills assessment if required', 'English evidence', 'Work history evidence', 'Police certificates if required'],
    '500': ['Passport biodata page', 'Confirmation of Enrolment', 'OSHC evidence', 'Financial capacity evidence', 'Genuine student statement', 'English evidence if required']
  };
  return uniq(fromEv.length ? fromEv : (fallbackBySubclass[String(assessment && assessment.visa_type || '')] || ['Passport biodata page', 'Current visa evidence', 'Subclass-specific supporting documents']));
}

function buildClientJourneyView(journey, assessment, documents) {
  const required = safeJson(journey && journey.required_documents, { items: [] }).items || [];
  const uploadedNames = new Set((documents || []).map(d => String(d.document_name || d.filename || d.label || '').toLowerCase()));
  const checklist = required.map((name) => ({
    name,
    uploaded: Array.from(uploadedNames).some(u => u.includes(String(name).toLowerCase().split(' ')[0])),
    status: Array.from(uploadedNames).some(u => u.includes(String(name).toLowerCase().split(' ')[0])) ? 'uploaded' : 'required'
  }));
  const completeCount = checklist.filter(i => i.uploaded).length;
  const percent = checklist.length ? Math.round((completeCount / checklist.length) * 100) : 0;
  const stage = journey && journey.stage ? journey.stage : nextStageFromAssessment(assessment);
  const stageLabels = [
    ['assessment_complete', 'Assessment completed'],
    ['awaiting_payment', 'Payment / service selection'],
    ['paid', 'Payment verified'],
    ['awaiting_documents', 'Documents required'],
    ['review_in_progress', 'Professional review in progress'],
    ['ready_for_lodgement', 'Ready for lodgement review']
  ];
  return {
    ok: true,
    stage,
    stageLabel: stageLabels.find(s => s[0] === stage)?.[1] || stage,
    assessmentId: assessment && assessment.id,
    visaType: assessment && assessment.visa_type,
    serviceType: journey && journey.service_type,
    completionPercent: percent,
    documentsRequired: checklist,
    nextAction: nextAction(stage, percent),
    timeline: stageLabels.map(([key, label]) => ({ key, label, active: key === stage, completed: stageCompleted(key, stage) })),
    professionalMessage: buildProfessionalMessage(stage, assessment, percent)
  };
}

function stageCompleted(key, current) {
  const order = ['assessment_complete', 'awaiting_payment', 'paid', 'awaiting_documents', 'review_in_progress', 'ready_for_lodgement'];
  return order.indexOf(key) < order.indexOf(current);
}

function nextAction(stage, percent) {
  if (stage === JOURNEY_STAGE.AWAITING_PAYMENT) return { label: 'Proceed to professional review', action: 'checkout' };
  if (stage === JOURNEY_STAGE.PAID || stage === JOURNEY_STAGE.AWAITING_DOCUMENTS) return { label: percent >= 100 ? 'Submit for professional review' : 'Upload required documents', action: percent >= 100 ? 'submit_review' : 'upload_documents' };
  if (stage === JOURNEY_STAGE.REVIEW_IN_PROGRESS) return { label: 'Await professional review outcome', action: 'wait' };
  if (stage === JOURNEY_STAGE.READY_FOR_LODGEMENT) return { label: 'Book lodgement strategy consultation', action: 'book_consultation' };
  return { label: 'Continue assessment journey', action: 'continue' };
}

function buildProfessionalMessage(stage, assessment, percent) {
  const subclass = assessment && assessment.visa_type ? `Subclass ${assessment.visa_type}` : 'this visa';
  if (stage === JOURNEY_STAGE.AWAITING_PAYMENT) return `Your preliminary ${subclass} assessment is complete. The next professional step is document review and strategy confirmation before any lodgement action.`;
  if (stage === JOURNEY_STAGE.AWAITING_DOCUMENTS || stage === JOURNEY_STAGE.PAID) return `Your matter is now in document preparation stage. ${percent}% of the required document checklist appears to be complete.`;
  if (stage === JOURNEY_STAGE.REVIEW_IN_PROGRESS) return `Your documents are marked for professional review. No lodgement action should be taken until the review is finalised.`;
  if (stage === JOURNEY_STAGE.READY_FOR_LODGEMENT) return `The matter is marked ready for final lodgement strategy review, subject to professional confirmation and current law/policy checks.`;
  return `Your preliminary assessment has been recorded. Continue through the guided pathway to reduce lodgement risk.`;
}

function installClientJourneyRoutes(app, deps) {
  const { query, tx, requireAuth, stripe, appBaseUrl, resolveVisaPriceId } = deps;
  if (!app || !query || !requireAuth) throw new Error('installClientJourneyRoutes requires app, query and requireAuth.');

  app.post('/api/journey/bootstrap', requireAuth, async (req, res, next) => {
    try {
      const assessmentId = req.body.assessmentId || req.body.assessment_id || req.body.id;
      if (!assessmentId) return res.status(400).json({ ok: false, error: 'assessmentId is required.' });
      const { rows } = await query('SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [assessmentId, req.client.email]);
      const assessment = rows[0];
      if (!assessment) return res.status(404).json({ ok: false, error: 'Assessment was not found for this account.' });
      const required = evidenceFromAssessment(assessment);
      const stage = nextStageFromAssessment(assessment);
      await query(`INSERT INTO client_journeys (assessment_id, client_id, client_email, visa_type, stage, service_type, required_documents, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now())
        ON CONFLICT (assessment_id) DO UPDATE SET stage=EXCLUDED.stage, required_documents=EXCLUDED.required_documents, updated_at=now()
        WHERE client_journeys.stage NOT IN ('review_in_progress','ready_for_lodgement','closed')`,
        [assessment.id, req.client.id, req.client.email, assessment.visa_type, stage, SERVICE_TYPE.DOCUMENT_REVIEW, JSON.stringify({ items: required })]);
      const view = await getJourneyView(query, assessment.id, req.client.email);
      res.json(view);
    } catch (err) { next(err); }
  });

  app.get('/api/journey/:assessmentId', requireAuth, async (req, res, next) => {
    try { res.json(await getJourneyView(query, req.params.assessmentId, req.client.email)); }
    catch (err) { next(err); }
  });

  app.post('/api/journey/:assessmentId/documents', requireAuth, async (req, res, next) => {
    try {
      const name = String(req.body.name || req.body.documentName || req.body.filename || '').trim();
      const type = String(req.body.type || req.body.category || 'supporting_document').trim();
      if (!name) return res.status(400).json({ ok: false, error: 'Document name is required.' });
      const assessmentId = req.params.assessmentId;
      const assessment = await assertAssessment(query, assessmentId, req.client.email);
      await ensureJourney(query, req.client, assessment);
      await query(`INSERT INTO journey_documents (assessment_id, client_email, document_name, document_type, status, metadata)
        VALUES ($1,$2,$3,$4,'uploaded',$5)`, [assessmentId, req.client.email, name, type, JSON.stringify({ source: 'client_dashboard', uploadedAt: nowIso(), note: req.body.note || null })]);
      await maybeAdvanceDocumentStage(query, assessmentId, req.client.email);
      res.json(await getJourneyView(query, assessmentId, req.client.email));
    } catch (err) { next(err); }
  });

  app.post('/api/journey/:assessmentId/submit-review', requireAuth, async (req, res, next) => {
    try {
      const assessment = await assertAssessment(query, req.params.assessmentId, req.client.email);
      await ensureJourney(query, req.client, assessment);
      await query(`UPDATE client_journeys SET stage='review_in_progress', review_requested_at=now(), updated_at=now() WHERE assessment_id=$1 AND lower(client_email)=lower($2)`, [assessment.id, req.client.email]);
      res.json(await getJourneyView(query, assessment.id, req.client.email));
    } catch (err) { next(err); }
  });

  app.post('/api/journey/:assessmentId/mark-ready-for-lodgement', requireAuth, async (req, res, next) => {
    try {
      // This endpoint is intentionally protected by env flag; production should restrict to admin only.
      if (String(process.env.ALLOW_CLIENT_MARK_READY || 'false').toLowerCase() !== 'true') return res.status(403).json({ ok: false, error: 'Professional/admin review required to mark ready for lodgement.' });
      const assessment = await assertAssessment(query, req.params.assessmentId, req.client.email);
      await query(`UPDATE client_journeys SET stage='ready_for_lodgement', ready_for_lodgement_at=now(), updated_at=now() WHERE assessment_id=$1 AND lower(client_email)=lower($2)`, [assessment.id, req.client.email]);
      res.json(await getJourneyView(query, assessment.id, req.client.email));
    } catch (err) { next(err); }
  });
}

async function assertAssessment(query, assessmentId, email) {
  const { rows } = await query('SELECT * FROM assessments WHERE id=$1 AND lower(client_email)=lower($2)', [assessmentId, email]);
  if (!rows[0]) throw Object.assign(new Error('Assessment was not found for this account.'), { status: 404 });
  return rows[0];
}

async function ensureJourney(query, client, assessment) {
  const required = evidenceFromAssessment(assessment);
  await query(`INSERT INTO client_journeys (assessment_id, client_id, client_email, visa_type, stage, service_type, required_documents, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT (assessment_id) DO NOTHING`,
    [assessment.id, client.id, client.email, assessment.visa_type, nextStageFromAssessment(assessment), SERVICE_TYPE.DOCUMENT_REVIEW, JSON.stringify({ items: required })]);
}

async function maybeAdvanceDocumentStage(query, assessmentId, email) {
  const view = await getJourneyView(query, assessmentId, email);
  if (view.completionPercent >= 100 && ['paid','awaiting_documents'].includes(view.stage)) {
    await query(`UPDATE client_journeys SET stage='awaiting_documents', updated_at=now() WHERE assessment_id=$1 AND lower(client_email)=lower($2)`, [assessmentId, email]);
  }
}

async function getJourneyView(query, assessmentId, email) {
  const assessment = await assertAssessment(query, assessmentId, email);
  const journeyRows = await query('SELECT * FROM client_journeys WHERE assessment_id=$1 AND lower(client_email)=lower($2)', [assessmentId, email]);
  const docRows = await query('SELECT * FROM journey_documents WHERE assessment_id=$1 AND lower(client_email)=lower($2) ORDER BY created_at DESC', [assessmentId, email]);
  const journey = journeyRows.rows[0] || { stage: nextStageFromAssessment(assessment), required_documents: { items: evidenceFromAssessment(assessment) }, service_type: SERVICE_TYPE.DOCUMENT_REVIEW };
  return buildClientJourneyView(journey, assessment, docRows.rows);
}

async function ensureClientJourneySchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS client_journeys (
    id bigserial PRIMARY KEY,
    assessment_id text UNIQUE NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    client_id uuid,
    client_email text NOT NULL,
    visa_type text,
    stage text NOT NULL DEFAULT 'assessment_complete',
    service_type text NOT NULL DEFAULT 'document_review',
    required_documents jsonb NOT NULL DEFAULT '{"items":[]}'::jsonb,
    review_requested_at timestamptz,
    ready_for_lodgement_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS journey_documents (
    id bigserial PRIMARY KEY,
    assessment_id text NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
    client_email text NOT NULL,
    document_name text NOT NULL,
    document_type text,
    status text NOT NULL DEFAULT 'uploaded',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_client_journeys_client_email ON client_journeys(lower(client_email))`);
  await query(`CREATE INDEX IF NOT EXISTS idx_journey_documents_assessment ON journey_documents(assessment_id, lower(client_email))`);
}

module.exports = {
  JOURNEY_STAGE,
  SERVICE_TYPE,
  installClientJourneyRoutes,
  ensureClientJourneySchema,
  buildClientJourneyView,
  evidenceFromAssessment
};
