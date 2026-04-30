
/**
 * Bircan Migration - backend generation pipeline hardening patch
 *
 * Purpose:
 * 1. Do NOT mark PDF/document as ready unless GPT advice content exists.
 * 2. Do NOT generate placeholder/template PDFs.
 * 3. Force GPT analysis before PDF generation when stored analysis is missing.
 * 4. Return "processing" or "failed" honestly instead of a fake ready PDF.
 *
 * How to use:
 * - Copy the functions in this file into server.js near the existing PDF/assessment helpers.
 * - Replace your current /api/assessment/:id/generate-pdf route with the route below.
 * - Replace ensureSubmissionPdfReady logic so it calls ensureFullAdviceLetterReady.
 */

/* ---------- FINALITY VALIDATION ---------- */

function hasRealAdviceContent(submission = {}) {
  const analysis = submission.analysis?.analysis || submission.analysis || {};
  const fields = [
    analysis.executiveSummary,
    analysis.caseSummary,
    analysis.outcomeRationale,
    analysis.professionalOpinion,
    analysis.detailedAssessment,
    analysis.strategyAdvice,
    analysis.refusalRiskSummary,
    analysis.eligibilityOutcome,
  ];

  const joined = fields
    .filter(Boolean)
    .map(v => typeof v === 'string' ? v : JSON.stringify(v))
    .join('\n')
    .trim();

  const listCount =
    (Array.isArray(analysis.criterionFramework) ? analysis.criterionFramework.length : 0) +
    (Array.isArray(analysis.refusalExposure) ? analysis.refusalExposure.length : 0) +
    (Array.isArray(analysis.evidenceGaps) ? analysis.evidenceGaps.length : 0) +
    (Array.isArray(analysis.nextSteps) ? analysis.nextSteps.length : 0) +
    (Array.isArray(analysis.documentChecklist) ? analysis.documentChecklist.length : 0);

  const placeholderPhrases = [
    /not available/i,
    /was not generated/i,
    /no criterion-by-criterion/i,
    /no structured/i,
    /not provided/i,
  ];

  if (joined.length < 900) return false;
  if (placeholderPhrases.some(rx => rx.test(joined))) return false;
  if (listCount < 3) return false;

  return true;
}

function markGenerationState(submission, status, extra = {}) {
  return {
    ...submission,
    pdfStatus: status,
    documentStatus: status,
    generationStatus: status,
    updatedAt: nowIso(),
    ...extra,
  };
}

/* ---------- GPT ANALYSIS ---------- */

function buildAdvicePrompt(submission = {}) {
  const answers = Array.isArray(submission.answers)
    ? submission.answers
    : Array.isArray(submission.formData?.answers)
      ? submission.formData.answers
      : [];

  const answerText = answers.map((a, i) => {
    if (typeof a === 'string') return `${i + 1}. ${a}`;
    return `${i + 1}. ${a.question || 'Question'}\nAnswer: ${a.answer || ''}`;
  }).join('\n\n');

  return `
You are preparing a professional preliminary Australian visa assessment advice letter for Bircan Migration & Education.

Visa subclass/type:
${submission.visaType || submission.subclass || submission.visaSubclass || 'Unknown'}

Client:
${submission.client?.fullName || submission.fullName || 'Client'}
${submission.client?.email || submission.email || submission.clientEmail || ''}

Assessment answers:
${answerText || JSON.stringify(submission.formData || submission, null, 2)}

Return STRICT JSON only. Do not use markdown.

Required JSON shape:
{
  "eligibilityOutcome": "clear concise outcome",
  "executiveSummary": "minimum 250 words",
  "caseSummary": "minimum 250 words",
  "outcomeRationale": "minimum 350 words",
  "professionalOpinion": "minimum 350 words",
  "detailedAssessment": "minimum 500 words",
  "strategyAdvice": "minimum 300 words",
  "refusalRiskSummary": "minimum 250 words",
  "criterionFramework": [
    {"criterion":"criterion name","assessment":"analysis","risk":"low/moderate/high","evidenceRequired":"evidence"}
  ],
  "refusalExposure": ["specific refusal exposure 1", "specific refusal exposure 2"],
  "evidenceGaps": ["gap 1", "gap 2"],
  "strengths": ["strength 1", "strength 2"],
  "concerns": ["concern 1", "concern 2"],
  "nextSteps": ["step 1", "step 2"],
  "documentChecklist": ["document 1", "document 2"],
  "riskLevel": "Low/Moderate/High",
  "lodgementReadiness": "Ready/Further review required/Not ready"
}

Important:
- Do not say content was not generated.
- Do not use placeholder wording.
- Give criterion-by-criterion reasoning.
- If facts are missing, identify the evidence gap and its legal effect.
`.trim();
}

async function callOpenAiAdviceAnalysis(submission) {
  if (!OPENAI_API_KEY) {
    const err = new Error('OPENAI_API_KEY is not configured.');
    err.statusCode = 500;
    throw err;
  }

  const prompt = buildAdvicePrompt(submission);

  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL_ANALYSIS || 'gpt-4.1',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a senior Australian migration law assessment writer. Return complete JSON only.'
        },
        { role: 'user', content: prompt }
      ],
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `OpenAI failed with HTTP ${res.status}`);
    err.statusCode = 502;
    throw err;
  }

  const content = data.choices?.[0]?.message?.content || '';
  if (!content || content.length < 800) {
    const err = new Error('OpenAI returned insufficient advice content.');
    err.statusCode = 502;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    const err = new Error('OpenAI advice JSON could not be parsed.');
    err.statusCode = 502;
    throw err;
  }

  const patched = {
    ...submission,
    analysis: {
      ...(submission.analysis || {}),
      analysis: parsed,
      generatedAt: nowIso(),
      model: OPENAI_MODEL_ANALYSIS || 'gpt-4.1',
    },
    analysisStatus: 'completed',
    generationStatus: 'analysis_completed',
    updatedAt: nowIso(),
  };

  if (!hasRealAdviceContent(patched)) {
    const err = new Error('Generated advice content failed finality validation.');
    err.statusCode = 422;
    throw err;
  }

  await saveSubmission(patched);
  return patched;
}

/* ---------- FULL PIPELINE ---------- */

async function ensureFullAdviceLetterReady(submissionId, options = {}) {
  let submission = await getSubmission(submissionId);
  if (!submission) {
    const err = new Error('Assessment submission not found.');
    err.statusCode = 404;
    throw err;
  }

  submission = await saveSubmission(markGenerationState(submission, 'generating', {
    pdfError: '',
    generationStartedAt: nowIso(),
  }));

  try {
    if (!hasRealAdviceContent(submission) || options.regenerate === true || options.force === true) {
      submission = await callOpenAiAdviceAnalysis(submission);
    }

    if (!hasRealAdviceContent(submission)) {
      const err = new Error('Advice content is incomplete. PDF generation blocked.');
      err.statusCode = 422;
      throw err;
    }

    const generated = await generateProfessionalPdf(submission);

    if (!generated?.pdfPath || !fs.existsSync(generated.pdfPath)) {
      const err = new Error('PDF file was not created.');
      err.statusCode = 500;
      throw err;
    }

    const stat = fs.statSync(generated.pdfPath);
    if (stat.size < 25000) {
      const err = new Error('Generated PDF is too small and appears to be a template.');
      err.statusCode = 422;
      throw err;
    }

    const final = await saveSubmission({
      ...submission,
      pdfPath: generated.pdfPath,
      pdfFileName: path.basename(generated.pdfPath),
      pdfUrl: generated.pdfUrl,
      downloadUrl: generated.pdfUrl,
      documentUrl: generated.pdfUrl,
      pdfStatus: 'ready',
      documentStatus: 'ready',
      generationStatus: 'ready',
      completedAt: nowIso(),
      pdfIssuedAt: nowIso(),
      pdfError: '',
    });

    await syncDbServiceDocumentFromSubmission(final).catch(() => null);
    return final;
  } catch (error) {
    const failed = await saveSubmission(markGenerationState(submission, 'failed', {
      pdfError: error.message || 'Advice-letter generation failed.',
      generationFailedAt: nowIso(),
      pdfStatus: 'failed',
      documentStatus: 'failed',
    }));
    await syncDbServiceDocumentFromSubmission(failed).catch(() => null);
    throw error;
  }
}

/* ---------- ROUTES TO REPLACE EXISTING GENERATE-PDF ROUTE ---------- */

app.post(['/api/assessment/:id/generate-pdf', '/api/assessment/:id/generate', '/api/assessments/:id/generate-pdf'], async (req, res) => {
  const id = normaliseDocumentSubmissionId(req.params.id || req.body?.assessmentId || req.body?.submissionId);
  try {
    const submission = await ensureFullAdviceLetterReady(id, {
      force: Boolean(req.body?.force),
      regenerate: Boolean(req.body?.regenerate),
    });

    return res.json({
      ok: true,
      ready: true,
      assessmentId: submission.id,
      pdfStatus: submission.pdfStatus,
      documentStatus: submission.documentStatus,
      generationStatus: submission.generationStatus,
      pdfUrl: submission.pdfUrl,
      downloadUrl: submission.downloadUrl,
      documentUrl: submission.documentUrl,
      pdfIssuedAt: submission.pdfIssuedAt,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      ok: false,
      ready: false,
      error: error.message || 'Advice-letter generation failed.',
    });
  }
});

app.post('/api/assessment/generate-pdf', async (req, res) => {
  const id = normaliseDocumentSubmissionId(req.body?.assessmentId || req.body?.submissionId || req.body?.id);
  if (!id) return res.status(400).json({ ok:false, error:'Missing assessment ID.' });

  try {
    const submission = await ensureFullAdviceLetterReady(id, {
      force: Boolean(req.body?.force),
      regenerate: Boolean(req.body?.regenerate),
    });

    return res.json({
      ok: true,
      ready: true,
      assessmentId: submission.id,
      pdfStatus: submission.pdfStatus,
      documentStatus: submission.documentStatus,
      generationStatus: submission.generationStatus,
      pdfUrl: submission.pdfUrl,
      downloadUrl: submission.downloadUrl,
      documentUrl: submission.documentUrl,
      pdfIssuedAt: submission.pdfIssuedAt,
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      ok: false,
      ready: false,
      error: error.message || 'Advice-letter generation failed.',
    });
  }
});

/* ---------- IMPORTANT PDF DOWNLOAD RULE ----------
In your GET /api/assessment/:id/pdf route:
- Do NOT call generateProfessionalPdf if hasRealAdviceContent(submission) is false.
- Return 409 while processing or failed state instead of serving a template PDF.

Example:

if (!hasRealAdviceContent(submission)) {
  return res.status(409).json({
    ok:false,
    ready:false,
    error:'Advice letter is not generated yet.'
  });
}

*/
