const fs=require('fs'); const path=require('path');
const dir=path.join(__dirname,'criteriaRegistry');
const files=fs.readdirSync(dir).filter(f=>/^subclass\d+\.json$/.test(f));
const report=[]; let ok=true;
for(const f of files){
 const d=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
 const streams=d.streams||{}; let criteria=0, bad=[];
 for(const [sn,st] of Object.entries(streams)){ const arr=st.grantCriteria||st.criteria||[]; criteria+=arr.length; arr.forEach((c,i)=>{ if(c.schedule!=='Schedule 2') bad.push(`${sn}[${i}] schedule`); if(!c.clause) bad.push(`${sn}[${i}] clause`); if(!c.timePoint) bad.push(`${sn}[${i}] timePoint`); if(!c.manualClauseAudit) bad.push(`${sn}[${i}] manualClauseAudit`); if(!c.sourceMap||!c.sourceMap.sourceHash) bad.push(`${sn}[${i}] sourceHash`); if(!c.intakeMapping) bad.push(`${sn}[${i}] intakeMapping`); if(!c.pdfMapping) bad.push(`${sn}[${i}] pdfMapping`); }); }
 const schedule1OK=d.validApplicationRequirements?.notGrantCriteria===true;
 const score=d.coverageScoring?.v9EstimatedSchedule2CoverageReadiness||0;
 const entry={file:f, subclass:d.subclass, criteriaItems:criteria, expectedClauseCount:d.expectedGrantCriteriaManifest?.expectedClauseCount||0, schedule1Excluded:schedule1OK, score, issues:bad.slice(0,20)};
 if(!schedule1OK||bad.length) ok=false;
 report.push(entry);
}
console.log(JSON.stringify({ok, files:files.length, report}, null, 2));
if(!ok) process.exit(1);
