(function(){
  function emailFromPayload(payload){return String(payload?.client?.email||payload?.applicant?.email||payload?.applicantEmail||payload?.email||'').trim().toLowerCase();}
  function canonicalPlan(v){const x=String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,''); if(['instant','fastest','fast','immediate','priority','express','urgent','premium'].includes(x))return'instant'; if(['24h','24hr','24hrs','24hour','24hours','recommended','standard','normal'].includes(x))return'24h'; if(['3d','3day','3days','72h','72hours','economy','value','budget'].includes(x))return'3d'; return x||'';}
  async function startLoginThenCheckout({assessmentPayload,plan,subclass,returnUrl}){
    const applicantEmail=emailFromPayload(assessmentPayload);
    if(!applicantEmail) throw new Error('Applicant email address is required before checkout.');
    const selectedPlan=canonicalPlan(plan||assessmentPayload?.selectedPlan||assessmentPayload?.plan);
    const pending={assessmentPayload:{...assessmentPayload,client:{...(assessmentPayload.client||{}),email:applicantEmail},email:applicantEmail},plan:selectedPlan,subclass:subclass||assessmentPayload?.subclass||assessmentPayload?.visaSubclass||'',applicantEmail,returnUrl:returnUrl||location.href,savedAt:new Date().toISOString()};
    BircanAuth.savePendingAssessment(pending);
    location.href='/login.html?next='+encodeURIComponent('/checkout-start.html');
  }
  async function createCheckoutFromPending(){
    const pending=BircanAuth.getPendingAssessment();
    if(!pending.assessmentPayload) throw new Error('Missing assessment details. Please return to the assessment form and submit again.');
    const applicantEmail=(pending.applicantEmail||emailFromPayload(pending.assessmentPayload)).toLowerCase();
    const me=(await BircanAuth.me()).user;
    if(String(me.email||'').toLowerCase()!==applicantEmail){throw new Error('This assessment was completed with '+applicantEmail+', but you are logged in as '+me.email+'. Please use the same email address.');}
    const payload={...pending.assessmentPayload,client:{...(pending.assessmentPayload.client||{}),email:me.email},email:me.email};
    const data=await BircanAuth.api('/api/assessment/create-checkout-session',{method:'POST',body:JSON.stringify({assessmentPayload:payload,plan:canonicalPlan(pending.plan),subclass:pending.subclass,successUrl:location.origin+'/account-dashboard.html?checkout=success&session_id={CHECKOUT_SESSION_ID}',cancelUrl:pending.returnUrl||location.origin+'/account-dashboard.html?checkout=cancelled'})});
    BircanAuth.clearPendingAssessment();
    location.href=data.url;
  }
  window.BircanAssessmentFlow={startLoginThenCheckout,createCheckoutFromPending,emailFromPayload,canonicalPlan};
})();
