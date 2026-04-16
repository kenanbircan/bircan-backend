import nodemailer from 'nodemailer';

function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

export async function sendAdminNotification(submission) {
  const transporter = createTransporter();
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!transporter || !to) return false;

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject: `New Bircan Migration submission: ${submission.type}`,
    text: `Submission ${submission.id}\nType: ${submission.type}\nName: ${submission.name}\nEmail: ${submission.email}\nSummary: ${submission.summary || ''}`
  });
  return true;
}

export async function sendClientReceipt(submission) {
  const transporter = createTransporter();
  if (!transporter || !submission.email) return false;

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: submission.email,
    subject: 'Your Bircan Migration submission',
    text: `Thank you for your submission. Your reference is ${submission.id}.`
  });
  return true;
}
