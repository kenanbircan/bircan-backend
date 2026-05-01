'use strict';

/**
 * Bircan Migration Decision Engine — delegate-simulator layer.
 *
 * Production principle:
 * - The engine controls legal classification, risk and lodgement position.
 * - GPT, if used elsewhere, may only improve wording and must not override these outputs.
 * - Output is shaped to the existing pdf.js adviceBundle contract.
 */

const SUPPORTED = ['189','190','491','482','186','187','494','500','600','820','309','300','866'];

function isObj(v){ return v && typeof v === 'object' && !Array.isArray(v); }
function clean(v){
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return v.map(clean).filter(Boolean).join('; ');
  if (isObj(v)) return JSON.stringify(v);
  return String(v).replace(/\s+/g,' ').trim();
}
function norm(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function flatten(input, prefix='', out={}){
  if(!isObj(input)) return out;
  for(const [k,v] of Object.entries(input)){
    if(['password','token','auth','authorization','bmsession'].includes(norm(k))) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if(isObj(v)) flatten(v,key,out);
    else if(Array.isArray(v)) out[key] = v.map(clean).filter(Boolean).join('; ');
    else if(v !== undefined && v !== null && String(v).trim() !== '') out[key] = clean(v);
  }
  return out;
}
function assessmentFlat(assessment){
  const p = isObj(assessment && assessment.form_payload) ? assessment.form_payload : {};
  const base = isObj(p.answers) ? p.answers : isObj(p.formPayload) ? p.formPayload : isObj(p.rawSubmission) ? p.rawSubmission : isObj(p.form_payload) ? p.form_payload : p;
  return { ...flatten(base), ...(isObj(p.flatAnswers) ? flatten(p.flatAnswers) : {}) };
}
function pick(flat, aliases){
  const wanted = aliases.map(norm).filter(Boolean);
  for(const [k,v] of Object.entries(flat || {})){
    const nk = norm(k);
    if(wanted.some(a => nk === a || nk.includes(a) || a.includes(nk))){ const val = clean(v); if(val) return val; }
  }
  return '';
}
function affirmative(v){ return /\b(yes|y|true|approved|valid|current|held|satisfied|met|pass|positive|available|competent|proficient|superior|confirmed|lodged|completed|genuine|eligible|sufficient|provided|included|married|de facto|defacto)\b/i.test(clean(v)); }
function adverse(v){ return /\b(no|false|not|none|absent|missing|refused|rejected|withdrawn|cancelled|canceled|expired|invalid|unresolved|unsure|unknown|failed|bar|adverse|criminal|breach|condition present|not provided|not available|ineligible|not met)\b/i.test(clean(v)); }
function numberFrom(v){ const m = clean(v).match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; }
function dateFrom(v){ const d = new Date(clean(v)); return Number.isNaN(d.getTime()) ? null : d; }
function ageAt(dob, ref){ if(!dob || !ref) return null; let a = ref.getFullYear()-dob.getFullYear(); const m = ref.getMonth()-dob.getMonth(); if(m < 0 || (m===0 && ref.getDate()<dob.getDate())) a--; return a; }

function rule({ id, criterion, aliases=[], evidence=[], severity='critical', layer='grant', legalEffect='REFUSAL_RISK', mode='positiveRequired', missingIs='UNCONFIRMED', consequence='', recommendation='' }){
  return { id, criterion, aliases, evidence, severity, layer, legalEffect, mode, missingIs, consequence, recommendation };
}

const COMMON_GRANT = [
  rule({ id:'health', criterion:'Health requirement', aliases:['health','medical','pic4005','pic4007','health examination'], evidence:['Health examination results','Medical reports if relevant'], severity:'review', legalEffect:'DISCRETIONARY_RISK', mode:'adverseIfYes', consequence:'Health issues may affect grant and require further assessment or waiver analysis where available.', recommendation:'Review health evidence before final advice.' }),
  rule({ id:'character', criterion:'Character requirement', aliases:['character','criminal','police','court','conviction','pic4001'], evidence:['Police certificates','Court documents if relevant'], severity:'review', legalEffect:'DISCRETIONARY_RISK', mode:'adverseIfYes', consequence:'Character issues may affect grant and must be assessed before any application strategy is recommended.', recommendation:'Obtain and review character evidence.' }),
  rule({ id:'integrity', criterion:'Integrity / PIC 4020 risk', aliases:['pic4020','integrity','bogus','false document','misleading','fraud'], evidence:['Prior visa/application records','Department correspondence','Documents previously submitted'], severity:'critical', legalEffect:'REFUSAL_RISK', mode:'adverseIfYes', consequence:'Integrity concerns may create serious visa risk and must be resolved before lodgement action.', recommendation:'Conduct an integrity review before proceeding.' })
];

const SKILLED_BASE = [
  rule({ id:'invitation', criterion:'Valid SkillSelect invitation', aliases:['invitation','skillselect invitation','invited to apply','invitation held'], evidence:['SkillSelect invitation letter showing invitation date, nominated occupation and points score'], severity:'blocker', layer:'validity', legalEffect:'INVALID_APPLICATION', consequence:'Without a verifiable SkillSelect invitation, the application is not ready for valid lodgement.', recommendation:'Obtain and verify the SkillSelect invitation before lodgement.' }),
  rule({ id:'skills_assessment', criterion:'Suitable skills assessment for nominated occupation', aliases:['skills assessment','skills assessment held','suitable skills','assessment authority'], evidence:['Skills assessment outcome letter','Assessment authority details','Assessment date and reference number'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'A suitable skills assessment is a primary criterion for the skilled pathway.', recommendation:'Verify the skills assessment outcome and validity against the invitation date.' }),
  rule({ id:'occupation', criterion:'Nominated occupation eligibility', aliases:['occupation','nominated occupation','anzsco','occupation list','skilled occupation list'], evidence:['Nominated occupation/ANZSCO evidence','Occupation list or nomination list evidence at the relevant time'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'The nominated occupation must align with the relevant skilled occupation framework.', recommendation:'Confirm occupation eligibility and alignment with the invitation/nomination.' }),
  rule({ id:'english', criterion:'English language requirement', aliases:['english','competent english','english test','passport evidence'], evidence:['English test result or eligible passport evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'English must be evidenced at the required level unless an exemption or passport basis applies.', recommendation:'Collect and verify English evidence before final advice.' }),
  rule({ id:'points', criterion:'Points test threshold', aliases:['points','points score','points breakdown','pass mark','65 points'], evidence:['Full points calculation','Evidence for each points claim'], severity:'critical', legalEffect:'REFUSAL_RISK', mode:'points65', consequence:'The points score must meet the applicable pass mark and be supported by evidence.', recommendation:'Complete a full evidence-based points calculation.' }),
  rule({ id:'age', criterion:'Age requirement at invitation', aliases:['date of birth','dob','invitation date','age'], evidence:['Passport biodata page','SkillSelect invitation letter'], severity:'critical', legalEffect:'REFUSAL_RISK', mode:'ageUnder45', consequence:'The age criterion is assessed by reference to the relevant invitation/time requirement.', recommendation:'Verify identity and invitation date.' }),
  rule({ id:'s48_nfs', criterion:'Section 48 / No Further Stay / onshore validity restrictions', aliases:['section 48','s48','no further stay','8503','condition 8503','onshore bar'], evidence:['Current visa grant notice','VEVO','Refusal/cancellation notices','Waiver decision if relevant'], severity:'blocker', layer:'validity', legalEffect:'INVALID_APPLICATION', mode:'adverseIfYes', consequence:'If an onshore bar or No Further Stay condition applies, lodgement may be invalid unless a lawful pathway or waiver applies.', recommendation:'Resolve any onshore validity restriction before lodgement action.' })
];
const STATE_NOM = rule({ id:'state_nomination', criterion:'Current state or territory nomination', aliases:['nomination','state nomination','territory nomination','nomination status'], evidence:['State or territory nomination approval letter','Evidence nomination is current and matches the nominated occupation'], severity:'blocker', layer:'validity', legalEffect:'INVALID_APPLICATION', consequence:'Subclass 190 requires a current state or territory nomination.', recommendation:'Do not proceed until nomination is verified.' });
const REGIONAL_NOM = rule({ id:'regional_nomination_sponsorship', criterion:'Regional nomination or eligible family sponsorship', aliases:['regional nomination','state nomination','family sponsor','regional sponsor','491 nomination'], evidence:['Nomination approval or eligible family sponsorship evidence','Regional residence evidence if applicable'], severity:'blocker', layer:'validity', legalEffect:'INVALID_APPLICATION', consequence:'Subclass 491 requires a valid regional nomination or eligible family sponsorship pathway.', recommendation:'Verify the applicable 491 pathway before lodgement.' });

const EMPLOYER_BASE = [
  rule({ id:'sponsor', criterion:'Approved or eligible sponsor', aliases:['sponsor','sponsorship','standard business sponsor','employer sponsor','sbs','labour agreement'], evidence:['Sponsor approval or labour agreement evidence','Sponsor ABN/ACN and identity details'], severity:'blocker', layer:'sponsor', legalEffect:'INVALID_APPLICATION', consequence:'Employer-sponsored pathways require a valid sponsor or agreement pathway.', recommendation:'Verify sponsorship status before relying on the employer pathway.' }),
  rule({ id:'nomination', criterion:'Approved or valid nomination', aliases:['nomination','sponsor nomination','nomination status','nomination approved'], evidence:['Nomination approval/lodgement evidence','Position description','Employment contract'], severity:'blocker', layer:'nomination', legalEffect:'INVALID_APPLICATION', consequence:'The visa application depends on a valid nomination for the applicant and position.', recommendation:'Confirm nomination status and position details.' }),
  rule({ id:'occupation', criterion:'Occupation eligibility', aliases:['occupation','nominated occupation','anzsco','occupation list','core skills occupation'], evidence:['ANZSCO/occupation details','Occupation list or labour agreement clause'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'The nominated occupation must fit the selected employer-sponsored pathway.', recommendation:'Verify occupation eligibility for the selected stream.' }),
  rule({ id:'genuine_position', criterion:'Genuine position and business need', aliases:['genuine position','business need','position genuine','organisation chart','role needed'], evidence:['Business case','Organisation chart','Position description','Financial/business activity evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'If the position is not genuine or not supported by business need, nomination risk is high.', recommendation:'Prepare evidence showing the role is genuine and required.' }),
  rule({ id:'salary', criterion:'Salary / market salary / income threshold compliance', aliases:['salary','market salary','tsmit','income threshold','annual market salary rate','amsr'], evidence:['Employment contract','Salary evidence','Market salary comparison','Applicable threshold check'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'Salary must satisfy the applicable market salary and income threshold rules.', recommendation:'Verify salary compliance before nomination or visa lodgement.' }),
  rule({ id:'skills_experience', criterion:'Applicant skills, qualifications and experience', aliases:['skills','qualifications','work experience','experience','employment references'], evidence:['CV','Qualifications','Employment references','Skills assessment if required'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'The applicant must have the skills, qualifications and experience required for the occupation and stream.', recommendation:'Verify skills and experience against the position requirements.' }),
  rule({ id:'english', criterion:'English requirement', aliases:['english','english test','english requirement'], evidence:['English test result or exemption evidence'], severity:'review', legalEffect:'REFUSAL_RISK', consequence:'English requirements must be confirmed unless an exemption applies.', recommendation:'Confirm English evidence or exemption.' }),
  rule({ id:'registration', criterion:'Registration/licensing where required', aliases:['registration','licensing','licence','license','professional registration'], evidence:['Registration/licence evidence or confirmation not required'], severity:'review', legalEffect:'REFUSAL_RISK', consequence:'Where licensing or registration is required, lack of evidence may affect grant or lawful work.', recommendation:'Confirm licensing requirements for the occupation and state/territory.' })
];
const RULES_482 = [rule({ id:'stream', criterion:'Correct subclass 482 stream identified', aliases:['stream','482 stream','core skills','specialist skills','labour agreement'], evidence:['Stream selection and basis'], severity:'critical', layer:'validity', legalEffect:'REFUSAL_RISK', consequence:'The applicable 482 stream controls nomination, occupation, salary and visa criteria.', recommendation:'Confirm the correct 482 stream before final advice.' }), ...EMPLOYER_BASE, rule({ id:'lmt', criterion:'Labour Market Testing or exemption', aliases:['labour market testing','lmt','advertising','exemption'], evidence:['Advertisements','LMT report','Exemption basis if applicable'], severity:'review', layer:'nomination', legalEffect:'REFUSAL_RISK', consequence:'Labour Market Testing may be required unless an exemption applies.', recommendation:'Confirm whether LMT applies and keep evidence on file.' })];
const RULES_186 = [rule({ id:'stream', criterion:'Correct subclass 186 stream identified', aliases:['stream','186 stream','trt','temporary residence transition','direct entry','labour agreement'], evidence:['Stream selection and legal basis'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'Subclass 186 criteria differ by stream.', recommendation:'Confirm TRT, Direct Entry or Labour Agreement stream.' }), ...EMPLOYER_BASE, rule({ id:'permanent_role', criterion:'Permanent full-time position / two-year availability', aliases:['permanent role','full time','two years','position available','employment contract'], evidence:['Employment contract','Position availability evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'The nominated position must meet permanent residence nomination requirements for the stream.', recommendation:'Verify contract and ongoing position evidence.' }), rule({ id:'trt_or_de_experience', criterion:'TRT / Direct Entry work experience or skills assessment requirements', aliases:['trt employment','three years','2 years','direct entry skills assessment','skills assessment'], evidence:['Employment history','Skills assessment where required','482/457 visa history for TRT'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'The applicable stream may require qualifying employment history, skills assessment and experience evidence.', recommendation:'Map the applicant to the correct 186 stream and verify evidence.' })];
const RULES_187 = [rule({ id:'stream_legacy', criterion:'Subclass 187 stream / legacy availability', aliases:['187 stream','legacy','rsms','regional sponsored migration scheme','trt','direct entry'], evidence:['Stream and lodgement eligibility evidence','Transitional/legacy basis if applicable'], severity:'blocker', layer:'validity', legalEffect:'INVALID_APPLICATION', consequence:'Subclass 187 is a legacy pathway and availability depends on transitional or pending matters.', recommendation:'Confirm whether subclass 187 remains legally available for this matter.' }), ...EMPLOYER_BASE, rule({ id:'regional_position', criterion:'Regional position and regional employer requirements', aliases:['regional','regional employer','regional position','location','regional area'], evidence:['Regional location evidence','Employer location evidence','Position location evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'The RSMS pathway depends on regional employer and position requirements.', recommendation:'Verify the regional basis and any transitional requirements.' })];
const RULES_494 = [rule({ id:'regional_sponsor', criterion:'Regional employer sponsor pathway', aliases:['regional sponsor','494 sponsor','regional employer','sponsorship'], evidence:['Sponsor approval','Regional location evidence'], severity:'blocker', legalEffect:'INVALID_APPLICATION', consequence:'Subclass 494 requires a regional employer-sponsored pathway.', recommendation:'Verify sponsor and regional location before lodgement.' }), ...EMPLOYER_BASE, rule({ id:'regional_position', criterion:'Position located in designated regional area', aliases:['regional area','regional position','designated regional','location'], evidence:['Work location evidence','Designated regional area check'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'The nominated position must be in a designated regional area.', recommendation:'Verify work location against the regional area requirement.' })];

const RULES_STUDENT_500 = [
  rule({ id:'coe', criterion:'Confirmation of Enrolment / eligible course', aliases:['coe','confirmation of enrolment','course','enrolment','education provider'], evidence:['CoE','Course details','Provider evidence'], severity:'blocker', layer:'validity', legalEffect:'INVALID_APPLICATION', consequence:'A student visa pathway depends on a valid course enrolment basis.', recommendation:'Verify CoE and course details.' }),
  rule({ id:'genuine_student', criterion:'Genuine Student requirement', aliases:['genuine student','gs requirement','study reason','genuine temporary entrant','gte'], evidence:['Genuine Student statement','Study history','Career plan','Country ties'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'The applicant must satisfy the Genuine Student requirement.', recommendation:'Prepare a properly evidenced Genuine Student assessment.' }),
  rule({ id:'financial_capacity', criterion:'Financial capacity', aliases:['financial capacity','funds','bank','income','support'], evidence:['Bank statements','Income evidence','Sponsor support evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'Financial capacity must be evidenced unless an exemption applies.', recommendation:'Verify funds and financial support evidence.' }),
  rule({ id:'oshc', criterion:'Overseas Student Health Cover', aliases:['oshc','health cover','insurance'], evidence:['OSHC policy evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'OSHC must be arranged unless exempt.', recommendation:'Obtain OSHC evidence.' }),
  rule({ id:'english', criterion:'English/course entry requirement', aliases:['english','english test','course entry'], evidence:['English evidence or provider entry confirmation'], severity:'review', legalEffect:'REFUSAL_RISK', consequence:'English/course entry requirements must be verified.', recommendation:'Verify English evidence or exemption.' })
];
const RULES_VISITOR_600 = [
  rule({ id:'purpose', criterion:'Genuine temporary stay / visit purpose', aliases:['purpose','visit purpose','tourism','family visit','business visitor','genuine temporary stay'], evidence:['Visit itinerary','Invitation letter','Purpose evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'The applicant must demonstrate a genuine temporary stay purpose.', recommendation:'Prepare evidence supporting the visit purpose and temporary stay.' }),
  rule({ id:'funds', criterion:'Adequate funds and support', aliases:['funds','financial','bank','support','sponsor support'], evidence:['Bank statements','Employment/income evidence','Sponsor support evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'Adequate funds and support must be shown.', recommendation:'Collect financial evidence before lodgement.' }),
  rule({ id:'incentive_return', criterion:'Incentive to return / home ties', aliases:['home ties','return','employment overseas','family overseas','property','study overseas'], evidence:['Employment evidence','Family/property ties','Return travel plan'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'Weak home ties can create genuine visitor risk.', recommendation:'Document return incentives and country ties.' }),
  rule({ id:'previous_compliance', criterion:'Previous visa compliance', aliases:['previous visa','overstay','compliance','refusal','cancellation'], evidence:['Visa history','Refusal/cancellation records if any'], severity:'review', legalEffect:'REFUSAL_RISK', mode:'adverseIfYes', consequence:'Adverse immigration history may affect visitor prospects.', recommendation:'Review prior visa history before lodgement.' })
];
const PARTNER_BASE = [
  rule({ id:'sponsorship', criterion:'Eligible sponsor / sponsorship status', aliases:['sponsor','sponsorship','partner sponsor','australian partner','citizen','permanent resident'], evidence:['Sponsor identity/status evidence','Sponsorship details'], severity:'blocker', legalEffect:'INVALID_APPLICATION', consequence:'Partner/prospective marriage pathways require an eligible sponsor pathway.', recommendation:'Verify sponsor eligibility and status.' }),
  rule({ id:'relationship', criterion:'Genuine and continuing relationship', aliases:['relationship','marriage','de facto','defacto','spouse','partner evidence','genuine relationship'], evidence:['Relationship statement','Joint financial evidence','Household/social evidence','Commitment evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'The relationship must satisfy the applicable legal test for the visa pathway.', recommendation:'Prepare relationship evidence mapped to the legal criteria.' }),
  rule({ id:'status_location', criterion:'Correct location and visa pathway', aliases:['onshore','offshore','current location','current visa','bridging visa','location'], evidence:['Current visa grant notice','VEVO','Location evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'Onshore/offshore location and current visa status affect pathway validity and strategy.', recommendation:'Verify location and current visa before lodgement.' }),
  rule({ id:'prior_sponsorship', criterion:'Prior sponsorship limitations / family violence / special issues', aliases:['prior sponsorship','sponsorship limitation','family violence','previous partner visa','sponsor history'], evidence:['Sponsor visa history','Prior sponsorship records','Relevant special circumstances evidence'], severity:'review', legalEffect:'REFUSAL_RISK', mode:'adverseIfYes', consequence:'Prior sponsorship or special issues may affect eligibility or strategy.', recommendation:'Review sponsorship history before final advice.' })
];
const RULES_300 = [
  rule({ id:'prospective_marriage', criterion:'Prospective marriage intention and eligibility', aliases:['prospective marriage','fiance','fiancé','intention to marry','marriage planned','wedding'], evidence:['Notice/intention to marry evidence','Relationship evidence','Sponsor status evidence'], severity:'blocker', legalEffect:'INVALID_APPLICATION', consequence:'Subclass 300 requires a prospective marriage pathway supported by evidence.', recommendation:'Verify intention to marry and sponsor eligibility.' }),
  ...PARTNER_BASE.filter(r => r.id !== 'status_location')
];
const RULES_866 = [
  rule({ id:'protection_claims', criterion:'Protection claims / engagement of protection obligations', aliases:['protection claim','refugee','fear','persecution','harm','complementary protection'], evidence:['Detailed protection statement','Country information','Supporting documents'], severity:'critical', legalEffect:'REFUSAL_RISK', consequence:'Protection claims must be legally coherent, credible and supported where possible.', recommendation:'Prepare a detailed protection statement and evidence matrix.' }),
  rule({ id:'onshore_validity', criterion:'Onshore presence and valid protection application pathway', aliases:['onshore','in australia','current visa','immigration clearance','866'], evidence:['Current visa status','VEVO','Entry details'], severity:'blocker', layer:'validity', legalEffect:'INVALID_APPLICATION', consequence:'Subclass 866 is an onshore protection pathway and validity must be confirmed.', recommendation:'Verify current location, status and any bars before lodgement.' }),
  rule({ id:'s48_or_bars', criterion:'Statutory bars / previous protection claims', aliases:['section 48','s48','previous protection','bar','refusal','unauthorised maritime arrival'], evidence:['Prior application records','Refusal notices','Status documents'], severity:'blocker', layer:'validity', legalEffect:'INVALID_APPLICATION', mode:'adverseIfYes', consequence:'Bars or previous claims may prevent or affect lodgement/assessment.', recommendation:'Review all prior immigration history before any action.' }),
  rule({ id:'credibility', criterion:'Credibility and consistency of claims', aliases:['credibility','inconsistent','documents','identity','story','claim consistency'], evidence:['Identity documents','Prior statements','Supporting evidence'], severity:'critical', legalEffect:'REFUSAL_RISK', mode:'adverseIfYes', consequence:'Credibility concerns can be determinative in protection matters.', recommendation:'Resolve inconsistencies before final advice.' })
];

function rulesFor(subclass){
  switch(String(subclass)){
    case '189': return [...SKILLED_BASE, ...COMMON_GRANT];
    case '190': return [...SKILLED_BASE, STATE_NOM, ...COMMON_GRANT];
    case '491': return [...SKILLED_BASE, REGIONAL_NOM, ...COMMON_GRANT];
    case '482': return [...RULES_482, ...COMMON_GRANT];
    case '186': return [...RULES_186, ...COMMON_GRANT];
    case '187': return [...RULES_187, ...COMMON_GRANT];
    case '494': return [...RULES_494, ...COMMON_GRANT];
    case '500': return [...RULES_STUDENT_500, ...COMMON_GRANT];
    case '600': return [...RULES_VISITOR_600, ...COMMON_GRANT];
    case '820': return [...PARTNER_BASE, ...COMMON_GRANT];
    case '309': return [...PARTNER_BASE, ...COMMON_GRANT];
    case '300': return [...RULES_300, ...COMMON_GRANT];
    case '866': return [...RULES_866, ...COMMON_GRANT];
    default: return [];
  }
}
function titleFor(subclass){
  return ({'189':'Subclass 189 Skilled Independent visa','190':'Subclass 190 Skilled Nominated visa','491':'Subclass 491 Skilled Work Regional visa','482':'Subclass 482 Skills in Demand / Temporary Skill Shortage pathway','186':'Subclass 186 Employer Nomination Scheme visa','187':'Subclass 187 Regional Sponsored Migration Scheme visa','494':'Subclass 494 Skilled Employer Sponsored Regional visa','500':'Subclass 500 Student visa','600':'Subclass 600 Visitor visa','820':'Subclass 820 Partner visa','309':'Subclass 309 Partner visa','300':'Subclass 300 Prospective Marriage visa','866':'Subclass 866 Protection visa'})[String(subclass)] || `Subclass ${subclass} visa`;
}
function subclassGroup(subclass){
  if(['189','190','491'].includes(String(subclass))) return 'skilled';
  if(['482','186','187','494'].includes(String(subclass))) return 'employer-sponsored';
  if(['820','309','300'].includes(String(subclass))) return 'partner/family';
  if(['500','600'].includes(String(subclass))) return 'temporary';
  if(String(subclass)==='866') return 'protection';
  return 'unknown';
}
function evaluateRule(r, flat){
  let value = pick(flat, r.aliases || []);
  let status = 'UNCONFIRMED';
  let fact = value;
  if(r.mode === 'points65'){
    const n = numberFrom(value);
    if(n === null) status = r.missingIs || 'UNCONFIRMED';
    else status = n >= 65 ? 'SATISFIED_INDICATED' : 'NOT_SATISFIED';
  } else if(r.mode === 'ageUnder45'){
    const dob = dateFrom(pick(flat, ['date of birth','dob','birth date']));
    const inv = dateFrom(pick(flat, ['invitation date','date of invitation','invited date'])) || new Date();
    const age = ageAt(dob, inv);
    if(age === null) status = 'UNCONFIRMED';
    else { status = age < 45 ? 'SATISFIED_INDICATED' : 'NOT_SATISFIED'; fact = `Calculated age ${age} using available date information`; }
  } else if(r.mode === 'adverseIfYes'){
    if(!value) status = r.severity === 'blocker' ? 'UNCONFIRMED' : 'SATISFIED_INDICATED';
    else if(affirmative(value) && !/^no\b/i.test(value)) status = 'REVIEW_RISK';
    else if(adverse(value)) status = 'SATISFIED_INDICATED';
    else status = 'UNCONFIRMED';
  } else {
    if(!value) status = r.missingIs || 'UNCONFIRMED';
    else if(adverse(value)) status = 'NOT_SATISFIED';
    else if(affirmative(value) || clean(value)) status = 'SATISFIED_INDICATED';
  }
  const evidence = Array.isArray(r.evidence) ? r.evidence : [];
  const finding = status === 'SATISFIED_INDICATED'
    ? `Questionnaire information indicates this criterion may be satisfied, subject to verification of supporting documents.${fact ? ` Recorded information: ${fact}.` : ''}`
    : status === 'NOT_SATISFIED'
      ? `The information provided indicates this criterion is not satisfied or an adverse answer is present.${fact ? ` Recorded information: ${fact}.` : ''}`
      : status === 'REVIEW_RISK'
        ? `The information provided discloses a matter requiring legal review.${fact ? ` Recorded information: ${fact}.` : ''}`
        : `No verified evidence has been identified for this criterion from the submitted questionnaire.`;
  return {
    ruleId: r.id,
    criterion: r.criterion,
    status,
    layer: r.layer,
    severity: r.severity,
    legalEffect: r.legalEffect,
    evidenceProvided: fact && status !== 'UNCONFIRMED' ? [fact] : [],
    evidenceMissing: status === 'SATISFIED_INDICATED' ? evidence.map(e => `${e} (verify on file)`) : evidence,
    finding,
    legal_consequence: r.consequence,
    evidence_gap: evidence.length ? evidence.join('; ') : 'Supporting evidence must be reviewed and verified.',
    recommendation: r.recommendation,
    confidence: status === 'UNCONFIRMED' ? 'LOW' : 'MEDIUM'
  };
}
function aggregate(findings){
  const blockerFail = findings.filter(f => f.severity === 'blocker' && f.status === 'NOT_SATISFIED');
  const blockerUnknown = findings.filter(f => f.severity === 'blocker' && f.status === 'UNCONFIRMED');
  const criticalFail = findings.filter(f => f.severity === 'critical' && f.status === 'NOT_SATISFIED');
  const risks = findings.filter(f => f.status === 'REVIEW_RISK');
  const unknownCritical = findings.filter(f => f.severity === 'critical' && f.status === 'UNCONFIRMED');
  if(blockerFail.length) return { lodgement_position:'NOT_LODGEABLE', risk_level:'CRITICAL', classification:'INVALID_OR_NON_LODGEABLE_ON_CURRENT_INFORMATION', primaryReason:blockerFail[0].criterion, blockers:blockerFail };
  if(blockerUnknown.length) return { lodgement_position:'EVIDENCE_REQUIRED_BEFORE_LODGEMENT', risk_level:'HIGH', classification:'VALIDITY_NOT_CONFIRMED', primaryReason:blockerUnknown[0].criterion, blockers:blockerUnknown };
  if(criticalFail.length) return { lodgement_position:'LODGEABLE_HIGH_RISK', risk_level:'HIGH', classification:'PRIMARY_CRITERIA_FAILURE_RISK', primaryReason:criticalFail[0].criterion, blockers:criticalFail };
  if(risks.length || unknownCritical.length) return { lodgement_position:'EVIDENCE_REQUIRED_BEFORE_ADVICE', risk_level: risks.length ? 'HIGH' : 'MEDIUM', classification:'MANUAL_REVIEW_REQUIRED', primaryReason:(risks[0]||unknownCritical[0]).criterion, blockers:[] };
  return { lodgement_position:'POTENTIALLY_LODGEABLE_SUBJECT_TO_VERIFICATION', risk_level:'LOW', classification:'NO_BLOCKER_IDENTIFIED_FROM_QUESTIONNAIRE', primaryReason:'No blocker identified from questionnaire', blockers:[] };
}
function runDecisionEngine(assessment){
  const subclass = String(assessment.visa_type || assessment.subclass || '').replace(/[^0-9]/g,'');
  if(!SUPPORTED.includes(subclass)) return null;
  const flat = assessmentFlat(assessment);
  const rules = rulesFor(subclass);
  const findings = rules.map(r => evaluateRule(r, flat));
  const finalPosition = aggregate(findings);
  const evidenceRequired = [...new Set(findings.flatMap(f => f.evidenceMissing || []).filter(Boolean))];
  return {
    engine:'bircan-delegate-simulator-v1', subclass, title:titleFor(subclass), group:subclassGroup(subclass),
    finalPosition, risk_level:finalPosition.risk_level, lodgement_position:finalPosition.lodgement_position,
    criteriaFindings: findings, evidenceRequired,
    qualityFlags:[
      `Delegate-simulator engine applied for subclass ${subclass}.`,
      'Risk level, lodgement position and criterion outcomes were determined by the rule engine.',
      'GPT must not override risk, lodgement position, validity blockers or criterion status.'
    ]
  };
}
function statusLabel(s){
  return ({SATISFIED_INDICATED:'Appears satisfied subject to evidence verification',NOT_SATISFIED:'Not satisfied on current information',UNCONFIRMED:'Evidence required / not verified',REVIEW_RISK:'Manual legal review required'})[s] || s;
}
function legalEffectLabel(e){
  return ({INVALID_APPLICATION:'Invalid application / not lodgeable risk',REFUSAL_RISK:'Refusal risk',DISCRETIONARY_RISK:'Discretionary or adverse consideration risk'})[e] || e;
}
function buildAdviceBundle(decision, assessment){
  const fp = assessment.form_payload || {};
  const facts = {
    applicant: { name: assessment.applicant_name || fp.applicantName || fp.name || null, email: assessment.applicant_email || assessment.client_email || null },
    matter: { group: decision.group, selected_plan: assessment.active_plan || assessment.selected_plan || null }
  };
  const findings = decision.criteriaFindings.map(f => ({
    criterion: f.criterion,
    finding: `${statusLabel(f.status)}. ${f.finding}`,
    legal_consequence: `${legalEffectLabel(f.legalEffect)}. ${f.legal_consequence}`,
    evidence_gap: f.evidence_gap,
    recommendation: f.recommendation
  }));
  const blockers = decision.finalPosition.blockers || [];
  const sections = [
    { heading:'Scope and basis of preliminary advice', body:'This letter is a preliminary migration assessment based on the questionnaire answers provided. It is subject to identity verification, conflict checks, review of original supporting documents, signed client authority/service terms where required, and confirmation of current migration law and policy before lodgement action.' },
    { heading:'Delegate-simulator outcome', body:`The engine assessed this matter as ${decision.finalPosition.classification}. Risk level: ${decision.risk_level}. Lodgement position: ${decision.lodgement_position.replace(/_/g,' ')}. Primary reason: ${decision.finalPosition.primaryReason}.` },
    { heading:'Application validity assessment', body:blockers.length ? `The following validity or primary blockers require attention before lodgement: ${blockers.map(b=>b.criterion).join('; ')}.` : 'No absolute validity blocker was identified from the questionnaire answers, subject to evidence verification.' },
    { heading:'Evidence and document verification', body:'Any positive questionnaire answer has been treated as an indication only. The criterion is not treated as finally met until supporting evidence is reviewed and retained on file.' },
    { heading:'Professional review position', body: decision.risk_level === 'LOW' ? 'The matter may proceed to document review and final strategy confirmation.' : 'The matter should not proceed to lodgement action until the identified evidence gaps, adverse answers or unresolved legal issues are reviewed.' },
    { heading:'GPT drafting boundary', body:'Any language generated for this advice must remain within the controlled findings produced by the delegate-simulator engine and must not invent evidence, upgrade prospects, remove blockers or change the lodgement position.' },
    { heading:'Next action', body:'Collect the listed evidence, conduct legal review against the current legislative and policy settings, and regenerate the advice only after the evidence position changes.' }
  ];
  const nextSteps = decision.lodgement_position === 'NOT_LODGEABLE'
    ? ['Do not proceed to lodgement on the current information.','Resolve all validity blockers and adverse findings.','Provide documentary evidence for legal review.','Regenerate the assessment after evidence verification.']
    : ['Collect and upload the required evidence.','Complete a legal review of all unverified or risk findings.','Confirm the final lodgement strategy before application action.'];
  return {
    facts,
    advice:{
      subclass: decision.subclass,
      title:`Preliminary Migration Advice – ${decision.title}`,
      risk_level:decision.risk_level,
      lodgement_position:decision.lodgement_position,
      sections,
      criterion_findings:findings,
      evidence_required:decision.evidenceRequired.slice(0,35),
      client_next_steps:nextSteps,
      quality_flags:decision.qualityFlags,
      disclaimer:'This preliminary advice is based on questionnaire information only and is not a guarantee of visa grant. Final advice requires review of original documents and confirmation of current law, policy and Department requirements at the relevant time.'
    }
  };
}
function buildDelegateSimulatorPdfInputs(assessment){
  const decision = runDecisionEngine(assessment);
  if(!decision) return null;
  const adviceBundle = buildAdviceBundle(decision, assessment);
  const assessmentForPdf = {
    ...assessment,
    riskLevel:decision.risk_level,
    risk_level:decision.risk_level,
    lodgementPosition:decision.lodgement_position,
    lodgement_position:decision.lodgement_position,
    legal_engine:decision.engine,
    form_payload:{ ...(assessment.form_payload || {}), delegateSimulatorDecision: decision }
  };
  return { decision, adviceBundle, assessmentForPdf };
}
function supportedDelegateSimulatorSubclasses(){ return [...SUPPORTED]; }
module.exports = { supportedDelegateSimulatorSubclasses, runDecisionEngine, buildDelegateSimulatorPdfInputs };
