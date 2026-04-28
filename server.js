import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import Stripe from "stripe";
import {
  listSubmissions,createSubmission,getSubmission,updateSubmission,listSubmissionsByUser,listDocumentsByUser,
  updateSubmissionByCheckoutSession,upsertDocument,getDocumentForSubmission,audit
} from "./storage.js";

const app=express(); app.set("trust proxy",1);
const PORT=Number(process.env.PORT||4242);
const JWT_SECRET=process.env.JWT_SECRET||process.env.SESSION_SECRET||"CHANGE_ME_IN_RENDER";
const STRIPE_MODE=String(process.env.STRIPE_MODE||"test").toLowerCase()==="live"?"live":"test";
const STRIPE_SECRET_KEY=STRIPE_MODE==="live"?(process.env.STRIPE_SECRET_KEY_LIVE||process.env.STRIPE_SECRET_KEY):(process.env.STRIPE_SECRET_KEY_TEST||process.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET=STRIPE_MODE==="live"?process.env.STRIPE_WEBHOOK_SECRET_LIVE:process.env.STRIPE_WEBHOOK_SECRET_TEST;
const stripe=STRIPE_SECRET_KEY?new Stripe(STRIPE_SECRET_KEY):null;
const APP_BASE_URL=(process.env.APP_BASE_URL||"https://bircanmigration.au").replace(/\/$/,"");
const BACKEND_BASE_URL=(process.env.BACKEND_BASE_URL||process.env.RENDER_EXTERNAL_URL||"").replace(/\/$/,"");
const allowedOrigins=(process.env.ALLOWED_ORIGINS||"https://bircanmigration.au,https://www.bircanmigration.au,https://bircanmigration.com.au,https://www.bircanmigration.com.au,https://assessment.bircanmigration.au,http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000,http://127.0.0.1:3000").split(",").map(v=>v.trim()).filter(Boolean);

app.use(cors({origin(origin,cb){if(!origin||allowedOrigins.includes(origin))return cb(null,true);return cb(new Error(`CORS blocked origin: ${origin}`));},credentials:true}));

async function markCheckoutPaid(session){
  const email=normalizeEmail(session.customer_details?.email||session.customer_email||session.metadata?.email||"");
  const patch={paymentStatus:"paid",status:"paid",checkoutSessionId:session.id,stripePaymentIntentId:String(session.payment_intent||""),stripeCustomerEmail:email,paidAt:new Date().toISOString()};
  let updated=session.metadata?.submissionId?updateSubmission(session.metadata.submissionId,patch):null;
  if(!updated) updated=updateSubmissionByCheckoutSession(session.id,patch);
  if(updated){ audit("payment.paid",{userId:updated.userId||updated.metadata?.userId,email,submissionId:updated.id,checkoutSessionId:session.id}); }
  return updated;
}

app.post("/api/stripe/webhook", express.raw({type:"application/json"}), async(req,res)=>{
  if(!stripe) return res.status(500).send("Stripe not configured");
  let event;
  try{event=STRIPE_WEBHOOK_SECRET?stripe.webhooks.constructEvent(req.body,req.headers["stripe-signature"],STRIPE_WEBHOOK_SECRET):JSON.parse(req.body.toString("utf8"));}
  catch(err){return res.status(400).send(`Webhook Error: ${err.message}`);}
  try{ if(event.type==="checkout.session.completed"||event.type==="checkout.session.async_payment_succeeded") await markCheckoutPaid(event.data.object); res.json({received:true}); }
  catch(err){ console.error(err); res.status(500).json({received:false,error:err.message}); }
});

app.use(express.json({limit:"5mb"})); app.use(cookieParser()); app.use(express.static(process.cwd()));

const usersFile=process.env.USERS_FILE||"./data/users.json";
function ensureDir(filePath){fs.mkdirSync(path.dirname(filePath),{recursive:true});}
function loadUsers(){ensureDir(usersFile); if(!fs.existsSync(usersFile))fs.writeFileSync(usersFile,JSON.stringify({users:{}},null,2)); try{return JSON.parse(fs.readFileSync(usersFile,"utf8"));}catch{return {users:{}};}}
function saveUsers(db){ensureDir(usersFile); fs.writeFileSync(usersFile,JSON.stringify(db,null,2));}
function normalizeEmail(v){return String(v||"").trim().toLowerCase();}
function publicUser(user){return {id:user.id||user.sub,email:normalizeEmail(user.email),fullName:user.fullName||""};}
function signToken(user){return jwt.sign({sub:user.id||user.sub,email:normalizeEmail(user.email),fullName:user.fullName||""},JWT_SECRET,{expiresIn:"30d"});}
function setAuthCookie(res,token){res.cookie("bm_auth",token,{httpOnly:true,secure:true,sameSite:"none",path:"/",maxAge:30*24*60*60*1000});}
function clearAuthCookie(res){res.clearCookie("bm_auth",{httpOnly:true,secure:true,sameSite:"none",path:"/"});}
function getBearer(req){const h=req.headers.authorization||""; if(h.toLowerCase().startsWith("bearer "))return h.slice(7).trim(); return req.headers["x-auth-token"]||req.cookies?.bm_auth||"";}
function requireAuth(req,res,next){const token=getBearer(req); if(!token)return res.status(401).json({ok:false,error:"Login required."}); try{req.user=jwt.verify(token,JWT_SECRET); next();}catch{return res.status(401).json({ok:false,error:"Invalid or expired login."});}}
function canonicalVisaPlan(value){const x=String(value||"").trim().toLowerCase().replace(/[^a-z0-9]+/g,""); if(["instant","fastest","fast","immediate","priority","express","sameday","today","urgent","premium"].includes(x))return"instant"; if(["24h","24hr","24hrs","24hour","24hours","recommended","standard","normal","regular"].includes(x))return"24h"; if(["3d","3day","3days","72h","72hours","economy","value","budget","basic"].includes(x))return"3d"; return"";}
function visaPriceMap(){return STRIPE_MODE==="live"?{instant:process.env.STRIPE_PRICE_VISA_INSTANT_LIVE||process.env.STRIPE_PRICE_VISA_INSTANT,"24h":process.env.STRIPE_PRICE_VISA_24H_LIVE||process.env.STRIPE_PRICE_VISA_24H,"3d":process.env.STRIPE_PRICE_VISA_3D_LIVE||process.env.STRIPE_PRICE_VISA_3D}:{instant:process.env.STRIPE_PRICE_VISA_INSTANT_TEST||process.env.STRIPE_PRICE_VISA_INSTANT,"24h":process.env.STRIPE_PRICE_VISA_24H_TEST||process.env.STRIPE_PRICE_VISA_24H,"3d":process.env.STRIPE_PRICE_VISA_3D_TEST||process.env.STRIPE_PRICE_VISA_3D};}
function safeReturnUrl(raw,fallback){const value=String(raw||"").trim(); if(!value)return fallback; try{const parsed=new URL(value); if(allowedOrigins.includes(parsed.origin))return value;}catch{} return fallback;}
function successUrlFromRequest(req){return safeReturnUrl(req.body?.successUrl,`${APP_BASE_URL}/account-dashboard.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`);}
function cancelUrlFromRequest(req){return safeReturnUrl(req.body?.cancelUrl,`${APP_BASE_URL}/account-dashboard.html?checkout=cancelled`);}
function extractApplicantEmail(payload={},body={}){return normalizeEmail(payload?.client?.email||payload?.applicant?.email||payload?.applicantEmail||payload?.email||body?.clientEmail||body?.applicantEmail||body?.email||"");}
function extractApplicantName(payload={},body={}){return String(payload?.client?.fullName||payload?.applicant?.fullName||payload?.fullName||body?.fullName||"").trim();}
function assertSameClientEmail(req,res,applicantEmail){const accountEmail=normalizeEmail(req.user?.email); if(!applicantEmail){res.status(400).json({ok:false,code:"APPLICANT_EMAIL_REQUIRED",error:"Applicant email address is required before payment."});return false;} if(accountEmail!==applicantEmail){audit("security.email_mismatch",{userId:req.user?.sub,accountEmail,applicantEmail}); res.status(403).json({ok:false,code:"EMAIL_MISMATCH",error:"This assessment must be submitted from the same email address as the logged-in account.",applicantEmail,accountEmail});return false;} return true;}
function ownsSubmission(user,item){const email=normalizeEmail(user?.email); const userId=String(user?.sub||user?.id||""); const itemEmail=normalizeEmail(item?.client?.email||item?.stripeCustomerEmail||item?.metadata?.clientEmail||item?.metadata?.applicantEmail); const itemUser=String(item?.userId||item?.metadata?.userId||""); return (userId&&itemUser===userId)||(email&&itemEmail===email);}
function pdfBufferFor(item){const lines=["Bircan Migration & Education","Visa Assessment Download","","Assessment ID: "+item.id,"Client: "+(item.client?.fullName||""),"Email: "+(item.client?.email||""),"Subclass: "+(item.visa?.subclass||""),"Plan: "+(item.visa?.selectedPlan||""),"Payment: "+(item.paymentStatus||""),"Status: "+(item.status||""),"Generated: "+new Date().toISOString()]; const text=lines.join("\\n").replace(/[()\\]/g,"\\$&"); const stream=`BT /F1 12 Tf 72 760 Td 14 TL (${text.replace(/\\n/g,") Tj T* (")}) Tj ET`; const objs=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]; let pdf="%PDF-1.4\n"; const x=[0]; objs.forEach((o,i)=>{x.push(Buffer.byteLength(pdf)); pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;}); const start=Buffer.byteLength(pdf); pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`; x.slice(1).forEach(n=>pdf+=String(n).padStart(10,"0")+" 00000 n \n"); pdf+=`trailer << /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`; return Buffer.from(pdf);}


function safeFileName(value, fallback = "visa-assessment.pdf") {
  const raw = String(value || fallback).trim();
  const clean = raw.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  return clean.toLowerCase().endsWith(".pdf") ? clean : `${clean}.pdf`;
}
function resolvePdfSource(item) {
  const doc = getDocumentForSubmission(item.id) || null;
  const candidates = [
    doc?.filePath, doc?.path, doc?.pdfPath, doc?.localPath, doc?.storagePath,
    item?.pdf?.filePath, item?.pdf?.path, item?.pdf?.pdfPath, item?.pdf?.localPath, item?.pdf?.storagePath,
    item?.pdfPath, item?.documentPath, item?.generatedPdfPath
  ].filter(Boolean);
  for (const raw of candidates) {
    const candidate = String(raw).trim();
    if (!candidate || /^https?:\/\//i.test(candidate)) continue;
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
      return { kind: "file", absolute, filename: safeFileName(doc?.filename || item?.pdf?.filename || path.basename(absolute) || `bircan-assessment-${item.id}.pdf`) };
    }
  }
  const base64 = doc?.base64 || doc?.pdfBase64 || item?.pdf?.base64 || item?.pdf?.pdfBase64 || item?.generatedPdfBase64;
  if (base64) {
    const clean = String(base64).replace(/^data:application\/pdf;base64,/, "");
    return { kind: "buffer", buffer: Buffer.from(clean, "base64"), filename: safeFileName(doc?.filename || item?.pdf?.filename || `bircan-assessment-${item.id}.pdf`) };
  }
  return { kind: "missing", doc };
}
function sendStoredAssessmentPdf(req, res) {
  const item = getSubmission(req.params.id);
  if (!item) return res.status(404).json({ ok:false, code:"ASSESSMENT_NOT_FOUND", error:"Assessment was not found." });
  if (!ownsSubmission(req.user,item)) return res.status(403).json({ ok:false, code:"ASSESSMENT_FORBIDDEN", error:"This assessment does not belong to the logged-in account." });
  if (item.paymentStatus !== "paid") return res.status(402).json({ ok:false, code:"PAYMENT_NOT_VERIFIED", error:"PDF download is available after payment is verified." });
  const source = resolvePdfSource(item);
  if (source.kind === "missing") {
    return res.status(404).json({
      ok:false,
      code:"PDF_NOT_READY",
      error:"The generated visa assessment PDF is not ready yet. The dashboard will show the download once the stored assessment PDF is available."
    });
  }
  audit("document.download",{userId:req.user.sub,email:req.user.email,submissionId:item.id});
  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition",`attachment; filename="${source.filename}"`);
  if (source.kind === "file") return res.sendFile(source.absolute);
  return res.send(source.buffer);
}

app.get("/api/health",(req,res)=>{const prices=visaPriceMap(); res.json({ok:true,service:"bircan-migration-backend",stripeMode:STRIPE_MODE,stripeConfigured:Boolean(stripe),webhookConfigured:Boolean(STRIPE_WEBHOOK_SECRET),appBaseUrl:APP_BASE_URL,backendBaseUrl:BACKEND_BASE_URL||null,allowedOrigins,auth:"httpOnly-cookie-plus-authorization-fallback",visaPrices:{instant:Boolean(prices.instant),"24h":Boolean(prices["24h"]),"3d":Boolean(prices["3d"])}});});
app.post("/api/auth/register",async(req,res)=>{const email=normalizeEmail(req.body?.email); const password=String(req.body?.password||""); const fullName=String(req.body?.fullName||"").trim(); const expectedEmail=normalizeEmail(req.body?.expectedEmail||req.body?.applicantEmail||""); if(!email||!password)return res.status(400).json({ok:false,error:"Email and password are required."}); if(expectedEmail&&email!==expectedEmail)return res.status(403).json({ok:false,code:"EMAIL_MISMATCH",error:"Please create the account using the same email address entered in the assessment form.",expectedEmail,accountEmail:email}); const db=loadUsers(); if(db.users[email])return res.status(409).json({ok:false,error:"An account already exists for this email."}); const user={id:`usr_${Date.now()}_${Math.random().toString(36).slice(2,10)}`,email,fullName,passwordHash:await bcrypt.hash(password,10),createdAt:new Date().toISOString()}; db.users[email]=user; saveUsers(db); const token=signToken(user); setAuthCookie(res,token); audit("auth.register",{userId:user.id,email}); res.json({ok:true,token,user:publicUser(user)});});
app.post("/api/auth/login",async(req,res)=>{const email=normalizeEmail(req.body?.email); const password=String(req.body?.password||""); const expectedEmail=normalizeEmail(req.body?.expectedEmail||req.body?.applicantEmail||""); if(expectedEmail&&email!==expectedEmail)return res.status(403).json({ok:false,code:"EMAIL_MISMATCH",error:"Please log in using the same email address entered in the assessment form.",expectedEmail,accountEmail:email}); const db=loadUsers(); const user=db.users[email]; if(!user||!(await bcrypt.compare(password,user.passwordHash)))return res.status(401).json({ok:false,error:"Invalid email or password."}); const token=signToken(user); setAuthCookie(res,token); audit("auth.login",{userId:user.id,email}); res.json({ok:true,token,user:publicUser(user)});});
app.get("/api/auth/me",requireAuth,(req,res)=>res.json({ok:true,user:publicUser(req.user)}));
app.post("/api/auth/logout",(req,res)=>{audit("auth.logout",{userId:req.user?.sub,email:req.user?.email}); clearAuthCookie(res); res.json({ok:true});});
app.get("/api/account/dashboard",requireAuth,(req,res)=>res.json({ok:true,user:publicUser(req.user),visaAssessments:listSubmissionsByUser(req.user,100),documents:listDocumentsByUser(req.user,100)}));
app.post("/api/assessment/create-checkout-session",requireAuth,async(req,res)=>{if(!stripe)return res.status(500).json({ok:false,error:`Stripe is not configured for ${STRIPE_MODE} mode.`}); const assessmentPayload=req.body?.assessmentPayload||{}; const applicantEmail=extractApplicantEmail(assessmentPayload,req.body); if(!assertSameClientEmail(req,res,applicantEmail))return; const plan=canonicalVisaPlan(req.body?.plan||req.body?.selectedPlan||req.body?.selectedPlanKey||req.body?.planCode||assessmentPayload?.plan||assessmentPayload?.selectedPlan); if(!plan)return res.status(400).json({ok:false,error:"Invalid visa assessment plan. Use instant, 24h, or 3d."}); const prices=visaPriceMap(); const priceId=prices[plan]; if(!priceId)return res.status(500).json({ok:false,error:`Missing Stripe Price ID for ${plan} in ${STRIPE_MODE} mode.`}); const fullName=extractApplicantName(assessmentPayload,req.body)||req.user.fullName||""; const submission=createSubmission({...assessmentPayload,email:applicantEmail,fullName,userId:req.user.sub,visaSubclass:req.body?.subclass||assessmentPayload?.subclass||assessmentPayload?.visaSubclass||"",selectedPlan:plan,metadata:{...(assessmentPayload?.metadata||{}),userId:req.user.sub,accountEmail:normalizeEmail(req.user.email),clientEmail:applicantEmail,applicantEmail,selectedPlan:plan,stripeMode:STRIPE_MODE}}); const session=await stripe.checkout.sessions.create({mode:"payment",customer_email:applicantEmail,line_items:[{price:priceId,quantity:1}],success_url:successUrlFromRequest(req),cancel_url:cancelUrlFromRequest(req),metadata:{product:"visa_assessment",plan,selectedPlan:plan,userId:req.user.sub,email:applicantEmail,accountEmail:normalizeEmail(req.user.email),submissionId:submission.id,subclass:String(req.body?.subclass||assessmentPayload?.subclass||assessmentPayload?.visaSubclass||"")}}); updateSubmission(submission.id,{checkoutSessionId:session.id,status:"checkout_created",paymentStatus:"pending",stripeCustomerEmail:applicantEmail,visa:{...submission.visa,selectedPlan:plan}}); audit("checkout.created",{userId:req.user.sub,email:applicantEmail,submissionId:submission.id,checkoutSessionId:session.id,plan}); res.json({ok:true,url:session.url,sessionId:session.id,plan,applicantEmail,priceId});});
app.get("/api/stripe/verify-session",requireAuth,async(req,res)=>{if(!stripe)return res.status(500).json({ok:false,error:`Stripe is not configured for ${STRIPE_MODE} mode.`}); const sessionId=String(req.query.session_id||"").trim(); if(!sessionId)return res.status(400).json({ok:false,error:"Missing session_id."}); const session=await stripe.checkout.sessions.retrieve(sessionId); if(!session||session.payment_status!=="paid")return res.status(402).json({ok:false,error:"Payment has not been verified as paid."}); const sessionEmail=normalizeEmail(session.customer_details?.email||session.customer_email||session.metadata?.email||""); if(!assertSameClientEmail(req,res,sessionEmail))return; const updated=await markCheckoutPaid(session); res.json({ok:true,verified:true,product:session.metadata?.product||"visa_assessment",plan:canonicalVisaPlan(session.metadata?.plan||session.metadata?.selectedPlan),email:sessionEmail,submission:updated,user:publicUser(req.user),visaAssessments:listSubmissionsByUser(req.user,100),documents:listDocumentsByUser(req.user,100)});});
app.get("/api/assessment/:id/status",requireAuth,(req,res)=>{const item=getSubmission(req.params.id); if(!item)return res.status(404).json({ok:false,error:"Assessment was not found."}); if(!ownsSubmission(req.user,item))return res.status(403).json({ok:false,error:"This assessment does not belong to the logged-in account."}); res.json({ok:true,submission:item,...item});});
app.get("/api/assessment/:id/pdf",requireAuth,sendStoredAssessmentPdf);
app.get("/api/assessments/:id/pdf",requireAuth,sendStoredAssessmentPdf);
app.get("/api/admin/review-queue",requireAuth,(req,res)=>{const email=normalizeEmail(req.user.email); if(!email.endsWith("@bircanmigration.au")&&!email.endsWith("@bircanmigration.com.au"))return res.status(403).json({ok:false,error:"Admin access required."}); res.json({ok:true,queue:listSubmissions(100).filter(x=>x.paymentStatus==="paid"&&x.pdfStatus!=="ready")});});
app.use((err,req,res,next)=>{console.error(err); res.status(500).json({ok:false,error:err.message||"Server error"});});
app.listen(PORT,()=>console.log(`Bircan backend running on :${PORT} mode=${STRIPE_MODE}`));
