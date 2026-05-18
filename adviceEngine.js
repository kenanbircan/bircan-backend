'use strict';
const matrices = require('./advice-matrices.json');
const coverage = require('./knowledgebase_coverage.json');
const { evaluateDecisionEngine } = require('./decisionEngines');
const { buildKnowledgebaseLegalPack, assertKnowledgebasePack, extractVisaSubclass, extractSelectedStream } = require('./knowledgebaseLoader');
const { loadCriteriaRegistry, listSupportedCriteriaRegistrySubclasses } = require('./criteriaRegistry');
const { validateCriteriaCoverage, buildRegistryBackedFindings } = require('./validators/criteriaCoverageValidator');
const DEFAULT_MODEL = process.env.OPENAI_ADVICE_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = 'https://api.openai.com/v1/responses';
function normSubclass(v){ return String(v || '').replace(/[^0-9]/g, ''); }
function isPlainObject(v){ return v && typeof v === 'object' && !Array.isArray(v); }
function normKey(s){ return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function cleanText(v){ if(v===undefined||v===null) return ''; if(Array.isArray(v)) return v.map(cleanText).filter(Boolean).join('; '); if(isPlainObject(v)) return JSON.stringify(v); return String(v).replace(/\s+/g,' ').trim(); }
function looksLikeDummy(v){ const s=cleanText(v).toLowerCase(); return !s || /sample\s*\d+/.test(s) || /high risk: adverse factors/i.test(s) || /^(test|dummy|n\/a|na|null|undefined)$/.test(s); }
function flatten(input,prefix='',out={}){ if(!isPlainObject(input)) return out; for(const [k,v] of Object.entries(input)){ const key=prefix?`${prefix}.${k}`:k; if(['password','token','auth','authorization','bm_session'].includes(normKey(k))) continue; if(isPlainObject(v)) flatten(v,key,out); else if(Array.isArray(v)) out[key]=v.map(cleanText).filter(Boolean).join('; '); else if(!looksLikeDummy(v)) out[key]=cleanText(v); } return out; }
function payloadOf(assessment){ const p=assessment && assessment.form_payload && typeof assessment.form_payload==='object' ? assessment.form_payload : {}; const base=isPlainObject(p.answers)?p.answers:isPlainObject(p.formPayload)?p.formPayload:isPlainObject(p.rawSubmission)?p.rawSubmission:p; return {...flatten(base), ...(isPlainObject(p.flatAnswers)?flatten(p.flatAnswers):{})}; }
function pick(flat,names,fallback=''){ const wanted=names.map(normKey); for(const [k,v] of Object.entries(flat||{})){ const nk=normKey(k); if(wanted.includes(nk) || wanted.some(w=>nk.includes(w)||w.includes(nk))){ if(!looksLikeDummy(v)) return cleanText(v); }} return fallback; }
function supportedSubclassCodes(){ return [...new Set([...Object.keys(matrices || {}), ...Object.keys(coverage || {})])].filter(Boolean).sort(); }
function familyForSubclass(code){
  const c=normSubclass(code);
  if(['186','187','482','494'].includes(c)) return 'EMPLOYER_SPONSORED';
  if(['189','190','491'].includes(c)) return 'SKILLED';
  if(['300','309','820'].includes(c)) return 'PARTNER';
  if(['101','103','115','116','173'].includes(c)) return 'FAMILY';
  if(['500','407'].includes(c)) return 'STUDENT_TRAINING';
  if(['600'].includes(c)) return 'VISITOR';
  if(['866'].includes(c)) return 'PROTECTION';
  if(['188'].includes(c)) return 'BUSINESS_INNOVATION_INVESTMENT';
  return 'GENERAL_MIGRATION';
}
function ontologyForFamily(family){
  const base={validity:['Schedule 1 validity: correct form, charge, location, application method and any required prerequisite invitation/nomination/sponsorship'],primary:['Schedule 2 primary criteria applicable to the subclass and stream'],secondary:['Secondary applicant criteria and one-fails-all-fail public interest criteria where relevant'],hard:['Invalid application, mandatory bar, unresolved PIC/SRC issue, false or misleading information, or missing essential prerequisite'],evidence:['identity documents','visa history','current location and status','health evidence','character evidence','documents supporting each claimed criterion']};
  const map={
    EMPLOYER_SPONSORED:{primary:['approved sponsor/nomination','genuine position','occupation alignment','skills/work experience','English/age concessions if applicable','salary/market salary where relevant'],evidence:['nomination approval','position description','employment contract','payslips/tax/super','English test or exemption','skills/registration evidence']},
    SKILLED:{primary:['SkillSelect invitation where required','points test','skills assessment','English','state/territory nomination if applicable','occupation list eligibility'],evidence:['invitation','points breakdown','skills assessment','English test','EOI records','state nomination']},
    PARTNER:{primary:['sponsor eligibility','genuine and continuing relationship','four relationship aspects','location/time of decision requirements','family violence considerations where relevant'],evidence:['identity','relationship statements','financial/social/household/commitment evidence','sponsor documents','police checks']},
    FAMILY:{primary:['eligible family relationship','sponsor/proposer requirements','dependency/age/care/parent balance tests where applicable','assurance of support where applicable'],evidence:['birth/marriage/relationship documents','sponsor status','dependency evidence','AoS evidence if required']},
    STUDENT_TRAINING:{primary:['enrolment/training arrangement','genuine temporary/study/training requirement','financial capacity','English/OSHC where relevant'],evidence:['CoE/training plan','financial evidence','OSHC','English evidence','genuine-stay explanation']},
    VISITOR:{primary:['genuine visitor requirement','purpose of stay','funds','incentives to return','risk factors'],evidence:['itinerary','funds','employment/family ties','invitation if relevant','travel history']},
    PROTECTION:{primary:['protection claims','identity/nationality','credibility','exclusion/ineligibility','complementary protection where relevant'],evidence:['identity','country information','claim statement','supporting documents','prior applications/refusals']},
    BUSINESS_INNOVATION_INVESTMENT:{primary:['nomination','business/investment threshold','points/stream criteria','source of funds','genuine business/investment history'],evidence:['nomination','business records','financial statements','asset/source-of-funds evidence','investment records']}
  };
  const extra=map[family]||{};
  return {...base, ...extra, primary:[...base.primary, ...(extra.primary||[])], evidence:[...base.evidence, ...(extra.evidence||[])]};
}
function matrixFor(subclass){
  const code=normSubclass(subclass);
  const m=matrices[code];
  if(m) return {subclass:code, family:familyForSubclass(code), dynamic:false, ...m};
  const c=coverage && coverage[code];
  if(c){
    const family=familyForSubclass(code);
    const onto=ontologyForFamily(family);
    return {subclass:code, family, dynamic:true, title:c.title || `Subclass ${code} visa`, source:'knowledgebase_coverage.json + universal migration-law ontology', streams:[], validity:onto.validity, primary:(Array.isArray(c.criteria)?c.criteria.slice(0,18):onto.primary), secondary:onto.secondary, hard:onto.hard, evidence:onto.evidence, coverageLatest:c.latest || '', criteriaCount:c.criteriaCount || (Array.isArray(c.criteria)?c.criteria.length:0)};
  }
  const family=familyForSubclass(code);
  const onto=ontologyForFamily(family);
  return {subclass:code, family, dynamic:true, title:`Subclass ${code} visa`, source:'dynamic knowledgebase source pack + universal migration-law ontology', streams:[], validity:onto.validity, primary:onto.primary, secondary:onto.secondary, hard:onto.hard, evidence:onto.evidence};
}
function negative(v){ const s=cleanText(v).toLowerCase(); return /(no|not|none|absent|missing|refused|rejected|withdrawn|cancelled|expired|invalid|unresolved|unsure|not sure|unknown|failed|bar|condition present|adverse|criminal|overstay|breach)/i.test(s); }
function positive(v){ const s=cleanText(v).toLowerCase(); return /(yes|approved|valid|current|held|satisfied|met|granted|positive|available|competent|genuine|confirmed)/i.test(s); }
const aliasBank={invitation:['invitation','skillselect'],nomination:['nomination','state-nomination','sponsor-nomination'],skills:['skills','skills-assessment','qualification','experience'],english:['english','competent-english'],points:['points','passmark'],sponsor:['sponsor','sponsorship','employer'],relationship:['relationship','partner','spouse','defacto','marriage'],funds:['funds','financial','means-of-support'],health:['health','oshc','health-insurance'],character:['character','criminal','security'],integrity:['pic4020','integrity','bogus','false'],section48:['section48','s48'],conditions:['8503','no-further-stay','nfa-condition'],coe:['coe','enrolment','course'],genuine:['genuine','intention','temporary-stay','genuine-student'],protection:['protection','refugee','persecution','harm','claim']};
function findValue(flat, aliases){ for(const [k,v] of Object.entries(flat||{})){ const nk=normKey(k); if(aliases.map(normKey).some(a=>nk.includes(a)||a.includes(nk))) return cleanText(v); } return ''; }
function runDeterministicRules(subclass, flat){
  const code = normSubclass(subclass);
  if (code === '190' || code === '482') {
    return evaluateDecisionEngine(code, flat);
  }
  const m=matrixFor(subclass); const findings=[], hard_fails=[], review_flags=[]; for(const [key,aliases] of Object.entries(aliasBank)){ const val=findValue(flat,aliases); if(!val) continue; const status=negative(val)?'REVIEW_REQUIRED':positive(val)?'INDICATED_SATISFIED':'UNCONFIRMED'; findings.push({criterion:key, status, observed_value:val}); if(status==='REVIEW_REQUIRED') review_flags.push(`${key}: ${val}`); }
  for(const issue of m.hard||[]){ const hit=Object.entries(aliasBank).find(([k])=>issue.toLowerCase().includes(k) || (k==='conditions'&&/8503|further stay/.test(issue.toLowerCase())) || (k==='integrity'&&/4020|integrity/.test(issue.toLowerCase()))); if(hit){ const val=findValue(flat,hit[1]); if(val && negative(val)) hard_fails.push({issue, observed_value:val, consequence:'Potential blocking criterion or validity/grant risk.'}); }}
  const risk_level=hard_fails.length?'CRITICAL':review_flags.length>=3?'HIGH':review_flags.length?'MEDIUM':'LOW'; const lodgement_position=hard_fails.length?'DO_NOT_LODGE_NOW':review_flags.length?'PROCEED_AFTER_EVIDENCE_REVIEW':'MANUAL_LEGAL_REVIEW_REQUIRED'; return {subclass:m.subclass, risk_level, lodgement_position, deterministic_findings:findings, hard_fails, review_flags};
}
function structuredFacts(assessment){ const flat=payloadOf(assessment); const subclass=normSubclass(assessment.visa_type || pick(flat,['visaType','subclass','visaSubclass'])); const m=matrixFor(subclass); return {reference:assessment.id, visa_subclass:subclass, matrix_title:m.title, matrix_source:m.source, client_email:cleanText(assessment.client_email), applicant:{name:cleanText(assessment.applicant_name)||pick(flat,['full-name','fullName','applicantName','name']), email:cleanText(assessment.applicant_email)||pick(flat,['email-address','email','applicantEmail']), citizenship:pick(flat,['country-of-citizenship','citizenship','nationality','passportCountry']), date_of_birth:pick(flat,['date-of-birth','dob','dateOfBirth'])}, matter:{selected_plan:cleanText(assessment.active_plan||assessment.selected_plan), current_location:pick(flat,['current-location','currentLocation','grant-location','location']), current_visa_status:pick(flat,['current-visa-status','currentVisaStatus','qualifying-visa-held']), family_included:pick(flat,['family-included','familyIncluded','secondaryApplicants']), stream:pick(flat,['stream','selected-stream','visa-stream','application-stream'])}, subclass_factors:{occupation:pick(flat,['occupation','nominated-occupation','anzsco','course','business','investment']), nomination:pick(flat,['nomination','state-nomination-held','nomination-current','sponsor-nomination','nomination-status']), invitation:pick(flat,['invitation-held','invitation','skillselect']), sponsor:pick(flat,['sponsor','employer','partner','proposer','sponsorship']), relationship:pick(flat,['relationship','marriage','defacto','spouse','partner-evidence']), skills:pick(flat,['skills','skills-assessment-held','qualification','work-experience','experience']), english:pick(flat,['english','competent-english','english-test-type']), points:pick(flat,['points','points-breakdown','pass-mark-met']), funds:pick(flat,['funds','financial-capacity','means-of-support']), health:pick(flat,['health','health-issues','health-insurance','oshc']), character:pick(flat,['character-security-issues','character','criminal']), integrity:pick(flat,['pic4020-integrity','pic4020','bogus','false']), visa_conditions:pick(flat,['section48-bar','8503','nfa-condition','no-further-stay','current-visa-status'])}, cleaned_answers:Object.fromEntries(Object.entries(flat).slice(0,160))}; }
function schema(){ return {type:'object',additionalProperties:false,required:['subclass','risk_level','lodgement_position','title','sections','criterion_findings','evidence_required','client_next_steps','quality_flags','disclaimer'],properties:{subclass:{type:'string',enum:supportedSubclassCodes()},risk_level:{type:'string',enum:['LOW','MEDIUM','HIGH','CRITICAL']},lodgement_position:{type:'string',enum:['SUITABLE_TO_PROCEED','PROCEED_AFTER_EVIDENCE_REVIEW','DO_NOT_LODGE_NOW','INVALID_OR_NOT_AVAILABLE','MANUAL_LEGAL_REVIEW_REQUIRED']},title:{type:'string'},sections:{type:'array',minItems:7,maxItems:10,items:{type:'object',additionalProperties:false,required:['heading','body'],properties:{heading:{type:'string'},body:{type:'string'}}}},criterion_findings:{type:'array',minItems:6,maxItems:100,items:{type:'object',additionalProperties:false,required:['criterion_id','criterion','finding','legal_consequence','evidence_gap','recommendation'],properties:{criterion_id:{type:'string'},criterion:{type:'string'},finding:{type:'string'},legal_consequence:{type:'string'},evidence_gap:{type:'string'},recommendation:{type:'string'}}}},evidence_required:{type:'array',minItems:4,maxItems:30,items:{type:'string'}},client_next_steps:{type:'array',minItems:3,maxItems:15,items:{type:'string'}},quality_flags:{type:'array',maxItems:15,items:{type:'string'}},disclaimer:{type:'string'}}}; }
function framework(m){ return [`Subclass matrix: ${m.title}`,`Knowledge source: ${m.source}`,`Streams/pathways: ${(m.streams||[]).join('; ')}`,`Validity/Schedule 1: ${(m.validity||[]).join('; ')}`,`Primary grant criteria: ${(m.primary||[]).join('; ')}`,`Secondary criteria: ${(m.secondary||[]).join('; ') || 'Not applicable'}`,`Hard fail / do not lodge triggers: ${(m.hard||[]).join('; ')}`,`Evidence required: ${(m.evidence||[]).join('; ')}`].join('\n'); }

function clientSafeAdviceText(v){
  let s = cleanText(v);
  if(!s) return '';
  s = s
    .replace(/known issue\.?/gi, 'The information provided indicates a matter requiring further review.')
    .replace(/weak\/generic gpt wording detected[^.;]*[.;]?/gi, '')
    .replace(/matrix coverage warning[^.;]*[.;]?/gi, '')
    .replace(/criterion reasoning warning[^.;]*[.;]?/gi, '')
    .replace(/\bGPT\b|\bAI\b|artificial intelligence|model output|prompt/gi, 'internal assessment system')
    .replace(/will be refused/gi, 'may result in refusal if not addressed')
    .replace(/will result in refusal/gi, 'may result in refusal if not addressed')
    .replace(/cannot succeed/gi, 'is unlikely to succeed unless the issue is resolved')
    .replace(/hard[- ]fail/gi, 'potentially blocking')
    .replace(/do not lodge/gi, 'lodgement is not recommended')
    .replace(/consult a professional/gi, 'seek further advice from Bircan Migration')
    .replace(/as an internal assessment system[^.]*\./gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}
function sanitiseAdviceForClient(advice){
  if(!advice || typeof advice !== 'object') return advice;
  const cleanObj = (obj) => {
    if(Array.isArray(obj)) return obj.map(cleanObj).filter(v => v !== '' && v !== null && v !== undefined);
    if(obj && typeof obj === 'object'){
      const out={};
      for(const [k,v] of Object.entries(obj)){
        if(k === 'quality_flags') { out[k] = Array.isArray(v) ? v.map(clientSafeAdviceText).filter(Boolean) : []; continue; }
        out[k] = cleanObj(v);
      }
      return out;
    }
    if(typeof obj === 'string') return clientSafeAdviceText(obj);
    return obj;
  };
  return cleanObj(advice);
}
function ensureMaraCommercialMinimums(advice){
  advice.disclaimer = clientSafeAdviceText(advice.disclaimer) || 'This preliminary advice is based on the questionnaire answers provided and is subject to identity checks, document review, conflict checks, any required service agreement, and verification of current migration law and policy before lodgement action is taken.';
  if(!Array.isArray(advice.sections)) advice.sections=[];
  const hasScope = advice.sections.some(s => /scope|basis|limitations/i.test(cleanText(s.heading)));
  if(!hasScope && advice.sections.length < 10){
    advice.sections.unshift({
      heading:'Scope and basis of this preliminary advice',
      body:'This letter is based on the information provided in the online questionnaire. It is not a lodgement instruction and should not be treated as final advice until Bircan Migration has verified identity, reviewed supporting documents, checked for conflicts, and confirmed the current law and policy position.'
    });
  }
  const hasFutile = advice.sections.some(s => /prospect|futile|not recommended/i.test(cleanText(s.heading)+' '+cleanText(s.body)));
  if(!hasFutile && advice.sections.length < 10 && ['HIGH','CRITICAL'].includes(String(advice.risk_level||''))){
    advice.sections.push({
      heading:'Prospects and lodgement caution',
      body:'On the information currently available, lodgement is not recommended unless the identified adverse or unconfirmed matters are resolved. If prospects appear poor after document review, Bircan Migration must advise you of that position before any further immigration assistance is provided.'
    });
  }
  return advice;
}

function validateAdvice(advice, subclass, matrix){
  if(!advice||typeof advice!=='object') throw new Error('GPT advice response empty/invalid.');
  if(String(advice.subclass)!==String(subclass)) throw new Error('GPT advice subclass mismatch.');

  advice.quality_flags = Array.isArray(advice.quality_flags) ? advice.quality_flags : [];
  advice.sections = Array.isArray(advice.sections) ? advice.sections : [];
  advice.criterion_findings = Array.isArray(advice.criterion_findings) ? advice.criterion_findings : [];
  advice.evidence_required = Array.isArray(advice.evidence_required) ? advice.evidence_required : [];
  advice.client_next_steps = Array.isArray(advice.client_next_steps) ? advice.client_next_steps : [];

  const joined=JSON.stringify(advice).toLowerCase();
  const banned=['known issue','high risk: adverse factors','sample 1','sample 2','sample 3','as an ai','generic advice','consult a professional'];
  const triggered=banned.filter(b=>joined.includes(b));
  if(triggered.length){
    throw new Error(`Weak/generic advice wording detected. Knowledgebase-enforced PDF generation blocked: ${triggered.join(', ')}`);
  }

  if(advice.sections.length<7) advice.quality_flags.push('Quality issue: fewer than 7 structured advice sections returned.');
  if(advice.criterion_findings.length<6) advice.quality_flags.push('Quality issue: fewer than 6 criterion findings returned.');

  const criteria = Array.isArray(matrix.primary) ? matrix.primary : [];
  const missingMatrixCriteria = criteria.filter(c => {
    const cNorm = normKey(c).slice(0,40);
    return cNorm && !advice.criterion_findings.some(f => normKey(f.criterion + ' ' + f.finding + ' ' + f.legal_consequence).includes(cNorm.slice(0,18)));
  }).slice(0,8);
  if(missingMatrixCriteria.length){
    advice.quality_flags.push(`Matrix coverage warning: not all primary criteria were expressly mapped: ${missingMatrixCriteria.join('; ')}`);
  }

  const weakFindings = advice.criterion_findings.filter(f => {
    const text = cleanText([f.criterion,f.finding,f.legal_consequence,f.evidence_gap,f.recommendation]);
    return text.length < 120 || !/evidence|document|confirm|cannot be confirmed|provided|questionnaire|review/i.test(text) || !/risk|consequence|satisf|not satisf|criterion|requirement|valid|grant/i.test(text);
  });
  if(weakFindings.length){
    advice.quality_flags.push(`Criterion reasoning warning: ${weakFindings.length} finding(s) may lack evidence-linked legal consequence.`);
  }

  if(!advice.evidence_required.length) advice.evidence_required=['Further documents required before the advice can be treated as final.'];
  if(!advice.client_next_steps.length) advice.client_next_steps=['Manual review by Bircan Migration is required before lodgement action.'];
  if(!advice.disclaimer) advice.disclaimer='This is preliminary migration advice subject to document review and current law/policy verification by Bircan Migration.';

  return ensureMaraCommercialMinimums(sanitiseAdviceForClient(advice));
}


function aggregateSourceHash(sources){
  const crypto = require('crypto');
  const basis = (Array.isArray(sources) ? sources : [])
    .map(s => [s.authority || '', s.path || '', s.sha256 || '', s.modified || ''].join('|'))
    .join('\n');
  return crypto.createHash('sha256').update(basis || 'no-sources').digest('hex');
}
function buildLegalVersionLock(legalSourcePack){
  const sources = Array.isArray(legalSourcePack && legalSourcePack.sources) ? legalSourcePack.sources : [];
  return {
    lawVersionCheckedAt: new Date().toISOString(),
    subclass: String(legalSourcePack && legalSourcePack.subclass || ''),
    selectedStream: String(legalSourcePack && legalSourcePack.selectedStream || ''),
    authorityOrder: Array.isArray(legalSourcePack && legalSourcePack.legalAuthorityOrder) ? legalSourcePack.legalAuthorityOrder : ['ACT','REGULATIONS','INSTRUMENTS','PAMS','OTHER'],
    sourceCount: sources.length,
    knowledgebaseSnapshotId: legalSourcePack && legalSourcePack.knowledgebaseSnapshot && legalSourcePack.knowledgebaseSnapshot.snapshotId || legalSourcePack && legalSourcePack.snapshotId || '',
    knowledgebaseTotalFiles: legalSourcePack && legalSourcePack.knowledgebaseSnapshot && legalSourcePack.knowledgebaseSnapshot.totalFiles || 0,
    aggregateSourceHash: aggregateSourceHash(sources),
    sourceHashes: sources.map(s => ({ authority:s.authority || 'OTHER', path:s.path || '', sha256:s.sha256 || '', modified:s.modified || '' }))
  };
}
function findFlatValue(flat, patterns){
  for(const [k,v] of Object.entries(flat||{})){
    const key = normKey(k);
    if(patterns.some(p => key.includes(normKey(p)))) return cleanText(v);
  }
  return '';
}
function yesish(v){ return /\b(yes|true|declared|disclosed|has|have|held|granted|approved|current|valid|confirmed)\b/i.test(cleanText(v)); }
function noish(v){ return /\b(no|none|not applicable|n\/a|false|never|absent|missing)\b/i.test(cleanText(v)); }
function detectContradictions(facts, advice, rules){
  const flat = facts && facts.cleaned_answers ? facts.cleaned_answers : {};
  const flags=[];
  const refusal = findFlatValue(flat,['refusal','refused','aart','tribunal','review','cancellation','cancelled']);
  const noRefusal = findFlatValue(flat,['no refusal','refusals cancellations','previous refusals','visa refusal']);
  if(refusal && yesish(refusal) && noRefusal && noish(noRefusal)) flags.push({severity:'HIGH',area:'Migration history',issue:'Refusal/review/cancellation answers appear inconsistent.',clientSafe:'Migration history requires clarification before any final advice or lodgement strategy.'});
  const health = findFlatValue(flat,['health issue','medical condition','medical','health']);
  const healthNo = findFlatValue(flat,['no health','health issues']);
  if(health && yesish(health) && healthNo && noish(healthNo)) flags.push({severity:'MEDIUM',area:'Health',issue:'Health disclosure appears inconsistent.',clientSafe:'Health disclosures and any medical evidence should be reconciled before final advice.'});
  const character = findFlatValue(flat,['criminal','conviction','police','character']);
  const characterNo = findFlatValue(flat,['no character','character issues']);
  if(character && yesish(character) && characterNo && noish(characterNo)) flags.push({severity:'HIGH',area:'Character',issue:'Character disclosure appears inconsistent.',clientSafe:'Character history requires clarification and supporting records before final advice.'});
  const stream = cleanText(facts && facts.matter && facts.matter.stream).toLowerCase();
  const employment = findFlatValue(flat,['two years','2 years','employment period','start date','commencement','work with sponsor','trt']);
  if(/trt|temporary residence transition/.test(stream) && (!employment || /less than|under|not sure|unknown|no/i.test(employment))) flags.push({severity:'HIGH',area:'TRT employment',issue:'TRT stream indicated but employment continuity is not confirmed.',clientSafe:'TRT employment continuity must be verified before the pathway can be recommended.'});
  if(rules && Array.isArray(rules.hard_fails)){
    for(const hf of rules.hard_fails.slice(0,5)) flags.push({severity:'CRITICAL',area:'Deterministic legal rule',issue:cleanText(hf.issue || hf.consequence),clientSafe:'A potentially blocking legal issue requires professional review before lodgement.'});
  }
  return flags;
}
function buildEvidenceSufficiencyMatrix(advice, matrix){
  const findings = Array.isArray(advice && advice.criterion_findings) ? advice.criterion_findings : [];
  const evidenceList = Array.isArray(advice && advice.evidence_required) ? advice.evidence_required : [];
  const rows = findings.map(f => {
    const text = cleanText([f.finding,f.evidence_gap,f.recommendation,f.legal_consequence]);
    let score = 55;
    if(/appears satisfied|satisfied|confirmed|provided|available/i.test(text)) score += 25;
    if(/cannot be confirmed|missing|required|unverified|not provided|gap|clarify|review/i.test(text)) score -= 25;
    if(/not satisfied|invalid|bar|refusal|blocking|do not lodge|not recommended/i.test(text)) score -= 20;
    score = Math.max(0, Math.min(100, score));
    const grade = score >= 80 ? 'STRONG' : score >= 60 ? 'ADEQUATE_SUBJECT_TO_VERIFICATION' : score >= 40 ? 'WEAK_REQUIRES_EVIDENCE' : 'INSUFFICIENT_DO_NOT_RELY';
    return {criterion:cleanText(f.criterion), evidenceSufficiencyScore:score, grade, evidenceGap:cleanText(f.evidence_gap), requiredAction:cleanText(f.recommendation)};
  });
  const averageScore = rows.length ? Math.round(rows.reduce((a,r)=>a+r.evidenceSufficiencyScore,0)/rows.length) : 0;
  const missingCoreEvidence = evidenceList.filter(x => /missing|required|provide|obtain|evidence|certificate|contract|payslip|test|passport|police|health/i.test(cleanText(x))).slice(0,20);
  return {averageScore, overallGrade: averageScore >= 80 ? 'STRONG' : averageScore >= 60 ? 'ADEQUATE_SUBJECT_TO_VERIFICATION' : averageScore >= 40 ? 'WEAK_REQUIRES_EVIDENCE' : 'INSUFFICIENT_DO_NOT_RELY', rows, missingCoreEvidence};
}
function buildClientSafetyFilter(advice, contradictionFlags){
  const clientSafeWarnings = (Array.isArray(contradictionFlags)?contradictionFlags:[]).map(f => f.clientSafe).filter(Boolean);
  const internalOnlySuppressed = [];
  const raw = JSON.stringify(advice || {});
  ['prompt','GPT','AI','quality_flags','source hash','internal','known issue'].forEach(term => { if(raw.toLowerCase().includes(term.toLowerCase())) internalOnlySuppressed.push(term); });
  return {clientSafeWarnings, internalOnlySuppressed:[...new Set(internalOnlySuppressed)], enforced:true};
}
function buildInternalLegalAudit({facts,rules,matrix,legalSourcePack,advice,legalVersionLock,contradictionFlags,evidenceSufficiencyMatrix,universalLegalGraph}){
  return {
    auditGeneratedAt:new Date().toISOString(),
    assessmentReference:facts && facts.reference || null,
    subclass:facts && facts.visa_subclass || null,
    selectedStream:legalSourcePack && legalSourcePack.selectedStream || facts?.matter?.stream || '',
    legalVersionLock,
    authorityHierarchy: legalSourcePack && legalSourcePack.hierarchy || [],
    sourcesUsed: legalSourcePack && legalSourcePack.sources || [],
    criteriaAssessed: Array.isArray(advice && advice.criterion_findings) ? advice.criterion_findings.map(f => f.criterion) : [],
    deterministicRisk: rules || {},
    contradictionFlags: contradictionFlags || [],
    evidenceSufficiencyMatrix,
    universalLegalGraph,
    clientFactsReliedOn: facts ? { applicant:facts.applicant, matter:facts.matter, subclass_factors:facts.subclass_factors } : {},
    internalReviewPosition: (contradictionFlags||[]).some(f=>['CRITICAL','HIGH'].includes(f.severity)) ? 'MANUAL_REVIEW_REQUIRED_BEFORE_RELEASE' : 'SUITABLE_FOR_PRELIMINARY_RELEASE_SUBJECT_TO_RMA_REVIEW'
  };
}
function assertFinalProductionControls(bundle){
  if(!bundle || !bundle.legalVersionLock || !bundle.legalVersionLock.aggregateSourceHash) throw new Error('Final control gate failed: legal-version lock missing. PDF generation blocked.');
  if(!bundle.evidenceSufficiencyMatrix || !Array.isArray(bundle.evidenceSufficiencyMatrix.rows) || bundle.evidenceSufficiencyMatrix.rows.length < 6) throw new Error('Final control gate failed: evidence sufficiency matrix missing. PDF generation blocked.');
  if(!bundle.internalLegalAudit || !bundle.internalLegalAudit.auditGeneratedAt) throw new Error('Final control gate failed: internal legal audit missing. PDF generation blocked.');
  if(!bundle.clientSafetyFilter || bundle.clientSafetyFilter.enforced !== true) throw new Error('Final control gate failed: client-safety filter missing. PDF generation blocked.');
  if(!bundle.criteriaRegistry || !bundle.criteriaCoverage || Number(bundle.criteriaCoverage.coverageRate) < 100) throw new Error('Final control gate failed: criteria registry coverage incomplete. PDF generation blocked.');
  return true;
}


function buildUniversalLegalGraph({facts,matrix,legalSourcePack,evidenceSufficiencyMatrix,contradictionFlags}){
  const family = matrix.family || familyForSubclass(facts && facts.visa_subclass);
  const ontology = ontologyForFamily(family);
  const subclass = facts && facts.visa_subclass || legalSourcePack && legalSourcePack.subclass || '';
  const stream = legalSourcePack && legalSourcePack.selectedStream || facts && facts.matter && facts.matter.stream || '';
  const extractedSources = Array.isArray(legalSourcePack && legalSourcePack.sources) ? legalSourcePack.sources : [];
  const sourceAuthorities = [...new Set(extractedSources.map(s => s.authority || 'OTHER'))];
  const hasWaiverSignal = /waiver|exemption|concession|compelling|special circumstance|schedule 3|health waiver|age exemption|english exemption/i.test(JSON.stringify({facts,matrix,stream}));
  const nodes = [
    {id:'subclass_stream_gate', type:'GATE', mandatory:true, timing:'pre_analysis', criteria:[`Subclass ${subclass}`, stream || 'stream not identified'], dependsOn:[], effectIfFailed:'Advice/PDF generation blocked until subclass is identified.'},
    {id:'legal_source_hierarchy', type:'AUTHORITY', mandatory:true, timing:'pre_analysis', criteria:['Migration Act','Migration Regulations','Legislative Instruments','PAMs / policy'], dependsOn:['subclass_stream_gate'], effectIfFailed:'Knowledgebase enforcement blocked.'},
    {id:'schedule1_validity', type:'VALIDITY', mandatory:true, timing:'time_of_application', criteria:matrix.validity || ontology.validity, dependsOn:['legal_source_hierarchy'], effectIfFailed:'Application may be invalid or incapable of valid lodgement.'},
    {id:'schedule2_primary', type:'GRANT_PRIMARY', mandatory:true, timing:'time_of_decision', criteria:matrix.primary || ontology.primary, dependsOn:['schedule1_validity'], effectIfFailed:'Primary applicant may not satisfy grant criteria.'},
    {id:'secondary_applicants', type:'GRANT_SECONDARY', mandatory:false, timing:'time_of_decision', criteria:matrix.secondary || ontology.secondary, dependsOn:['schedule2_primary'], effectIfFailed:'Secondary applicant issue may affect combined application or family member grant.'},
    {id:'public_interest_src', type:'PIC_SRC', mandatory:true, timing:'time_of_decision', criteria:['health','character','integrity / PIC 4020','special return criteria','one fails all fail where applicable'], dependsOn:['schedule2_primary','secondary_applicants'], effectIfFailed:'Mandatory public-interest issue may prevent grant unless waiver or discretion is available.'},
    {id:'waiver_exemption_layer', type:'WAIVER_EXEMPTION', mandatory:false, timing:'exception_review', criteria:['age exemptions','English exemptions','health waivers','Schedule 3 waivers','stream concessions','compelling circumstances'], dependsOn:['schedule2_primary','public_interest_src'], activated:!!hasWaiverSignal, effectIfFailed:'If relied on, the exemption/waiver must be legally available and evidenced.'},
    {id:'evidence_sufficiency', type:'EVIDENCE', mandatory:true, timing:'pre_lodgement_review', criteria:(evidenceSufficiencyMatrix && evidenceSufficiencyMatrix.rows || []).map(r=>r.criterion), dependsOn:['schedule1_validity','schedule2_primary','public_interest_src','waiver_exemption_layer'], effectIfFailed:'Matter should not proceed to lodgement recommendation until evidence gaps are resolved.'},
    {id:'manual_review_lock', type:'PROFESSIONAL_CONTROL', mandatory:true, timing:'before_client_release', criteria:['high-risk escalation','MARA/RMA review','client-safe wording control','internal audit preserved'], dependsOn:['evidence_sufficiency'], effectIfFailed:'Client PDF should not be released automatically.'},
    {id:'final_position', type:'CONCLUSION', mandatory:true, timing:'before_client_release', criteria:['risk level','lodgement position','alternative pathway strategy','document review required'], dependsOn:['manual_review_lock'], effectIfFailed:'Final client-facing advice cannot be issued.'}
  ];
  const oneFailsAllFail = nodes.some(n => JSON.stringify(n.criteria).toLowerCase().includes('one fails')) || family === 'FAMILY' || family === 'PARTNER';
  const highRisk = (contradictionFlags||[]).some(f=>['HIGH','CRITICAL'].includes(f.severity)) || (evidenceSufficiencyMatrix && /INSUFFICIENT|WEAK/.test(String(evidenceSufficiencyMatrix.overallGrade||'')));
  const timingSeparation = nodes.reduce((acc,n)=>{ acc[n.timing] = (acc[n.timing]||0)+1; return acc; },{});
  const missingAuthority = ['ACT','REGULATIONS','PAMS'].filter(a => !sourceAuthorities.includes(a));
  return {
    version:'10.4-final-all-subclass-dynamic-legal-graph',
    subclass,
    selectedStream: stream,
    family,
    ontology,
    nodes,
    edges:nodes.flatMap(n => (n.dependsOn||[]).map(d => ({from:d,to:n.id}))),
    timingSeparation,
    authorityCoverage: sourceAuthorities,
    missingAuthority,
    oneFailsAllFail,
    waiverOrExemptionReviewActivated: !!hasWaiverSignal,
    highRiskManualReviewRequired:!!highRisk,
    clientReleaseBlockedUntilManualReview: !!highRisk,
    sourceSnapshotId:legalSourcePack?.knowledgebaseSnapshot?.snapshotId || legalSourcePack?.snapshotId || '',
    lawUpdateMode:'dynamic-folder-rescan-per-generation'
  };
}
function assertDynamicKnowledgebaseControls(bundle){
  if(!bundle?.legalSourcePack?.knowledgebaseSnapshot?.snapshotId) throw new Error('Final dynamic gate failed: knowledgebase snapshot missing.');
  if(!bundle?.universalLegalGraph?.sourceSnapshotId) throw new Error('Final dynamic gate failed: universal legal graph missing source snapshot.');
  const requiredNodes = ['subclass_stream_gate','legal_source_hierarchy','schedule1_validity','schedule2_primary','public_interest_src','evidence_sufficiency','manual_review_lock','final_position'];
  const graphNodeIds = new Set((bundle.universalLegalGraph.nodes || []).map(n => n.id));
  for (const id of requiredNodes) { if (!graphNodeIds.has(id)) throw new Error(`Final dynamic gate failed: universal legal graph missing ${id}.`); }
  if(bundle.legalVersionLock?.knowledgebaseSnapshotId !== bundle.legalSourcePack.knowledgebaseSnapshot.snapshotId) throw new Error('Final dynamic gate failed: legal-version lock does not match knowledgebase snapshot.');
  return true;
}


// ---------- Research-grade strategic intelligence layer (10.5) ----------
// These functions do not replace the legal criteria engine. They add internal strategic
// intelligence for professional review: historical-law context, delegate focus points,
// refusal-risk themes, case-law similarity placeholders, and future learning hooks.
function extractRelevantDatesForTemporalLaw(facts){
  const flat = facts && facts.cleaned_answers ? facts.cleaned_answers : {};
  const keys = ['application date','applied date','lodgement date','decision date','refusal date','invitation date','nomination date','visa expiry','last substantive visa'];
  const dates = [];
  for(const [k,v] of Object.entries(flat||{})){
    const key = cleanText(k).toLowerCase();
    if(keys.some(p => key.includes(p.replace(/\s+/g,'')) || key.includes(p)) || /date|lodg|decision|refusal|invitation|nomination/i.test(k)){
      const text = cleanText(v);
      if(text) dates.push({field:k, value:text});
    }
  }
  return dates.slice(0,20);
}
function buildHistoricalLawReplaySimulation({facts, legalSourcePack, legalVersionLock}){
  const relevantDates = extractRelevantDatesForTemporalLaw(facts);
  const snapshotId = legalSourcePack?.knowledgebaseSnapshot?.snapshotId || legalSourcePack?.snapshotId || '';
  return {
    enabled:true,
    mode:'snapshot-aware-current-folder',
    limitation:'This backend applies the current knowledgebase snapshot. Historic replay requires archived prior knowledgebase snapshots for each relevant legal date.',
    currentSnapshotId:snapshotId,
    lawVersionCheckedAt:legalVersionLock?.lawVersionCheckedAt || '',
    relevantMatterDates:relevantDates,
    replayTriggers: relevantDates.filter(d => /refusal|decision|invitation|nomination|application|lodg/i.test(d.field)).map(d => ({dateField:d.field, dateValue:d.value, action:'Compare this date against the archived knowledgebase snapshot if historic-law replay is enabled.'})),
    professionalUse:'For refusals, cancellations and appeals, compare the law at application/decision/refusal date against the current folder before final advice.'
  };
}
function buildDelegateBehaviourModel({facts, matrix, contradictionFlags, evidenceSufficiencyMatrix, rules}){
  const family = matrix?.family || familyForSubclass(facts?.visa_subclass);
  const lowEvidence = (evidenceSufficiencyMatrix?.rows||[]).filter(r => /WEAK|INSUFFICIENT/.test(String(r.grade))).slice(0,10);
  const concerns = [];
  if((contradictionFlags||[]).length) concerns.push('Inconsistencies or contradictory answers may attract credibility and clarification concerns.');
  if(lowEvidence.length) concerns.push('Weak or insufficient evidence may cause the delegate to give limited weight to the claimed facts.');
  if(rules?.hard_fails?.length) concerns.push('A potentially blocking legal issue may prevent a favourable outcome unless resolved.');
  const familyFocus = {
    EMPLOYER_SPONSORED:['genuine position','sponsor/nomination integrity','occupation alignment','salary and employment evidence','work-experience continuity'],
    SKILLED:['valid invitation/nomination','points claims','skills assessment','English validity','occupation list eligibility'],
    PARTNER:['genuine and continuing relationship','four aspects of relationship evidence','sponsor eligibility','timeline consistency','family violence/schedule issues if raised'],
    FAMILY:['eligible family relationship','sponsor/proposer status','dependency/age/care requirements','assurance of support where applicable'],
    STUDENT_TRAINING:['genuine student/training purpose','financial capacity','course/training evidence','immigration history'],
    VISITOR:['genuine visitor intention','funds','incentives to return','travel history and compliance'],
    PROTECTION:['identity and nationality','credibility','country information','exclusion issues','complementary protection'],
    BUSINESS_INNOVATION_INVESTMENT:['nomination','business/investment thresholds','source of funds','genuine business/investment history']
  };
  return {
    enabled:true,
    visaFamily:family,
    likelyDelegateFocus: familyFocus[family] || ['valid application','subclass criteria','PIC/SRC','evidence sufficiency','credibility and consistency'],
    matterSpecificConcerns: concerns,
    weakEvidenceCriteria: lowEvidence.map(r => ({criterion:r.criterion, grade:r.grade, requiredAction:r.requiredAction})),
    recommendedInternalReview: concerns.length || lowEvidence.length ? 'Senior migration-agent review recommended before final client release or lodgement action.' : 'Standard professional review still required before lodgement action.'
  };
}
function buildRefusalProbabilityModel({rules, contradictionFlags, evidenceSufficiencyMatrix, universalLegalGraph}){
  let score = 20;
  const reasons=[];
  const hard = (rules?.hard_fails||[]).length;
  const reviews = (rules?.review_flags||[]).length;
  const highContradictions=(contradictionFlags||[]).filter(f=>/HIGH|CRITICAL/.test(f.severity)).length;
  const avg = evidenceSufficiencyMatrix?.averageScore || 0;
  if(hard){ score += 35; reasons.push('Potential blocking criterion or hard-fail issue detected.'); }
  if(reviews>=3){ score += 15; reasons.push('Multiple deterministic review flags detected.'); }
  if(highContradictions){ score += 20; reasons.push('High-severity contradiction or credibility issue detected.'); }
  if(avg && avg<40){ score += 25; reasons.push('Overall evidence sufficiency is insufficient.'); }
  else if(avg && avg<60){ score += 15; reasons.push('Overall evidence sufficiency is weak.'); }
  if(universalLegalGraph?.missingAuthority?.length){ score += 5; reasons.push('Knowledgebase authority coverage has missing categories requiring review.'); }
  score=Math.max(0,Math.min(95,score));
  const band = score>=75?'VERY_HIGH':score>=55?'HIGH':score>=35?'MODERATE':'LOW_TO_MODERATE';
  return {enabled:true, score, band, reasons, note:'This is an internal risk-screening score, not a prediction or guarantee of Department/Tribunal outcome.'};
}
function buildCaseLawSimilarityLayer({facts, matrix, contradictionFlags, evidenceSufficiencyMatrix}){
  const family = matrix?.family || familyForSubclass(facts?.visa_subclass);
  const issueTags = new Set([family]);
  for(const f of (contradictionFlags||[])) issueTags.add(normKey(f.area||f.issue));
  for(const r of (evidenceSufficiencyMatrix?.rows||[])) if(/WEAK|INSUFFICIENT/.test(String(r.grade))) issueTags.add(normKey(r.criterion).slice(0,40));
  return {
    enabled:true,
    status:'ready-for-case-law-corpus',
    issueTags:[...issueTags].filter(Boolean),
    similarDecisionSearchPrompt:'When a tribunal/court/case-law knowledgebase is connected, search for decisions matching these issue tags and compare favourable/unfavourable facts.',
    currentLimitation:'No external case-law corpus is included in this backend package. This layer prepares the matter tags and audit structure for future case-law ingestion.'
  };
}
function buildPrecedentClusterHints({matrix, contradictionFlags, evidenceSufficiencyMatrix}){
  const weak = (evidenceSufficiencyMatrix?.rows||[]).filter(r => /WEAK|INSUFFICIENT/.test(String(r.grade))).map(r=>r.criterion);
  return {
    enabled:true,
    clusterFamily:matrix?.family || 'GENERAL_MIGRATION',
    riskClusters:[
      ...(weak.length?[{cluster:'weak-evidence',criteria:weak.slice(0,8)}]:[]),
      ...((contradictionFlags||[]).length?[{cluster:'credibility-or-consistency',items:(contradictionFlags||[]).map(f=>f.area).slice(0,8)}]:[])
    ],
    professionalUse:'Use these clusters to compare future matters and standardise evidence requests, refusal-risk reviews and internal quality control.'
  };
}
function buildResearchGradeStrategicLayer({facts,rules,matrix,legalSourcePack,legalVersionLock,contradictionFlags,evidenceSufficiencyMatrix,universalLegalGraph}){
  const historicalLawReplay = buildHistoricalLawReplaySimulation({facts,legalSourcePack,legalVersionLock});
  const delegateBehaviourModel = buildDelegateBehaviourModel({facts,matrix,contradictionFlags,evidenceSufficiencyMatrix,rules});
  const refusalProbabilityModel = buildRefusalProbabilityModel({rules,contradictionFlags,evidenceSufficiencyMatrix,universalLegalGraph});
  const caseLawSimilarityLayer = buildCaseLawSimilarityLayer({facts,matrix,contradictionFlags,evidenceSufficiencyMatrix});
  const precedentClusterHints = buildPrecedentClusterHints({matrix,contradictionFlags,evidenceSufficiencyMatrix});
  const selfLearningEvidenceWeighting = {
    enabled:true,
    mode:'audit-ready',
    note:'Stores criterion/evidence/risk structures so future outcomes can be used to tune evidence weighting. No autonomous legal learning occurs without professional governance.'
  };
  return {version:'10.5-research-grade-strategic-intelligence', historicalLawReplay, delegateBehaviourModel, refusalProbabilityModel, caseLawSimilarityLayer, precedentClusterHints, selfLearningEvidenceWeighting};
}
function assertResearchGradeControls(bundle){
  if(!bundle?.researchGradeStrategicLayer?.refusalProbabilityModel?.band) throw new Error('Research-grade gate failed: refusal probability model missing.');
  if(!bundle?.researchGradeStrategicLayer?.delegateBehaviourModel?.likelyDelegateFocus?.length) throw new Error('Research-grade gate failed: delegate behaviour model missing.');
  if(!bundle?.researchGradeStrategicLayer?.historicalLawReplay?.currentSnapshotId) throw new Error('Research-grade gate failed: historical law snapshot reference missing.');
  return true;
}

async function callOpenAIForAdvice(facts, rules, legalPack, criteriaRegistry){
  assertKnowledgebasePack(legalPack);
  if(!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required for migration-agent level GPT advice generation. Refusing to issue weak template PDF.');
  const subclass=normSubclass(facts.visa_subclass);
  const m=matrixFor(subclass);
  const system=[
    'You are drafting a preliminary migration advice letter for review/issue by Bircan Migration, a Registered Migration Agent practice in Australia.',
    'Compliance discipline: write consistently with the Registered Migration Agents Code of Conduct. Be professional, competent, diligent, honest, and not misleading.',
    'Do not give futile assistance. If prospects appear poor or a validity bar may apply, say lodgement is not recommended unless the issue is resolved and reviewed.',
    'Do not overstate certainty. Distinguish confirmed facts, unconfirmed facts, and adverse information.',
    'Do not imply a government outcome can be procured. Do not promise success.',
    'Do not expose internal QA language, GPT/AI wording, matrix warnings, or system diagnostics to the client.',
    'Assume identity, document authenticity, conflict checks, service agreement status, and Consumer Guide delivery may require separate confirmation unless expressly confirmed in the facts.',
    'Your output must be structured legal reasoning, not generic immigration commentary.',
    'Use only the supplied knowledgebase legal-source pack, subclass matrix, deterministic findings, and cleaned matter facts.',
    'Apply the legal-source hierarchy in this order: Migration Act first, Migration Regulations second, Legislative Instruments third, PAMs/policy fourth. PAMs cannot override legislation or instruments.',
    'First identify the visa subclass and selected stream, then apply only the matching legal materials to the client facts.',
    'Treat the knowledgebase extracts as the current legal framework for this backend. Do not rely on general memory where the knowledgebase is silent or inconsistent.',
    'Every material conclusion must be traceable to the supplied knowledgebase, questionnaire facts, and deterministic findings.',
    'Do not invent facts, evidence, dates, employment history, relationship facts, points, nominations, invitations, or legal provisions.',
    'If a required fact is absent, write: cannot be confirmed from the questionnaire.',
    'Every criterion finding must use this reasoning chain: criterion -> relevant facts from questionnaire -> evidence gap -> legal consequence -> recommendation.',
    'Separate validity / time-of-application issues from grant / time-of-decision issues.',
    'Use the formal legal graph: subclass/stream gate -> legal source hierarchy -> Schedule 1 validity -> Schedule 2 primary criteria -> secondary applicants -> PIC/SRC -> waiver/exemption layer -> evidence sufficiency -> manual review lock -> final position.',
    'Also identify likely delegate concern areas, refusal-risk themes, and any need for historical-law replay where dates suggest appeal/refusal/cancellation context.',
    'Apply hard-fail triggers firmly. If a hard-fail or bar may apply, state that lodgement should not proceed until resolved.',
    'Do not use placeholders, sample labels, known issue text, AI disclaimers, or broad risk labels without reasons.',
    'Do not dump raw questionnaire answers. Convert them into findings.',
    'Write in firm Registered Migration Agent style: precise, restrained, evidence-linked, and commercially usable.',
    'The PDF is preliminary advice subject to document review and current law/policy verification.',
    'Write the main advice as a senior migration agent letter, not as a criteria registry export. The main letter must contain a natural professional opinion, pathway analysis, risk analysis, evidence strategy and next professional step before any appendix-style material.',
    'Do not start prose sentences with action labels such as Verify, Confirm, Reconcile or Obtain. Convert them into natural legal advice, for example: The key issues are whether the agreement is current, whether the occupation is covered, and whether the nomination can be reconciled with the agreement terms.',
    'Use client-facing criterion labels. Avoid title-case machine labels such as Time Of Application And Time Of Decision Requirements Tracked. Use natural headings such as time-of-application and time-of-decision requirements.',
    'Avoid hidden control characters, object replacement characters and registry-backed wording in client-facing text.'
  ].join('\n');
  const requiredReasoning=[
    'For each mandatory criterion in the supplied criteria registry, create one criterion_findings item. Use the exact registry id in criterion_id and the registry label in criterion.',
    'Each criterion_findings item must expressly state whether the criterion appears satisfied, not satisfied, or cannot be confirmed.',
    'Each legal_consequence must explain the practical visa consequence of the finding.',
    'Each evidence_gap must name the missing or required evidence, not merely say more evidence is needed.',
    'Each recommendation must give the client an action, not generic advice.',
    'Quality flags must identify weaknesses in facts/evidence for internal review only; do not include internal system labels.',
    'Each finding should be fact-linked: refer to the actual questionnaire answer where available, and say when the answer is absent or unverified.',
    'Use client-safe wording: potentially blocking issue, not hard-fail; may result in refusal if not addressed, not will be refused unless legally certain.',
    'For executive_summary, recommendation, sections and client_next_steps, write complete professional sentences. Do not output bare labels or command-style fragments.',
    'If the selected stream is Labour Agreement, expressly address agreement currency, employer coverage, occupation coverage, nomination terms, concessions, salary/AMSR, English/age/skills concessions, and employer compliance as separate professional issues.'
  ].join('\n- ');
  const user=`Prepare structured preliminary advice for subclass ${subclass}.

MANDATORY LEGAL-REASONING METHOD:
- ${requiredReasoning}

${framework(m)}

MANDATORY CRITERIA REGISTRY. You must assess every mandatory criterion listed here. Do not omit, merge, rename, or replace registry criteria. Use the exact registry id in criterion_id.
${JSON.stringify(criteriaRegistry,null,2)}

MANDATORY KNOWLEDGEBASE LEGAL-SOURCE PACK. You must read and apply these sources before drafting. If the sources do not support a conclusion, say the issue requires manual legal review.
The sources are already ordered by authority. Apply them sequentially: Act -> Regulations -> Instruments -> PAMs. Do not reverse this hierarchy.
${JSON.stringify(legalPack,null,2)}

Deterministic decision-engine findings to treat as binding ground truth. Do not contradict or soften these findings:
${JSON.stringify(rules,null,2)}

Cleaned matter facts:
${JSON.stringify(facts,null,2)}`;
  const body={model:DEFAULT_MODEL,input:[{role:'system',content:[{type:'input_text',text:system}]},{role:'user',content:[{type:'input_text',text:user}]}],temperature:Number(process.env.OPENAI_ADVICE_TEMPERATURE||0.1),store:false,text:{format:{type:'json_schema',name:'migration_advice_letter_structured_legal_reasoning',strict:true,schema:schema()}}};
  const response=await fetch(OPENAI_URL,{method:'POST',headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error(`OpenAI advice generation failed: ${data.error&&data.error.message?data.error.message:response.statusText}`);
  const out=data.output_text || (Array.isArray(data.output)?data.output.flatMap(o=>o.content||[]).map(c=>c.text||'').join(''):'');
  if(!out) throw new Error('OpenAI advice generation returned no structured text.');
  return JSON.parse(out);
}
async function generateMigrationAdvice(assessment){
  // FIRST GATE: extract subclass and stream before any knowledgebase or GPT call.
  const extractedSubclass = extractVisaSubclass(assessment);
  if(!extractedSubclass) throw new Error('Visa subclass could not be identified. Knowledgebase-enforced advice generation blocked.');
  const selectedStream = extractSelectedStream(assessment);
  const assessmentForAdvice = { ...assessment, visa_type: extractedSubclass, selected_stream: selectedStream || assessment.selected_stream };
  const facts=structuredFacts(assessmentForAdvice);
  const subclass=normSubclass(extractedSubclass || facts.visa_subclass);
  const matrix=matrixFor(subclass);
  const rules=runDeterministicRules(subclass, facts.cleaned_answers||{});
  const legalPack=await buildKnowledgebaseLegalPack(assessmentForAdvice);
  assertKnowledgebasePack(legalPack);
  if(String(legalPack.subclass) !== String(subclass)) throw new Error('Knowledgebase subclass does not match extracted assessment subclass. Advice generation blocked.');
  const criteriaRegistry = loadCriteriaRegistry(subclass, selectedStream || legalPack.selectedStream || '');
  const advice=await callOpenAIForAdvice(facts,rules,legalPack,criteriaRegistry);
  const legalSourcePack={
    loadedAt:legalPack.loadedAt,
    root:legalPack.root,
    assessmentKind:legalPack.assessmentKind,
    subclass:legalPack.subclass,
    selectedStream:legalPack.selectedStream,
    subclassExtraction:legalPack.subclassExtraction,
    legalAuthorityOrder:legalPack.legalAuthorityOrder,
    hierarchyEnforced:legalPack.hierarchyEnforced,
    hierarchy:legalPack.hierarchy,
    documentCountScanned:legalPack.documentCountScanned,
    documentCountLoaded:legalPack.documentCountLoaded,
    knowledgebaseSnapshot: legalPack.knowledgebaseSnapshot,
    snapshotId: legalPack.snapshotId,
    sources:legalPack.sources.map(s=>({authority:s.authority,path:s.path,sha256:s.sha256,modified:s.modified,chars:s.chars}))
  };
  if(!legalSourcePack.sources || legalSourcePack.sources.length < 2) throw new Error('Knowledgebase-enforced adviceBundle missing legalSourcePack. Advice generation blocked.');
  const validatedAdvice = validateAdvice(advice,subclass,matrix);
  const legalVersionLock = buildLegalVersionLock(legalSourcePack);
  const contradictionFlags = detectContradictions(facts, validatedAdvice, rules);
  const evidenceSufficiencyMatrix = buildEvidenceSufficiencyMatrix(validatedAdvice, matrix);
  const registryBacked = buildRegistryBackedFindings({
    registry: criteriaRegistry,
    adviceBundle: { advice: validatedAdvice },
    legalPack: legalSourcePack,
    facts
  });
  validatedAdvice.seniorAgentNarrative = {
    standard: 'Senior migration-agent advice standard',
    clientFacingPurpose: 'The advice must read as a professional letter to the client, not as an internal registry report.',
    requiredTone: 'firm, careful, commercial and legally controlled',
    lodgementPosition: validatedAdvice.executive_summary || validatedAdvice.recommendation || 'Lodgement should not be recommended until original evidence and current-law checks support that position.',
    nextProfessionalStep: 'Proceed to a formal evidence review and lodgement-readiness assessment before filing.'
  };
  validatedAdvice.criterion_findings = registryBacked.findings;
  validatedAdvice.grantCriteriaFindings = registryBacked.findings;
  const criteriaCoverage = validateCriteriaCoverage(criteriaRegistry, {
    advice: validatedAdvice,
    grantCriteriaFindings: registryBacked.findings,
    criteriaRegistryFindings: registryBacked.findings
  }, legalSourcePack, facts);
  criteriaCoverage.totalRegistryCriteria = registryBacked.audit.totalRegistryCriteria;
  criteriaCoverage.mandatoryOrTriggeredRequired = registryBacked.audit.mandatoryOrTriggeredRequired;
  criteriaCoverage.mandatoryOrTriggeredAssessed = registryBacked.audit.mandatoryOrTriggeredAssessed;
  const clientSafetyFilter = buildClientSafetyFilter(validatedAdvice, contradictionFlags);
  const universalLegalGraph = buildUniversalLegalGraph({facts,matrix,legalSourcePack,evidenceSufficiencyMatrix,contradictionFlags});
  const researchGradeStrategicLayer = buildResearchGradeStrategicLayer({facts,rules,matrix,legalSourcePack,legalVersionLock,contradictionFlags,evidenceSufficiencyMatrix,universalLegalGraph});
  const internalLegalAudit = buildInternalLegalAudit({facts,rules,matrix,legalSourcePack,advice:validatedAdvice,legalVersionLock,contradictionFlags,evidenceSufficiencyMatrix,universalLegalGraph});
  internalLegalAudit.researchGradeStrategicLayer = researchGradeStrategicLayer;
  internalLegalAudit.universalLegalGraph = universalLegalGraph;
  internalLegalAudit.knowledgebaseSnapshot = legalSourcePack.knowledgebaseSnapshot;
  internalLegalAudit.criteriaRegistry = { registryVersion: criteriaRegistry.registryVersion, subclass: criteriaRegistry.subclass, mandatoryCriteriaCount: criteriaRegistry.mandatoryCriteriaCount, sourceFile: criteriaRegistry.sourceFile };
  internalLegalAudit.criteriaCoverage = criteriaCoverage;
  const bundle = {facts,rules,matrix,criteriaRegistry,criteriaCoverage,legalSourcePack,legalVersionLock,contradictionFlags,evidenceSufficiencyMatrix,clientSafetyFilter,universalLegalGraph,researchGradeStrategicLayer,internalLegalAudit,advice:validatedAdvice,model:DEFAULT_MODEL,knowledgebaseEnforced:true,criteriaRegistryEnforced:true,subclassFirstGate:true,legalHierarchyEnforced:true,dynamicKnowledgebaseLawUpdates:true,finalProductionControls:true,researchGradeStrategicIntelligence:true};
  assertFinalProductionControls(bundle);
  assertDynamicKnowledgebaseControls(bundle);
  assertResearchGradeControls(bundle);
  return bundle;
}
module.exports={generateMigrationAdvice,structuredFacts,validateAdvice,matrices,supportedSubclasses:()=>supportedSubclassCodes(),detectContradictions,buildEvidenceSufficiencyMatrix,buildLegalVersionLock,assertFinalProductionControls,buildUniversalLegalGraph,assertDynamicKnowledgebaseControls,buildResearchGradeStrategicLayer,assertResearchGradeControls,supportedSubclassCodes,criteriaRegistrySubclasses:()=>listSupportedCriteriaRegistrySubclasses()};
