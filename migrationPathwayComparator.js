'use strict';

/**
 * migrationPathwayComparator.js
 * Bircan Migration — Full Subclass-Aware Comparator V2
 *
 * Production-grade strategy comparator:
 * - Classifies the matter into the correct pathway group before comparing.
 * - Compares relevant active subclasses only.
 * - Handles closed/legacy subclasses such as 187 safely.
 * - Produces PDF-ready and dashboard-ready strategy outputs.
 * - Does not override the legal decision engine, PDF engine or RMA review.
 */

const COMPARATOR_VERSION = '2.0.0-full-subclass-aware-production';

const AVAILABILITY = Object.freeze({
  ACTIVE: 'ACTIVE',
  LEGACY: 'LEGACY_ONLY',
  CLOSED: 'CLOSED_TO_NEW_APPLICATIONS'
});

const PATHWAY_GROUPS = Object.freeze({
  employerSponsored: {
    label: 'Employer-sponsored pathways',
    active: ['482', '186', '494'],
    legacy: ['187'],
    description: 'Employer-sponsored options where a sponsoring employer, nomination and position-related evidence are central.'
  },
  skilled: {
    label: 'Skilled migration pathways',
    active: ['189', '190', '491'],
    legacy: ['489'],
    description: 'Points-tested skilled options where age, English, skills assessment, invitation and points evidence are central.'
  },
  partner: {
    label: 'Partner and prospective marriage pathways',
    active: ['300', '309', '820'],
    legacy: [],
    description: 'Relationship-based pathways requiring genuine relationship and sponsor eligibility evidence.'
  },
  studentVisitor: {
    label: 'Student, guardian and visitor pathways',
    active: ['500', '590', '600', '602'],
    legacy: [],
    description: 'Temporary stay pathways requiring purpose, genuine temporary stay/student criteria and financial evidence.'
  },
  trainingActivityGraduate: {
    label: 'Training, activity, holiday and graduate pathways',
    active: ['407', '408', '417', '462', '485'],
    legacy: [],
    description: 'Temporary training, activity, working holiday and graduate options.'
  },
  family: {
    label: 'Family pathways',
    active: ['101', '103', '115', '116', '173', '461', '836', '870'],
    legacy: [],
    description: 'Family relationship, parent, carer, remaining relative and NZ family relationship options.'
  },
  protection: {
    label: 'Protection pathways',
    active: ['866', '785', '790'],
    legacy: [],
    description: 'Protection/refugee/complementary protection pathways requiring careful legal assessment.'
  },
  business: {
    label: 'Business and investment pathways',
    active: ['188', '888'],
    legacy: [],
    description: 'Business innovation, investment and permanent business pathways.'
  }
});

const PATHWAYS = Object.freeze({
  '482': { group: 'employerSponsored', availability: AVAILABILITY.ACTIVE, shortName: '482 Employer Sponsored', name: 'Subclass 482 Skills in Demand / Temporary Skill Shortage', required: ['sponsor','nomination','occupation','experience'], useful: ['english','salary','genuinePosition','lmt'] },
  '186': { group: 'employerSponsored', availability: AVAILABILITY.ACTIVE, shortName: '186 Employer Nomination', name: 'Subclass 186 Employer Nomination Scheme', required: ['sponsor','nomination','occupation','english','experience'], useful: ['salary','skillsAssessment','stream'] },
  '494': { group: 'employerSponsored', availability: AVAILABILITY.ACTIVE, shortName: '494 Regional Employer Sponsored', name: 'Subclass 494 Skilled Employer Sponsored Regional', required: ['sponsor','nomination','occupation','experience','regional'], useful: ['english','salary','genuinePosition'] },
  '187': { group: 'employerSponsored', availability: AVAILABILITY.CLOSED, shortName: '187 RSMS legacy', name: 'Subclass 187 Regional Sponsored Migration Scheme', required: ['legacy187'], useful: [], closedMessage: 'Subclass 187 is closed to new applications. Consider 494 or 186 where appropriate.' },

  '189': { group: 'skilled', availability: AVAILABILITY.ACTIVE, shortName: '189 Skilled Independent', name: 'Subclass 189 Skilled Independent', required: ['ageUnder45','english','skillsAssessment','points65','invitation'], useful: ['occupation','onshoreValidity'] },
  '190': { group: 'skilled', availability: AVAILABILITY.ACTIVE, shortName: '190 State Nominated', name: 'Subclass 190 Skilled Nominated', required: ['ageUnder45','english','skillsAssessment','points65','stateNomination','invitation'], useful: ['occupation','onshoreValidity'] },
  '491': { group: 'skilled', availability: AVAILABILITY.ACTIVE, shortName: '491 Regional Skilled', name: 'Subclass 491 Skilled Work Regional', required: ['ageUnder45','english','skillsAssessment','points65','regionalNominationOrSponsor','invitation'], useful: ['occupation','regionalCommitment','onshoreValidity'] },
  '489': { group: 'skilled', availability: AVAILABILITY.LEGACY, shortName: '489 Skilled Regional legacy', name: 'Subclass 489 Skilled Regional', required: ['legacy489'], useful: [], closedMessage: 'Subclass 489 is a legacy pathway. Consider 491 where appropriate.' },

  '300': { group: 'partner', availability: AVAILABILITY.ACTIVE, shortName: '300 Prospective Marriage', name: 'Subclass 300 Prospective Marriage', required: ['eligibleSponsor','relationship','intentionToMarry','metInPerson'], useful: ['identity','character'] },
  '309': { group: 'partner', availability: AVAILABILITY.ACTIVE, shortName: '309 Partner Offshore', name: 'Subclass 309 Partner', required: ['eligibleSponsor','relationship','offshore'], useful: ['identity','character'] },
  '820': { group: 'partner', availability: AVAILABILITY.ACTIVE, shortName: '820 Partner Onshore', name: 'Subclass 820 Partner', required: ['eligibleSponsor','relationship','onshore'], useful: ['schedule3','identity','character'] },

  '500': { group: 'studentVisitor', availability: AVAILABILITY.ACTIVE, shortName: '500 Student', name: 'Subclass 500 Student', required: ['coe','genuineStudent','financialCapacity','oshc'], useful: ['english','priorStudy'] },
  '590': { group: 'studentVisitor', availability: AVAILABILITY.ACTIVE, shortName: '590 Student Guardian', name: 'Subclass 590 Student Guardian', required: ['studentLink','welfare','financialCapacity','temporaryStay'], useful: ['healthInsurance'] },
  '600': { group: 'studentVisitor', availability: AVAILABILITY.ACTIVE, shortName: '600 Visitor', name: 'Subclass 600 Visitor', required: ['genuineVisitor','purpose','financialCapacity','incentiveToReturn'], useful: ['travelHistory'] },
  '602': { group: 'studentVisitor', availability: AVAILABILITY.ACTIVE, shortName: '602 Medical Treatment', name: 'Subclass 602 Medical Treatment', required: ['medicalTreatment','financialCapacity','temporaryStay'], useful: ['treatmentPlan'] },

  '407': { group: 'trainingActivityGraduate', availability: AVAILABILITY.ACTIVE, shortName: '407 Training', name: 'Subclass 407 Training', required: ['sponsor','nomination','trainingPlan','temporaryStay'], useful: ['english','financialCapacity'] },
  '408': { group: 'trainingActivityGraduate', availability: AVAILABILITY.ACTIVE, shortName: '408 Temporary Activity', name: 'Subclass 408 Temporary Activity', required: ['activity','sponsorOrSupport','temporaryStay'], useful: ['financialCapacity'] },
  '417': { group: 'trainingActivityGraduate', availability: AVAILABILITY.ACTIVE, shortName: '417 Working Holiday', name: 'Subclass 417 Working Holiday', required: ['eligiblePassport','ageHoliday','funds'], useful: ['previousHolidayVisa'] },
  '462': { group: 'trainingActivityGraduate', availability: AVAILABILITY.ACTIVE, shortName: '462 Work and Holiday', name: 'Subclass 462 Work and Holiday', required: ['eligiblePassport','ageHoliday','education','english','funds'], useful: ['governmentSupport'] },
  '485': { group: 'trainingActivityGraduate', availability: AVAILABILITY.ACTIVE, shortName: '485 Temporary Graduate', name: 'Subclass 485 Temporary Graduate', required: ['ageGraduate','recentStudy','qualification','english'], useful: ['healthInsurance','skillsAssessment'] },

  '101': { group: 'family', availability: AVAILABILITY.ACTIVE, shortName: '101 Child', name: 'Subclass 101 Child', required: ['childRelationship','sponsor','dependency'], useful: ['custody'] },
  '103': { group: 'family', availability: AVAILABILITY.ACTIVE, shortName: '103 Parent', name: 'Subclass 103 Parent', required: ['parentRelationship','sponsor','balanceOfFamily'], useful: ['assuranceOfSupport'] },
  '173': { group: 'family', availability: AVAILABILITY.ACTIVE, shortName: '173 Contributory Parent temporary', name: 'Subclass 173 Contributory Parent temporary', required: ['parentRelationship','sponsor','balanceOfFamily'], useful: ['assuranceOfSupport'] },
  '870': { group: 'family', availability: AVAILABILITY.ACTIVE, shortName: '870 Sponsored Parent temporary', name: 'Subclass 870 Sponsored Parent temporary', required: ['approvedParentSponsor','parentRelationship','temporaryStay'], useful: ['healthInsurance'] },
  '115': { group: 'family', availability: AVAILABILITY.ACTIVE, shortName: '115 Remaining Relative', name: 'Subclass 115 Remaining Relative', required: ['remainingRelative','sponsor','outsideAustralia'], useful: [] },
  '116': { group: 'family', availability: AVAILABILITY.ACTIVE, shortName: '116 Carer', name: 'Subclass 116 Carer', required: ['carerNeed','sponsor','medicalAssessment'], useful: [] },
  '836': { group: 'family', availability: AVAILABILITY.ACTIVE, shortName: '836 Carer Onshore', name: 'Subclass 836 Carer', required: ['carerNeed','sponsor','medicalAssessment','onshore'], useful: [] },
  '461': { group: 'family', availability: AVAILABILITY.ACTIVE, shortName: '461 NZ family relationship', name: 'Subclass 461 New Zealand Citizen Family Relationship', required: ['nzCitizenRelationship','eligibleNzCitizen','familyUnit'], useful: [] },

  '866': { group: 'protection', availability: AVAILABILITY.ACTIVE, shortName: '866 Protection', name: 'Subclass 866 Protection', required: ['onshore','protectionClaims','identity'], useful: ['credibility','countryInformation'] },
  '785': { group: 'protection', availability: AVAILABILITY.ACTIVE, shortName: '785 Temporary Protection', name: 'Subclass 785 Temporary Protection', required: ['protectionClaims','identity','temporaryProtectionCohort'], useful: [] },
  '790': { group: 'protection', availability: AVAILABILITY.ACTIVE, shortName: '790 Safe Haven Enterprise', name: 'Subclass 790 Safe Haven Enterprise', required: ['protectionClaims','identity','safeHavenCohort'], useful: [] },

  '188': { group: 'business', availability: AVAILABILITY.ACTIVE, shortName: '188 Business Innovation provisional', name: 'Subclass 188 Business Innovation and Investment', required: ['invitation','stateNomination','stream','businessAssets'], useful: ['turnover','points65'] },
  '888': { group: 'business', availability: AVAILABILITY.ACTIVE, shortName: '888 Business Innovation permanent', name: 'Subclass 888 Business Innovation and Investment permanent', required: ['held188','stateNomination','businessCompliance'], useful: ['residence'] }
});

function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function lower(v) { return str(v).toLowerCase(); }
function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function uniq(values) { return Array.from(new Set((values || []).flat().filter(Boolean).map(v => String(v).trim()).filter(Boolean))); }
function flatten(input, prefix = '', out = {}) {
  if (!isPlainObject(input)) return out;
  for (const [k, v] of Object.entries(input)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
function pick(flat, keys) {
  const entries = Object.entries(flat || {});
  const cleaned = entries.map(([k, v]) => [String(k).toLowerCase().replace(/[^a-z0-9]/g, ''), v]);
  for (const key of keys) {
    const want = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [ck, v] of cleaned) {
      if ((ck === want || ck.includes(want)) && v !== undefined && v !== null && str(v) !== '') return v;
    }
  }
  return null;
}
function bool(v) {
  if (typeof v === 'boolean') return v;
  const s = lower(v);
  if (!s) return null;
  if (['yes','y','true','1','valid','current','approved','positive','held','met','satisfied','pass','passed','eligible','available','completed','lodged'].includes(s)) return true;
  if (['no','n','false','0','invalid','expired','withdrawn','refused','not held','not met','not satisfied','fail','failed','ineligible','unavailable','missing'].includes(s)) return false;
  if (/\b(no|not|none|unknown|unsure|refused|expired|invalid|cannot|unable|missing)\b/i.test(s)) return false;
  return null;
}
function num(v) { const m = str(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; }
function date(v) { const d = new Date(str(v)); return Number.isNaN(d.getTime()) ? null : d; }
function ageAt(dob, eventDate = new Date()) {
  const b = date(dob); const a = date(eventDate) || new Date();
  if (!b) return null;
  let age = a.getFullYear() - b.getFullYear();
  const m = a.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && a.getDate() < b.getDate())) age -= 1;
  return age;
}

const SIGNAL_KEYS = Object.freeze({
  sponsor: ['sponsorApproved','approvedSponsor','standardBusinessSponsor','employerSponsor','sponsor','eligibleSponsor'],
  nomination: ['nominationApproved','approvedNomination','employerNomination','nomination'],
  occupation: ['occupation','nominatedOccupation','anzsco','occupationEligible'],
  experience: ['workExperienceYears','relevantExperienceYears','experience','yearsExperience'],
  english: ['englishMet','competentEnglish','englishRequirement','englishTest','englishLevel'],
  salary: ['salary','annualSalary','guaranteedAnnualEarnings','marketSalary'],
  genuinePosition: ['genuinePosition','genuineRole','positionGenuine'],
  lmt: ['labourMarketTesting','lmt','advertisingCompleted','lmtExemption'],
  regional: ['regional','regionalEmployer','designatedRegionalArea'],
  stream: ['stream','visaStream','applicationStream'],
  age: ['age'],
  dob: ['dateOfBirth','dob','birthDate'],
  invitationDate: ['invitationDate','skillSelectInvitationDate','invitedDate'],
  skillsAssessment: ['skillsAssessment','positiveSkillsAssessment','hasSkillsAssessment'],
  points: ['points','claimedPoints','totalPoints','eoiPoints','pointsScore'],
  stateNomination: ['stateNomination','territoryNomination','stateNominationApproved','nominationApproved'],
  regionalNominationOrSponsor: ['regionalNomination','regionalSponsor','familySponsor','eligibleFamilySponsor','regionalSponsorship'],
  invitation: ['invitation','hasInvitation','skillSelectInvitation','invitationReceived'],
  onshore: ['onshore','inAustralia','currentlyInAustralia'],
  offshore: ['offshore','outsideAustralia','currentlyOutsideAustralia'],
  onshoreValidity: ['section48','section48Bar','noFurtherStay','condition8503','condition8534','condition8535'],
  relationship: ['relationship','genuineRelationship','partnerRelationship','spouse','deFacto','relationshipEvidence'],
  intentionToMarry: ['intentionToMarry','weddingDate','prospectiveMarriage'],
  metInPerson: ['metInPerson','metPartner','inPersonMeeting'],
  schedule3: ['schedule3','schedule 3'],
  coe: ['coe','confirmationOfEnrolment','course'],
  genuineStudent: ['genuineStudent','genuineTemporaryEntrant','genuineStudy'],
  genuineVisitor: ['genuineVisitor','genuineTemporaryStay','genuineStay'],
  financialCapacity: ['financialCapacity','funds','sufficientFunds','bankBalance','income'],
  oshc: ['oshc','healthInsurance','overseasStudentHealthCover'],
  purpose: ['purpose','visitPurpose','travelPurpose'],
  incentiveToReturn: ['incentiveToReturn','homeTies','returnHome'],
  medicalTreatment: ['medicalTreatment','treatmentPlan'],
  temporaryStay: ['temporaryStay','genuineTemporaryStay'],
  trainingPlan: ['trainingPlan','training'],
  activity: ['activity','temporaryActivity'],
  sponsorOrSupport: ['sponsorOrSupport','supporter','sponsor'],
  eligiblePassport: ['eligiblePassport','passportCountry','passport'],
  funds: ['funds','financialCapacity','sufficientFunds'],
  previousHolidayVisa: ['previousWorkingHoliday','previous417','previous462'],
  education: ['education','qualification','study'],
  governmentSupport: ['governmentSupport','letterOfSupport'],
  recentStudy: ['recentStudy','australianStudy','courseCompletion'],
  qualification: ['qualification','degree','diploma'],
  childRelationship: ['childRelationship','birthCertificate','child'],
  parentRelationship: ['parentRelationship','parent','birthCertificate'],
  dependency: ['dependency','dependent'],
  custody: ['custody','parentalResponsibility'],
  balanceOfFamily: ['balanceOfFamily','familyComposition'],
  assuranceOfSupport: ['assuranceOfSupport'],
  approvedParentSponsor: ['approvedParentSponsor','parentSponsor'],
  remainingRelative: ['remainingRelative'],
  carerNeed: ['carerNeed','careNeed','medicalAssessment'],
  medicalAssessment: ['medicalAssessment','medicalReport'],
  nzCitizenRelationship: ['nzCitizenRelationship','newZealandCitizenRelationship'],
  eligibleNzCitizen: ['eligibleNzCitizen','nzCitizen'],
  familyUnit: ['familyUnit','memberOfFamilyUnit'],
  protectionClaims: ['protectionClaim','fearOfHarm','refugeeClaim','complementaryProtection','persecution'],
  identity: ['identity','passport','birthCertificate','nationalId'],
  credibility: ['credibility','statement','consistentClaims'],
  countryInformation: ['countryInformation','countryEvidence'],
  temporaryProtectionCohort: ['temporaryProtectionCohort','tpvCohort'],
  safeHavenCohort: ['safeHavenCohort','shevCohort'],
  businessAssets: ['businessAssets','assets','investment'],
  turnover: ['turnover','businessTurnover'],
  held188: ['held188','subclass188','188Held'],
  businessCompliance: ['businessCompliance','investmentCompliance','businessResidence'],
  residence: ['residence','residency'],
  legacy187: ['187','subclass187','rsms','legacy187','transitional187'],
  legacy489: ['489','subclass489','legacy489']
});

function normaliseAssessment(assessment) {
  const payload = assessment && assessment.form_payload ? assessment.form_payload : {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload.formData || payload.data || payload || {};
  const flat = flatten(answers);
  const requestedSubclass = str(assessment?.visa_type || pick(flat, ['visaType','visaSubclass','subclass'])).replace(/\D/g, '');
  const invitationDate = pick(flat, SIGNAL_KEYS.invitationDate) || new Date();
  const dob = pick(flat, SIGNAL_KEYS.dob);
  const age = num(pick(flat, SIGNAL_KEYS.age)) ?? ageAt(dob, invitationDate);
  const allText = JSON.stringify(answers).toLowerCase();
  return { assessment: assessment || {}, payload, answers, flat, requestedSubclass, age, allText };
}

function getSignal(ctx, key) { return pick(ctx.flat, SIGNAL_KEYS[key] || [key]); }
function getBool(ctx, key) { return bool(getSignal(ctx, key)); }
function hasAnyText(ctx, words) { return words.some(w => ctx.allText.includes(String(w).toLowerCase())); }

function extractSignals(ctx) {
  const points = num(getSignal(ctx, 'points'));
  const experience = num(getSignal(ctx, 'experience'));
  const salary = num(getSignal(ctx, 'salary'));
  const onshoreBar = hasAnyText(ctx, ['section 48','s48','no further stay','8503','8534','8535']);
  return {
    age: ctx.age,
    ageUnder45: ctx.age === null ? null : ctx.age < 45,
    ageHoliday: ctx.age === null ? null : ctx.age >= 18 && ctx.age <= 30,
    ageGraduate: ctx.age === null ? null : ctx.age < 50,
    points,
    points65: points === null ? null : points >= 65,
    experience,
    experienceAtLeast1: experience === null ? null : experience >= 1,
    experienceAtLeast2: experience === null ? null : experience >= 2,
    salary,
    onshoreBar,
    onshoreValidity: onshoreBar ? false : null,
    sponsor: getBool(ctx, 'sponsor'),
    nomination: getBool(ctx, 'nomination'),
    occupation: getSignal(ctx, 'occupation') ? true : null,
    english: getBool(ctx, 'english'),
    skillsAssessment: getBool(ctx, 'skillsAssessment'),
    stateNomination: getBool(ctx, 'stateNomination'),
    regionalNominationOrSponsor: getBool(ctx, 'regionalNominationOrSponsor'),
    invitation: getBool(ctx, 'invitation'),
    genuinePosition: getBool(ctx, 'genuinePosition'),
    lmt: getBool(ctx, 'lmt'),
    regional: getBool(ctx, 'regional'),
    stream: getSignal(ctx, 'stream') ? true : null,
    onshore: getBool(ctx, 'onshore'),
    offshore: getBool(ctx, 'offshore'),
    relationship: getBool(ctx, 'relationship'),
    eligibleSponsor: getBool(ctx, 'sponsor') || getBool(ctx, 'eligibleSponsor'),
    intentionToMarry: getBool(ctx, 'intentionToMarry'),
    metInPerson: getBool(ctx, 'metInPerson'),
    schedule3: getBool(ctx, 'schedule3'),
    coe: getBool(ctx, 'coe'),
    genuineStudent: getBool(ctx, 'genuineStudent'),
    genuineVisitor: getBool(ctx, 'genuineVisitor'),
    financialCapacity: getBool(ctx, 'financialCapacity'),
    oshc: getBool(ctx, 'oshc'),
    purpose: getSignal(ctx, 'purpose') ? true : null,
    incentiveToReturn: getBool(ctx, 'incentiveToReturn'),
    medicalTreatment: getBool(ctx, 'medicalTreatment'),
    temporaryStay: getBool(ctx, 'temporaryStay'),
    trainingPlan: getBool(ctx, 'trainingPlan'),
    activity: getBool(ctx, 'activity'),
    sponsorOrSupport: getBool(ctx, 'sponsorOrSupport'),
    eligiblePassport: getBool(ctx, 'eligiblePassport'),
    funds: getBool(ctx, 'funds') || getBool(ctx, 'financialCapacity'),
    previousHolidayVisa: getBool(ctx, 'previousHolidayVisa'),
    education: getBool(ctx, 'education'),
    governmentSupport: getBool(ctx, 'governmentSupport'),
    recentStudy: getBool(ctx, 'recentStudy'),
    qualification: getBool(ctx, 'qualification'),
    childRelationship: getBool(ctx, 'childRelationship'),
    parentRelationship: getBool(ctx, 'parentRelationship'),
    dependency: getBool(ctx, 'dependency'),
    custody: getBool(ctx, 'custody'),
    balanceOfFamily: getBool(ctx, 'balanceOfFamily'),
    assuranceOfSupport: getBool(ctx, 'assuranceOfSupport'),
    approvedParentSponsor: getBool(ctx, 'approvedParentSponsor'),
    remainingRelative: getBool(ctx, 'remainingRelative'),
    carerNeed: getBool(ctx, 'carerNeed'),
    medicalAssessment: getBool(ctx, 'medicalAssessment'),
    nzCitizenRelationship: getBool(ctx, 'nzCitizenRelationship'),
    eligibleNzCitizen: getBool(ctx, 'eligibleNzCitizen'),
    familyUnit: getBool(ctx, 'familyUnit'),
    protectionClaims: getBool(ctx, 'protectionClaims'),
    identity: getBool(ctx, 'identity') || (getSignal(ctx, 'identity') ? true : null),
    credibility: getBool(ctx, 'credibility'),
    countryInformation: getBool(ctx, 'countryInformation'),
    temporaryProtectionCohort: getBool(ctx, 'temporaryProtectionCohort'),
    safeHavenCohort: getBool(ctx, 'safeHavenCohort'),
    businessAssets: getBool(ctx, 'businessAssets'),
    turnover: getBool(ctx, 'turnover'),
    held188: getBool(ctx, 'held188'),
    businessCompliance: getBool(ctx, 'businessCompliance'),
    residence: getBool(ctx, 'residence'),
    legacy187: hasAnyText(ctx, ['subclass 187','rsms','legacy 187','187 visa']),
    legacy489: hasAnyText(ctx, ['subclass 489','legacy 489','489 visa'])
  };
}

function inferPathwayGroup(ctx, signals) {
  const requested = ctx.requestedSubclass;
  if (requested && PATHWAYS[requested]) return PATHWAYS[requested].group;
  const scores = {
    employerSponsored: [signals.sponsor, signals.nomination, signals.genuinePosition, signals.salary !== null, signals.experienceAtLeast1].filter(Boolean).length,
    skilled: [signals.skillsAssessment, signals.points65, signals.stateNomination, signals.regionalNominationOrSponsor, signals.invitation].filter(Boolean).length,
    partner: [signals.relationship, signals.eligibleSponsor, signals.intentionToMarry].filter(Boolean).length,
    studentVisitor: [signals.coe, signals.genuineStudent, signals.genuineVisitor, signals.purpose, signals.financialCapacity].filter(Boolean).length,
    trainingActivityGraduate: [signals.trainingPlan, signals.activity, signals.eligiblePassport, signals.recentStudy, signals.qualification].filter(Boolean).length,
    family: [signals.childRelationship, signals.parentRelationship, signals.remainingRelative, signals.carerNeed, signals.nzCitizenRelationship].filter(Boolean).length,
    protection: [signals.protectionClaims, signals.countryInformation].filter(Boolean).length,
    business: [signals.businessAssets, signals.held188, signals.businessCompliance, signals.turnover].filter(Boolean).length
  };
  const ranked = Object.entries(scores).sort((a,b) => b[1] - a[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : 'skilled';
}

function evaluateSignal(signalName, signals) {
  if (signalName === 'experience') return signals.experienceAtLeast1;
  if (signalName === 'ageHoliday') return signals.ageHoliday;
  if (signalName === 'ageGraduate') return signals.ageGraduate;
  return Object.prototype.hasOwnProperty.call(signals, signalName) ? signals[signalName] : null;
}

function scorePathway(subclass, signals) {
  const p = PATHWAYS[subclass];
  if (!p) return null;
  if (p.availability !== AVAILABILITY.ACTIVE) {
    return {
      subclass, shortName: p.shortName, name: p.name, group: p.group, availability: p.availability,
      score: 0, recommendation: 'NOT_AVAILABLE_FOR_NEW_APPLICATIONS', confidence: 'High', riskLevel: 'Not available', blockers: [p.closedMessage || 'This pathway is not available for new applications.'], risks: [], positives: [], missing: [], rationale: p.closedMessage || 'This subclass is not available for new applications.', nextAction: 'Assess active alternative pathways.'
    };
  }

  const required = p.required || [];
  const useful = p.useful || [];
  const blockers = [];
  const risks = [];
  const positives = [];
  const missing = [];
  let score = 20;

  for (const r of required) {
    const v = evaluateSignal(r, signals);
    if (v === true) { score += 12; positives.push(r); }
    else if (v === false) { score -= 28; blockers.push(r); }
    else { score -= 7; missing.push(r); }
  }
  for (const u of useful) {
    const v = evaluateSignal(u, signals);
    if (v === true) { score += 5; positives.push(u); }
    else if (v === false) { score -= 6; risks.push(u); }
    else { score -= 1; }
  }

  if ((subclass === '189' || subclass === '190' || subclass === '491') && signals.onshoreBar === true) {
    score -= 40;
    blockers.push('onshore validity restriction');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  let recommendation = 'NOT_RECOMMENDED';
  let confidence = 'Low';
  let riskLevel = 'High';
  if (blockers.length === 0 && score >= 70) { recommendation = 'RECOMMENDED'; confidence = 'High'; riskLevel = missing.length ? 'Medium' : 'Low'; }
  else if (blockers.length === 0 && score >= 45) { recommendation = 'POSSIBLE_SUBJECT_TO_EVIDENCE'; confidence = 'Moderate'; riskLevel = 'Medium'; }
  else if (blockers.length <= 1 && score >= 35) { recommendation = 'HIGH_RISK_ALTERNATIVE'; confidence = 'Low'; riskLevel = 'High'; }

  const issue = blockers[0] || missing[0] || risks[0] || 'documentary verification';
  const rationale = recommendation === 'RECOMMENDED'
    ? `${p.shortName} is the strongest pathway on the current information, subject to verification of supporting documents.`
    : recommendation === 'POSSIBLE_SUBJECT_TO_EVIDENCE'
      ? `${p.shortName} may be available, but further instructions and evidence are required before it can be recommended.`
      : recommendation === 'HIGH_RISK_ALTERNATIVE'
        ? `${p.shortName} should only be considered after the identified risk is clarified: ${issue}.`
        : `${p.shortName} is not recommended at this stage. Main issue: ${issue}.`;

  return { subclass, shortName: p.shortName, name: p.name, group: p.group, availability: p.availability, score, recommendation, confidence, riskLevel, blockers: uniq(blockers), risks: uniq(risks), positives: uniq(positives), missing: uniq(missing), rationale, nextAction: buildNextAction(recommendation, p.group, issue) };
}

function buildNextAction(recommendation, group, issue) {
  if (recommendation === 'RECOMMENDED') return 'Proceed to document verification and professional review before lodgement.';
  if (recommendation === 'POSSIBLE_SUBJECT_TO_EVIDENCE') return 'Request missing evidence and confirm eligibility before recommending this pathway.';
  if (recommendation === 'HIGH_RISK_ALTERNATIVE') return `Clarify the identified issue before progressing: ${issue}.`;
  if (group === 'employerSponsored') return 'Consider whether an active employer-sponsored alternative such as 482, 186 or 494 is available.';
  return 'Do not progress this pathway unless the blocker can be resolved.';
}

function subclassesForGroup(group, options = {}) {
  const g = PATHWAY_GROUPS[group] || PATHWAY_GROUPS.skilled;
  const includeLegacy = Boolean(options.includeLegacy || options.includeClosed);
  return includeLegacy ? [...g.active, ...g.legacy] : g.active.slice();
}

function rankResults(results) {
  return results.filter(Boolean).sort((a,b) => {
    const order = { RECOMMENDED: 0, POSSIBLE_SUBJECT_TO_EVIDENCE: 1, HIGH_RISK_ALTERNATIVE: 2, NOT_RECOMMENDED: 3, NOT_AVAILABLE_FOR_NEW_APPLICATIONS: 4 };
    const ao = order[a.recommendation] ?? 9;
    const bo = order[b.recommendation] ?? 9;
    if (ao !== bo) return ao - bo;
    return b.score - a.score;
  });
}

function buildStrategyNarrative(comparison) {
  const groupInfo = PATHWAY_GROUPS[comparison.pathwayGroup] || PATHWAY_GROUPS.skilled;
  const primary = comparison.primaryRecommendation;
  const notAvailable = comparison.ranked.filter(r => r.recommendation === 'NOT_AVAILABLE_FOR_NEW_APPLICATIONS');
  const lines = [];
  lines.push(`I have compared the relevant ${groupInfo.label.toLowerCase()} based on the information currently available.`);
  if (primary) {
    lines.push(`The strongest current pathway is ${primary.shortName}. This is a preliminary strategy position only and remains subject to documentary verification and registered migration agent review.`);
  } else {
    lines.push('No pathway in this group can be recommended on the current information. Further instructions and evidence are required before a pathway can be safely progressed.');
  }
  const possible = comparison.ranked.filter(r => r.recommendation === 'POSSIBLE_SUBJECT_TO_EVIDENCE' || r.recommendation === 'HIGH_RISK_ALTERNATIVE');
  if (possible.length) lines.push(`Possible alternatives requiring further review: ${possible.map(p => `${p.shortName} (score ${p.score}/100)`).join('; ')}.`);
  if (notAvailable.length) lines.push(`Legacy/closed subclasses have not been treated as active recommendations: ${notAvailable.map(p => p.shortName).join('; ')}.`);
  lines.push('This comparison does not replace final legal advice. It is a strategy tool to identify the most appropriate next review pathway.');
  return lines.join('\n\n');
}

function buildPdfSection(comparison) {
  const bullets = comparison.ranked.map(r => {
    const status = r.recommendation.replace(/_/g, ' ').toLowerCase();
    const issue = r.blockers[0] || r.missing[0] || r.risks[0] || 'subject to documentary verification';
    return `${r.shortName}: ${status}. Score: ${r.score}/100. Confidence: ${r.confidence}. Main issue: ${issue}.`;
  });
  return { heading: 'Alternative pathway assessment', body: comparison.strategyNarrative, bullets };
}

function buildDashboardCards(comparison) {
  return comparison.ranked.map((r, index) => ({
    rank: index + 1,
    subclass: r.subclass,
    title: r.shortName,
    group: r.group,
    availability: r.availability,
    recommendation: r.recommendation,
    riskLevel: r.riskLevel,
    score: r.score,
    confidence: r.confidence,
    message: r.rationale,
    primaryAction: r.nextAction,
    blockers: r.blockers,
    missing: r.missing,
    positives: r.positives
  }));
}

function compareMigrationPathways(assessment, options = {}) {
  const ctx = normaliseAssessment(assessment || {});
  const signals = extractSignals(ctx);
  const requested = ctx.requestedSubclass;
  const pathwayGroup = options.group || inferPathwayGroup(ctx, signals);
  let subclasses = options.subclasses || subclassesForGroup(pathwayGroup, options);
  if (requested && PATHWAYS[requested] && !subclasses.includes(requested) && (options.includeRequested !== false)) {
    // Surface a requested closed/legacy subclass safely, but do not treat it as active.
    subclasses = [requested, ...subclasses];
  }
  subclasses = uniq(subclasses).filter(s => PATHWAYS[s]);
  const ranked = rankResults(subclasses.map(s => scorePathway(s, signals)));
  const primary = ranked.find(r => r.recommendation === 'RECOMMENDED') || ranked.find(r => r.recommendation === 'POSSIBLE_SUBJECT_TO_EVIDENCE') || null;
  const comparison = {
    ok: true,
    source: 'migrationPathwayComparator',
    version: COMPARATOR_VERSION,
    requestedSubclass: requested || null,
    pathwayGroup,
    pathwayGroupLabel: (PATHWAY_GROUPS[pathwayGroup] || {}).label || pathwayGroup,
    comparedSubclasses: subclasses,
    signals,
    ranked,
    primaryRecommendation: primary,
    alternativeRecommendations: ranked.filter(r => primary && r.subclass !== primary.subclass && ['RECOMMENDED','POSSIBLE_SUBJECT_TO_EVIDENCE','HIGH_RISK_ALTERNATIVE'].includes(r.recommendation)),
    notRecommended: ranked.filter(r => r.recommendation === 'NOT_RECOMMENDED'),
    notAvailable: ranked.filter(r => r.recommendation === 'NOT_AVAILABLE_FOR_NEW_APPLICATIONS'),
    strategyNarrative: ''
  };
  comparison.strategyNarrative = buildStrategyNarrative(comparison);
  comparison.pdfSection = buildPdfSection(comparison);
  comparison.dashboardCards = buildDashboardCards(comparison);
  return comparison;
}

function attachPathwayComparisonToAdviceBundle(adviceBundle, assessment, options = {}) {
  const bundle = adviceBundle && typeof adviceBundle === 'object' ? { ...adviceBundle } : {};
  const comparison = compareMigrationPathways(assessment, options);
  bundle.pathwayComparison = comparison;
  if (bundle.advice) {
    const advice = { ...bundle.advice };
    const sections = Array.isArray(advice.sections) ? advice.sections.slice() : [];
    const body = comparison.pdfSection.body + '\n\n' + comparison.pdfSection.bullets.map(b => `• ${b}`).join('\n');
    sections.push({ heading: comparison.pdfSection.heading, body });
    advice.sections = sections;
    bundle.advice = advice;
  }
  return bundle;
}

function supportedComparatorSubclasses(options = {}) {
  const includeLegacy = Boolean(options.includeLegacy || options.includeClosed);
  return Object.keys(PATHWAYS).filter(s => includeLegacy || PATHWAYS[s].availability === AVAILABILITY.ACTIVE);
}

module.exports = {
  compareMigrationPathways,
  attachPathwayComparisonToAdviceBundle,
  supportedComparatorSubclasses,
  PATHWAYS,
  PATHWAY_GROUPS,
  AVAILABILITY,
  COMPARATOR_VERSION
};
