(function(){
  function findEmail(payload){return String(payload?.client?.email||payload?.applicant?.email||payload?.applicantEmail||payload?.email||'').trim().toLowerCase();}
  window.BircanAssessmentFlow={
    startLoginThenCheckout:function({assessmentPayload,plan,subclass}){
      const applicantEmail=findEmail(assessmentPayload);
      if(!applicantEmail){throw new Error('Applicant email address is required.');}
      sessionStorage.setItem('bircan_pending_assessment',JSON.stringify({assessmentPayload,plan,subclass,applicantEmail,savedAt:new Date().toISOString()}));
      location.href='/login.html?next='+encodeURIComponent('/checkout-start.html');
    }
  };
})();
