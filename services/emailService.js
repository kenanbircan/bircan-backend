const nodemailer=require('nodemailer');
async function sendAdviceEmail({to,subject,body,attachments=[]}){ if(!process.env.SMTP_HOST) return {skipped:true,reason:'SMTP not configured'}; const tx=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:false,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}}); return tx.sendMail({from:process.env.MAIL_FROM,to,subject,html:body,attachments}); }
module.exports={sendAdviceEmail};
