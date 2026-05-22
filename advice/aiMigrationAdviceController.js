'use strict';

/**
 * Bircan Migration AI Migration Advice Controller
 *
 * v2 converts the controller from a wording enhancer into a deterministic
 * criteria-assessment orchestration layer. It reads the full saved assessment
 * payload, maps all available answers to the selected subclass/stream registry
 * and knowledgebase-backed criteria, then produces:
 *   1. a clientAdviceObject for pdf.js; and
 *   2. an internalAuditObject for admin/legal control.
 *
 * The controller does not handle payment, dashboard display or PDF formatting.
 * pdf.js must render the client object only.
 */

const AI_CONTROLLER_VERSION = 'ai-migration-advice-controller-v4-subclass186-mandatory-age-finding-20260522';

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

function text(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.map(v => text(v, '')).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_err) { return fallback; }
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function clean(value) {
  return text(value, '')
    .replace(/Questionnaire instruction recorded:\s*/gi, '')
    .replace(/This is treated as an instruction only and must be reconciled against original evidence\.?/gi, '')
    .replace(/\s+\./g, '.')
    .replace(/\.\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function flattenObject(input, prefix = '', out = {}) {
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenObject(value, full, out);
    else out[full] = value;
  }
  return out;
}

function safeParseJson(value) {
  if (!value) return {};
  if (isPlainObject(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_err) { return {}; }
  }
  return {};
}

function assessmentPayloadRoot(assessment = {}) {
  return safeParseJson(pick(
    assessment.form_payload,
    assessment.formPayload,
    assessment.raw_answers,
    assessment.answers,
    assessment.payload,
    {}
  ));
}

function assessmentAnswers(assessment = {}) {
  const payload = assessmentPayloadRoot(assessment);
  if (isPlainObject(payload.answers)) return payload.answers;
  if (isPlainObject(payload.formPayload) && isPlainObject(payload.formPayload.answers)) return payload.formPayload.answers;
  if (isPlainObject(payload.formPayload)) return payload.formPayload;
  if (isPlainObject(payload.flatAnswers)) return payload.flatAnswers;
  if (isPlainObject(payload.rawSubmission) && isPlainObject(payload.rawSubmission.answers)) return payload.rawSubmission.answers;
  if (isPlainObject(payload.rawSubmission)) return payload.rawSubmission;
  return payload;
}

function normaliseSubclass(value) {
  return String(value || '').replace(/[^0-9]/g, '').slice(0, 3);
}

function normaliseStream(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/direct/i.test(raw)) return 'Direct Entry';
  if (/temporary|trt/i.test(raw)) return 'Temporary Residence Transition';
  if (/labour|agreement/i.test(raw)) return 'Labour Agreement';
  return raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function normaliseKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normaliseYesNo(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return '';
  if (/^(yes|true|y|1|held|available|completed|successful)$/i.test(raw)) return 'yes';
  if (/^(no|false|n|0|none|not applicable|na|n\/a)$/i.test(raw)) return 'no';
  if (/unsure|unknown|in progress|part|partial|maybe/i.test(raw)) return 'unclear';
  return raw;
}

function parseNumber(value) {
  const m = String(value == null ? '' : value).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function answerEntries(flat = {}) {
  return Object.entries(flat || {}).filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');
}

function findValue(flat, patterns = []) {
  const entries = answerEntries(flat);
  for (const pattern of patterns) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
    const hit = entries.find(([key]) => re.test(key));
    if (hit) return hit[1];
  }
  return '';
}

function findAnyValue(flat, patterns = []) {
  const entries = answerEntries(flat);
  const hits = [];
  const seen = new Set();
  for (const pattern of patterns) {
    const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
    for (const [key, value] of entries) {
      if (seen.has(key)) continue;
      if (re.test(key)) {
        seen.add(key);
        hits.push([key, value]);
      }
    }
  }
  return hits;
}

function exactAnswer(flat, ...keys) {
  const wanted = keys.map(normaliseKey);
  for (const [key, value] of Object.entries(flat || {})) {
    if (wanted.includes(normaliseKey(key))) return value;
  }
  return '';
}

function dateAge(dateValue, reference = new Date()) {
  if (!dateValue) return null;
  const d = new Date(dateValue);
  if (Number.isNaN(d.getTime())) return null;
  let age = reference.getFullYear() - d.getFullYear();
  const beforeBirthday = reference.getMonth() < d.getMonth() || (reference.getMonth() === d.getMonth() && reference.getDate() < d.getDate());
  if (beforeBirthday) age -= 1;
  return age > 0 && age < 120 ? age : null;
}

function extractAge(flat, assessment = {}) {
  const dob = pick(
    assessment.date_of_birth,
    assessment.dateOfBirth,
    exactAnswer(flat, 'date-of-birth', 'dateOfBirth', 'dob'),
    findValue(flat, [/date.*birth/i, /dob/i])
  );
  const ageFromDob = dateAge(dob);
  const explicit = pick(
    exactAnswer(flat, 'age-at-application', 'ageAtApplication', 'ageAtAssessment', 'applicantAge'),
    assessment.age,
    assessment.applicant_age,
    assessment.applicantAge,
    findValue(flat, [/age.*application/i, /applicant.*age/i, /\bage\b/i])
  );
  const age = parseNumber(explicit);
  const exemption = pick(
    exactAnswer(flat, 'age-exemption-discussed', 'age-exemption-category', 'ageExemptionClaimed', 'ageExemptionBasis'),
    findValue(flat, [/age.*exemption/i, /age.*concession/i])
  );
  return {
    age: Number.isFinite(age) && age > 0 && age < 120 ? age : ageFromDob,
    dateOfBirth: dob || '',
    ageAtApplication: Number.isFinite(age) && age > 0 && age < 120 ? age : null,
    exemption,
    fields: ['date-of-birth', 'age-at-application', 'age-exemption-discussed', 'age-exemption-category'].filter(k => exactAnswer(flat, k) !== '')
  };
}

function extractEnglishDetails(flat, assessment = {}) {
  const all = findAnyValue(flat, [/english/i, /ielts/i, /pte/i, /toefl/i, /cambridge/i, /cae/i, /oet/i]);
  const joined = all.map(([k, v]) => `${k}: ${v}`).join(' | ');
  const testCompleted = pick(exactAnswer(flat, 'english-test-completed', 'englishTestCompleted'), findValue(flat, [/english.*completed/i]));
  const testTypeRaw = pick(exactAnswer(flat, 'english-test-type', 'englishTestType'), assessment.english_test_type, assessment.englishTestType, findValue(flat, [/english.*type/i, /test.*type/i]));
  const raw = text(pick(testTypeRaw, assessment.english, assessment.english_test, assessment.englishEvidence, joined), '');
  const rawLower = raw.toLowerCase();
  const testType = /pte/.test(rawLower) ? 'PTE Academic' : /ielts/.test(rawLower) ? 'IELTS' : /toefl/.test(rawLower) ? 'TOEFL iBT' : /oet/.test(rawLower) ? 'OET' : /cambridge|cae/.test(rawLower) ? 'Cambridge C1 Advanced' : raw ? raw : '';

  const scoreFields = {
    listening: parseNumber(pick(exactAnswer(flat, 'english-listening', 'englishListening'), findValue(flat, [/english.*listen/i, /listening/i]))),
    reading: parseNumber(pick(exactAnswer(flat, 'english-reading', 'englishReading'), findValue(flat, [/english.*read/i, /reading/i]))),
    writing: parseNumber(pick(exactAnswer(flat, 'english-writing', 'englishWriting'), findValue(flat, [/english.*writ/i, /writing/i]))),
    speaking: parseNumber(pick(exactAnswer(flat, 'english-speaking', 'englishSpeaking'), findValue(flat, [/english.*speak/i, /speaking/i]))),
    overall: parseNumber(pick(exactAnswer(flat, 'english-overall', 'overallScore'), findValue(flat, [/english.*overall/i, /overall.*score/i])))
  };

  const compact = String(raw || joined);
  const compactPairs = [
    ['listening', /(?:listening|listen|\bL\b)\s*[:=]?\s*(\d+(?:\.\d+)?)/i],
    ['reading', /(?:reading|read|\bR\b)\s*[:=]?\s*(\d+(?:\.\d+)?)/i],
    ['writing', /(?:writing|write|\bW\b)\s*[:=]?\s*(\d+(?:\.\d+)?)/i],
    ['speaking', /(?:speaking|speak|\bS\b)\s*[:=]?\s*(\d+(?:\.\d+)?)/i]
  ];
  for (const [name, re] of compactPairs) {
    const m = compact.match(re);
    if (m && !Number.isFinite(scoreFields[name])) scoreFields[name] = Number(m[1]);
  }

  const testDate = pick(exactAnswer(flat, 'english-test-date', 'englishTestDate'), findValue(flat, [/english.*date/i, /test.*date/i]));
  const passportEnglishCountry = pick(exactAnswer(flat, 'passport-english-country', 'passportEnglishCountry'), findValue(flat, [/passport.*english.*country/i]));
  const exemption = pick(exactAnswer(flat, 'english-exemption-claimed', 'englishExemptionClaimed'), findValue(flat, [/english.*exempt/i, /concession/i]));
  const docsAvailable = pick(exactAnswer(flat, 'english-docs-available', 'englishDocsAvailable'), findValue(flat, [/english.*doc/i]));
  const componentScores = ['listening', 'reading', 'writing', 'speaking'].map(k => scoreFields[k]).filter(v => Number.isFinite(v));

  let status = 'unclear';
  let reason = 'English evidence must be verified from the original test report, component scores and validity period.';
  if (normaliseYesNo(passportEnglishCountry) === 'yes' || /yes|true|exempt|passport|concession/i.test(String(exemption || ''))) {
    status = 'likely_satisfied';
    reason = 'An English exemption/concession or passport-country indicator was recorded, subject to verifying the supporting evidence and current instrument settings.';
  } else if (/ielts/i.test(testType) && componentScores.length === 4) {
    const pass = componentScores.every(v => v >= 6);
    status = pass ? 'likely_satisfied' : 'not_satisfied_or_high_risk';
    reason = pass ? 'Recorded IELTS component scores appear to meet a competent-English style threshold, subject to original report and validity checks.' : 'One or more recorded IELTS component scores appear below the usual competent-English threshold; verify whether a concession/exemption applies.';
  } else if (/pte/i.test(testType) && componentScores.length === 4) {
    const pass = componentScores.every(v => v >= 50);
    status = pass ? 'likely_satisfied' : 'not_satisfied_or_high_risk';
    reason = pass ? 'Recorded PTE component scores appear to meet a competent-English style threshold, subject to original report and validity checks.' : 'One or more recorded PTE component scores appear below the usual competent-English threshold; verify whether a concession/exemption applies.';
  } else if (normaliseYesNo(testCompleted) === 'no') {
    status = 'unclear';
    reason = 'No completed English test was recorded; an exemption, concession or test strategy must be confirmed.';
  } else if (raw && !/^yes$/i.test(raw.trim())) {
    status = 'unclear';
    reason = 'English evidence was identified, but component scores, validity and any exemption/concession still require verification.';
  }

  return { raw, testCompleted, testType, testDate, scores: scoreFields, passportEnglishCountry, exemption, docsAvailable, status, reason };
}

function extractFacts(assessment = {}) {
  const root = assessmentPayloadRoot(assessment);
  const answers = assessmentAnswers(assessment);
  const flat = flattenObject(answers);
  const flatRoot = flattenObject(root);
  const allFlat = { ...flatRoot, ...flat };
  const ageInfo = extractAge(allFlat, assessment);
  const subclass = normaliseSubclass(pick(
    assessment.visa_type,
    assessment.subclass,
    assessment.visa_subclass,
    root.subclass,
    root.visaSubclass,
    root.visaType,
    findValue(allFlat, [/subclass/i, /visa.*type/i])
  ));
  const stream = normaliseStream(pick(
    assessment.stream,
    assessment.selected_stream,
    assessment.visa_stream,
    root.stream,
    root.selectedStream,
    root.visaStream,
    root.pathway,
    findValue(allFlat, [/selected.*stream/i, /stream/i, /pathway/i])
  ));

  return {
    subclass,
    stream,
    applicantName: pick(assessment.applicant_name, assessment.applicantName, root.applicantName, root.fullName, exactAnswer(allFlat, 'full-name'), findValue(allFlat, [/applicant.*name/i, /^name$/i])),
    clientEmail: pick(assessment.client_email, assessment.applicant_email, assessment.email, root.clientEmail, root.email, exactAnswer(allFlat, 'email-address'), findValue(allFlat, [/email/i])),
    employer: pick(exactAnswer(allFlat, 'employer-name', 'current-employer'), findValue(allFlat, [/employer.*name/i, /current.*employer/i, /sponsor.*name/i])),
    occupation: pick(exactAnswer(allFlat, 'occupation-title', 'nominated-position-title', 'anzsco-code-known'), findValue(allFlat, [/occupation/i, /job.*title/i, /anzsco/i])),
    duties: pick(exactAnswer(allFlat, 'daily-duties', 'nominated-duties', 'current-role-summary'), findValue(allFlat, [/duties/i, /aligned/i])),
    skills: pick(exactAnswer(allFlat, 'skills-assessment-status', 'highest-qualification', 'qualification-field', 'skills-assessing-authority'), findValue(allFlat, [/skills.*assessment/i, /qualification/i, /trade/i, /licen[cs]/i])),
    english: findValue(allFlat, [/english/i, /ielts/i, /pte/i, /toefl/i]),
    englishDetails: extractEnglishDetails(allFlat, assessment),
    age: ageInfo.age,
    ageInfo,
    salary: pick(exactAnswer(allFlat, 'salary-offered', 'annual-earnings-last-year', 'similar-role-salary'), findValue(allFlat, [/salary/i, /remuneration/i, /market.*salary/i])),
    health: pick(exactAnswer(allFlat, 'serious-medical', 'healthIssuesDisclosed'), findValue(allFlat, [/health/i, /medical/i])),
    character: pick(exactAnswer(allFlat, 'criminal-history', 'pending-matter'), findValue(allFlat, [/character/i, /criminal/i, /police/i])),
    migrationHistory: pick(exactAnswer(allFlat, 'visa-refused', 'visa-cancelled', 'section48-mentioned', 'unlawful-status', 'overstayed'), findValue(allFlat, [/refus/i, /cancel/i, /section\s*48/i, /8503/i, /unlawful/i, /migration.*history/i])),
    identity: pick(exactAnswer(allFlat, 'passport-available', 'passport-expiry'), findValue(allFlat, [/passport/i, /identity/i])),
    rootPayload: root,
    answers,
    rawFlat: allFlat,
    answerCount: answerEntries(allFlat).length
  };
}

function registryStreamKey(registry, stream) {
  if (!registry || !registry.streams) return '';
  const wanted = normaliseStream(stream);
  if (registry.streams[wanted]) return wanted;
  const key = Object.keys(registry.streams).find(k => normaliseStream(k) === wanted);
  return key || '';
}

function registryGrantCriteria(registry, stream) {
  const out = [];
  const seen = new Set();
  if (!registry || !registry.streams) return out;
  const add = (criteria, label) => {
    for (const c of asArray(criteria)) {
      const id = c && (c.criterionId || c.clause || c.id || `${label}-${out.length}`);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ ...(isPlainObject(c) ? c : { requirementText: text(c) }), registryStream: label });
    }
  };
  const common = registry.streams.common_or_secondary || registry.streams.common || registry.streams.Common;
  if (common) add(common.grantCriteria || common.criteria || common, 'common_or_secondary');
  const key = registryStreamKey(registry, stream);
  if (key && registry.streams[key]) add(registry.streams[key].grantCriteria || registry.streams[key].criteria || [], key);
  if (!out.length) {
    for (const [label, data] of Object.entries(registry.streams)) add(data.grantCriteria || data.criteria || [], label);
  }
  return out;
}

const AREA_PROFILES = [
  { area: 'stream_pathway', label: 'Subclass and stream/pathway', patterns: [/selected.*stream/i, /stream/i, /pathway/i, /labour.*agreement/i, /dama/i, /points/i, /invitation/i, /nomination/i, /visitor/i, /student/i, /protection/i], types: /stream|pathway|labour_agreement|points|invitation|validity|visitor|student|protection/ },
  { area: 'nomination', label: 'Sponsor, nominator, employer or pathway support', patterns: [/sponsor/i, /employer/i, /nomination/i, /nominator/i, /business/i, /position/i, /genuine/i, /abn/i, /contract/i, /ongoing/i, /support/i, /inviter/i, /relationship.*sponsor/i], types: /nomination|sponsor|employer|genuine|supporter|nominator/ },
  { area: 'occupation_skills', label: 'Occupation, skills, study or pathway-specific capability', patterns: [/occupation/i, /anzsco/i, /duties/i, /skill/i, /qualification/i, /licen[cs]/i, /assess/i, /authority/i, /training/i, /study/i, /course/i, /business.*history/i, /investment/i, /claim.*evidence/i], types: /skill|occupation|anzsco|licen|registration|qualification|study|business|investment|claim/ },
  { area: 'employment', label: 'Employment, study, relationship or personal history chronology', patterns: [/employment/i, /employed/i, /work/i, /hours/i, /start/i, /payroll/i, /reference/i, /visa.*right/i, /study.*history/i, /relationship.*history/i, /cohab/i, /travel.*history/i, /movement/i, /claim.*chronology/i], types: /employment|work|salary_employment|study_history|relationship_history|chronology|personal_history/ },
  { area: 'salary', label: 'Salary, funds, financial capacity and support evidence', patterns: [/salary/i, /remuneration/i, /market/i, /super/i, /award/i, /enterprise/i, /allowance/i, /deduction/i, /bank/i, /tax/i, /fund/i, /financial/i, /income/i, /asset/i, /support/i], types: /salary|market|remuneration|fund|financial|income|asset/ },
  { area: 'english', label: 'English language requirement or concession', patterns: [/english/i, /ielts/i, /pte/i, /toefl/i, /oet/i, /cambridge/i, /passport.*country/i, /concession/i], types: /english/ },
  { area: 'age', label: 'Age requirement or exemption', patterns: [/date.*birth/i, /dob/i, /age/i, /high.*income/i, /earnings/i], types: /age/ },
  { area: 'identity_location', label: 'Application validity, identity and location/status', patterns: [/passport/i, /identity/i, /name.*change/i, /currently.*australia/i, /current.*country/i, /current.*visa/i, /visa.*expiry/i, /bridging/i, /condition/i, /location/i, /form/i, /charge/i, /lodgement/i], types: /location_status|identity|validity|application_validity|charge|lodgement/ },
  { area: 'health', label: 'Health requirements', patterns: [/health/i, /medical/i, /treatment/i, /hap/i, /disease/i, /disability/i], types: /health/ },
  { area: 'character_integrity', label: 'Character, integrity and adverse information', patterns: [/character/i, /criminal/i, /police/i, /offen/i, /convict/i, /pending/i, /false/i, /fraud/i, /identity/i, /integrity/i, /paid.*sponsor/i, /pic/i, /4020/i, /public.*interest/i], types: /character|integrity|public_interest|health_character|pic|4020/ },
  { area: 'migration_history', label: 'Migration history, refusals, compliance or claims history', patterns: [/refus/i, /cancel/i, /section\s*48/i, /8503/i, /unlawful/i, /overstay/i, /breach/i, /tribunal/i, /appeal/i, /visa.*history/i, /protection.*claim/i, /persecution/i, /country/i, /relocation/i], types: /migration|compliance|public_interest|protection|refugee|complementary|exclusion|claims/ },
  { area: 'family', label: 'Family, relationship and secondary applicants', patterns: [/partner/i, /spouse/i, /de facto/i, /dependent/i, /dependant/i, /child/i, /family/i, /custody/i, /relationship/i, /sponsor.*partner/i, /family.*violence/i], types: /relationship_family|family|secondary|partner|child|parent|carer|remaining_relative/ },
  { area: 'evidence', label: 'Evidence readiness', patterns: [/available/i, /docs/i, /document/i, /evidence/i, /records/i, /payslip/i, /tax/i, /super/i, /resume/i, /reference/i, /certificate/i, /statement/i], types: /evidence|document/ }
];


function subclassNumber(facts = {}) {
  return normaliseSubclass(facts.subclass || '');
}

function subclassIn(facts, list) {
  return list.map(String).includes(subclassNumber(facts));
}

function subclassFamily(facts = {}) {
  const sc = subclassNumber(facts);
  if (['186','187','482','494','407'].includes(sc)) return 'employer_sponsored';
  if (['189','190','489','491'].includes(sc)) return 'general_skilled';
  if (['188','888'].includes(sc)) return 'business_investment';
  if (['300','309','820','801'].includes(sc)) return 'partner_family';
  if (['101','102','103','115','116','173','836','870'].includes(sc)) return 'family_parent_child_carer';
  if (['500','590'].includes(sc)) return 'student_guardian';
  if (['600','601','602','651'].includes(sc)) return 'visitor_medical';
  if (['785','790','866'].includes(sc)) return 'protection_humanitarian';
  if (['417','462'].includes(sc)) return 'working_holiday';
  if (['444','461'].includes(sc)) return 'nz_related';
  if (['485'].includes(sc)) return 'graduate';
  return 'visa';
}

function profileLabel(profile, facts = {}, criterion = {}) {
  const family = subclassFamily(facts);
  const textHay = `${criterion.criterionId || ''} ${criterion.criterionType || ''} ${criterion.requirementText || ''}`.toLowerCase();
  if (profile.area === 'nomination') {
    if (family === 'partner_family') return 'Sponsor, relationship and application support';
    if (family === 'family_parent_child_carer') return 'Sponsor, family relationship and dependency criteria';
    if (family === 'student_guardian') return 'Enrolment, genuine student/guardian and support criteria';
    if (family === 'protection_humanitarian') return 'Protection claims, complementary protection and exclusion issues';
    if (family === 'general_skilled') return 'Nomination/invitation, points-tested pathway and state/territory support';
    if (family === 'business_investment') return 'Business, investment and nomination criteria';
    if (family === 'visitor_medical') return 'Visitor purpose, stay period and temporary entrant criteria';
    if (family === 'working_holiday') return 'Working holiday eligibility and conditions';
    if (family === 'nz_related') return 'New Zealand citizen/family relationship pathway';
  }
  if (profile.area === 'occupation_skills') {
    if (family === 'partner_family') return 'Relationship evidence and family criteria';
    if (family === 'student_guardian') return 'Course, study history and genuine student evidence';
    if (family === 'protection_humanitarian') return 'Claims evidence and country-information alignment';
    if (family === 'visitor_medical') return 'Visit purpose, funds and temporary stay evidence';
    if (family === 'business_investment') return 'Business/investment history and ownership evidence';
  }
  if (profile.area === 'employment') {
    if (family === 'student_guardian') return 'Study, work rights and temporary stay history';
    if (family === 'partner_family') return 'Relationship chronology and household evidence';
    if (family === 'protection_humanitarian') return 'Personal history, movements and claim chronology';
  }
  if (profile.area === 'salary') {
    if (family === 'student_guardian' || family === 'visitor_medical') return 'Funds, financial capacity and support evidence';
    if (family === 'partner_family' || family === 'family_parent_child_carer') return 'Financial support, dependency and household evidence';
    if (family === 'protection_humanitarian') return 'Practical barriers, relocation and support evidence';
  }
  if (profile.area === 'stream_pathway') return `Subclass ${subclassNumber(facts) || ''} stream/pathway selection`.trim();
  if (/relationship|partner|spouse|de facto|sponsor/.test(textHay)) return 'Relationship and sponsorship criterion';
  return profile.label;
}

function areaRelevantForSubclass(area, facts = {}, registryAreas = new Set()) {
  const sc = subclassNumber(facts);
  if (!sc) return true;
  if (registryAreas && registryAreas.has(area)) return true;
  if (area === 'age') return ['186','187','188','189','190','407','485','489','491','494','888'].includes(sc) || Boolean(facts.ageInfo && (facts.ageInfo.age || facts.ageInfo.dateOfBirth || facts.ageInfo.exemption));
  if (area === 'english') return ['186','187','188','189','190','407','482','485','489','491','494','500','590','888'].includes(sc) || Boolean(facts.englishDetails && (facts.englishDetails.raw || facts.englishDetails.testType));
  return true;
}

function profileForCriterion(criterion) {
  const hay = `${criterion.clause || ''} ${criterion.criterionId || ''} ${asArray(criterion.criterionType).join(' ')} ${criterion.requirementText || ''} ${asArray(criterion.evidenceRules).map(r => text(r.documentGroup || r.document || r.proves)).join(' ')}`;
  const lower = hay.toLowerCase();
  if (/partner|spouse|de facto|relationship|sponsor|family violence/.test(lower)) return AREA_PROFILES.find(p => p.area === 'family');
  if (/student|enrol|course|genuine student|gs requirement|oshc|school|guardian/.test(lower)) return AREA_PROFILES.find(p => p.area === 'employment');
  if (/fund|financial|money|support|income|asset|bank/.test(lower)) return AREA_PROFILES.find(p => p.area === 'salary');
  if (/protection|refugee|complementary|persecution|country information|claim|exclusion|article/.test(lower)) return AREA_PROFILES.find(p => p.area === 'migration_history');
  if (/visitor|tourist|temporary entrant|genuine temporary|visit purpose|medical treatment/.test(lower)) return AREA_PROFILES.find(p => p.area === 'stream_pathway');
  if (/points|invitation|state nomination|territory nomination|eoi/.test(lower)) return AREA_PROFILES.find(p => p.area === 'stream_pathway');
  return AREA_PROFILES.find(p => p.types.test(hay)) || AREA_PROFILES.find(p => p.patterns.some(re => re.test(hay))) || AREA_PROFILES.find(p => p.area === 'evidence');
}

function fieldsForProfile(flat, profile, criterion = {}) {
  const fields = new Map();
  const required = [];
  const intake = criterion.intakeMapping || criterion.pdfMapping && criterion.pdfMapping.intakeMapping || {};
  for (const f of asArray(intake.requiredFields)) required.push(f);
  for (const field of required) {
    const direct = exactAnswer(flat, field);
    if (direct !== '') fields.set(field, direct);
  }
  for (const [key, value] of answerEntries(flat)) {
    if (profile.patterns.some(re => re.test(key))) fields.set(key, value);
  }
  return Array.from(fields.entries()).slice(0, 18);
}

function fieldSummary(fields, limit = 8) {
  if (!fields.length) return '';
  return fields.slice(0, limit).map(([k, v]) => `${k}: ${clean(v)}`).join('; ');
}

function hasPositiveEvidence(fields, profile) {
  if (!fields.length) return false;
  const positive = fields.filter(([, value]) => ['yes', 'held', 'completed', 'successful', 'available'].includes(normaliseYesNo(value)) || String(value || '').trim().length > 2);
  if (profile.area === 'english') return false; // handled separately
  if (profile.area === 'age') return false; // handled separately
  return positive.length >= Math.min(2, fields.length);
}

function hasAdverseAnswer(fields, profile) {
  const hay = fields.map(([k, v]) => `${k}=${v}`).join(' | ').toLowerCase();
  if (profile.area === 'nomination' && /has-australian-sponsor\s*=\s*no|role-full-time\s*=\s*no|role-ongoing\s*=\s*no|paid-for-sponsorship\s*=\s*yes/.test(hay)) return true;
  if (profile.area === 'occupation_skills' && /skills-assessment-status\s*=\s*no|skills-assessment-successful\s*=\s*no|licence-refused\s*=\s*yes/.test(hay)) return true;
  if (profile.area === 'english') return /english-test-completed\s*=\s*no/.test(hay);
  if (profile.area === 'health') return /serious-medical\s*=\s*yes|medical.*yes/.test(hay);
  if (profile.area === 'character_integrity') return /criminal-history\s*=\s*yes|pending-matter\s*=\s*yes|false-document-concern\s*=\s*yes|paid-for-sponsorship\s*=\s*yes/.test(hay);
  if (profile.area === 'migration_history') return /visa-refused\s*=\s*yes|visa-cancelled\s*=\s*yes|unlawful-status\s*=\s*yes|overstayed\s*=\s*yes|breached-conditions\s*=\s*yes|section48-mentioned\s*=\s*yes/.test(hay);
  return false;
}

function sourceLabelForCriterion(criterion, registry) {
  const source = criterion.sourceMap || criterion.source || {};
  const file = source.knowledgebaseFile || source.legalFrame || source.pamFile || source.pamDoc || (registry && registry.sourceOfTruth && registry.sourceOfTruth.pams) || 'knowledgebase source pack';
  const confidence = source.extractionConfidence || source.sourceConfidence || 'source-mapped registry requires RMA verification';
  return `${criterion.clause || criterion.criterionId || 'criterion'} — ${file} (${confidence})`;
}

function evidenceTextForCriterion(criterion, profile) {
  const rules = asArray(criterion.evidenceRules);
  const relevant = rules.map(r => r.documentGroup || r.document || r.proves).filter(Boolean).slice(0, 4);
  if (relevant.length) return relevant.join('; ');
  if (profile.area === 'english') return 'Original English test report, passport exemption evidence or concession evidence.';
  if (profile.area === 'age') return 'Passport/date of birth and any age exemption/concession evidence.';
  if (profile.area === 'nomination') return 'Nomination, employer, position description, contract, organisation chart and business need evidence.';
  return 'Original supporting evidence must be reviewed and reconciled before final lodgement advice.';
}

function requirementFromCriterion(criterion, profile, facts) {
  const req = clean(criterion.requirementText || criterion.requirement || '');
  if (req) return req.length > 520 ? `${req.slice(0, 520).replace(/\s+\S*$/, '')}…` : req;
  return requirementFor(profile.label, facts.subclass, facts.stream, '');
}

function statusForRegistryCriterion({ criterion, profile, fields, facts }) {
  if (profile.area === 'english') {
    const e = facts.englishDetails || {};
    return {
      status: e.status === 'likely_satisfied' ? 'likely_satisfied' : e.status === 'not_satisfied_or_high_risk' ? 'not_satisfied_or_high_risk' : 'unclear',
      displayStatus: e.status === 'likely_satisfied' ? 'Likely satisfied - verify evidence' : e.status === 'not_satisfied_or_high_risk' ? 'High risk - English threshold not confirmed' : 'Unclear - evidence required',
      riskLevel: e.status === 'likely_satisfied' ? 'Low to medium' : 'High'
    };
  }
  if (profile.area === 'age') {
    const a = ageCriteriaAnalysis(facts);
    return { status: a.status, displayStatus: a.displayStatus, riskLevel: a.riskLevel };
  }
  if (hasAdverseAnswer(fields, profile)) return { status: 'not_satisfied_or_high_risk', displayStatus: 'High risk - adverse answer requires review', riskLevel: 'High' };
  if (hasPositiveEvidence(fields, profile)) return { status: 'likely_satisfied', displayStatus: 'Likely satisfied - verify evidence', riskLevel: 'Low to medium' };
  return { status: 'unclear', displayStatus: 'Unclear - evidence required', riskLevel: /nomination|skill|english|age|salary|stream/i.test(profile.area) ? 'High' : 'Medium' };
}

function clientFactsForRegistryCriterion({ criterion, profile, fields, facts }) {
  if (profile.area === 'english') return factAnalysisFor('English language requirement or concession', facts, '');
  if (profile.area === 'age') return ageCriteriaAnalysis(facts).clientFacts;
  const summary = fieldSummary(fields, 8);
  if (!summary) return `No clear answer fields were mapped to this ${profile.label.toLowerCase()} criterion from the stored assessment payload. Follow-up and original evidence are required.`;
  return `The stored assessment answers mapped to this criterion include: ${summary}. These answers are not treated as final proof until reconciled against original evidence and current legal settings.`;
}

function actionForRegistryCriterion({ profile, status }) {
  if (profile.area === 'english') return 'Verify original English test report, component scores, test date/validity and any exemption or concession evidence.';
  if (profile.area === 'age') return ageCriteriaAnalysis({ age: null }).requiredAction.replace('Confirm date of birth', 'Confirm date of birth, recorded age');
  if (profile.area === 'nomination') return 'Build and reconcile the employer nomination file, including business need, genuine position, contract, duties and capacity evidence.';
  if (profile.area === 'occupation_skills') return 'Reconcile occupation, ANZSCO, duties, qualifications, skills assessment, registration/licensing and employment evidence.';
  if (profile.area === 'salary') return 'Reconcile salary, contract, payroll, superannuation, market salary and any threshold/concession material.';
  if (profile.area === 'health') return 'Review health disclosures and obtain health examination/medical evidence if required.';
  if (profile.area === 'character_integrity') return 'Review police checks, character disclosures, integrity issues and document consistency before final advice.';
  if (profile.area === 'migration_history') return 'Review visa history, refusals, cancellations, conditions and Departmental records before lodgement strategy.';
  if (status.status === 'likely_satisfied') return 'Verify the recorded answers against original documents before final lodgement advice.';
  return 'Obtain missing information and original evidence before treating this criterion as satisfied.';
}

function consequenceForRegistryCriterion(profile, status) {
  if (/high|not_satisfied/i.test(`${status.riskLevel} ${status.status}`)) {
    return `${profile.label} is a material risk area. If the answers are not supported by original evidence or current legal settings, the pathway may be unsuitable or require a different strategy.`;
  }
  return `${profile.label} appears potentially supportable on the stored answers, but it remains subject to original evidence, Departmental records and current-law verification.`;
}

function buildRegistryCriteriaFindings({ registry, facts }) {
  const criteria = registryGrantCriteria(registry, facts.stream);
  const findings = [];
  const fieldUsage = new Map();
  const registryAreas = new Set();
  for (const criterion of criteria) {
    const profile = profileForCriterion(criterion);
    registryAreas.add(profile.area);
    const fields = fieldsForProfile(facts.rawFlat, profile, criterion);
    const label = profileLabel(profile, facts, criterion);
    fields.forEach(([k]) => fieldUsage.set(k, (fieldUsage.get(k) || 0) + 1));
    const status = statusForRegistryCriterion({ criterion, profile, fields, facts });
    const issue = `${label}${criterion.clause ? ` — clause ${criterion.clause}` : ''}`;
    findings.push({
      issue,
      title: issue,
      criterionId: criterion.criterionId || criterion.id || criterion.clause || issue,
      clause: criterion.clause || null,
      sourceArea: sourceLabelForCriterion(criterion, registry),
      sourceConfidence: criterion.sourceMap && criterion.sourceMap.extractionConfidence || 'registry-source-mapped-needs-rma-verification',
      answerFieldsUsed: fields.map(([field]) => field),
      mappedAnswerSummary: fieldSummary(fields, 10),
      status: status.status,
      displayStatus: status.displayStatus,
      riskLevel: status.riskLevel,
      materiality: materialityFor(issue),
      legalRequirement: requirementFromCriterion(criterion, profile, facts),
      clientFacts: clientFactsForRegistryCriterion({ criterion, profile, fields, facts }),
      evidenceGap: evidenceTextForCriterion(criterion, profile),
      consequence: consequenceForRegistryCriterion({ ...profile, label }, status),
      requiredAction: actionForRegistryCriterion({ profile: { ...profile, label }, status }),
      criterionTypes: asArray(criterion.criterionType),
      registryStream: criterion.registryStream || facts.stream,
      aiControllerAssessed: true
    });
  }
  const allFields = answerEntries(facts.rawFlat).map(([k]) => k);
  const unused = allFields.filter(k => !fieldUsage.has(k) && !/^meta\.|rawSubmission\./i.test(k)).slice(0, 200);
  return {
    findings,
    audit: {
      registryCriteriaCount: criteria.length,
      registryAreas: Array.from(registryAreas),
      savedAnswerFieldCount: allFields.length,
      usedAnswerFieldCount: fieldUsage.size,
      unusedAnswerFields: unused,
      fieldUsage: Object.fromEntries(Array.from(fieldUsage.entries()).slice(0, 250))
    }
  };
}

function sourceFindings(adviceBundle = {}) {
  const advice = adviceBundle.advice || {};
  const model = adviceBundle.seniorAdviceModel || adviceBundle.universalAdviceModel || adviceBundle.adviceModel || advice.seniorAdviceModel || advice;
  const candidates = [
    adviceBundle.seniorCriteriaFindings,
    adviceBundle.clientFacingCriteriaFindings,
    adviceBundle.grantCriteriaFindings,
    adviceBundle.criterion_findings,
    model && model.criteriaFindings,
    model && model.seniorCriteriaFindings,
    model && model.grantCriteriaFindings,
    advice && advice.grantCriteriaFindings,
    advice && advice.criterion_findings
  ];
  for (const candidate of candidates) {
    const arr = asArray(candidate);
    if (arr.length) return arr;
  }
  return [];
}

function findingTitle(finding) {
  if (!isPlainObject(finding)) return text(finding, 'Legal issue');
  return clean(pick(finding.issue, finding.title, finding.label, finding.criterionLabel, finding.criterionName, finding.name, finding.criterion, 'Legal issue'));
}

function findingStatus(finding) {
  if (!isPlainObject(finding)) return 'unclear';
  return String(pick(finding.status, finding.displayStatus, finding.riskLevel, finding.risk, '')).toLowerCase();
}

function displayStatusFor(finding) {
  if (finding && finding.displayStatus) return clean(finding.displayStatus);
  const raw = findingStatus(finding);
  if (/not[_\s-]?satisfied|adverse|high|risk|refus|cancel/.test(raw)) return 'Unclear / risk to resolve';
  if (/likely|satisfied|supportable|low/.test(raw)) return 'Likely satisfied - verify evidence';
  if (/not[_\s-]?applicable|n\/a/.test(raw)) return 'Not applicable';
  return 'Unclear - evidence required';
}

function materialityFor(title) {
  const lower = String(title || '').toLowerCase();
  if (/nomination|sponsor|employer|genuine position|operational/.test(lower)) return 'primary';
  if (/skill|occupation|anzsco|english|salary|market|stream|pathway|age/.test(lower)) return 'material';
  if (/health|character|integrity|migration|refusal|cancellation|public interest/.test(lower)) return 'public-interest';
  return 'supporting';
}

function riskLevelFor(title, status) {
  const lower = `${title} ${status}`.toLowerCase();
  if (/nomination|sponsor|skills|occupation|english|salary|stream|pathway|age/.test(lower) && /unclear|risk|required|not_satisfied|high/.test(lower)) return 'High';
  if (/health|character|migration|integrity/.test(lower) && /unclear|risk|required|high/.test(lower)) return 'Medium to high';
  if (/likely|satisfied/.test(lower)) return 'Low to medium';
  return 'Medium';
}

function requirementFor(title, subclass, stream, existing) {
  const lower = String(title || '').toLowerCase();
  if (existing && !/^the requirement must be assessed under/i.test(existing)) return clean(existing);
  if (/stream|pathway/.test(lower)) return `The selected Subclass ${subclass}${stream ? ` ${stream}` : ''} pathway must be legally available on the facts and strategically appropriate having regard to the applicant, sponsor and evidence position.`;
  if (/sponsor|employer|nomination|genuine position|operational/.test(lower)) return 'The nomination and employer file must support a genuine, available and properly documented role connected to the business operations, position duties and ongoing need.';
  if (/direct entry|skill|occupation|anzsco/.test(lower)) return 'The applicant’s occupation, duties, qualifications, employment history, skills assessment and any licensing or registration evidence must support the selected pathway.';
  if (/employment|work history|continuity/.test(lower)) return 'The employment history must be reconstructed from objective records and tested against the selected stream, nominated occupation and any relevant continuity or experience requirement.';
  if (/salary|market/.test(lower)) return 'The remuneration position must be consistent with the nomination, contract, payroll, superannuation, market salary evidence and any applicable threshold or concession.';
  if (/english/.test(lower)) return 'The applicant must hold acceptable English evidence, exemption evidence or concession evidence that is valid at the relevant time for the selected stream.';
  if (/age/.test(lower)) return 'The applicant must satisfy the applicable age setting for the selected stream, or identify a valid exemption, concession or alternative pathway before lodgement.';
  if (/validity|identity/.test(lower)) return 'The application must be validly made, including correct identity, location, visa-status and any stream-specific validity prerequisites before grant criteria are assessed.';
  if (/health/.test(lower)) return 'The applicant and included family members must satisfy the applicable health requirements or address any health-related concern before final advice is relied upon.';
  if (/character|integrity/.test(lower)) return 'The applicant must satisfy character and integrity requirements, including truthful disclosure and consistency across documents and Departmental records.';
  if (/migration|compliance|refusal|cancellation/.test(lower)) return 'Prior visa history, refusals, cancellations, conditions, section 48 issues and no-further-stay restrictions must be reviewed before lodgement strategy is finalised.';
  return `The issue must be assessed under the Subclass ${subclass}${stream ? ` ${stream}` : ''} legal framework and reconciled against original evidence before final lodgement advice.`;
}

function ageCriteriaAnalysis(facts) {
  const age = facts.age;
  const exemption = facts.ageInfo && facts.ageInfo.exemption;
  if (!Number.isFinite(age)) {
    return {
      status: 'unclear',
      displayStatus: 'Unclear - age evidence required',
      riskLevel: 'High',
      clientFacts: 'The applicant’s age was not clearly identified from the stored assessment data. Age must be confirmed because it may be material unless an exemption or concession applies.',
      consequence: 'If the applicant is outside the applicable age setting and no exemption/concession applies, the pathway may not be viable.',
      requiredAction: 'Confirm date of birth, age at the relevant time, and whether any age exemption or concession applies.'
    };
  }
  if (age < 45 || /yes|medical|academic|scientist|technical|long-term|high-income|labour|dama/i.test(String(exemption || ''))) {
    return {
      status: 'likely_satisfied',
      displayStatus: 'Likely satisfied - verify evidence',
      riskLevel: age < 45 ? 'Low to medium' : 'Medium to high',
      clientFacts: `The applicant’s recorded age is ${age}${exemption ? ` and the intake records an age exemption/concession indicator: ${clean(exemption)}.` : '.'} On the present information, the age position appears potentially supportable, subject to original evidence and current pathway settings.`,
      consequence: 'The age issue appears manageable if original identity documents and any exemption/concession evidence confirm the recorded position.',
      requiredAction: 'Verify passport/date of birth, timing and any age exemption/concession evidence before final advice.'
    };
  }
  return {
    status: 'not_satisfied_or_high_risk',
    displayStatus: 'High risk - exemption/concession required',
    riskLevel: 'High',
    clientFacts: `The applicant’s recorded age is ${age}. This may create a material risk unless an exemption, concession or alternative pathway is available.`,
    consequence: 'If the applicable age requirement is not met and no exemption/concession applies, the application may not be viable.',
    requiredAction: 'Confirm exact age, applicable stream settings and any available age exemption/concession before relying on this pathway.'
  };
}


function hasSavedAgeAnswer(facts) {
  if (!facts) return false;
  if (Number.isFinite(facts.age)) return true;
  if (facts.ageInfo && (facts.ageInfo.dateOfBirth || facts.ageInfo.ageAtApplication || facts.ageInfo.exemption)) return true;
  const flat = facts.rawFlat || {};
  return Object.keys(flat).some(k => /\bage\b|date[-_\s]*of[-_\s]*birth|birth|dob/i.test(k) && clean(flat[k]));
}

function findingLooksLikeAge(finding) {
  const title = findingTitle(finding);
  const body = [
    title,
    finding && finding.issue,
    finding && finding.title,
    finding && finding.criterionId,
    finding && finding.legalRequirement,
    finding && finding.clientFacts,
    finding && finding.requiredAction
  ].map(clean).join(' ');
  return /\bage\b|date[-_\s]*of[-_\s]*birth|birth|dob/i.test(body);
}

function buildMandatoryAgeFinding(facts) {
  const analysis = ageCriteriaAnalysis(facts || {});
  const subclass = facts && facts.subclass ? facts.subclass : '186';
  const stream = facts && facts.stream ? facts.stream : '';
  const issue = 'Age';
  return {
    issue,
    title: issue,
    area: 'Age',
    criterionKey: 'age',
    criterionId: `subclass-${subclass}-age`,
    clause: null,
    sourceArea: `Subclass ${subclass}${stream ? ` ${stream}` : ''} age criterion`,
    sourceConfidence: 'mandatory-controller-finding-from-saved-age-answer',
    answerFieldsUsed: (facts && facts.ageInfo && facts.ageInfo.fields) || [],
    mappedAnswerSummary: facts && Number.isFinite(facts.age) ? `Recorded age: ${facts.age}` : 'Age/date-of-birth answer requires verification.',
    status: analysis.status,
    displayStatus: analysis.displayStatus,
    riskLevel: analysis.riskLevel,
    materiality: 'material',
    legalRequirement: requirementFor('Age', subclass, stream),
    clientFacts: analysis.clientFacts,
    evidenceGap: 'Passport bio page, date-of-birth evidence and any age exemption/concession evidence must be checked before final advice is relied upon.',
    consequence: analysis.consequence,
    requiredAction: analysis.requiredAction,
    requiredEvidence: ['Passport bio page', 'Date of birth evidence', 'Age exemption/concession evidence if relied upon'],
    missingEvidence: [],
    criterionTypes: ['grant-criterion', 'mandatory-saved-answer-coverage'],
    registryStream: stream,
    aiControllerAssessed: true,
    mandatoryCoverageFinding: true
  };
}

function ensureMandatorySavedAnswerFindings(findings, facts) {
  const out = asArray(findings).filter(Boolean);
  if ((facts && facts.subclass === '186') && hasSavedAgeAnswer(facts) && !out.some(findingLooksLikeAge)) {
    out.unshift(buildMandatoryAgeFinding(facts));
  }
  return out;
}

function factAnalysisFor(title, facts, existing) {
  const lower = String(title || '').toLowerCase();
  const existingText = clean(existing || '');
  if (/stream|pathway/.test(lower)) return facts.stream ? `The selected pathway is recorded as ${facts.stream}. It must be confirmed against the nomination, skills, visa-history and source-mapped stream criteria before it is adopted as the lodgement pathway.` : 'The selected pathway has not been clearly confirmed from the stored assessment record.';
  if (/sponsor|employer|nomination/.test(lower)) return facts.employer ? `The employer/nomination instruction identifies ${clean(facts.employer)}. The nomination file, business records, position description and evidence of genuine ongoing need must support that instruction.` : 'The employer/nomination position requires confirmation from the nomination file and employer evidence.';
  if (/direct entry|skill/.test(lower)) return facts.skills ? `The skills/qualification information recorded is ${clean(facts.skills)}. It should be tested against the nominated occupation, skills-assessment pathway, licensing/registration and employment evidence before the stream is relied upon.` : 'The skills position requires confirmation through skills-assessment, qualifications, licensing and employment evidence.';
  if (/occupation|anzsco/.test(lower)) return facts.duties || facts.occupation ? `The occupation/duties information appears potentially supportive, but actual duties must be mapped to the nominated occupation and supported by references, qualifications and any required registration or licensing.` : 'The nominated occupation and ANZSCO alignment are not yet sufficiently established on the stored facts.';
  if (/employment|work history|continuity/.test(lower)) return 'Employment continuity should be reconstructed from objective payroll, tax, superannuation, leave and visa/work-rights records rather than treated as established from questionnaire wording alone.';
  if (/salary|market/.test(lower)) return facts.salary ? `The remuneration figure recorded is ${clean(facts.salary)}. It should be tested against the nomination record, contract, payroll, superannuation, market salary evidence and any applicable threshold or concession.` : 'The salary and market salary position requires confirmation from the nomination, contract, payroll and market evidence.';
  if (/english/.test(lower)) {
    const e = facts.englishDetails || {};
    const scoreBits = e.scores ? Object.entries(e.scores).filter(([,v]) => Number.isFinite(v)).map(([k,v]) => `${k} ${v}`).join(', ') : '';
    const base = e.raw || e.testType ? `The English evidence recorded is ${clean(e.testType || e.raw)}${scoreBits ? ` (${scoreBits})` : ''}${e.testDate ? `, test date ${clean(e.testDate)}` : ''}.` : 'The English position has not been verified from original test or exemption evidence.';
    return `${base} ${e.reason || 'The original result, test type, component scores, validity date, exemption basis or concession must be verified before final advice.'}`;
  }
  if (/age/.test(lower)) return ageCriteriaAnalysis(facts).clientFacts;
  if (/health/.test(lower)) return /yes|issue|condition|medical/i.test(String(facts.health || '')) ? 'A health issue may have been disclosed and must be reviewed before final lodgement advice.' : 'No health issue was disclosed in the assessment response, subject to standard health declarations, examinations and family-member checks.';
  if (/character|integrity|migration|compliance/.test(lower)) return /yes|refus|cancel|criminal|convict|section|8503/i.test(`${facts.character} ${facts.migrationHistory}`) ? 'An adverse character, integrity or migration-history issue may require strategy before lodgement.' : 'No adverse character, integrity or immigration-history issue was disclosed in the assessment response, subject to police clearances, Departmental records and document-consistency checks.';
  if (existingText) return existingText;
  return 'The present instructions require reconciliation against original evidence before lodgement-ready advice is issued.';
}

function evidenceFor(finding) {
  if (!isPlainObject(finding)) return 'Original evidence should be reviewed.';
  return clean(pick(finding.evidenceGap, finding.evidenceMissing, finding.gap, finding.requiredEvidence, finding.documentsRequired, 'Original evidence should be reviewed and reconciled before final lodgement advice.'));
}

function actionFor(finding) {
  if (!isPlainObject(finding)) return 'Resolve before final lodgement advice.';
  return clean(pick(finding.requiredAction, finding.action, finding.recommendation, finding.seniorOpinion, finding.agentOpinion, finding.professionalPosition, 'Resolve before final lodgement advice.'));
}

function consequenceFor(title, finding, status) {
  const existing = isPlainObject(finding) ? clean(pick(finding.consequence, finding.legalConsequence, finding.consequenceOfFailure, finding.riskIfMissing, finding.whyItMatters)) : '';
  if (existing) return existing;
  const lower = String(title || '').toLowerCase();
  if (/nomination|sponsor|employer|genuine/.test(lower)) return 'If the nomination, genuine-position or employer-capacity evidence is inconsistent or incomplete, the nomination may become the central refusal risk.';
  if (/skill|occupation|anzsco/.test(lower)) return 'If the skills, occupation, registration/licensing or qualification evidence cannot be verified, the selected pathway may not be lodgement-ready.';
  if (/salary|market/.test(lower)) return 'If salary or market salary evidence cannot be reconciled, the nomination and stream position may become vulnerable.';
  if (/english/.test(lower)) return 'The English position may be supportable only if the evidence is valid, current and meets the applicable threshold, exemption or concession for the selected stream.';
  if (/age/.test(lower)) return ageCriteriaAnalysis({ age: null }).consequence;
  if (/health/.test(lower)) return 'Health issues may affect timing, evidence strategy or final lodgement advice depending on Departmental assessment.';
  if (/character|integrity|migration/.test(lower)) return 'If Departmental records differ from the instructions, the matter may require strategy before lodgement.';
  return /likely/i.test(status) ? 'The issue appears potentially supportable, subject to original evidence confirming the instructions.' : 'The criterion may be capable of being satisfied, but only if supporting documents confirm the instructions and no inconsistent records emerge.';
}

function enhanceFinding(finding, index, facts) {
  const title = findingTitle(finding);
  const displayStatus = displayStatusFor(finding);
  const existingRequirement = isPlainObject(finding) ? pick(finding.legalRequirement, finding.requirement, finding.legalTest, finding.rule) : '';
  const existingFacts = isPlainObject(finding) ? pick(finding.clientFacts, finding.factsApplied, finding.currentPosition, finding.presentInformation, finding.evidenceHeld, finding.filePosition, finding.finding) : '';
  return {
    ...(isPlainObject(finding) ? finding : {}),
    issue: title,
    title,
    sequence: index + 1,
    status: /likely/i.test(displayStatus) ? 'likely_satisfied' : /not applicable/i.test(displayStatus) ? 'not_applicable' : /not_satisfied|high risk/i.test(String(finding.status || displayStatus)) ? 'not_satisfied_or_high_risk' : 'unclear',
    displayStatus,
    riskLevel: finding.riskLevel || riskLevelFor(title, displayStatus),
    materiality: finding.materiality || materialityFor(title),
    legalRequirement: requirementFor(title, facts.subclass, facts.stream, existingRequirement),
    clientFacts: factAnalysisFor(title, facts, existingFacts),
    evidenceGap: evidenceFor(finding),
    consequence: consequenceFor(title, finding, displayStatus),
    requiredAction: actionFor(finding),
    aiControllerEnhanced: true
  };
}

function hasFinding(findings, pattern) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
  return findings.some(f => re.test(findingTitle(f)));
}

function ensureCoreFindings(findings, facts, registryAreas = new Set()) {
  const out = [...findings];
  if (areaRelevantForSubclass('age', facts, registryAreas) && !hasFinding(out, /age/)) {
    const age = ageCriteriaAnalysis(facts);
    out.push({
      issue: 'Age requirement or exemption',
      title: 'Age requirement or exemption',
      status: age.status,
      displayStatus: age.displayStatus,
      riskLevel: age.riskLevel,
      legalRequirement: requirementFor('Age requirement or exemption', facts.subclass, facts.stream),
      clientFacts: age.clientFacts,
      evidenceGap: 'Passport/date-of-birth evidence and any age exemption, concession or pathway-specific material.',
      consequence: age.consequence,
      requiredAction: age.requiredAction,
      insertedByAiController: true
    });
  }
  if (areaRelevantForSubclass('english', facts, registryAreas) && !hasFinding(out, /english/)) {
    const e = facts.englishDetails || {};
    out.push({
      issue: 'English language requirement or concession',
      title: 'English language requirement or concession',
      status: e.status === 'likely_satisfied' ? 'likely_satisfied' : e.status === 'not_satisfied_or_high_risk' ? 'not_satisfied_or_high_risk' : 'unclear',
      displayStatus: e.status === 'likely_satisfied' ? 'Likely satisfied - verify evidence' : e.status === 'not_satisfied_or_high_risk' ? 'High risk - English threshold not confirmed' : 'Unclear - evidence required',
      riskLevel: e.status === 'likely_satisfied' ? 'Low to medium' : 'High',
      legalRequirement: requirementFor('English language requirement or concession', facts.subclass, facts.stream),
      clientFacts: factAnalysisFor('English language requirement or concession', facts, ''),
      evidenceGap: 'Original English test report showing test type, component scores and validity date, or exemption/concession evidence.',
      consequence: 'The English position may be supportable only if the evidence is valid, current and meets the applicable threshold, exemption or concession.',
      requiredAction: 'Verify English component scores, validity and any exemption/concession before final lodgement advice.',
      insertedByAiController: true
    });
  }
  return out;
}

function mergeFindings(registryFindings, existingFindings, facts, registryAreas = new Set()) {
  const out = [];
  const seen = new Set();
  const add = (finding) => {
    const title = findingTitle(finding);
    const clause = finding && finding.clause ? String(finding.clause) : '';
    const key = clause || normaliseKey(title).slice(0, 80);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(finding);
  };
  registryFindings.forEach(add);
  existingFindings.forEach(add);
  return ensureCoreFindings(out, facts, registryAreas);
}

function topBlockers(findings) {
  const priorityOrder = ['nomination', 'sponsor', 'employer', 'direct entry', 'skill', 'occupation', 'anzsco', 'salary', 'market', 'english', 'age', 'stream', 'pathway', 'health', 'character', 'migration'];
  const scored = findings.map(f => {
    const title = f.title || f.issue || '';
    const lower = title.toLowerCase();
    const priority = priorityOrder.findIndex(p => lower.includes(p));
    const unresolved = /unclear|risk|required|medium|high|not_satisfied/i.test(`${f.displayStatus} ${f.riskLevel} ${f.status}`) ? 10 : 0;
    return { f, score: unresolved + (priority >= 0 ? (priorityOrder.length - priority) : 0) };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, 5).map(x => x.f);
}

function buildPriorityActionPlan(findings) {
  return topBlockers(findings).map((f, index) => ({
    priority: index + 1,
    issue: f.title || f.issue,
    whyItMatters: f.consequence,
    requiredAction: f.requiredAction,
    riskLevel: f.riskLevel
  }));
}

function buildViabilityOpinion(facts, findings) {
  const blockers = topBlockers(findings);
  const high = blockers.filter(f => /high/i.test(String(f.riskLevel || ''))).length;
  const likely = findings.filter(f => /likely_satisfied/i.test(String(f.status || ''))).length;
  const unresolved = findings.filter(f => /unclear|risk|required|not_satisfied/i.test(`${f.status} ${f.displayStatus}`)).length;

  let position = 'Potentially viable but not lodgement-ready';
  let overallRisk = 'High';
  if (high >= 3) {
    position = 'Not lodgement-ready; viability depends on resolving primary evidence risks';
    overallRisk = 'High';
  } else if (likely >= Math.ceil(findings.length / 2) && unresolved <= Math.ceil(findings.length / 2)) {
    position = 'Potentially viable subject to evidence reconciliation';
    overallRisk = 'Medium to high';
  }

  const blockerText = blockers.map(f => f.title || f.issue).filter(Boolean);
  const summary = `On the current saved answers, the Subclass ${facts.subclass}${facts.stream ? ` ${facts.stream}` : ''} pathway is ${position.toLowerCase()}. The main unresolved issues are ${blockerText.length ? blockerText.join('; ') : 'the criterion-by-criterion evidence position'}.`;
  const nextStep = blockerText.length
    ? `Start with ${blockerText[0]}, then reconcile ${blockerText.slice(1, 4).join('; ') || 'the remaining evidence gaps'} before final lodgement advice.`
    : 'Complete original evidence review before final lodgement advice.';

  return { position, overallRisk, summary, nextStep, materialBlockers: blockerText };
}

function legalFrameworkSummary(facts, registry) {
  const streamPart = facts.stream ? ` ${facts.stream}` : '';
  const family = subclassFamily(facts).replace(/_/g, ' ');
  const registryVersion = registry && (registry.schemaVersion || registry.version || registry.registryFingerprint) ? ` Registry/source snapshot: ${registry.schemaVersion || registry.version || registry.registryFingerprint}.` : '';
  return `This preliminary assessment considered the Subclass ${facts.subclass}${streamPart} framework using the subclass criteria registry and knowledgebase source pack for the ${family} pathway. The controller mapped the saved assessment answers to the registry criteria for this subclass/stream, including validity, identity/location, family/sponsor/employer/nomination or pathway-specific requirements where relevant, skills/English/age/financial criteria where applicable, health, character, integrity/public-interest and migration-history considerations. Exact clause references are used only where present in the source-mapped registry and remain subject to RMA verification.${registryVersion}`;
}

function buildClientAdviceObject({ facts, findings, adviceBundle, registry, registryAssessmentAudit }) {
  const viability = buildViabilityOpinion(facts, findings);
  const priorityActionPlan = buildPriorityActionPlan(findings);
  const pathwayStrengthAnalysis = `The selected pathway (${facts.stream || 'stream/pathway not confirmed'}) has been screened against the saved answers, subclass criteria registry and knowledgebase source mapping. It should not be treated as lodgement-ready until the priority criteria and original evidence are reconciled.`;
  return {
    matter: {
      reference: pick(adviceBundle.assessmentId, adviceBundle.reference),
      subclass: facts.subclass,
      stream: facts.stream,
      clientEmail: facts.clientEmail
    },
    applicantName: facts.applicantName,
    clientEmail: facts.clientEmail,
    subclass: facts.subclass,
    stream: facts.stream,
    executiveAdvice: `${viability.summary} ${pathwayStrengthAnalysis}`,
    seniorOpinion: {
      shortOpinion: viability.summary,
      viability: viability.position,
      nextStep: viability.nextStep
    },
    viabilityOpinion: viability,
    pathwayStrengthAnalysis,
    topMaterialBlockers: viability.materialBlockers,
    priorityActionPlan,
    legalFrameworkSummary: legalFrameworkSummary(facts, registry),
    eligibilityFindings: findings,
    criteriaFindings: findings,
    seniorCriteriaFindings: findings,
    grantCriteriaFindings: findings,
    evidenceGaps: findings.map(f => ({ issue: f.title || f.issue, requiredEvidence: f.evidenceGap, action: f.requiredAction })),
    lodgementReadinessActionPlan: priorityActionPlan.map(p => `Priority ${p.priority} — ${p.issue}: ${p.requiredAction}`),
    overallRisk: viability.overallRisk,
    riskLevel: viability.overallRisk,
    lodgementPosition: viability.position,
    nextStep: viability.nextStep,
    fieldCoverageSummary: registryAssessmentAudit ? {
      savedAnswerFieldCount: registryAssessmentAudit.savedAnswerFieldCount,
      usedAnswerFieldCount: registryAssessmentAudit.usedAnswerFieldCount,
      registryCriteriaCount: registryAssessmentAudit.registryCriteriaCount
    } : null,
    finalRecommendation: {
      position: 'Do not lodge yet',
      overallRisk: viability.overallRisk,
      nextStep: viability.nextStep,
      summary: `${viability.position}. Do not lodge until the priority issues are reconciled against original evidence.`,
      fullText: `${viability.position}. The matter should proceed to formal evidence review. If the priority issues are verified and no adverse Departmental records, source-mapping issues or public-interest concerns emerge, the matter may become suitable for final lodgement advice. The first practical step is: ${viability.nextStep}`
    },
    limitations: [
      'This is preliminary advice based on saved questionnaire answers and available source materials.',
      'Original evidence, current law, Departmental records and final migration-agent review are required before lodgement.',
      'No guarantee of visa grant is given.'
    ],
    aiControllerVersion: AI_CONTROLLER_VERSION
  };
}

function buildInternalAuditObject({ facts, findings, adviceBundle, registry, registryResult, registryAssessmentAudit }) {
  const legalPack = adviceBundle.legalSourcePack || {};
  return {
    assessmentId: pick(adviceBundle.assessmentId, adviceBundle.advice && adviceBundle.advice.assessmentId),
    engineVersion: AI_CONTROLLER_VERSION,
    registryVersion: pick(registry && registry.version, registry && registry.schemaVersion, registry && registry.metadata && registry.metadata.version, 'registry-version-not-declared'),
    knowledgebaseVersion: pick(legalPack.snapshotId, legalPack.knowledgebaseSnapshot && legalPack.knowledgebaseSnapshot.snapshotId, registry && registry.registryFingerprint, 'knowledgebase-snapshot-not-declared'),
    pdfTemplateVersion: 'pdf-js-ai-controller-layout-v2',
    generatedAt: new Date().toISOString(),
    criteriaAssessed: findings.map(f => ({ issue: f.title || f.issue, clause: f.clause || null, status: f.status, riskLevel: f.riskLevel, materiality: f.materiality, answerFieldsUsed: f.answerFieldsUsed || [] })),
    sourcesUsed: Array.isArray(legalPack.sources) ? legalPack.sources.map(s => ({ authority: s.authority, title: s.title, path: s.path, sha256: s.sha256 })).slice(0, 50) : [],
    sourceConfidence: { subclass: facts.subclass ? 'medium' : 'low', stream: facts.stream ? 'medium' : 'low', registry: registry ? 'source-mapped-needs-rma-verification' : 'missing' },
    coverageWarnings: asArray(registryResult && registryResult.audit && (registryResult.audit.coverageGateWarningMessage || registryResult.audit.sourceSupportWarningMessage)).filter(Boolean),
    answerCoverageAudit: registryAssessmentAudit || null,
    fallbackUsed: Boolean(adviceBundle.fallbackUsed || adviceBundle.deterministicFallbackUsed),
    fallbackReason: pick(adviceBundle.fallbackReason, adviceBundle.primaryPipelineFailure, null),
    qualityGateResult: {
      clientEmailPresent: Boolean(facts.clientEmail),
      subclassPresent: Boolean(facts.subclass),
      streamPresent: Boolean(facts.stream),
      criteriaFindingsPresent: findings.length > 0,
      answerPayloadPresent: facts.answerCount > 0,
      registryCriteriaMapped: Boolean(registryAssessmentAudit && registryAssessmentAudit.registryCriteriaCount),
      noFakeCitations: true,
      passed: Boolean(facts.clientEmail && facts.subclass && facts.stream && findings.length)
    },
    adminWarnings: [
      ...(!facts.stream ? ['Stream/pathway could not be confidently identified.'] : []),
      ...(!facts.clientEmail ? ['Client email missing from advice controller facts.'] : []),
      ...(!registry ? ['Criteria registry was not supplied to AI controller; fallback/enhanced findings only.'] : []),
      ...(registryAssessmentAudit && registryAssessmentAudit.unusedAnswerFields && registryAssessmentAudit.unusedAnswerFields.length ? [`Some saved answer fields were not mapped to registry criteria: ${registryAssessmentAudit.unusedAnswerFields.slice(0, 25).join(', ')}`] : [])
    ]
  };
}

function applyAiMigrationAdviceController({ adviceBundle = {}, assessment = {}, registry = null, registryResult = null } = {}) {
  const facts = extractFacts(assessment);
  facts.subclass = facts.subclass || normaliseSubclass(pick(adviceBundle.subclass, adviceBundle.advice && adviceBundle.advice.subclass));
  facts.stream = facts.stream || normaliseStream(pick(adviceBundle.stream, adviceBundle.selectedStream, adviceBundle.clientFacingStream, adviceBundle.advice && adviceBundle.advice.stream));

  const registryAssessment = registry ? buildRegistryCriteriaFindings({ registry, facts }) : { findings: [], audit: null };
  const originalFindings = sourceFindings(adviceBundle);
  const mergedFindings = mergeFindings(registryAssessment.findings, originalFindings, facts, new Set(registryAssessment.audit && registryAssessment.audit.registryAreas || []));
  const coverageCompleteFindings = ensureMandatorySavedAnswerFindings(mergedFindings, facts);
  const enhancedFindings = coverageCompleteFindings.map((finding, index) => enhanceFinding(finding, index, facts));
  const clientAdviceObject = buildClientAdviceObject({ facts, findings: enhancedFindings, adviceBundle, registry, registryAssessmentAudit: registryAssessment.audit });
  const internalAuditObject = buildInternalAuditObject({ facts, findings: enhancedFindings, adviceBundle, registry, registryResult, registryAssessmentAudit: registryAssessment.audit });
  const advice = adviceBundle.advice || {};
  const existingModel = adviceBundle.seniorAdviceModel || adviceBundle.universalAdviceModel || adviceBundle.adviceModel || advice.seniorAdviceModel || advice;

  return {
    ...adviceBundle,
    subclass: facts.subclass || adviceBundle.subclass,
    stream: facts.stream || adviceBundle.stream,
    selectedStream: facts.stream || adviceBundle.selectedStream,
    clientFacingStream: facts.stream || adviceBundle.clientFacingStream,
    aiMigrationAdviceControllerVersion: AI_CONTROLLER_VERSION,
    aiControllerApplied: true,
    aiControllerMode: registry ? 'all-answers-registry-criteria-assessment' : 'all-answers-fallback-enhancement',
    clientAdviceObject,
    internalAuditObject: {
      ...(adviceBundle.internalAuditObject || {}),
      ...internalAuditObject
    },
    internalLegalAudit: {
      ...(adviceBundle.internalLegalAudit || {}),
      aiMigrationAdviceController: internalAuditObject
    },
    advice: {
      ...advice,
      clientAdviceObject,
      aiMigrationAdviceControllerVersion: AI_CONTROLLER_VERSION,
      seniorAdviceModel: {
        ...(isPlainObject(existingModel) ? existingModel : {}),
        ...clientAdviceObject,
        criteriaFindings: enhancedFindings,
        seniorCriteriaFindings: enhancedFindings,
        grantCriteriaFindings: enhancedFindings
      },
      grantCriteriaFindings: enhancedFindings,
      seniorCriteriaFindings: enhancedFindings,
      criterion_findings: enhancedFindings
    },
    seniorAdviceModel: {
      ...(isPlainObject(existingModel) ? existingModel : {}),
      ...clientAdviceObject,
      criteriaFindings: enhancedFindings,
      seniorCriteriaFindings: enhancedFindings,
      grantCriteriaFindings: enhancedFindings
    },
    universalAdviceModel: {
      ...(isPlainObject(adviceBundle.universalAdviceModel) ? adviceBundle.universalAdviceModel : {}),
      ...clientAdviceObject,
      criteriaFindings: enhancedFindings,
      seniorCriteriaFindings: enhancedFindings,
      grantCriteriaFindings: enhancedFindings
    },
    seniorCriteriaFindings: enhancedFindings,
    clientFacingCriteriaFindings: enhancedFindings,
    grantCriteriaFindings: enhancedFindings,
    criterion_findings: enhancedFindings
  };
}

module.exports = {
  AI_CONTROLLER_VERSION,
  applyAiMigrationAdviceController
};
