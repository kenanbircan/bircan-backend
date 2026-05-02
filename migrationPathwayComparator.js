'use strict';

/**
 * migrationPathwayComparator.js
 * Bircan Migration — Full Subclass-Aware Comparator V2.1
 *
 * Fixes:
 * - Exports attachPathwayComparisonToAdviceBundle
 * - Exports compareMigrationPathways
 * - Keeps 187 closed to new applications
 * - Produces PDF-ready alternative pathway assessment sections
 * - Safe: does not override decision-engine legal outcome
 */

const COMPARATOR_VERSION = '2.1.0-full-subclass-aware-export-fix';

const GROUPS = Object.freeze({
  employer: ['482', '186', '494'],
  skilled: ['189', '190', '491'],
  partner: ['309', '820', '300'],
  studentVisitor: ['500', '590', '600', '602'],
  trainingActivityGraduate: ['407', '408', '417', '462', '485'],
  family: ['101', '103', '115', '116', '173', '461', '836', '870'],
  protection: ['866', '785', '790'],
  business: ['188', '888']
});

const CLOSED_SUBCLASSES = Object.freeze({
  '187': {
    subclass: '187',
    label: 'Subclass 187 Regional Sponsored Migration Scheme',
    reason: 'Subclass 187 is closed to new applications and should only be considered in legacy or transitional contexts.',
    alternatives: ['494', '186']
  },
  '489': {
    subclass: '489',
    label: 'Subclass 489 Skilled Regional (legacy)',
    reason: 'Subclass 489 is a legacy pathway and is not recommended as an active new application pathway.',
    alternatives: ['491']
  }
});

const TITLES = Object.freeze({
  '482': '482 Employer Sponsored',
  '186': '186 Employer Nomination Scheme',
  '494': '494 Regional Employer Sponsored',
  '189': '189 Skilled Independent',
  '190': '190 State Nominated',
  '491': '491 Regional Skilled',
  '309': '309 Partner Offshore',
  '820': '820 Partner Onshore',
  '300': '300 Prospective Marriage',
  '500': '500 Student',
  '590': '590 Student Guardian',
  '600': '600 Visitor',
  '602': '602 Medical Treatment',
  '407': '407 Training',
  '408': '408 Temporary Activity',
  '417': '417 Working Holiday',
  '462': '462 Work and Holiday',
  '485': '485 Temporary Graduate',
  '101': '101 Child',
  '103': '103 Parent',
  '115': '115 Remaining Relative',
  '116': '116 Carer',
  '173': '173 Contributory Parent Temporary',
  '461': '461 New Zealand Citizen Family Relationship',
  '836': '836 Carer Onshore',
  '870': '870 Sponsored Parent Temporary',
  '866': '866 Protection',
  '785': '785 Temporary Protection',
  '790': '790 Safe Haven Enterprise',
  '188': '188 Business Innovation and Investment',
  '888': '888 Business Innovation and Investment Permanent'
});

function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function lower(v) { return str(v).toLowerCase(); }
function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function flatten(obj, prefix = '', out = {}) {
  if (!isObj(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v)) flatten(v, key, out);
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
      if (ck.includes(want) && v !== undefined && v !== null && str(v) !== '') return v;
    }
  }
  return null;
}

function bool(v) {
  if (typeof v === 'boolean') return v;
  const s = lower(v);
  if (!s) return null;
  if (['yes','y','true','1','valid','current','approved','positive','held','met','satisfied','pass','passed','eligible','available'].includes(s)) return true;
  if (['no','n','false','0','invalid','expired','withdrawn','refused','not held','not met','not satisfied','fail','failed','ineligible','unavailable'].includes(s)) return false;
  if (/\b(no|not|none|unknown|unsure|refused|expired|invalid|cannot|unable)\b/i.test(s)) return false;
  return null;
}

function num(v) {
  const m = str(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function date(v) {
  const d = new Date(str(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

function ageAt(dob, at = new Date()) {
  const b = date(dob);
  const a = date(at) || new Date();
  if (!b) return null;
  let age = a.getFullYear() - b.getFullYear();
  const m = a.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && a.getDate() < b.getDate())) age -= 1;
  return age;
}

function normaliseAssessment(assessment = {}) {
  const payload = assessment.form_payload || assessment.formPayload || assessment.payload || {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload.formData || payload.data || payload || {};
  const flat = flatten(answers);
  const visaType = str(assessment.visa_type || assessment.subclass || pick(flat, ['visaType','visa_type','subclass','visaSubclass'])).replace(/\D/g, '');
  return { assessment, payload, answers, flat, visaType };
}

function hasYes(flat, keys) { return bool(pick(flat, keys)) === true; }
function hasNo(flat, keys) { return bool(pick(flat, keys)) === false; }
function hasAny(flat, keys) { const v = pick(flat, keys); return v !== null && v !== undefined && str(v) !== ''; }

function inferGroup(ctx) {
  const requested = ctx.visaType;
  if (CLOSED_SUBCLASSES[requested]) return 'employer';
  for (const [group, subs] of Object.entries(GROUPS)) {
    if (subs.includes(requested)) return group;
  }

  const f = ctx.flat;
  if (hasAny(f, ['partner','spouse','deFacto','relationship','sponsorEligible','intentionToMarry'])) return 'partner';
  if (hasAny(f, ['sponsorApproved','nominationApproved','employer','salary','genuinePosition'])) return 'employer';
  if (hasAny(f, ['skillsAssessment','points','invitation','stateNomination','regionalNomination','englishLevel'])) return 'skilled';
  if (hasAny(f, ['coe','course','student','genuineStudent','visitor','funds'])) return 'studentVisitor';
  if (hasAny(f, ['protection','fearOfHarm','refugee','persecution'])) return 'protection';
  if (hasAny(f, ['business','investment','turnover','assets'])) return 'business';
  return 'skilled';
}

function signalFacts(ctx) {
  const f = ctx.flat;
  const dob = pick(f, ['dob','dateOfBirth','birthDate']);
  const invitationDate = pick(f, ['invitationDate','skillSelectInvitationDate']) || new Date();
  const age = num(pick(f, ['age'])) ?? ageAt(dob, invitationDate);

  return {
    age,
    ageUnder45: age === null ? null : age < 45,
    english: hasYes(f, ['englishMet','competentEnglish','englishRequirement','englishTest','englishLevel']),
    skillsAssessment: hasYes(f, ['skillsAssessment','positiveSkillsAssessment','hasSkillsAssessment']),
    points65: (num(pick(f, ['points','claimedPoints','totalPoints','eoiPoints'])) || 0) >= 65,
    stateNomination: hasYes(f, ['stateNomination','territoryNomination','nominationApproved','nomination']),
    regionalNominationOrSponsor: hasYes(f, ['regionalNomination','regionalSponsor','familySponsor','eligibleFamilySponsor','regional']),
    invitation: hasYes(f, ['invitation','skillSelectInvitation','hasInvitation','invitationReceived']),
    sponsor: hasYes(f, ['sponsorApproved','approvedSponsor','standardBusinessSponsor','sponsor']),
    employerNomination: hasYes(f, ['nominationApproved','approvedNomination','employerNomination','nomination']),
    occupation: hasAny(f, ['occupation','nominatedOccupation','anzsco']),
    experience: (num(pick(f, ['workExperienceYears','relevantExperienceYears','experience'])) || 0) >= 1,
    salary: (num(pick(f, ['salary','annualSalary','guaranteedAnnualEarnings','marketSalary'])) || 0) > 0,
    relationship: hasYes(f, ['genuineRelationship','relationshipEvidence','spouse','deFacto','partnerRelationship']),
    eligibleSponsor: hasYes(f, ['sponsorEligible','australianSponsor','sponsorCitizenPR','eligibleSponsor']),
    intentionToMarry: hasYes(f, ['intentionToMarry','weddingDate','prospectiveMarriage']),
    coe: hasYes(f, ['coe','confirmationOfEnrolment','course']),
    genuineStay: hasYes(f, ['genuineTemporaryEntrant','genuineStudent','genuineVisitor','genuineStay','purpose']),
    funds: hasYes(f, ['financialCapacity','funds','sufficientFunds','bankBalance','income']),
    protectionClaim: hasYes(f, ['protectionClaim','fearOfHarm','refugeeClaim','complementaryProtection','persecution']),
    identity: hasYes(f, ['passport','identityDocument','nationalId','birthCertificate']),
    business: hasYes(f, ['businessAssets','investment','turnover','businessCompliance','held188']),
    healthBad: hasYes(f, ['healthIssue','medicalIssue','healthConcern']),
    characterBad: hasYes(f, ['characterIssue','criminalHistory','conviction']),
    integrityBad: hasYes(f, ['pic4020','falseDocument','misleadingInformation','integrityIssue'])
  };
}

function pathwaySignals(subclass, facts) {
  const commonRisk = facts.healthBad || facts.characterBad || facts.integrityBad;
  switch (subclass) {
    case '482':
      return {
        required: ['sponsor','employerNomination','occupation','experience'],
        useful: ['english','salary'],
        hardFail: commonRisk || facts.sponsor === false || facts.employerNomination === false
      };
    case '186':
      return {
        required: ['employerNomination','occupation','experience','english'],
        useful: ['sponsor','salary','skillsAssessment'],
        hardFail: commonRisk || facts.employerNomination === false
      };
    case '494':
      return {
        required: ['sponsor','employerNomination','occupation','experience'],
        useful: ['english','salary','regionalNominationOrSponsor'],
        hardFail: commonRisk || facts.sponsor === false || facts.employerNomination === false
      };
    case '189':
      return { required: ['ageUnder45','english','skillsAssessment','points65','invitation'], useful: ['occupation'], hardFail: commonRisk || facts.ageUnder45 === false };
    case '190':
      return { required: ['ageUnder45','english','skillsAssessment','points65','stateNomination','invitation'], useful: ['occupation'], hardFail: commonRisk || facts.ageUnder45 === false };
    case '491':
      return { required: ['ageUnder45','english','skillsAssessment','points65','regionalNominationOrSponsor','invitation'], useful: ['occupation'], hardFail: commonRisk || facts.ageUnder45 === false };
    case '309':
    case '820':
      return { required: ['relationship','eligibleSponsor'], useful: ['identity'], hardFail: commonRisk || facts.eligibleSponsor === false };
    case '300':
      return { required: ['intentionToMarry','eligibleSponsor'], useful: ['relationship','identity'], hardFail: commonRisk || facts.eligibleSponsor === false };
    case '500':
      return { required: ['coe','genuineStay','funds'], useful: ['english'], hardFail: commonRisk };
    case '590':
    case '600':
    case '602':
      return { required: ['genuineStay','funds'], useful: ['identity'], hardFail: commonRisk };
    case '866':
    case '785':
    case '790':
      return { required: ['protectionClaim','identity'], useful: [], hardFail: facts.integrityBad || facts.characterBad };
    case '188':
    case '888':
      return { required: ['business'], useful: ['funds','identity'], hardFail: commonRisk };
    default:
      return { required: ['identity'], useful: [], hardFail: commonRisk };
  }
}

function scoreSubclass(subclass, facts) {
  if (CLOSED_SUBCLASSES[subclass]) {
    return {
      subclass,
      title: CLOSED_SUBCLASSES[subclass].label,
      status: 'closed',
      label: 'closed to new applications',
      score: 0,
      confidence: 'High',
      mainIssue: 'closed subclass',
      reasons: [CLOSED_SUBCLASSES[subclass].reason],
      alternatives: CLOSED_SUBCLASSES[subclass].alternatives
    };
  }

  const sig = pathwaySignals(subclass, facts);
  if (sig.hardFail) {
    return {
      subclass,
      title: TITLES[subclass] || `Subclass ${subclass}`,
      status: 'not_recommended',
      label: 'not recommended',
      score: 0,
      confidence: 'High',
      mainIssue: facts.integrityBad ? 'integrity risk' : facts.characterBad ? 'character risk' : facts.healthBad ? 'health risk' : 'hard blocker',
      reasons: ['A threshold issue or adverse risk means this pathway should not be positively recommended on the current information.']
    };
  }

  let score = 0;
  let missing = [];
  for (const key of sig.required) {
    if (facts[key] === true) score += Math.round(80 / sig.required.length);
    else missing.push(key);
  }
  for (const key of sig.useful) {
    if (facts[key] === true) score += Math.round(20 / Math.max(1, sig.useful.length));
  }
  score = Math.max(0, Math.min(100, score));

  const label = score >= 70 ? 'recommended' : score >= 45 ? 'possible' : 'not recommended';
  const confidence = score >= 70 ? 'High' : score >= 45 ? 'Moderate' : 'Low';

  return {
    subclass,
    title: TITLES[subclass] || `Subclass ${subclass}`,
    status: label.replace(/\s+/g, '_'),
    label,
    score,
    confidence,
    mainIssue: missing[0] || 'documentary verification',
    missing,
    reasons: missing.length
      ? [`Further information is required for: ${missing.join(', ')}.`]
      : ['The declared facts align with the core structure of this pathway, subject to verification.']
  };
}

function compareMigrationPathways(assessment = {}, options = {}) {
  const ctx = normaliseAssessment(assessment);
  const group = options.group || inferGroup(ctx);
  const facts = signalFacts(ctx);
  const subclasses = options.subclasses || GROUPS[group] || GROUPS.skilled;

  let results = subclasses.map(sc => scoreSubclass(sc, facts));
  if (ctx.visaType && CLOSED_SUBCLASSES[ctx.visaType] && !results.find(r => r.subclass === ctx.visaType)) {
    results.unshift(scoreSubclass(ctx.visaType, facts));
  }

  results = results.sort((a, b) => {
    if (a.status === 'closed' && b.status !== 'closed') return 1;
    if (b.status === 'closed' && a.status !== 'closed') return -1;
    return b.score - a.score;
  });

  const recommended = results.find(r => r.label === 'recommended') || null;
  const possible = results.filter(r => r.label === 'possible');
  const notRecommended = results.filter(r => r.label === 'not recommended' || r.status === 'closed');

  const groupLabel = {
    employer: 'employer sponsored pathways',
    skilled: 'skilled migration pathways',
    partner: 'partner and prospective marriage pathways',
    studentVisitor: 'student, guardian, visitor and medical treatment pathways',
    trainingActivityGraduate: 'training, activity, working holiday and graduate pathways',
    family: 'family migration pathways',
    protection: 'protection pathways',
    business: 'business and investment pathways'
  }[group] || 'migration pathways';

  const narrative = buildNarrative(groupLabel, recommended, possible, notRecommended, results);

  return {
    ok: true,
    comparatorVersion: COMPARATOR_VERSION,
    group,
    groupLabel,
    requestedSubclass: ctx.visaType || null,
    results,
    recommended,
    possible,
    notRecommended,
    narrative,
    pdfSection: {
      heading: 'Alternative pathway assessment',
      body: narrative,
      bullets: results.map(r => `${r.title}: ${r.label}. Score: ${r.score}/100. Confidence: ${r.confidence}. Main issue: ${r.mainIssue}.`)
    }
  };
}

function buildNarrative(groupLabel, recommended, possible, _notRecommended, results) {
  const lines = [];
  lines.push(`I have compared the relevant ${groupLabel} based on the information currently available.`);
  if (recommended) {
    lines.push(`${recommended.title} is the strongest pathway on the current information. This does not remove the need for document verification and final professional review.`);
  } else if (possible.length) {
    lines.push(`No pathway can be treated as clearly recommended at this stage, however ${possible[0].title} may be considered further if the outstanding issues are addressed.`);
  } else {
    lines.push('No pathway in this group can be recommended on the current information. Further instructions and evidence are required before a pathway can be safely progressed.');
  }

  const sharedIssue = findCommonIssue(results);
  if (sharedIssue) {
    lines.push(`This outcome arises from a threshold issue affecting the pathways in this group, namely ${sharedIssue}. Until this is resolved, no pathway can be safely progressed.`);
  }

  lines.push('This comparison does not replace final legal advice. It is a strategy tool to identify the most appropriate next review pathway.');
  return lines.join('\n\n');
}

function findCommonIssue(results) {
  if (!Array.isArray(results) || results.length < 2) return '';
  const issues = results.map(r => r.mainIssue).filter(Boolean);
  if (!issues.length) return '';
  const first = issues[0];
  return issues.every(i => i === first) ? first : '';
}

function attachPathwayComparisonToAdviceBundle(adviceBundle = {}, assessment = {}, options = {}) {
  const comparison = compareMigrationPathways(assessment, options);
  const bundle = adviceBundle && typeof adviceBundle === 'object' ? { ...adviceBundle } : {};
  bundle.pathwayComparison = comparison;

  if (bundle.advice && typeof bundle.advice === 'object') {
    const section = comparison.pdfSection;
    const existing = Array.isArray(bundle.advice.sections) ? bundle.advice.sections : [];
    const withoutOld = existing.filter(s => String(s.heading || s.title || '').toLowerCase() !== 'alternative pathway assessment');
    bundle.advice.sections = [
      ...withoutOld,
      { heading: section.heading, body: [section.body, ...(section.bullets || []).map(b => `• ${b}`)].join('\n') }
    ];
  }

  return bundle;
}

function supportedComparatorSubclasses() {
  return Array.from(new Set(Object.values(GROUPS).flat().concat(Object.keys(CLOSED_SUBCLASSES))));
}

module.exports = {
  COMPARATOR_VERSION,
  GROUPS,
  CLOSED_SUBCLASSES,
  compareMigrationPathways,
  attachPathwayComparisonToAdviceBundle,
  supportedComparatorSubclasses
};
