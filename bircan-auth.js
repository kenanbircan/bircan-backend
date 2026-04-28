(function(){
  const DEFAULT_BACKEND='https://bircan-migration-backend.onrender.com';
  function backend(){return (window.BIRCAN_BACKEND_URL||DEFAULT_BACKEND).replace(/\/$/,'');}
  function token(){return localStorage.getItem('bircan_token')||localStorage.getItem('bm_token')||'';}
  function setToken(t){ if(t){ localStorage.setItem('bircan_token',t); localStorage.setItem('bm_token',t); } }
  function clearToken(){['bircan_token','bm_token','citizenshipToken','auth_token'].forEach(k=>localStorage.removeItem(k));}
  function headers(extra){const h={'Content-Type':'application/json',...(extra||{})}; const t=token(); if(t) h.Authorization='Bearer '+t; return h;}
  async function api(path,opt={}){const res=await fetch(backend()+path,{credentials:'include',...opt,headers:{...headers(),...(opt.headers||{})}}); let data={}; try{data=await res.json()}catch{data={error:await res.text()}} if(!res.ok) throw data; return data;}
  async function me(){return api('/api/auth/me');}
  async function login(body){const data=await api('/api/auth/login',{method:'POST',body:JSON.stringify(body)}); setToken(data.token); return data;}
  async function register(body){const data=await api('/api/auth/register',{method:'POST',body:JSON.stringify(body)}); setToken(data.token); return data;}
  async function logout(){try{await api('/api/auth/logout',{method:'POST',body:'{}'});}catch{} clearToken();}
  function getPendingAssessment(){let p={}; try{p=JSON.parse(sessionStorage.getItem('bircan_pending_assessment')||localStorage.getItem('bircan_pending_visa_checkout')||'{}')}catch{} return p||{};}
  function savePendingAssessment(p){sessionStorage.setItem('bircan_pending_assessment',JSON.stringify(p)); localStorage.setItem('bircan_pending_visa_checkout',JSON.stringify(p));}
  function clearPendingAssessment(){sessionStorage.removeItem('bircan_pending_assessment'); localStorage.removeItem('bircan_pending_visa_checkout');}
  window.BircanAuth={backend,token,setToken,clearToken,headers,api,me,login,register,logout,getPendingAssessment,savePendingAssessment,clearPendingAssessment};
})();
