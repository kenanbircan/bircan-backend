'use strict';

// Production GPT advice engine for Bircan Migration.
// Subclass 190 and 482 are supported first. Other subclasses fail closed unless explicitly enabled.
// Uses OpenAI Structured Outputs over the Responses API via native fetch (Node 22+).

const DEFAULT_MODEL = process.env.OPENAI_ADVICE_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/responses';

function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function normKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function cleanText(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(cleanText).filter(Boolean).join('; ');
  if (isPlainObject(v)) return JSON.stringify(v);
  return String(v).replace(/\s+/g, ' ').trim();
}
function looksLikeDummy(value) {
  const v = cleanText(value).toLowerCase();
  if (!v) return true;
  if (/sample\s*\d+/.test(v)) return true;
  if (/high risk: adverse factors or eligibility gaps require careful advice/i.test(v)) return true;
  if (/^(test|dummy|n\/a|na|null|undefined)$/.test(v)) return true;
  return false;
}
function flatten(input, prefix = '', out = {}) {
  if (!isPlainObject(input)) return out;
  for (const [k, v] of Object.entries(input)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (['password','token','auth','authorization','bm_session'].includes(normKey(k))) continue;
    if (isPlainObject(v)) flatten(v, key, out);
    else if (Array.isArray(v)) out[key] = v.map(cleanText).filter(Boolean).join('; ');
    else if (!looksLikeDummy(v)) out[key] = cleanText(v);
  }
  return out;
}
function payloadOf(assessment) {
  const p = assessment && assessment.form_payload && typeof assessment.form_payload === 'object' ? assessment.form_payload : {};
  const base = isPlainObject(p.answers) ? p.answers : isPlainObject(p.formPayload) ? p.formPayload : isPlainObject(p.rawSubmission) ? p.rawSubmission : p;
  return { ...flatten(base), ...(isPlainObject(p.flatAnswers) ? flatten(p.flatAnswers) : {}) };
}
function pick(flat, names, fallback = '') {
  const wanted = names.map(normKey);
  for (const [k, v] of Object.entries(flat || {})) {
    if (wanted.includes(normKey(k)) && !looksLikeDummy(v)) return cleanText(v);
  }
  return fallback;
}
function truthyRisk(v) {
  const s = cleanText(v).toLowerCase();
  if (!s) return false;
  return /(yes|known|present|refus|cancel|criminal|convict|overstay|breach|withdrawn|unsure|not sure|condition present|no)/i.test(s);
}
function structuredFacts(assessment) {
  const flat = payloadOf(assessment);
  const visa = String(assessment.visa_type || pick(flat, ['visaType','subclass','visaSubclass']) || '').replace(/[^0-9A-Za-z]/g, '');
  return {
    reference: assessment.id,
    visa_subclass: visa,
    client_email: cleanText(assessment.client_email),
    applicant: {
      name: cleanText(assessment.applicant_name) || pick(flat, ['full-name','fullName','applicantName','name']),
      email: cleanText(assessment.applicant_email) || pick(flat, ['email-address','email','applicantEmail']),
      citizenship: pick(flat, ['country-of-citizenship','citizenship','nationality','passportCountry']),
      date_of_birth: pick(flat, ['date-of-birth','dob','dateOfBirth'])
    },
    matter: {
      selected_plan: cleanText(assessment.active_plan || assessment.selected_plan),
      current_location: pick(flat, ['current-location','currentLocation','grant-location','location']),
      current_visa_status: pick(flat, ['current-visa-status','currentVisaStatus','qualifying-visa-held']),
      family_included: pick(flat, ['family-included','familyIncluded','secondaryApplicants'])
    },
    subclass_190: {
      nominated_occupation: pick(flat, ['nominated-occupation','occupation','anzsco']),
      nominating_state: pick(flat, ['nominating-state','state','territory']),
      nomination_status: pick(flat, ['state-nomination-held','nomination-current','nominationStatus']),
      invitation_held: pick(flat, ['invitation-held','invitationHeld']),
      invitation_within_period: pick(flat, ['invitation-within-period','invitationWithinPeriod']),
      skills_assessment: pick(flat, ['skills-assessment-held','skillsAssessmentHeld','skills-assessment-purpose']),
      occupation_alignment: pick(flat, ['occupation-matches-invitation','occupation-on-instrument','state-occupation-list']),
      points: pick(flat, ['points-breakdown','points','pass-mark-met']),
      english: pick(flat, ['competent-english','english-test-type','english'])
    },
    subclass_482: {
      sponsor: pick(flat, ['sponsor','employer','standard-business-sponsor','sponsor-approved']),
      nomination: pick(flat, ['nomination','nomination-status','position','genuine-position']),
      occupation: pick(flat, ['occupation','nominated-occupation','anzsco']),
      skills_experience: pick(flat, ['skills','experience','work-experience','skills-assessment']),
      english: pick(flat, ['english','english-test','competent-english']),
      salary: pick(flat, ['salary','market-salary','amsr','tsmit']),
      labour_market_testing: pick(flat, ['labour-market-testing','lmt']),
      registration: pick(flat, ['registration','licensing','professional-registration'])
    },
    adverse_flags: {
      section_48: truthyRisk(pick(flat, ['section48-bar','section48','s48'])) ? pick(flat, ['section48-bar','section48','s48']) : '',
      pic_4020: truthyRisk(pick(flat, ['pic4020-integrity','pic4020'])) ? pick(flat, ['pic4020-integrity','pic4020']) : '',
      health: truthyRisk(pick(flat, ['health-issues','health'])) ? pick(flat, ['health-issues','health']) : '',
      character: truthyRisk(pick(flat, ['character-security-issues','character','criminal'])) ? pick(flat, ['character-security-issues','character','criminal']) : '',
      no_further_stay: truthyRisk(pick(flat, ['nfa-condition','8503','no-further-stay'])) ? pick(flat, ['nfa-condition','8503','no-further-stay']) : '',
      previous_refusal_or_cancellation: pick(flat, ['previous-refusal','refusal','cancellation','visa-cancelled'])
    },
    cleaned_answers: Object.fromEntries(Object.entries(flat).slice(0, 120))
  };
}

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['subclass','risk_level','lodgement_position','title','sections','criterion_findings','evidence_required','client_next_steps','quality_flags','disclaimer'],
  properties: {
    subclass: { type: 'string', enum: ['190','482'] },
    risk_level: { type: 'string', enum: ['LOW','MEDIUM','HIGH','CRITICAL'] },
    lodgement_position: { type: 'string', enum: ['SUITABLE_TO_PROCEED','PROCEED_AFTER_EVIDENCE_REVIEW','DO_NOT_LODGE_NOW','INVALID_OR_NOT_AVAILABLE','MANUAL_LEGAL_REVIEW_REQUIRED'] },
    title: { type: 'string' },
    sections: {
      type: 'array', minItems: 7, maxItems: 10,
      items: { type: 'object', additionalProperties: false, required: ['heading','body'], properties: { heading: { type: 'string' }, body: { type: 'string' } } }
    },
    criterion_findings: {
      type: 'array', minItems: 6, maxItems: 16,
      items: { type: 'object', additionalProperties: false, required: ['criterion','finding','legal_consequence','evidence_gap','recommendation'], properties: {
        criterion: { type: 'string' }, finding: { type: 'string' }, legal_consequence: { type: 'string' }, evidence_gap: { type: 'string' }, recommendation: { type: 'string' }
      } }
    },
    evidence_required: { type: 'array', minItems: 4, maxItems: 20, items: { type: 'string' } },
    client_next_steps: { type: 'array', minItems: 3, maxItems: 12, items: { type: 'string' } },
    quality_flags: { type: 'array', maxItems: 12, items: { type: 'string' } },
    disclaimer: { type: 'string' }
  }
};

function legalFramework(subclass) {
  if (subclass === '190') return [
    'Assess subclass 190 as a Skilled Nominated permanent visa matter.',
    'Address validity and Schedule 1 matters separately from Schedule 2 grant criteria.',
    'Cover invitation, current valid state/territory nomination, nominated occupation, skills assessment, points test, age at invitation, competent English, location/visa status, family members, health, character and PIC 4020.',
    'If nomination is withdrawn, invitation is uncertain, section 48 applies, or no further stay condition is unresolved, state the legal consequence firmly and do not merely call it high risk.'
  ].join('\n');
  if (subclass === '482') return [
    'Assess subclass 482/SID/TSS style employer-sponsored temporary work criteria at a preliminary level.',
    'Address sponsorship, nomination, genuine position, occupation/ANZSCO alignment, skills and experience, English, salary/market salary, labour market testing where relevant, registration/licensing, health, character and visa status.',
    'Separate employer-side defects from applicant-side defects and explain which issue blocks lodgement or grant readiness.'
  ].join('\n');
  throw new Error(`GPT advice engine currently supports subclass 190 and 482 only. Received: ${subclass || 'unknown'}.`);
}

function validateAdvice(advice, subclass) {
  if (!advice || typeof advice !== 'object') throw new Error('GPT advice response was empty or invalid.');
  if (String(advice.subclass) !== String(subclass)) throw new Error('GPT advice subclass mismatch.');
  if (!Array.isArray(advice.sections) || advice.sections.length < 7) throw new Error('GPT advice missing required advice sections.');
  if (!Array.isArray(advice.criterion_findings) || advice.criterion_findings.length < 6) throw new Error('GPT advice missing criterion-by-criterion findings.');
  const joined = JSON.stringify(advice).toLowerCase();
  const banned = ['known issue', 'high risk: adverse factors', 'sample 1', 'sample 2', 'sample 3'];
  for (const b of banned) if (joined.includes(b)) throw new Error(`GPT advice quality check failed: weak/test wording detected (${b}).`);
  return advice;
}

async function callOpenAIForAdvice(facts) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for migration-agent level GPT advice generation. Refusing to issue weak template PDF.');
  const subclass = String(facts.visa_subclass || '').replace(/[^0-9]/g, '');
  legalFramework(subclass);
  const system = [
    'You are drafting a preliminary migration advice letter for review/issue by Bircan Migration, a Registered Migration Agent practice in Australia.',
    'Write in a firm, professional Registered Migration Agent advice style.',
    'Do not invent facts, dates, legislation or evidence. If a fact is missing or uncertain, say it cannot be confirmed from the questionnaire.',
    'Do not quote regulation numbers unless they are supplied or you are certain. Prefer plain-law criterion descriptions.',
    'Do not provide generic risk labels without legal consequence and next action.',
    'Do not dump raw questionnaire answers.',
    'This is preliminary advice subject to document review and current law/policy verification.'
  ].join('\n');
  const user = `Prepare structured preliminary advice for subclass ${subclass}.\n\nSubclass framework:\n${legalFramework(subclass)}\n\nCleaned matter facts:\n${JSON.stringify(facts, null, 2)}`;
  const body = {
    model: DEFAULT_MODEL,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: system }] },
      { role: 'user', content: [{ type: 'input_text', text: user }] }
    ],
    temperature: Number(process.env.OPENAI_ADVICE_TEMPERATURE || 0.2),
    store: false,
    text: { format: { type: 'json_schema', name: 'migration_advice_letter', strict: true, schema } }
  };
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenAI advice generation failed: ${data.error && data.error.message ? data.error.message : response.statusText}`);
  const text = data.output_text || (Array.isArray(data.output) ? data.output.flatMap(o => o.content || []).map(c => c.text || '').join('') : '');
  if (!text) throw new Error('OpenAI advice generation returned no structured text.');
  return JSON.parse(text);
}

async function generateMigrationAdvice(assessment) {
  const facts = structuredFacts(assessment);
  const subclass = String(facts.visa_subclass || '').replace(/[^0-9]/g, '');
  const advice = await callOpenAIForAdvice(facts);
  return { facts, advice: validateAdvice(advice, subclass), model: DEFAULT_MODEL };
}

module.exports = { generateMigrationAdvice, structuredFacts, validateAdvice };
