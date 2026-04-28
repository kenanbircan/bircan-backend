(function(){
  function esc(s){return String(s||'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  async function downloadPdf(id){
    const res=await fetch(BircanAuth.backend()+'/api/assessment/'+encodeURIComponent(id)+'/pdf',{headers:BircanAuth.headers({'Accept':'application/pdf'}),credentials:'include'});
    if(!res.ok){let e='PDF is not ready yet.'; try{e=(await res.json()).error||e}catch{} throw new Error(e);}
    const blob=await res.blob(); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='bircan-assessment-'+id+'.pdf'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function itemHTML(s){const title=s?.client?.fullName||'Visa assessment'; const email=s?.client?.email||s?.stripeCustomerEmail||''; const plan=s?.visa?.selectedPlan||s?.metadata?.selectedPlan||'assessment'; const paid=s?.paymentStatus==='paid'?'Paid':(s?.paymentStatus||'Pending'); const stage=s?.pdfStatus==='ready'?'PDF ready':(paid==='Paid'?'Processing':'Awaiting payment'); return `<div class="item"><div><strong>${esc(title)}</strong><div class="meta"><span class="pill gray">${esc(email)}</span><span class="pill gray">${esc(plan)}</span><span class="pill ${paid==='Paid'?'green':'gray'}">${esc(paid)}</span><span class="pill gray">${esc(stage)}</span></div></div><button class="btn secondary" data-pdf-id="${esc(s.id)}">Download PDF</button></div>`;}
  async function init(){
    const qs=new URLSearchParams(location.search); const sessionId=qs.get('session_id'); const checkout=qs.get('checkout');
    if(window.year) year.textContent=new Date().getFullYear();
    try{
      let data;
      if(checkout==='success'&&sessionId){data=await BircanAuth.api('/api/stripe/verify-session?session_id='+encodeURIComponent(sessionId));}
      else {data=await BircanAuth.api('/api/account/dashboard');}
      if(window.clientName) clientName.textContent=data?.user?.fullName?' '+data.user.fullName:'';
      if(window.paymentBadge){paymentBadge.className='badge'; paymentBadge.textContent='Verified';}
      if(window.spinner) spinner.style.display='none';
      if(window.verifyTitle) verifyTitle.textContent='Logged in';
      if(window.verifyText) verifyText.textContent='Your secure dashboard is attached to your account.';
      const list=data?.visaAssessments||[];
      if(window.visaList) visaList.innerHTML=list.length?list.map(itemHTML).join(''):'<div class="empty" style="margin-top:14px"><strong>No paid visa assessment found yet.</strong><br><span class="muted">Submit an assessment, login with the same email address, and complete checkout.</span></div>';
      if(window.citizenshipList) citizenshipList.innerHTML='<div class="empty" style="margin-top:14px"><strong>No citizenship test package found yet.</strong><br><span class="muted">Purchase a package to unlock paid exam mode.</span></div>';
    }catch(err){
      if(window.paymentBadge){paymentBadge.className='badge error'; paymentBadge.textContent='Action needed';}
      if(window.spinner) spinner.style.display='none';
      if(window.verifyTitle) verifyTitle.textContent='Login required';
      if(window.verifyText) verifyText.textContent='Please login using the same email address entered in the assessment form.';
      if(window.notice){notice.textContent=err?.error||'Authentication is required.'; notice.classList.add('show');}
      setTimeout(()=>location.href='/login.html?next='+encodeURIComponent(location.href),900);
    }
    document.addEventListener('click',async(e)=>{const id=e.target?.dataset?.pdfId; if(!id)return; e.preventDefault(); e.target.disabled=true; const old=e.target.textContent; e.target.textContent='Preparing PDF...'; try{await downloadPdf(id)}catch(err){alert(err.message)} finally{e.target.disabled=false; e.target.textContent=old;}});
    const logout=document.getElementById('logoutBtn'); if(logout) logout.addEventListener('click',async()=>{await BircanAuth.logout(); location.href='/login.html';});
  }
  window.BircanDashboard={init,downloadPdf};
})();
