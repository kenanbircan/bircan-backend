import nodemailer from "nodemailer";

export function createMailer() {
  const secure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

export async function sendAssessmentEmail({
  to,
  subject,
  text,
  html,
  attachmentPath,
  attachmentFilename = "assessment-letter.pdf"
}) {
  const transporter = createMailer();

  return transporter.sendMail({
    from: process.env.EMAIL_FROM,
    replyTo: process.env.EMAIL_REPLY_TO || process.env.EMAIL_FROM,
    to,
    bcc: process.env.ADMIN_EMAIL || undefined,
    subject,
    text,
    html,
    attachments: attachmentPath
      ? [
          {
            filename: attachmentFilename,
            path: attachmentPath
          }
        ]
      : []
  });
}
