/**
 * migrationStrategyEngine.js
 * Bircan Migration — Multi-Pathway Strategy Advisor V1
 *
 * Purpose:
 *   Compares multiple visa pathways and produces an advisory strategy layer.
 *   This file does NOT replace migrationDecisionEngine.js.
 *   It sits above it and uses the deterministic legal engine outcome.
 *
 * Upload beside server.js and migrationDecisionEngine.js.
 */

const {
  runDecisionEngine,
  buildDelegateSimulatorPdfInputs,
  supportedDelegateSimulatorSubclasses
} = require('./migrationDecisionEngine');

const STRATEGY_VERSION = '1.0.0-multi-pathway-advisor';

const PATHWAY_GROUPS = Object.freeze({
  employer: ['482', '186', '494'],
  skilled: ['189', '190', '491'],
  partner: ['820', '309', '300'],
  studentVisitor: ['500', '590', '600'],
  protection: ['866'],
  business: ['188', '888']
});

const PATHWAY_TITLES = Object.freeze({
  '482': 'Subclass 482 — Skills in Demand / Temporary Skill Shortage pathway',
  '186': 'Subclass 186 — Employer Nomination Scheme pathway',
  '494': 'Subclass 494 — Skilled Employer Sponsored Regional pathway',
  '189': 'Subclass 189 — Skilled Independent pathway',
  '190': 'Subclass 190 — Skilled Nominated pathway',
  '491': 'Subclass 491 — Skilled Work Regional pathway',
  '820': 'Subclass 820 — Partner onshore pathway',
  '309': 'Subclass 309 — Partner offshore pathway',
  '300': 'Subclass 300 — Prospective Marriage pathway',
  '500': 'Subclass 500 — Student pathway',
  '590': 'Subclass 590 — Student Guardian pathway',
  '600': 'Subclass 600 — Visitor pathway',
  '866': 'Subclass 866 — Protection pathway',
  '188': 'Subclass 188 — Business Innovation and Investment pathway',
  '888': 'Subclass 888 — Business Innovation and Investment permanent pathway'
});

function str(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function lower(v) { return str(v).toLowerCase(); }
function bool(v) {
  if (typeof v === 'boolean') return v;
  const s = lower(v);
  if (!s) return null;
  if (['yes','y','true','1','approved','held','met','satisfied','eligible','pass','passed'].includes(s)) return true;
  if (['no','n','false','0','not held','not met','not satisfied','ineligible','fail','failed'].includes(s)) return false;
  return null;
}
function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = str(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function flatten(obj, prefix = '', out = {}) {
  if (!isPlainObject(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}
function pick(flat, keys) {
  const entries = Object.entries(flat || {});
  const exact = new Map(entries.map(([k,v]) => [k.toLowerCase(), v]));
  for (const key of keys) {
    if (flat[key] !== undefined && flat[key] !== null && str(flat[key]) !== '') return flat[key];
    const ev = exact.get(String(key).toLowerCase());
    if (ev !== undefined && ev !== null && str(ev) !== '') return ev;
  }
  const cleaned = entries.map(([k,v]) => [k.toLowerCase().replace(/[\s_\-./]/g, ''), v]);
  for (const key of keys) {
    const want = String(key).toLowerCase().replace(/[\s_\-./]/g, '');
    for (const [ck, v] of cleaned) {
      if (ck.includes(want) && v !== undefined && v !== null && str(v) !== '') return v;
    }
  }
  return null;
}
function yes(flat, keys) { return bool(pick(flat, keys)) === true; }
function no(flat, keys) { return bool(pick(flat, keys)) === false; }
function unique(arr) { return Array.from(new Set((arr || []).filter(Boolean).map(String))); }

function normaliseAssessmentForStrategy(assessment) {
  const payload = assessment && assessment.form_payload && typeof assessment.form_payload === 'object' ? assessment.form_payload : {};
  const answers = payload.answers || payload.formPayload || payload.form_payload || payload.formData || payload.data || payload || {};
  const flat = flatten(answers);
  const subclass = str(assessment && assessment.visa_type || pick(flat, ['visaType','visa_type','subclass','visaSubclass'])).replace(/\D/g, '') || 'unknown';
  return { assessment: assessment || {}, payload, answers, flat, subclass };
}

function inferCandidatePathways(ctx, options = {}) {
  const requested = Array.isArray(options.pathways) ? options.pathways.map(v => String(v).replace(/\D/g, '')).filter(Boolean) : [];
  if (requested.length) return requested;

  const f = ctx.flat;
  const current = ctx.subclass !== 'unknown' ? [ctx.subclass] : [];
  const inferred = [];

  if (yes(f, ['sponsorApproved','approvedSponsor','standardBusinessSponsor','sponsor','employerSponsor','nominationApproved','approvedNomination','employerNomination'])) inferred.push('482','186','494');
  if (yes(f, ['skillsAssessment','positiveSkillsAssessment','skillSelectInvitation','invitation','stateNomination','regionalNomination']) || num(pick(f, ['claimedPoints','points','totalPoints','eoiPoints'])) !== null) inferred.push('189','190','491');
  if (yes(f, ['partnerRelationship','genuineRelationship','spouse','deFacto','intentionToMarry','australianSponsor','sponsorEligible'])) inferred.push('820','309','300');
  if (yes(f, ['coe','confirmationOfEnrolment','course','genuineStudent'])) inferred.push('500');
  if (yes(f, ['genuineVisitor','tourism','visitPurpose','purpose'])) inferred.push('600');
  if (yes(f, ['protectionClaim','fearOfHarm','refugeeClaim','complementaryProtection'])) inferred.push('866');
  if (yes(f, ['businessAssets','investment','turnover','businessExperience'])) inferred.push('188','888');

  const merged = unique([...current, ...inferred]);
  if (merged.length) return merged;
  return ['482','186','189','190','491','500','600'];
}

function cloneAssessmentWithSubclass(assessment, subclass) {
  return {
    ...(assessment || {}),
    visa_type: String(subclass),
    form_payload: {
      ...((assessment && assessment.form_payload) || {}),
      strategyEvaluatedSubclass: String(subclass)
    }
  };
}

function riskPenalty(riskLevel) {
  const r = String(riskLevel || '').toUpperCase();
  if (r === 'LOW') return 0;
  if (r === 'MEDIUM') return 15;
  if (r === 'HIGH') return 35;
  if (r === 'CRITICAL') return 55;
  return 25;
}
function statusBaseScore(decision) {
  const pos = String(decision && decision.lodgementPosition || '').toUpperCase();
  const ds = String(decision && decision.decisionStatus || '').toUpperCase();
  if (pos === 'POTENTIALLY_LODGEABLE') return 90;
  if (pos.includes('POTENTIALLY_LODGEABLE_SUBJECT_TO_EVIDENCE') || ds.includes('PROVISIONALLY_SATISFIED')) return 78;
  if (pos.includes('LEGAL_REVIEW_REQUIRED')) return 55;
  if (pos.includes('NOT_READY_INFORMATION_REQUIRED')) return 45;
  if (pos.includes('LODGEABLE_HIGH_RISK')) return 40;
  if (pos.includes('NOT_LODGEABLE') || ds.includes('INVALID')) return 15;
  return 35;
}
function evidencePenalty(decision) {
  const missing = Array.isArray(decision && decision.evidenceRequired) ? decision.evidenceRequired.length : 0;
  const unknown = Array.isArray(decision && decision.findings) ? decision.findings.filter(f => f.status === 'UNKNOWN').length : 0;
  const provisional = Array.isArray(decision && decision.findings) ? decision.findings.filter(f => f.status === 'PROVISIONALLY_SATISFIED').length : 0;
  return Math.min(30, Math.round(missing * 0.7 + unknown * 5 + provisional * 1.5));
}
function subclassStrategicAdjustment(subclass, ctx) {
  const f = ctx.flat;
  let score = 0;
  const reasons = [];

  if (['482','186','494'].includes(subclass)) {
    if (yes(f, ['sponsorApproved','approvedSponsor','standardBusinessSponsor','sponsor'])) { score += 8; reasons.push('employer sponsorship pathway is supported by declared sponsor availability'); }
    if (yes(f, ['nominationApproved','approvedNomination','employerNomination','nomination'])) { score += 6; reasons.push('nomination appears available or intended'); }
    if (num(pick(f, ['workExperienceYears','relevantExperienceYears','experience'])) >= 2) { score += 5; reasons.push('work experience supports employer-sponsored pathway'); }
  }

  if (['189','190','491'].includes(subclass)) {
    const points = num(pick(f, ['claimedPoints','points','totalPoints','eoiPoints']));
    if (points !== null && points >= 65) { score += 10; reasons.push('declared points meet or exceed the base threshold'); }
    if (yes(f, ['skillsAssessment','positiveSkillsAssessment'])) { score += 8; reasons.push('skills assessment is declared'); }
    if (subclass === '190' && yes(f, ['stateNomination','nominationApproved','nomination'])) { score += 8; reasons.push('state nomination supports subclass 190'); }
    if (subclass === '491' && (yes(f, ['regionalNomination','familySponsor','eligibleFamilySponsor']) || yes(f, ['stateNomination']))) { score += 8; reasons.push('regional nomination or sponsorship supports subclass 491'); }
  }

  if (['820','309','300'].includes(subclass)) {
    if (yes(f, ['genuineRelationship','partnerRelationship','spouse','deFacto'])) { score += 12; reasons.push('relationship pathway is supported by declared relationship facts'); }
    if (yes(f, ['sponsorEligible','australianSponsor','sponsorCitizenPR'])) { score += 8; reasons.push('eligible sponsor is declared'); }
    if (subclass === '300' && yes(f, ['intentionToMarry','weddingDate'])) { score += 8; reasons.push('intention to marry supports prospective marriage pathway'); }
  }

  if (subclass === '500') {
    if (yes(f, ['coe','confirmationOfEnrolment','course'])) { score += 12; reasons.push('course/CoE pathway is declared'); }
    if (yes(f, ['financialCapacity','sufficientFunds'])) { score += 5; reasons.push('financial capacity is declared'); }
  }

  if (subclass === '600') {
    if (yes(f, ['genuineVisitor','purpose','visitPurpose'])) { score += 8; reasons.push('visitor purpose is declared'); }
    if (yes(f, ['financialCapacity','sufficientFunds','funds'])) { score += 5; reasons.push('funds are declared'); }
  }

  if (subclass === '866') {
    if (yes(f, ['protectionClaim','fearOfHarm','refugeeClaim','complementaryProtection'])) { score += 15; reasons.push('protection claims are declared'); }
    if (no(f, ['inAustralia','onshore'])) { score -= 40; reasons.push('onshore requirement appears unsupported'); }
  }

  return { score, reasons };
}

function scorePathway(subclass, decision, ctx) {
  const adjustment = subclassStrategicAdjustment(subclass, ctx);
  const score = Math.max(0, Math.min(100, statusBaseScore(decision) - riskPenalty(decision.riskLevel) - evidencePenalty(decision) + adjustment.score));
  let band = 'NOT_RECOMMENDED';
  if (score >= 80) band = 'STRONG';
  else if (score >= 65) band = 'VIABLE_SUBJECT_TO_EVIDENCE';
  else if (score >= 45) band = 'POSSIBLE_BUT_HIGH_RISK';
  else if (score >= 25) band = 'WEAK_OR_INCOMPLETE';
  return { score, band, reasons: adjustment.reasons };
}

function buildPathwayEvaluation(subclass, assessment, ctx) {
  const testAssessment = cloneAssessmentWithSubclass(assessment, subclass);
  const decision = runDecisionEngine(testAssessment);
  const score = scorePathway(subclass, decision, ctx);
  return {
    subclass,
    title: PATHWAY_TITLES[subclass] || `Subclass ${subclass}`,
    score: score.score,
    band: score.band,
    rankReason: buildRankReason(decision, score),
    strategicReasons: score.reasons,
    decisionStatus: decision.decisionStatus,
    lodgementPosition: decision.lodgementPosition,
    riskLevel: decision.riskLevel,
    primaryReason: decision.primaryReason,
    evidenceRequired: decision.evidenceRequired || [],
    blockers: (decision.blockers || []).map(f => f.criterion),
    criticalFindings: (decision.criticalFindings || []).map(f => f.criterion),
    provisionalFindings: (decision.provisionalFindings || []).map(f => f.criterion),
    qualityFlags: decision.qualityFlags || [],
    decision
  };
}

function buildRankReason(decision, score) {
  const parts = [];
  parts.push(`Outcome: ${human(decision.lodgementPosition)}.`);
  parts.push(`Risk: ${human(decision.riskLevel)}.`);
  if (decision.primaryReason) parts.push(`Primary issue: ${decision.primaryReason}.`);
  if (score.band === 'STRONG') parts.push('This is presently the strongest pathway on the declared information.');
  if (score.band === 'VIABLE_SUBJECT_TO_EVIDENCE') parts.push('This pathway is viable only if the declared facts are verified.');
  if (score.band === 'POSSIBLE_BUT_HIGH_RISK') parts.push('This pathway should not be progressed without agent review and further evidence.');
  if (score.band === 'WEAK_OR_INCOMPLETE') parts.push('This pathway is weak or incomplete on the current instructions.');
  if (score.band === 'NOT_RECOMMENDED') parts.push('This pathway is not recommended on the current information.');
  return parts.join(' ');
}
function human(v) { return str(v).replace(/_/g, ' ').replace(/\s+/g, ' ').toLowerCase().replace(/^./, c => c.toUpperCase()); }

function buildRecommendedStrategy(evaluations) {
  const sorted = evaluations.slice().sort((a, b) => b.score - a.score);
  const primary = sorted[0] || null;
  const alternatives = sorted.slice(1, 4);
  const notRecommended = sorted.filter(e => e.band === 'NOT_RECOMMENDED' || e.band === 'WEAK_OR_INCOMPLETE');

  const summary = primary
    ? `The preferred pathway on the current information is ${primary.title}. It is assessed as ${human(primary.band)} with a strategy score of ${primary.score}/100. ${primary.rankReason}`
    : 'No viable pathway could be ranked on the current information.';

  const recommendedSteps = [];
  if (primary) {
    if (primary.band === 'STRONG') recommendedSteps.push(`Proceed with ${primary.title} preparation subject to final evidence verification and registered migration agent review.`);
    if (primary.band === 'VIABLE_SUBJECT_TO_EVIDENCE') recommendedSteps.push(`Treat ${primary.title} as the preferred pathway, but do not lodge until the listed evidence is collected and verified.`);
    if (primary.band === 'POSSIBLE_BUT_HIGH_RISK') recommendedSteps.push(`Do not progress ${primary.title} without a detailed legal review and risk conference with the client.`);
    if (['WEAK_OR_INCOMPLETE','NOT_RECOMMENDED'].includes(primary.band)) recommendedSteps.push('Do not recommend lodgement on the present information. Request further instructions and evidence before selecting a pathway.');
  }
  const primaryEvidence = primary && Array.isArray(primary.evidenceRequired) ? primary.evidenceRequired.slice(0, 12) : [];
  if (primaryEvidence.length) recommendedSteps.push(`Prioritise evidence collection for: ${primaryEvidence.join('; ')}.`);
  if (alternatives.length) recommendedSteps.push(`Keep alternative pathways under review: ${alternatives.map(a => `Subclass ${a.subclass}`).join(', ')}.`);

  return {
    summary,
    primaryPathway: primary,
    alternativePathways: alternatives,
    notRecommendedPathways: notRecommended,
    recommendedSteps: unique(recommendedSteps)
  };
}

function buildClientStrategyNarrative(strategy) {
  const primary = strategy.primaryPathway;
  if (!primary) return 'At this stage, there is insufficient information to identify a preferred migration pathway.';
  const lines = [];
  lines.push(`Based on the information provided, the preferred pathway is ${primary.title}.`);
  lines.push(`The pathway is assessed as ${human(primary.band)} with a strategy score of ${primary.score}/100.`);
  lines.push(`The main issue is: ${primary.primaryReason || 'evidence and eligibility verification'}.`);
  if (primary.band === 'VIABLE_SUBJECT_TO_EVIDENCE') {
    lines.push('This means the pathway may be suitable, but only if the declared information is supported by acceptable documents before lodgement.');
  } else if (primary.band === 'STRONG') {
    lines.push('This pathway appears comparatively strong, subject to final document verification and professional review.');
  } else if (primary.band.includes('RISK')) {
    lines.push('This pathway carries elevated risk and should not proceed without detailed legal review.');
  }
  if (strategy.alternativePathways && strategy.alternativePathways.length) {
    lines.push(`Alternative pathways to keep under review are: ${strategy.alternativePathways.map(p => `Subclass ${p.subclass}`).join(', ')}.`);
  }
  return lines.join(' ');
}

function buildAgentStrategyNotes(evaluations) {
  return evaluations.map(e => ({
    subclass: e.subclass,
    title: e.title,
    score: e.score,
    band: e.band,
    legalOutcome: e.decisionStatus,
    lodgementPosition: e.lodgementPosition,
    riskLevel: e.riskLevel,
    blockers: e.blockers,
    evidenceRequired: e.evidenceRequired,
    comment: e.rankReason
  }));
}

function runStrategyEngine(assessment, options = {}) {
  const ctx = normaliseAssessmentForStrategy(assessment || {});
  const supported = new Set(supportedDelegateSimulatorSubclasses());
  const pathways = inferCandidatePathways(ctx, options).filter(p => supported.has(String(p)));
  const evaluations = unique(pathways).map(subclass => buildPathwayEvaluation(subclass, assessment || {}, ctx)).sort((a, b) => b.score - a.score);
  const strategy = buildRecommendedStrategy(evaluations);
  return {
    ok: true,
    source: 'migrationStrategyEngine',
    strategyVersion: STRATEGY_VERSION,
    assessedAt: new Date().toISOString(),
    originalSubclass: ctx.subclass,
    evaluatedPathways: evaluations,
    strategy,
    clientNarrative: buildClientStrategyNarrative(strategy),
    agentNotes: buildAgentStrategyNotes(evaluations),
    gptBoundary: {
      role: 'strategy_wording_only',
      cannotChange: ['evaluatedPathways.score','evaluatedPathways.band','evaluatedPathways.lodgementPosition','evaluatedPathways.riskLevel'],
      instruction: 'GPT may improve client wording only. It must not invent eligibility, change rankings, remove risks, or override the deterministic decision engine.'
    }
  };
}

function buildStrategyPdfSection(assessment, options = {}) {
  const result = runStrategyEngine(assessment, options);
  const s = result.strategy;
  return {
    heading: 'Strategy and pathway options',
    body: result.clientNarrative,
    primaryPathway: s.primaryPathway ? {
      subclass: s.primaryPathway.subclass,
      title: s.primaryPathway.title,
      score: s.primaryPathway.score,
      band: s.primaryPathway.band,
      riskLevel: s.primaryPathway.riskLevel,
      lodgementPosition: s.primaryPathway.lodgementPosition,
      primaryReason: s.primaryPathway.primaryReason
    } : null,
    alternatives: (s.alternativePathways || []).map(p => ({ subclass: p.subclass, title: p.title, score: p.score, band: p.band })),
    nextSteps: s.recommendedSteps || [],
    agentNotes: result.agentNotes
  };
}

module.exports = {
  runStrategyEngine,
  buildStrategyPdfSection,
  STRATEGY_VERSION,
  PATHWAY_GROUPS
};
