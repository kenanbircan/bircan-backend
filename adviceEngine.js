'use strict';
const matrices = require('./advice-matrices.json');
const { evaluateDecisionEngine } = require('./decisionEngines');
const DEFAULT_MODEL = process.env.OPENAI_ADVICE_MODEL || process.env.OPENAI_MODEL || 'gpt-5.5';
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
function matrixFor(subclass){ const code=normSubclass(subclass); const m=matrices[code]; if(!m) throw new Error(`Unsupported visa subclass for advice engine: ${code || 'unknown'}. Supported: ${Object.keys(matrices).sort().join(', ')}`); return {subclass:code, ...m}; }
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
function schema(){ return {type:'object',additionalProperties:false,required:['subclass','risk_level','lodgement_position','title','sections','criterion_findings','evidence_required','client_next_steps','quality_flags','disclaimer'],properties:{subclass:{type:'string',enum:Object.keys(matrices)},risk_level:{type:'string',enum:['LOW','MEDIUM','HIGH','CRITICAL']},lodgement_position:{type:'string',enum:['SUITABLE_TO_PROCEED','PROCEED_AFTER_EVIDENCE_REVIEW','DO_NOT_LODGE_NOW','INVALID_OR_NOT_AVAILABLE','MANUAL_LEGAL_REVIEW_REQUIRED']},title:{type:'string'},sections:{type:'array',minItems:7,maxItems:10,items:{type:'object',additionalProperties:false,required:['heading','body'],properties:{heading:{type:'string'},body:{type:'string'}}}},criterion_findings:{type:'array',minItems:6,maxItems:22,items:{type:'object',additionalProperties:false,required:['criterion','finding','legal_consequence','evidence_gap','recommendation'],properties:{criterion:{type:'string'},finding:{type:'string'},legal_consequence:{type:'string'},evidence_gap:{type:'string'},recommendation:{type:'string'}}}},evidence_required:{type:'array',minItems:4,maxItems:30,items:{type:'string'}},client_next_steps:{type:'array',minItems:3,maxItems:15,items:{type:'string'}},quality_flags:{type:'array',maxItems:15,items:{type:'string'}},disclaimer:{type:'string'}}}; }
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
    advice.quality_flags.push(`Weak/generic GPT wording detected and downgraded for manual review: ${triggered.join(', ')}`);
    advice.risk_level='HIGH';
    advice.lodgement_position='MANUAL_LEGAL_REVIEW_REQUIRED';
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
async function callOpenAIForAdvice(facts, rules){
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
    'Use only the supplied subclass matrix, deterministic findings, and cleaned matter facts.',
    'Do not invent facts, evidence, dates, employment history, relationship facts, points, nominations, invitations, or legal provisions.',
    'If a required fact is absent, write: cannot be confirmed from the questionnaire.',
    'Every criterion finding must use this reasoning chain: criterion -> relevant facts from questionnaire -> evidence gap -> legal consequence -> recommendation.',
    'Separate validity / time-of-application issues from grant / time-of-decision issues.',
    'Apply hard-fail triggers firmly. If a hard-fail or bar may apply, state that lodgement should not proceed until resolved.',
    'Do not use placeholders, sample labels, known issue text, AI disclaimers, or broad risk labels without reasons.',
    'Do not dump raw questionnaire answers. Convert them into findings.',
    'Write in firm Registered Migration Agent style: precise, restrained, evidence-linked, and commercially usable.',
    'The PDF is preliminary advice subject to document review and current law/policy verification.'
  ].join('\n');
  const requiredReasoning=[
    'For each primary criterion in the subclass matrix, create one criterion_findings item unless clearly irrelevant.',
    'Each criterion_findings item must expressly state whether the criterion appears satisfied, not satisfied, or cannot be confirmed.',
    'Each legal_consequence must explain the practical visa consequence of the finding.',
    'Each evidence_gap must name the missing or required evidence, not merely say more evidence is needed.',
    'Each recommendation must give the client an action, not generic advice.',
    'Quality flags must identify weaknesses in facts/evidence for internal review only; do not include internal system labels.',
    'Each finding should be fact-linked: refer to the actual questionnaire answer where available, and say when the answer is absent or unverified.',
    'Use client-safe wording: potentially blocking issue, not hard-fail; may result in refusal if not addressed, not will be refused unless legally certain.'
  ].join('\n- ');
  const user=`Prepare structured preliminary advice for subclass ${subclass}.

MANDATORY LEGAL-REASONING METHOD:
- ${requiredReasoning}

${framework(m)}

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
async function generateMigrationAdvice(assessment){ const facts=structuredFacts(assessment); const subclass=normSubclass(facts.visa_subclass); const matrix=matrixFor(subclass); const rules=runDeterministicRules(subclass, facts.cleaned_answers||{}); const advice=await callOpenAIForAdvice(facts,rules); return {facts,rules,matrix,advice:validateAdvice(advice,subclass,matrix),model:DEFAULT_MODEL}; }
module.exports={generateMigrationAdvice,structuredFacts,validateAdvice,matrices,supportedSubclasses:()=>Object.keys(matrices).sort()};
