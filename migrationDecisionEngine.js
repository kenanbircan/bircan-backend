/**
 * migrationDecisionEngine.js
 * Bircan Migration — 10/10 Enterprise Migration Decision Engine
 * 
 * SINGLE-FILE, DEPENDENCY-FREE, RENDER-SAFE.
 *
 * Upload this file beside server.js.
 *
 * Exports used by server.js:
 *   - runDecisionEngine(assessment)
 *   - buildLegalEngineBundle(decision, assessment)
 *
 * Optional exports:
 *   - validateAdviceBundle(bundle)
 *   - SUPPORTED_SUBCLASSES
 *
 * Design:
 * Form answers + uploaded/evidence metadata
 *   -> normalised facts
 *   -> subclass legal profile
 *   -> evidence verification
 *   -> points/stream/validity checks
 *   -> strict legal outcome
 *   -> GPT-safe advice bundle
 *
 * GPT must only draft wording from this bundle. It must not change legal outcome.
 */

const ENGINE_VERSION = "10.0.0-single-file-enterprise";
const ENGINE_NAME = "Bircan Migration Enterprise Decision Engine";

const STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  UNKNOWN: "UNKNOWN",
  RISK: "RISK"
});

const SEVERITY = Object.freeze({
  BLOCKER: "BLOCKER",
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW"
});

const EFFECT = Object.freeze({
  INVALID: "INVALID_APPLICATION",
  REFUSAL: "REFUSAL_LIKELY",
  DISCRETIONARY: "DISCRETIONARY_RISK",
  EVIDENCE: "EVIDENCE_GAP",
  INFO: "INFORMATIONAL"
});

const SUPPORTED_SUBCLASSES = Object.freeze([
  "101","103","115","116","173",
  "186","187","188","189","190",
  "300","309","407","408","417",
  "444","461","462","482","485",
  "489","491","494","500","590",
  "600","602","785","790","820",
  "836","866","870","888"
]);

/**
 * High-level regulation references.
 * These are deliberately conservative labels. For production, update each legalSource
 * against current legislation / instruments and maintain version/date stamps.
 */
const LEGAL_SOURCES = Object.freeze({
  COMMON_VALIDITY: "Migration Act 1958 and Migration Regulations 1994 - application validity, Schedule 1 and Schedule 2 as applicable",
  HEALTH: "Migration Regulations 1994 - public interest health criteria as applicable",
  CHARACTER: "Migration Act 1958 s501 and Migration Regulations 1994 character/public interest criteria as applicable",
  PIC4020: "Migration Regulations 1994 - Public Interest Criterion 4020 where applicable",
  SKILLED: "Migration Regulations 1994 - points-tested skilled visa criteria, invitation, occupation, skills assessment, points and English requirements as applicable",
  EMPLOYER: "Migration Regulations 1994 - employer sponsored visa sponsorship, nomination and visa criteria as applicable",
  PARTNER: "Migration Regulations 1994 - partner/prospective marriage/family relationship criteria as applicable",
  STUDENT: "Migration Regulations 1994 - student/guardian criteria including enrolment, genuine student/temporary stay and financial capacity as applicable",
  VISITOR: "Migration Regulations 1994 - visitor temporary stay, genuine visitor and financial capacity criteria as applicable",
  PROTECTION: "Migration Act 1958 and Migration Regulations 1994 - protection/refugee/complementary protection criteria as applicable",
  TRAINING_WORKING: "Migration Regulations 1994 - training, temporary activity, working holiday and work stream criteria as applicable",
  FAMILY_PARENT: "Migration Regulations 1994 - family/parent/carer/remaining relative criteria as applicable",
  BUSINESS: "Migration Regulations 1994 - business innovation/investment criteria as applicable"
});

const PROFILE = Object.freeze({
  "189": { group: "skilled", title: "Skilled Independent", extra: ["invitation","skills","occupation","english","points","age"] },
  "190": { group: "skilled", title: "Skilled Nominated", extra: ["invitation","nomination","skills","occupation","english","points","age"] },
  "491": { group: "skilled", title: "Skilled Work Regional", extra: ["invitation","regional_nomination_or_sponsor","skills","occupation","english","points","age"] },
  "489": { group: "skilled", title: "Skilled Regional (legacy)", extra: ["legacy","sponsorship_or_nomination","skills","occupation","points"] },
  "482": { group: "employer", title: "Skills in Demand / Temporary Skill Shortage", extra: ["sponsor","nomination","occupation","genuine_position","salary","experience","english","lmt"] },
  "186": { group: "employer", title: "Employer Nomination Scheme", extra: ["sponsor","nomination","stream","skills_or_trt","occupation","salary","english"] },
  "187": { group: "employer", title: "Regional Sponsored Migration Scheme (legacy)", extra: ["legacy","regional","nomination","stream","occupation"] },
  "494": { group: "employer", title: "Skilled Employer Sponsored Regional", extra: ["regional","sponsor","nomination","occupation","genuine_position","salary","experience","english"] },
  "407": { group: "training_activity", title: "Training visa", extra: ["sponsor","nomination","training_plan","genuine_temporary_stay","english","financial_capacity"] },
  "408": { group: "training_activity", title: "Temporary Activity visa", extra: ["activity","sponsor_or_support","genuine_temporary_stay","financial_capacity"] },
  "417": { group: "working_holiday", title: "Working Holiday", extra: ["eligible_passport","age","previous_visa","funds","health_character"] },
  "462": { group: "working_holiday", title: "Work and Holiday", extra: ["eligible_passport","age","education","english","government_support_if_required","funds"] },
  "485": { group: "graduate", title: "Temporary Graduate", extra: ["age","recent_study","qualification","skills_if_required","english","health_insurance"] },
  "500": { group: "student", title: "Student", extra: ["coe","genuine_student","financial_capacity","english_if_required","oshc"] },
  "590": { group: "student_guardian", title: "Student Guardian", extra: ["student_link","welfare","financial_capacity","genuine_temporary_stay","health_insurance"] },
  "600": { group: "visitor", title: "Visitor", extra: ["genuine_visitor","purpose","funds","incentive_to_return"] },
  "602": { group: "medical", title: "Medical Treatment", extra: ["medical_treatment","financial_capacity","temporary_stay"] },
  "820": { group: "partner", title: "Partner onshore", extra: ["eligible_sponsor","relationship","onshore","schedule3_if_relevant"] },
  "309": { group: "partner", title: "Partner offshore", extra: ["eligible_sponsor","relationship","offshore"] },
  "300": { group: "partner", title: "Prospective Marriage", extra: ["eligible_sponsor","intention_to_marry","met_in_person","relationship"] },
  "101": { group: "family_child", title: "Child visa", extra: ["child_relationship","sponsor","dependency","custody"] },
  "103": { group: "family_parent", title: "Parent visa", extra: ["parent_relationship","sponsor","balance_of_family","assurance_of_support"] },
  "173": { group: "family_parent", title: "Contributory Parent temporary", extra: ["parent_relationship","sponsor","balance_of_family","assurance_of_support"] },
  "870": { group: "family_parent", title: "Sponsored Parent temporary", extra: ["approved_parent_sponsor","parent_relationship","temporary_stay","health_insurance"] },
  "115": { group: "family_other", title: "Remaining Relative", extra: ["remaining_relative","eligible_sponsor","usually_resident_outside_au"] },
  "116": { group: "family_other", title: "Carer", extra: ["carer_need","eligible_sponsor","medical_assessment"] },
  "836": { group: "family_other", title: "Carer onshore", extra: ["carer_need","eligible_sponsor","medical_assessment","onshore"] },
  "461": { group: "family_other", title: "New Zealand Citizen Family Relationship", extra: ["nz_citizen_relationship","eligible_nz_citizen","family_unit"] },
  "444": { group: "nz_special", title: "Special Category visa", extra: ["nz_passport","arrival_clearance","health_character"] },
  "866": { group: "protection", title: "Protection visa", extra: ["onshore","protection_claims","identity","credibility","exclusion"] },
  "785": { group: "protection", title: "Temporary Protection visa", extra: ["protection_claims","identity","temporary_protection_cohort"] },
  "790": { group: "protection", title: "Safe Haven Enterprise visa", extra: ["protection_claims","identity","safe_haven_cohort"] },
  "188": { group: "business", title: "Business Innovation and Investment provisional", extra: ["invitation","nomination","stream","business_assets","turnover","points_if_relevant"] },
  "888": { group: "business", title: "Business Innovation and Investment permanent", extra: ["held_188","nomination","business_residence","investment_or_business_compliance"] }
});

// ---------------------
// Basic utilities
// ---------------------
function str(v) { return v === undefined || v === null ? "" : String(v).trim(); }
function lower(v) { return str(v).toLowerCase(); }
function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const m = str(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function date(v) {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function bool(v) {
  if (typeof v === "boolean") return v;
  const s = lower(v);
  if (!s) return null;
  if (["yes","y","true","1","valid","current","approved","positive","held","met","satisfied","pass","passed","eligible"].includes(s)) return true;
  if (["no","n","false","0","invalid","expired","withdrawn","refused","not held","not met","not satisfied","fail","failed","ineligible"].includes(s)) return false;
  return null;
}
function flatten(obj, prefix = "", out = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
function pick(flat, keys) {
  const entries = Object.entries(flat || {});
  const exact = new Map(entries.map(([k,v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    const v = flat[key];
    if (v !== undefined && v !== null && str(v) !== "") return v;
    const ev = exact.get(String(key).toLowerCase());
    if (ev !== undefined && ev !== null && str(ev) !== "") return ev;
  }
  const cleaned = entries.map(([k,v]) => [k.toLowerCase().replace(/[\s_\-./]/g, ""), v]);
  for (const key of keys) {
    const want = String(key).toLowerCase().replace(/[\s_\-./]/g, "");
    for (const [ck, v] of cleaned) {
      if (ck.includes(want) && v !== undefined && v !== null && str(v) !== "") return v;
    }
  }
  return null;
}
function has(flat, keys) { return pick(flat, keys) !== null; }
function yes(flat, keys) { return bool(pick(flat, keys)) === true; }
function no(flat, keys) { return bool(pick(flat, keys)) === false; }
function unique(arr) { return Array.from(new Set((arr || []).filter(Boolean).map(String))); }
function ageAt(dob, at) {
  const b = date(dob);
  const a = date(at) || new Date();
  if (!b) return null;
  let age = a.getFullYear() - b.getFullYear();
  const m = a.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && a.getDate() < b.getDate())) age -= 1;
  return age;
}
function normaliseAssessment(assessment) {
  const payload = assessment?.form_payload || {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload.formData || payload.data || payload || {};
  const flat = flatten(answers);
  const subclass = str(assessment?.visa_type || pick(flat, ["visaType","visa_type","subclass","visaSubclass"])).replace(/\D/g, "") || "unknown";
  const profile = PROFILE[subclass] || { group: "generic", title: `Subclass ${subclass}`, extra: [] };
  const dob = pick(flat, ["dateOfBirth","dob","birthDate","applicant.dateOfBirth"]);
  const invitationDate = pick(flat, ["invitationDate","skillSelectInvitationDate","eoiInvitationDate"]);
  return {
    assessment, payload, answers, flat, subclass, profile,
    dob, invitationDate,
    age: num(pick(flat, ["age"])) ?? ageAt(dob, invitationDate || new Date()),
    applicantName: str(assessment?.applicant_name || pick(flat, ["applicantName","fullName","name"])),
    evidenceIndex: buildEvidenceIndex(assessment, payload, flat)
  };
}

// ---------------------
// Evidence verification layer
// ---------------------
function buildEvidenceIndex(assessment, payload, flat) {
  const possible = [];
  if (Array.isArray(payload.evidence)) possible.push(...payload.evidence);
  if (Array.isArray(payload.documents)) possible.push(...payload.documents);
  if (Array.isArray(payload.uploads)) possible.push(...payload.uploads);
  if (Array.isArray(assessment?.documents)) possible.push(...assessment.documents);
  if (Array.isArray(assessment?.evidence)) possible.push(...assessment.evidence);

  const docs = possible.map((d, i) => ({
    id: d.id || d.documentId || d.filename || `doc_${i}`,
    type: lower(d.type || d.category || d.label || d.name || d.filename),
    name: str(d.name || d.filename || d.label || d.type || `Document ${i+1}`),
    issueDate: date(d.issueDate || d.issued || d.date),
    expiryDate: date(d.expiryDate || d.expires || d.validUntil),
    verified: bool(d.verified ?? d.isVerified ?? d.accepted),
    raw: d
  }));

  return {
    docs,
    hasDoc(types) {
      const wants = types.map(t => lower(t).replace(/[\s_\-]/g, ""));
      return docs.find(d => wants.some(w => (d.type + " " + lower(d.name)).replace(/[\s_\-]/g, "").includes(w))) || null;
    },
    status(types, answerKeys = []) {
      const doc = this.hasDoc(types);
      const answerYes = answerKeys.length ? yes(flat, answerKeys) : false;
      const answerNo = answerKeys.length ? no(flat, answerKeys) : false;
      const today = new Date();

      if (doc) {
        if (doc.expiryDate && doc.expiryDate < today) return { status: STATUS.FAIL, doc, reason: "document expired" };
        if (doc.verified === false) return { status: STATUS.RISK, doc, reason: "document uploaded but not verified" };
        return { status: STATUS.PASS, doc, reason: "document available" };
      }
      if (answerNo) return { status: STATUS.FAIL, doc: null, reason: "negative questionnaire answer" };
      if (answerYes) return { status: STATUS.UNKNOWN, doc: null, reason: "positive answer but no document verified" };
      return { status: STATUS.UNKNOWN, doc: null, reason: "no verified evidence" };
    }
  };
}

function criterion({ id, criterion, evidenceTypes = [], answerKeys = [], severity, effect, legalSource, missing = [], consequence, recommendation, forceStatus = null, facts = [] }, ctx) {
  const ev = ctx.evidenceIndex.status(evidenceTypes, answerKeys);
  const status = forceStatus || ev.status;
  const considered = [];
  if (ev.doc) considered.push(`Document: ${ev.doc.name}`);
  const ans = pick(ctx.flat, answerKeys);
  if (ans !== null) considered.push(`Questionnaire: ${str(ans)}`);
  considered.push(...facts.filter(Boolean));
  return {
    id,
    criterion,
    status,
    severity,
    legalEffect: effect,
    legalSource,
    evidenceConsidered: unique(considered),
    evidenceMissing: status === STATUS.PASS ? [] : unique(missing),
    evidenceReason: ev.reason,
    finding: findingText(status),
    legalConsequence: consequence || consequenceText(effect),
    evidenceGap: status === STATUS.PASS ? "" : unique(missing).join("; "),
    recommendation: recommendation || recommendationText(status, effect)
  };
}
function findingText(status) {
  if (status === STATUS.PASS) return "Satisfied on the current evidence position, subject to final professional review.";
  if (status === STATUS.FAIL) return "Not satisfied on the current information or evidence.";
  if (status === STATUS.RISK) return "Adverse issue or elevated risk identified.";
  return "Unable to determine because required evidence has not been verified.";
}
function consequenceText(effect) {
  if (effect === EFFECT.INVALID) return "Validity or not-lodgeable issue. The application should not proceed until this is resolved.";
  if (effect === EFFECT.REFUSAL) return "Primary criteria refusal risk if not resolved or evidenced.";
  if (effect === EFFECT.DISCRETIONARY) return "Adverse discretionary, public interest or character/health risk requiring legal review.";
  if (effect === EFFECT.EVIDENCE) return "Evidence gap requiring verification before final advice.";
  return "No adverse consequence identified.";
}
function recommendationText(status, effect) {
  if (status === STATUS.PASS) return "Retain verified evidence on file.";
  if (effect === EFFECT.INVALID) return "Do not lodge until this validity issue is resolved and verified.";
  if (effect === EFFECT.REFUSAL) return "Obtain evidence or address the criterion before lodgement.";
  if (effect === EFFECT.DISCRETIONARY) return "Conduct detailed legal review and prepare submissions if proceeding.";
  return "Request supporting evidence before final advice.";
}

// ---------------------
// Points calculator
// ---------------------
function calculateSkilledPoints(ctx) {
  const f = ctx.flat;
  let points = 0;
  const breakdown = [];

  const add = (factor, pts) => { points += pts; breakdown.push({ factor, points: pts }); };

  const age = ctx.age;
  if (age !== null) {
    if (age >= 18 && age <= 24) add("age", 25);
    else if (age >= 25 && age <= 32) add("age", 30);
    else if (age >= 33 && age <= 39) add("age", 25);
    else if (age >= 40 && age <= 44) add("age", 15);
    else add("age", 0);
  }

  const english = lower(pick(f, ["englishLevel","english","claimedEnglish","englishRequirement"]));
  if (english.includes("superior")) add("English", 20);
  else if (english.includes("proficient")) add("English", 10);
  else add("English", 0);

  const overseas = num(pick(f, ["overseasExperienceYears","overseasWorkExperience","experienceOverseas"]));
  if (overseas !== null) add("overseas skilled employment", overseas >= 8 ? 15 : overseas >= 5 ? 10 : overseas >= 3 ? 5 : 0);

  const aus = num(pick(f, ["australianExperienceYears","australianWorkExperience","experienceAustralia"]));
  if (aus !== null) add("Australian skilled employment", aus >= 8 ? 20 : aus >= 5 ? 15 : aus >= 3 ? 10 : aus >= 1 ? 5 : 0);

  const qual = lower(pick(f, ["qualification","highestQualification","degree"]));
  if (qual.includes("doctor") || qual.includes("phd")) add("qualification", 20);
  else if (qual.includes("bachelor") || qual.includes("master")) add("qualification", 15);
  else if (qual.includes("diploma") || qual.includes("trade")) add("qualification", 10);
  else add("qualification", 0);

  if (yes(f, ["australianStudy","australianStudyRequirement"])) add("Australian study", 5);
  if (yes(f, ["specialistEducation","specialistEducationQualification"])) add("specialist education", 10);
  if (yes(f, ["credentialledCommunityLanguage","naati","communityLanguage"])) add("credentialled community language", 5);
  if (yes(f, ["professionalYear"])) add("professional year", 5);
  if (yes(f, ["regionalStudy"])) add("regional study", 5);
  if (yes(f, ["partnerSkills","skilledPartner"])) add("partner skills", 10);
  if (ctx.subclass === "190") add("state/territory nomination", 5);
  if (ctx.subclass === "491") add("regional nomination/family sponsorship", 15);

  const claimed = num(pick(f, ["claimedPoints","points","totalPoints","eoiPoints"]));
  return { calculated: points, claimed, breakdown };
}

// ---------------------
// Common checks
// ---------------------
function commonChecks(ctx) {
  return [
    criterion({
      id: "HEALTH",
      criterion: "Health requirement",
      evidenceTypes: ["health", "medical"],
      answerKeys: ["healthIssue","medicalIssue","healthConcern","healthMet"],
      severity: SEVERITY.HIGH,
      effect: EFFECT.DISCRETIONARY,
      legalSource: LEGAL_SOURCES.HEALTH,
      missing: ["health examinations", "medical reports if relevant"],
      consequence: "Health issues may affect grant and require further assessment or waiver analysis where available."
    }, ctx),
    criterion({
      id: "CHARACTER",
      criterion: "Character requirement",
      evidenceTypes: ["police", "character", "court"],
      answerKeys: ["characterIssue","criminalHistory","conviction","characterMet"],
      severity: SEVERITY.HIGH,
      effect: EFFECT.DISCRETIONARY,
      legalSource: LEGAL_SOURCES.CHARACTER,
      missing: ["police certificates", "court documents if relevant"],
      consequence: "Character issues may affect grant and must be assessed before any application strategy is recommended."
    }, ctx),
    criterion({
      id: "PIC4020",
      criterion: "Integrity / PIC 4020 risk",
      evidenceTypes: ["prior visa", "department correspondence", "pic4020"],
      answerKeys: ["pic4020","falseDocument","misleadingInformation","integrityIssue"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.PIC4020,
      missing: ["prior visa/application records", "Department correspondence", "documents previously submitted"],
      consequence: "Integrity concerns may create serious visa risk and must be resolved before lodgement action."
    }, ctx)
  ];
}
function onshoreValidity(ctx) {
  const f = ctx.flat;
  const adverse = yes(f, ["section48","section48Bar","noFurtherStay","condition8503","condition8534","condition8535"]);
  const clear = no(f, ["section48","section48Bar","noFurtherStay","condition8503","condition8534","condition8535"]);
  const forceStatus = adverse ? STATUS.FAIL : clear ? STATUS.PASS : null;
  return criterion({
    id: "ONSHORE_VALIDITY",
    criterion: "Section 48 / No Further Stay / onshore validity restrictions",
    evidenceTypes: ["vevo", "visa grant", "waiver", "refusal", "cancellation"],
    answerKeys: ["section48","section48Bar","noFurtherStay","condition8503","condition8534","condition8535"],
    severity: SEVERITY.BLOCKER,
    effect: EFFECT.INVALID,
    legalSource: LEGAL_SOURCES.COMMON_VALIDITY,
    missing: ["current visa grant notice", "VEVO", "refusal/cancellation notices", "waiver decision if relevant"],
    forceStatus,
    consequence: "If an onshore bar or No Further Stay condition applies, lodgement may be invalid unless a lawful pathway or waiver applies."
  }, ctx);
}

// ---------------------
// Engines by group
// ---------------------
function runSkilled(ctx) {
  const points = calculateSkilledPoints(ctx);
  const pointStatus = (points.claimed !== null ? points.claimed >= 65 : points.calculated >= 65) ? STATUS.PASS : STATUS.UNKNOWN;
  const findings = [
    criterion({
      id: "SKILLED_INVITATION",
      criterion: "Valid SkillSelect invitation",
      evidenceTypes: ["invitation", "skillselect"],
      answerKeys: ["invitation","skillSelectInvitation","hasInvitation","invitationReceived","invitationDate","skillSelectInvitationDate"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["SkillSelect invitation letter showing invitation date, nominated occupation and points score"]
    }, ctx),
    criterion({
      id: "SKILLED_SKILLS",
      criterion: "Suitable skills assessment",
      evidenceTypes: ["skills assessment", "assessing authority"],
      answerKeys: ["skillsAssessment","positiveSkillsAssessment","hasSkillsAssessment","skillsAssessmentDate","assessingAuthority"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["skills assessment outcome letter", "assessing authority details", "assessment date and reference number"]
    }, ctx),
    criterion({
      id: "SKILLED_OCCUPATION",
      criterion: "Nominated occupation eligibility",
      evidenceTypes: ["anzsco", "occupation list", "occupation"],
      answerKeys: ["occupation","nominatedOccupation","anzsco"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["ANZSCO/nominated occupation evidence", "occupation list evidence at the relevant time"]
    }, ctx),
    criterion({
      id: "SKILLED_ENGLISH",
      criterion: "English language requirement",
      evidenceTypes: ["english", "ielts", "pte", "passport"],
      answerKeys: ["competentEnglish","englishMet","englishRequirement","englishTest","englishLevel","passportCountry"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["English test result or eligible passport evidence"]
    }, ctx),
    criterion({
      id: "SKILLED_POINTS",
      criterion: "Points test threshold and evidence",
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["full points calculation", "evidence for each points claim"],
      facts: [`engine calculated points scaffold: ${points.calculated}`, points.claimed !== null ? `claimed points: ${points.claimed}` : ""],
      forceStatus: pointStatus,
      consequence: "The points score must meet the applicable pass mark and be supported by evidence."
    }, ctx),
    criterion({
      id: "SKILLED_AGE",
      criterion: "Age requirement at invitation",
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["passport biodata page", "SkillSelect invitation letter"],
      facts: [ctx.age !== null ? `calculated age: ${ctx.age}` : ""],
      forceStatus: ctx.age === null ? STATUS.UNKNOWN : (ctx.age >= 18 && ctx.age < 45 ? STATUS.PASS : STATUS.FAIL)
    }, ctx),
    onshoreValidity(ctx)
  ];

  if (ctx.subclass === "190") {
    findings.push(criterion({
      id: "190_NOMINATION",
      criterion: "Current state or territory nomination",
      evidenceTypes: ["nomination", "state nomination", "territory nomination"],
      answerKeys: ["nomination","stateNomination","territoryNomination","nominationApproved","nominationDate"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["state or territory nomination approval letter", "evidence nomination is current and matches the nominated occupation"]
    }, ctx));
  }
  if (ctx.subclass === "491" || ctx.subclass === "489") {
    findings.push(criterion({
      id: "REGIONAL_NOMINATION_OR_SPONSOR",
      criterion: "Regional nomination or eligible family sponsorship",
      evidenceTypes: ["regional nomination", "family sponsor", "sponsorship"],
      answerKeys: ["regionalNomination","stateNomination","familySponsor","eligibleFamilySponsor","sponsorship"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.SKILLED,
      missing: ["regional nomination approval or eligible family sponsorship evidence"]
    }, ctx));
  }
  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings, { points });
}

function runEmployer(ctx) {
  const f = ctx.flat;
  const stream = lower(pick(f, ["stream","visaStream","applicationStream"]));
  const salary = num(pick(f, ["salary","annualSalary","guaranteedAnnualEarnings","marketSalary"]));
  const exp = num(pick(f, ["workExperienceYears","relevantExperienceYears","experience"]));
  const findings = [
    criterion({
      id: "EMP_SPONSOR",
      criterion: "Approved sponsor / sponsoring employer",
      evidenceTypes: ["sponsor approval", "standard business sponsor", "approved sponsor"],
      answerKeys: ["sponsorApproved","approvedSponsor","standardBusinessSponsor","sponsor"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["sponsor approval evidence", "sponsor details"]
    }, ctx),
    criterion({
      id: "EMP_NOMINATION",
      criterion: "Approved nomination / nominated position",
      evidenceTypes: ["nomination approval", "nomination"],
      answerKeys: ["nominationApproved","approvedNomination","employerNomination","nomination"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["nomination approval", "nomination application details"]
    }, ctx),
    criterion({
      id: "EMP_OCCUPATION",
      criterion: "Occupation eligibility and alignment",
      evidenceTypes: ["anzsco", "occupation", "occupation list"],
      answerKeys: ["occupation","nominatedOccupation","anzsco"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["ANZSCO/nominated occupation", "occupation list or labour agreement authority if relevant"]
    }, ctx),
    criterion({
      id: "EMP_GENUINE_POSITION",
      criterion: "Genuine position",
      evidenceTypes: ["position description", "organisation chart", "genuine position"],
      answerKeys: ["genuinePosition","genuineRole","positionGenuine"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["position description", "organisation chart", "business need evidence", "financial/operational evidence"]
    }, ctx),
    criterion({
      id: "EMP_SALARY",
      criterion: "Salary / market salary / income threshold",
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["salary evidence", "market salary evidence", "employment contract"],
      facts: [salary !== null ? `salary recorded: ${salary}` : ""],
      forceStatus: salary !== null && salary > 0 ? STATUS.PASS : STATUS.UNKNOWN
    }, ctx),
    criterion({
      id: "EMP_EXPERIENCE",
      criterion: "Relevant work experience / skills for role",
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["employment references", "CV", "payslips/tax records", "skills evidence"],
      facts: [exp !== null ? `experience recorded: ${exp} years` : ""],
      forceStatus: exp === null ? STATUS.UNKNOWN : exp >= (ctx.subclass === "482" ? 1 : 2) ? STATUS.PASS : STATUS.FAIL
    }, ctx),
    criterion({
      id: "EMP_ENGLISH",
      criterion: "English language requirement",
      evidenceTypes: ["english", "ielts", "pte", "passport"],
      answerKeys: ["englishMet","englishRequirement","competentEnglish","englishTest","englishLevel"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["English test result or exemption evidence"]
    }, ctx)
  ];

  if (ctx.subclass === "186") {
    findings.push(criterion({
      id: "186_STREAM",
      criterion: "ENS stream selection",
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["TRT / Direct Entry / Labour Agreement stream confirmation"],
      facts: [stream ? `stream: ${stream}` : ""],
      forceStatus: stream ? STATUS.PASS : STATUS.UNKNOWN
    }, ctx));
    if (stream.includes("direct")) {
      findings.push(criterion({
        id: "186_DIRECT_ENTRY_SKILLS",
        criterion: "Direct Entry skills assessment / experience",
        evidenceTypes: ["skills assessment", "employment reference"],
        answerKeys: ["skillsAssessment","positiveSkillsAssessment","workExperienceYears"],
        severity: SEVERITY.CRITICAL,
        effect: EFFECT.REFUSAL,
        legalSource: LEGAL_SOURCES.EMPLOYER,
        missing: ["skills assessment if required", "three years experience evidence unless exempt"]
      }, ctx));
    }
    if (stream.includes("trt") || stream.includes("temporary")) {
      findings.push(criterion({
        id: "186_TRT_EMPLOYMENT",
        criterion: "TRT qualifying employment",
        severity: SEVERITY.CRITICAL,
        effect: EFFECT.REFUSAL,
        legalSource: LEGAL_SOURCES.EMPLOYER,
        missing: ["temporary skilled visa history", "employment period evidence", "same employer/occupation evidence"],
        facts: [exp !== null ? `experience recorded: ${exp} years` : ""],
        forceStatus: exp === null ? STATUS.UNKNOWN : exp >= 2 ? STATUS.PASS : STATUS.FAIL
      }, ctx));
    }
  }

  if (ctx.subclass === "187") {
    findings.push(criterion({
      id: "187_LEGACY",
      criterion: "RSMS legacy / transitional eligibility",
      evidenceTypes: ["legacy", "transitional", "regional"],
      answerKeys: ["legacy","transitional","regionalEmployer","187Eligibility"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["legacy/transitional eligibility evidence", "prior visa history", "regional nomination evidence"]
    }, ctx));
  }

  if (ctx.subclass === "494") {
    findings.push(criterion({
      id: "494_REGIONAL",
      criterion: "Regional employer and designated regional position",
      evidenceTypes: ["regional", "regional employer"],
      answerKeys: ["regional","regionalEmployer","designatedRegionalArea"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["regional location evidence", "employer location evidence"]
    }, ctx));
  }

  if (ctx.subclass === "482") {
    findings.push(criterion({
      id: "482_LMT",
      criterion: "Labour market testing or exemption",
      evidenceTypes: ["labour market testing", "lmt", "advertising"],
      answerKeys: ["labourMarketTesting","lmt","advertisingCompleted","lmtExemption"],
      severity: SEVERITY.HIGH,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.EMPLOYER,
      missing: ["LMT advertisements", "exemption basis if relied on"]
    }, ctx));
  }

  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings, { stream });
}

function runPartnerFamily(ctx) {
  const isPartner = ["820","309","300"].includes(ctx.subclass);
  const isParent = ["103","173","870"].includes(ctx.subclass);
  const isChild = ctx.subclass === "101";
  const findings = [];

  if (isPartner) {
    findings.push(criterion({
      id: "PARTNER_RELATIONSHIP",
      criterion: ctx.subclass === "300" ? "Genuine intention to marry / relationship history" : "Genuine spouse or de facto relationship",
      evidenceTypes: ["relationship", "marriage", "de facto", "statement"],
      answerKeys: ["genuineRelationship","relationshipEvidence","spouse","deFacto","partnerRelationship","intentionToMarry","weddingDate"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.PARTNER,
      missing: ["relationship statements", "financial evidence", "social evidence", "household evidence", "commitment evidence"]
    }, ctx));
    findings.push(criterion({
      id: "PARTNER_SPONSOR",
      criterion: "Eligible sponsor",
      evidenceTypes: ["sponsor", "citizenship", "permanent residence"],
      answerKeys: ["sponsorEligible","australianSponsor","sponsorCitizenPR","eligibleSponsor"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.PARTNER,
      missing: ["sponsor citizenship/permanent residence evidence", "sponsor limitation checks"]
    }, ctx));
  }

  if (isParent) {
    findings.push(criterion({
      id: "PARENT_RELATIONSHIP",
      criterion: "Parent relationship and sponsorship",
      evidenceTypes: ["birth certificate", "parent", "sponsor"],
      answerKeys: ["parentRelationship","sponsorEligible","approvedParentSponsor"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.FAMILY_PARENT,
      missing: ["birth certificates", "sponsor evidence", "parent-child relationship evidence"]
    }, ctx));
    findings.push(criterion({
      id: "BALANCE_OF_FAMILY",
      criterion: "Balance of family / family composition requirement where applicable",
      evidenceTypes: ["family composition", "balance of family"],
      answerKeys: ["balanceOfFamily","familyComposition"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.FAMILY_PARENT,
      missing: ["family composition evidence", "children residence/citizenship evidence"]
    }, ctx));
  }

  if (isChild) {
    findings.push(criterion({
      id: "CHILD_RELATIONSHIP",
      criterion: "Child relationship, dependency and custody",
      evidenceTypes: ["birth certificate", "custody", "dependency"],
      answerKeys: ["childRelationship","dependency","custody"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.FAMILY_PARENT,
      missing: ["birth certificate", "custody evidence", "dependency evidence"]
    }, ctx));
  }

  if (["115","116","836","461"].includes(ctx.subclass)) {
    findings.push(criterion({
      id: "FAMILY_SPECIFIC",
      criterion: "Subclass-specific family relationship criterion",
      evidenceTypes: ["relationship", "medical", "care", "nz citizen"],
      answerKeys: ["relationshipEvidence","carerNeed","remainingRelative","eligibleSponsor","nzCitizenRelationship"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.FAMILY_PARENT,
      missing: ["subclass-specific family relationship evidence", "sponsor eligibility evidence"]
    }, ctx));
  }

  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings);
}

function runTemporaryStudentVisitor(ctx) {
  const group = ctx.profile.group;
  const isStudent = ["500","590"].includes(ctx.subclass);
  const findings = [
    criterion({
      id: "GENUINE_TEMPORARY_STAY",
      criterion: isStudent ? "Genuine student / genuine temporary stay" : "Genuine temporary stay / genuine visitor",
      evidenceTypes: ["statement", "genuine", "purpose"],
      answerKeys: ["genuineTemporaryEntrant","genuineStudent","genuineVisitor","genuineStay","purpose"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: isStudent ? LEGAL_SOURCES.STUDENT : LEGAL_SOURCES.VISITOR,
      missing: ["statement of purpose", "home ties evidence", "immigration history", "travel/study rationale"]
    }, ctx),
    criterion({
      id: "FINANCIAL_CAPACITY",
      criterion: "Financial capacity",
      evidenceTypes: ["bank", "financial", "income", "funds"],
      answerKeys: ["financialCapacity","funds","sufficientFunds","bankBalance","income"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: isStudent ? LEGAL_SOURCES.STUDENT : LEGAL_SOURCES.VISITOR,
      missing: ["bank statements", "income evidence", "sponsor support evidence"]
    }, ctx)
  ];

  if (ctx.subclass === "500") {
    findings.push(criterion({
      id: "500_COE",
      criterion: "Confirmation of Enrolment",
      evidenceTypes: ["coe", "confirmation of enrolment"],
      answerKeys: ["coe","confirmationOfEnrolment","course"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.STUDENT,
      missing: ["Confirmation of Enrolment"]
    }, ctx));
  }

  if (["407","408","417","462","485","602"].includes(ctx.subclass)) {
    findings.push(criterion({
      id: "TEMP_ACTIVITY_SPECIFIC",
      criterion: "Subclass-specific temporary activity/work/graduate/medical criterion",
      evidenceTypes: ["activity", "training", "passport", "education", "medical", "qualification"],
      answerKeys: ["activity","trainingPlan","eligiblePassport","education","medicalTreatment","qualification","recentStudy"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.TRAINING_WORKING,
      missing: ["subclass-specific eligibility evidence"]
    }, ctx));
  }

  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings);
}

function runProtection(ctx) {
  const findings = [
    criterion({
      id: "PROTECTION_ONSHORE_OR_COHORT",
      criterion: "Protection pathway location/cohort eligibility",
      evidenceTypes: ["visa status", "arrival", "immigration status"],
      answerKeys: ["inAustralia","onshore","temporaryProtectionCohort","safeHavenCohort"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.PROTECTION,
      missing: ["current location/status evidence", "arrival and visa history evidence"]
    }, ctx),
    criterion({
      id: "PROTECTION_CLAIMS",
      criterion: "Protection claims / fear of harm",
      evidenceTypes: ["protection claim", "country information", "statement"],
      answerKeys: ["protectionClaim","fearOfHarm","refugeeClaim","complementaryProtection","persecution"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.PROTECTION,
      missing: ["detailed protection statement", "country information", "harm/threat evidence"]
    }, ctx),
    criterion({
      id: "PROTECTION_IDENTITY",
      criterion: "Identity, nationality and credibility",
      evidenceTypes: ["passport", "identity", "birth certificate", "national id"],
      answerKeys: ["passport","identityDocument","nationalId","birthCertificate"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.PROTECTION,
      missing: ["passport", "identity documents", "explanation for missing identity evidence"]
    }, ctx)
  ];
  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings);
}

function runBusiness(ctx) {
  const findings = [
    criterion({
      id: "BUSINESS_NOMINATION_INVITATION",
      criterion: "Nomination / invitation / stream eligibility",
      evidenceTypes: ["invitation", "nomination", "state nomination"],
      answerKeys: ["invitation","nomination","stateNomination","stream"],
      severity: SEVERITY.BLOCKER,
      effect: EFFECT.INVALID,
      legalSource: LEGAL_SOURCES.BUSINESS,
      missing: ["invitation/nomination evidence", "stream confirmation"]
    }, ctx),
    criterion({
      id: "BUSINESS_ASSETS_COMPLIANCE",
      criterion: "Business/investment assets, turnover or compliance",
      evidenceTypes: ["business", "investment", "assets", "turnover", "financial"],
      answerKeys: ["businessAssets","investment","turnover","businessCompliance","held188"],
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.REFUSAL,
      legalSource: LEGAL_SOURCES.BUSINESS,
      missing: ["business financial evidence", "investment evidence", "ownership/management evidence"]
    }, ctx)
  ];
  findings.push(...commonChecks(ctx));
  return finalise(ctx, findings);
}

function runGeneric(ctx) {
  const findings = [
    criterion({
      id: "GENERIC_SUBCLASS_CRITERIA",
      criterion: `Subclass ${ctx.subclass} grant criteria`,
      severity: SEVERITY.CRITICAL,
      effect: EFFECT.EVIDENCE,
      legalSource: LEGAL_SOURCES.COMMON_VALIDITY,
      missing: ["subclass-specific knowledgebase criteria and evidence"],
      forceStatus: STATUS.UNKNOWN,
      consequence: "The engine does not have enough subclass-specific criteria to safely produce a final automated assessment."
    }, ctx)
  ];
  return finalise(ctx, findings);
}

// ---------------------
// Outcome, bundle and validation
// ---------------------
function classify(findings) {
  const blockerFail = findings.find(f => f.severity === SEVERITY.BLOCKER && f.status === STATUS.FAIL);
  const blockerUnknown = findings.find(f => f.severity === SEVERITY.BLOCKER && f.status === STATUS.UNKNOWN);
  const criticalFail = findings.find(f => f.severity === SEVERITY.CRITICAL && f.status === STATUS.FAIL);
  const risk = findings.find(f => f.status === STATUS.RISK);
  const unknown = findings.find(f => f.status === STATUS.UNKNOWN);

  if (blockerFail) return { decisionStatus: "INVALID_OR_NOT_LODGEABLE", lodgementPosition: "NOT_LODGEABLE", riskLevel: "CRITICAL", legalStatus: EFFECT.INVALID, primaryReason: blockerFail.criterion };
  if (blockerUnknown) return { decisionStatus: "VALIDITY_NOT_CONFIRMED", lodgementPosition: "NOT_LODGEABLE_PENDING_EVIDENCE", riskLevel: "CRITICAL", legalStatus: EFFECT.INVALID, primaryReason: blockerUnknown.criterion };
  if (criticalFail) return { decisionStatus: "PRIMARY_CRITERIA_NOT_MET", lodgementPosition: "LODGEABLE_HIGH_RISK", riskLevel: "HIGH", legalStatus: EFFECT.REFUSAL, primaryReason: criticalFail.criterion };
  if (risk) return { decisionStatus: "ADVERSE_RISK_IDENTIFIED", lodgementPosition: "LEGAL_REVIEW_REQUIRED", riskLevel: "HIGH", legalStatus: risk.legalEffect || EFFECT.DISCRETIONARY, primaryReason: risk.criterion };
  if (unknown) return { decisionStatus: "EVIDENCE_REQUIRED", lodgementPosition: "EVIDENCE_REQUIRED_BEFORE_LODGEMENT", riskLevel: "MEDIUM", legalStatus: EFFECT.EVIDENCE, primaryReason: unknown.criterion };
  return { decisionStatus: "POTENTIALLY_LODGEABLE", lodgementPosition: "POTENTIALLY_LODGEABLE", riskLevel: "LOW", legalStatus: "LIKELY_ELIGIBLE_SUBJECT_TO_REVIEW", primaryReason: "No blocker detected" };
}
function finalise(ctx, findings, extras = {}) {
  const outcome = classify(findings);
  const evidenceRequired = unique(findings.flatMap(f => f.evidenceMissing || []));
  const blockers = findings.filter(f => f.severity === SEVERITY.BLOCKER && f.status !== STATUS.PASS);
  const critical = findings.filter(f => f.severity === SEVERITY.CRITICAL && f.status !== STATUS.PASS);
  return {
    engine: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    subclass: ctx.subclass,
    subclassTitle: ctx.profile.title,
    group: ctx.profile.group,
    applicantName: ctx.applicantName,
    ...outcome,
    findings,
    blockers,
    criticalFindings: critical,
    evidenceRequired,
    nextSteps: buildNextSteps(outcome, evidenceRequired),
    qualityFlags: buildQualityFlags(ctx, findings),
    extras
  };
}
function buildNextSteps(outcome, evidenceRequired) {
  const steps = [];
  if (outcome.lodgementPosition.includes("NOT_LODGEABLE")) steps.push("Do not proceed to lodgement until all validity blockers are resolved and verified.");
  if (outcome.riskLevel === "HIGH" || outcome.riskLevel === "CRITICAL") steps.push("Conduct registered migration agent legal review before any application action.");
  if (evidenceRequired.length) steps.push("Collect, verify and retain the listed evidence before final advice.");
  steps.push("Regenerate the advice only after the evidence position changes.");
  return unique(steps);
}
function buildQualityFlags(ctx, findings) {
  const flags = [];
  if (!SUPPORTED_SUBCLASSES.includes(ctx.subclass)) flags.push("Subclass is not in the current engine support list.");
  if (findings.some(f => f.status === STATUS.UNKNOWN)) flags.push("One or more criteria are undetermined due to missing verified evidence.");
  if (findings.some(f => f.status === STATUS.RISK)) flags.push("One or more adverse risk issues require legal review.");
  if (findings.some(f => f.severity === SEVERITY.BLOCKER && f.status !== STATUS.PASS)) flags.push("Validity or not-lodgeable issue detected.");
  if (findings.some(f => !f.legalSource)) flags.push("One or more findings require legal source mapping.");
  return unique(flags);
}
function nice(v) { return str(v).replace(/_/g, " "); }

function runDecisionEngine(assessment) {
  const ctx = normaliseAssessment(assessment || {});
  const group = ctx.profile.group;
  if (["skilled"].includes(group)) return runSkilled(ctx);
  if (["employer"].includes(group)) return runEmployer(ctx);
  if (["partner","family_child","family_parent","family_other","nz_special"].includes(group)) return runPartnerFamily(ctx);
  if (["student","student_guardian","visitor","medical","training_activity","working_holiday","graduate"].includes(group)) return runTemporaryStudentVisitor(ctx);
  if (["protection"].includes(group)) return runProtection(ctx);
  if (["business"].includes(group)) return runBusiness(ctx);
  return runGeneric(ctx);
}

function buildLegalEngineBundle(decision, assessment) {
  const summary = [
    `The ${decision.engine} assessed Subclass ${decision.subclass} (${decision.subclassTitle}) as ${decision.decisionStatus}.`,
    `Risk level: ${decision.riskLevel}.`,
    `Lodgement position: ${nice(decision.lodgementPosition)}.`,
    `Legal classification: ${nice(decision.legalStatus)}.`,
    `Primary reason: ${decision.primaryReason}.`
  ].join(" ");

  const bundle = {
    source: "enterprise_10_10_migration_decision_engine",
    engineVersion: decision.engineVersion,
    title: `Subclass ${decision.subclass} preliminary migration advice`,
    subclass: decision.subclass,
    subclassTitle: decision.subclassTitle,
    riskLevel: decision.riskLevel,
    lodgementPosition: nice(decision.lodgementPosition),
    legalStatus: decision.legalStatus,
    decisionStatus: decision.decisionStatus,
    primaryReason: decision.primaryReason,
    summary,
    executiveSummary: summary,
    applicationValidity: {
      result: nice(decision.lodgementPosition),
      legalStatus: decision.legalStatus,
      blockers: (decision.blockers || []).map(f => f.criterion)
    },
    criterionFindings: (decision.findings || []).map(f => ({
      criterion: f.criterion,
      status: f.status,
      finding: f.finding,
      evidenceConsidered: (f.evidenceConsidered || []).join("; "),
      legalConsequence: f.legalConsequence,
      evidenceGap: f.evidenceGap,
      recommendation: f.recommendation,
      legalEffect: f.legalEffect,
      severity: f.severity,
      legalSource: f.legalSource,
      evidenceReason: f.evidenceReason
    })),
    evidenceRequired: decision.evidenceRequired || [],
    nextSteps: decision.nextSteps || [],
    qualityFlags: decision.qualityFlags || [],
    gptBoundary: {
      role: "drafting_only",
      cannotChange: ["riskLevel","lodgementPosition","legalStatus","decisionStatus","criterionFindings","evidenceRequired"],
      instruction: "GPT may only improve wording. It must not invent evidence, upgrade prospects, remove blockers, or change legal classification."
    },
    autoIssueAllowed: isAutoIssueAllowed(decision),
    manualReviewRequired: !isAutoIssueAllowed(decision),
    rawDecision: decision
  };

  bundle.validation = validateAdviceBundle(bundle);
  return bundle;
}

function isAutoIssueAllowed(decision) {
  if (!decision) return false;
  if (decision.riskLevel !== "LOW") return false;
  if (decision.lodgementPosition !== "POTENTIALLY_LODGEABLE") return false;
  if ((decision.qualityFlags || []).length) return false;
  if ((decision.findings || []).some(f => f.status !== STATUS.PASS)) return false;
  return true;
}

function validateAdviceBundle(bundle) {
  const errors = [];
  if (!bundle) errors.push("Missing bundle.");
  if (!bundle?.riskLevel) errors.push("Missing riskLevel.");
  if (!bundle?.lodgementPosition) errors.push("Missing lodgementPosition.");
  if (!bundle?.legalStatus) errors.push("Missing legalStatus.");
  if (!Array.isArray(bundle?.criterionFindings) || !bundle.criterionFindings.length) errors.push("Missing criterionFindings.");
  if ((bundle?.criterionFindings || []).some(f => !f.criterion || !f.status || !f.legalConsequence)) errors.push("One or more findings are incomplete.");
  if ((bundle?.criterionFindings || []).some(f => !f.legalSource)) errors.push("One or more findings are missing legalSource mapping.");
  return { ok: errors.length === 0, errors };
}

module.exports = {
  runDecisionEngine,
  buildLegalEngineBundle,
  validateAdviceBundle,
  SUPPORTED_SUBCLASSES,
  ENGINE_VERSION
};
