const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const client = process.env.OPENAI_API_KEY ? new OpenAI({apiKey:process.env.OPENAI_API_KEY}) : null;
const SITE_TONE = 'Bircan Migration & Education: professional Australian migration advice, clear written assessment, client-friendly but legally precise.';
const VISA_METRICS={
  '482':['sponsor eligibility','occupation/ANZSCO alignment','skills and experience','English/licensing','genuine position','salary/market rate','health/character','lodgement readiness'],
  '186':['nomination validity','occupation and skills','work experience','English','age exemption','salary/market rate','employer viability','health/character'],
  '189':['points score','skills assessment','EOI competitiveness','English','age','occupation list','health/character'],
  '190':['state nomination fit','points score','skills assessment','commitment to state','English','occupation list','health/character'],
  '491':['regional nomination/sponsorship','points score','skills assessment','regional commitment','English','occupation list','health/character'],
  '500':['Genuine Student requirement','financial capacity','English','course progression','immigration history','health insurance','health/character'],
  '485':['stream eligibility','qualification fit','skills assessment if required','English','age','AFP/health insurance','lodgement timing'],
  '309':['relationship genuineness','financial aspect','household aspect','social aspect','commitment aspect','sponsor eligibility','health/character'],
  '820':['relationship genuineness','financial aspect','household aspect','social aspect','commitment aspect','sponsor eligibility','family violence pathway'],
  '866':['Convention ground','serious harm','well-founded fear','state protection','internal relocation','complementary protection','identity/credibility','health/security']
};
function kbSnippets(subclass){
  const dir=path.join(process.cwd(),'data','knowledgebase');
  if(!fs.existsSync(dir)) return [];
  const files=fs.readdirSync(dir).filter(f=>f.toLowerCase().includes(String(subclass).toLowerCase()) || f.toLowerCase().includes('general'));
  return files.slice(0,6).map(f=>({file:f, excerpt:fs.readFileSync(path.join(dir,f),'utf8').slice(0,2500)}));
}
async function analyseAssessment({type,subclass,answers={},extractedText='',paymentPlan='standard'}){
  const metrics=VISA_METRICS[String(subclass)] || ['eligibility','evidence','risk','readiness','next steps'];
  const knowledge=kbSnippets(subclass);
  const instruction=`${SITE_TONE}\nYou are preparing senior registered migration agent style written advice. Do not invent facts. Assess the client answers and attached documents against the relevant Australian migration pathway. Produce decisive, commercial-grade advice with: executive advice, legal determination, evidence strength matrix, risk rating, fatal/fixable issues, document checklist, next steps, and client-friendly conclusion. Use subclass-specific metrics: ${metrics.join(', ')}.`;
  const payload={type,subclass,paymentPlan,answers,extractedText:extractedText.slice(0,18000),knowledge};
  if(!client){
    return fallbackAnalysis({type,subclass,answers,metrics});
  }
  const completion=await client.chat.completions.create({model:process.env.OPENAI_MODEL_ANALYSIS||'gpt-4.1',temperature:0.2,messages:[{role:'system',content:instruction},{role:'user',content:JSON.stringify(payload)}],response_format:{type:'json_object'}});
  try{return JSON.parse(completion.choices[0].message.content);}catch{return {raw:completion.choices[0].message.content};}
}
function fallbackAnalysis({type,subclass,answers,metrics}){
  return {title:`${type} assessment — Subclass ${subclass||'General'}`,riskLevel:'Requires professional review',executiveAdvice:'Assessment received. OpenAI is not configured, so this fallback confirms intake only. Configure OPENAI_API_KEY for full legal reasoning.',legalDetermination:metrics.map(m=>({criterion:m,finding:'Requires assessment',reason:'Pending AI legal review and document extraction.'})),evidenceMatrix:metrics.map(m=>({area:m,strength:'Not assessed',issueType:'Pending'})),recommendedNextSteps:['Configure OpenAI key','Upload subclass policy files into data/knowledgebase','Re-run assessment from admin dashboard'],answers};
}
module.exports={analyseAssessment,VISA_METRICS};
