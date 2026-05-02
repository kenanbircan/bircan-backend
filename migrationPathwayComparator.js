'use strict';

/**
 * migrationPathwayComparator.js
 * Bircan Migration — Multi-Pathway Comparator V1
 * Compares Subclass 482, 190 and 491 pathways using declared facts and existing decision-engine outputs.
 *
 * Safe design:
 * - Does not override migrationDecisionEngine legal outcomes.
 * - Does not promise grant success.
 * - Does not positively frame pathways with hard blockers.
 * - Produces PDF-ready and dashboard-ready strategy sections.
 */

const COMPARATOR_VERSION = '1.0.0-482-190-491';

const PATHWAYS = Object.freeze({
  '482': {
    subclass: '482',
    name: 'Subclass 482 Skills in Demand / Temporary Skill Shortage',
    type: 'Employer sponsored',
    shortName: '482 Employer Sponsored',
    requiredSignals: ['sponsor', 'nomination', 'occupation', 'experience'],
    usefulSignals: ['english', 'salary', 'genuinePosition', 'lmt']
  },
  '190': {
    subclass: '190',
    name: 'Subclass 190 Skilled Nominated',
    type: 'State nominated skilled',
    shortName: '190 State Nominated',
    requiredSignals: ['ageUnder45', 'english', 'skillsAssessment', 'points65', 'stateNomination', 'invitation'],
    usefulSignals: ['occupation', 'onshoreValidity']
  },
  '491': {
    subclass: '491',
    name: 'Subclass 491 Skilled Work Regional',
    type: 'Regional skilled',
    shortName: '491 Regional Skilled',
    requiredSignals: ['ageUnder45', 'english', 'skillsAssessment', 'points65', 'regionalNominationOrSponsor', 'invitation'],
    usefulSignals: ['occupation', 'regionalCommitment', 'onshoreValidity']
  }
});

function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function lower(v) { return str(v).toLowerCase(); }
function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
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
function ageAt(dob, eventDate = new Date()) {
  const b = date(dob); const a = date(eventDate) || new Date();
  if (!b) return null;
  let age = a.getFullYear() - b.getFullYear();
  const m = a.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && a.getDate() < b.getDate())) age -= 1;
  return age;
}
function uniq(values) { return Array.from(new Set((values || []).filter(Boolean).map(String))); }

function normaliseAssessment(assessment) {
  const payload = assessment && assessment.form_payload ? assessment.form_payload : {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload.formData || payload.data || payload || {};
  const flat = flatten(answers);
  const invitationDate = pick(flat, ['invitationDate','skillSelectInvitationDate','invitedDate']) || new Date();
  const dob = pick(flat, ['dateOfBirth','dob','birthDate']);
  const age = num(pick(flat, ['age'])) ?? ageAt(dob, invitationDate);
  return { assessment: assessment || {}, payload, answers, flat, age };
}

function signal(ctx, keys) { return pick(ctx.flat, keys); }
function signalBool(ctx, keys) { return bool(signal(ctx, keys)); }

function extractSignals(ctx) {
  const points = num(signal(ctx, ['points','claimedPoints','totalPoints','eoiPoints','pointsScore']));
  const experience = num(signal(ctx, ['workExperienceYears','relevantExperienceYears','experience','yearsExperience']));
  return {
    age: ctx.age,
    ageUnder45: ctx.age === null ? null : ctx.age < 45,
    english: signalBool(ctx, ['englishMet','competentEnglish','englishRequirement','englishTest','englishLevel']),
    skillsAssessment: signalBool(ctx, ['skillsAssessment','positiveSkillsAssessment','hasSkillsAssessment']),
    points,
    points65: points === null ? null : points >= 65,
    stateNomination: signalBool(ctx, ['stateNomination','territoryNomination','nominationApproved','nomination']),
    regionalNominationOrSponsor: signalBool(ctx, ['regionalNomination','regionalSponsor','familySponsor','eligibleFamilySponsor','regionalSponsorship']),
    invitation: signalBool(ctx, ['invitation','hasInvitation','skillSelectInvitation','invitationReceived']),
    sponsor: signalBool(ctx, ['sponsorApproved','approvedSponsor','standardBusinessSponsor','employerSponsor','sponsor']),
    nomination: signalBool(ctx, ['nominationApproved','approvedNomination','employerNomination','nomination']),
    occupation: signal(ctx, ['occupation','nominatedOccupation','anzsco']) ? true : null,
    experienceYears: experience,
    experience: experience === null ? null : experience >= 1,
    salary: num(signal(ctx, ['salary','annualSalary','guaranteedAnnualEarnings','marketSalary'])) !== null,
    genuinePosition: signalBool(ctx, ['genuinePosition','genuineRole','positionGenuine']),
    lmt: signalBool(ctx, ['labourMarketTesting','lmt','advertisingCompleted','lmtExemption']),
    onshoreValidity: !(signalBool(ctx, ['section48','section48Bar','noFurtherStay','condition8503','condition8534','condition8535']) === true),
    regionalCommitment: signalBool(ctx, ['regionalCommitment','liveRegional','workRegional','regionalArea'])
  };
}

function scorePathway(subclass, signals) {
  const p = PATHWAYS[subclass];
  const blockers = [];
  const risks = [];
  const strengths = [];
  let score = 50;

  function applyRequired(key, label, hard = true) {
    const v = signals[key];
    if (v === true) { score += 12; strengths.push(label); }
    else if (v === false) { score -= hard ? 40 : 20; (hard ? blockers : risks).push(label); }
    else { score -= 10; risks.push(`${label} not confirmed`); }
  }
  function applyUseful(key, label) {
    const v = signals[key];
    if (v === true) { score += 5; strengths.push(label); }
    else if (v === false) { score -= 8; risks.push(label); }
  }

  if (subclass === '482') {
    applyRequired('sponsor', 'eligible sponsoring employer');
    applyRequired('nomination', 'employer nomination');
    applyRequired('occupation', 'nominated occupation alignment', false);
    applyRequired('experience', 'relevant work experience', false);
    applyUseful('english', 'English position appears supportable');
    applyUseful('salary', 'salary / market salary evidence appears available');
    applyUseful('genuinePosition', 'genuine position');
    applyUseful('lmt', 'labour market testing / exemption');
  }

  if (subclass === '190') {
    applyRequired('ageUnder45', 'age under 45 at invitation');
    applyRequired('english', 'competent English');
    applyRequired('skillsAssessment', 'suitable skills assessment');
    applyRequired('points65', 'points score at or above 65');
    applyRequired('stateNomination', 'state or territory nomination');
    applyRequired('invitation', 'SkillSelect invitation');
    applyUseful('occupation', 'occupation alignment');
    applyUseful('onshoreValidity', 'no obvious onshore validity restriction');
  }

  if (subclass === '491') {
    applyRequired('ageUnder45', 'age under 45 at invitation');
    applyRequired('english', 'competent English');
    applyRequired('skillsAssessment', 'suitable skills assessment');
    applyRequired('points65', 'points score at or above 65');
    applyRequired('regionalNominationOrSponsor', 'regional nomination or eligible family sponsorship');
    applyRequired('invitation', 'SkillSelect invitation');
    applyUseful('occupation', 'occupation alignment');
    applyUseful('regionalCommitment', 'regional commitment');
    applyUseful('onshoreValidity', 'no obvious onshore validity restriction');
  }

  score = Math.max(0, Math.min(100, score));
  const hardBlocked = blockers.length > 0;
  let recommendation = 'NOT_RECOMMENDED';
  if (!hardBlocked && score >= 75) recommendation = 'PRIMARY_RECOMMENDED';
  else if (!hardBlocked && score >= 55) recommendation = 'POSSIBLE_SUBJECT_TO_EVIDENCE';
  else if (!hardBlocked && score >= 40) recommendation = 'LOW_CONFIDENCE_OPTION';

  const riskLevel = hardBlocked ? 'HIGH' : score >= 75 ? 'LOW' : score >= 55 ? 'MEDIUM' : 'HIGH';
  return {
    subclass,
    name: p.name,
    type: p.type,
    shortName: p.shortName,
    score,
    recommendation,
    riskLevel,
    hardBlocked,
    blockers: uniq(blockers),
    risks: uniq(risks),
    strengths: uniq(strengths),
    rationale: buildRationale(subclass, { score, recommendation, riskLevel, blockers, risks, strengths, hardBlocked })
  };
}

function buildRationale(subclass, r) {
  const p = PATHWAYS[subclass];
  if (r.hardBlocked) {
    return `${p.shortName} is not recommended at this stage because ${r.blockers[0]} is not confirmed or appears not to be satisfied.`;
  }
  if (r.recommendation === 'PRIMARY_RECOMMENDED') {
    return `${p.shortName} appears to be the strongest pathway on the current information, subject to documentary verification and final professional review.`;
  }
  if (r.recommendation === 'POSSIBLE_SUBJECT_TO_EVIDENCE') {
    return `${p.shortName} may be available, but further evidence and legal review are required before it should be progressed.`;
  }
  return `${p.shortName} should be treated cautiously because key eligibility matters remain unresolved.`;
}

function rankResults(results) {
  const priority = { PRIMARY_RECOMMENDED: 4, POSSIBLE_SUBJECT_TO_EVIDENCE: 3, LOW_CONFIDENCE_OPTION: 2, NOT_RECOMMENDED: 1 };
  return results.slice().sort((a, b) => {
    const p = (priority[b.recommendation] || 0) - (priority[a.recommendation] || 0);
    if (p) return p;
    return b.score - a.score;
  });
}

function buildStrategyNarrative(ranked) {
  const primary = ranked.find(r => r.recommendation !== 'NOT_RECOMMENDED') || ranked[0];
  const notRecommended = ranked.filter(r => r.recommendation === 'NOT_RECOMMENDED');
  const alternatives = ranked.filter(r => r.subclass !== primary.subclass && r.recommendation !== 'NOT_RECOMMENDED');

  const lines = [];
  lines.push('I have considered the Subclass 482, 190 and 491 pathways against the information currently available.');
  if (primary && primary.recommendation !== 'NOT_RECOMMENDED') {
    lines.push(`In my view, the strongest pathway to consider at this stage is ${primary.shortName}.`);
    lines.push(primary.rationale);
  } else {
    lines.push('On the current information, none of the compared pathways should be progressed without further clarification and evidence.');
  }
  if (alternatives.length) {
    lines.push(`Alternative pathways that may warrant further review include ${alternatives.map(a => a.shortName).join(' and ')}.`);
  }
  if (notRecommended.length) {
    lines.push(`The following pathway(s) are not recommended at this stage: ${notRecommended.map(n => `${n.shortName} (${n.blockers[0] || 'key criteria not confirmed'})`).join('; ')}.`);
  }
  lines.push('This pathway comparison is preliminary and must be confirmed through review of original documents, current legislative requirements and professional migration advice before any lodgement action is taken.');
  return lines.join('\n\n');
}

function buildPdfSection(comparison) {
  const bullets = comparison.ranked.map(r => {
    const status = r.recommendation.replace(/_/g, ' ').toLowerCase();
    const issue = r.blockers[0] || r.risks[0] || 'subject to documentary verification';
    return `${r.shortName}: ${status}. Main issue: ${issue}.`;
  });
  return {
    heading: 'Alternative pathway assessment',
    body: comparison.strategyNarrative,
    bullets
  };
}

function buildDashboardCards(comparison) {
  return comparison.ranked.map((r, index) => ({
    rank: index + 1,
    subclass: r.subclass,
    title: r.shortName,
    recommendation: r.recommendation,
    riskLevel: r.riskLevel,
    score: r.score,
    message: r.rationale,
    primaryAction: r.recommendation === 'NOT_RECOMMENDED'
      ? 'Clarify blocker before progressing'
      : 'Review evidence and confirm pathway'
  }));
}

function compareMigrationPathways(assessment, options = {}) {
  const ctx = normaliseAssessment(assessment || {});
  const signals = extractSignals(ctx);
  const subclasses = options.subclasses || ['482', '190', '491'];
  const results = subclasses.filter(s => PATHWAYS[s]).map(s => scorePathway(s, signals));
  const ranked = rankResults(results);
  const primary = ranked.find(r => r.recommendation !== 'NOT_RECOMMENDED') || null;
  const comparison = {
    ok: true,
    source: 'migrationPathwayComparator',
    version: COMPARATOR_VERSION,
    comparedSubclasses: subclasses,
    signals,
    ranked,
    primaryRecommendation: primary,
    alternativeRecommendations: ranked.filter(r => primary && r.subclass !== primary.subclass && r.recommendation !== 'NOT_RECOMMENDED'),
    notRecommended: ranked.filter(r => r.recommendation === 'NOT_RECOMMENDED'),
    strategyNarrative: ''
  };
  comparison.strategyNarrative = buildStrategyNarrative(ranked);
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
    sections.push({ heading: comparison.pdfSection.heading, body: comparison.pdfSection.body + '\n\n' + comparison.pdfSection.bullets.map(b => `• ${b}`).join('\n') });
    advice.sections = sections;
    bundle.advice = advice;
  }
  return bundle;
}

module.exports = {
  compareMigrationPathways,
  attachPathwayComparisonToAdviceBundle,
  PATHWAYS,
  COMPARATOR_VERSION
};
