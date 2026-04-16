import nodemailer from "nodemailer";

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

export function createTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

function businessFooterHtml() {
  return `
    <p style="margin:24px 0 0;color:#5b6475;font-size:13px;">
      ${env("BUSINESS_NAME", "Bircan Migration")}<br />
      ${env("BUSINESS_WEBSITE", "https://bircanmigration.com.au")}<br />
      ${env("BUSINESS_EMAIL", "")}
    </p>
  `;
}

function businessFooterText() {
  return [
    "",
    env("BUSINESS_NAME", "Bircan Migration"),
    env("BUSINESS_WEBSITE", "https://bircanmigration.com.au"),
    env("BUSINESS_EMAIL", "")
  ].filter(Boolean).join("\n");
}

export async function sendAdminNotification(submission) {
  const transporter = createTransporter();
  const to = process.env.ADMIN_NOTIFY_EMAIL;

  if (!transporter || !to) {
    return { sent: false, reason: "mail_not_configured" };
  }

  const subject = `New paid submission: ${submission.type || "Migration Service"} • ${submission.id}`;
  const text = [
    "A new paid submission is ready.",
    `Submission ID: ${submission.id}`,
    `Type: ${submission.type || ""}`,
    `Name: ${submission.name || ""}`,
    `Email: ${submission.email || ""}`,
    `Phone: ${submission.phone || ""}`,
    `Amount: ${(Number(submission.amountCents || 0) / 100).toFixed(2)} ${(submission.currency || "AUD").toUpperCase()}`,
    `PDF ready: ${submission.pdfReady ? "Yes" : "No"}`,
    `Created: ${submission.createdAt || ""}`,
    `Paid: ${submission.paidAt || ""}`,
    "",
    "Summary:",
    submission.summary || "",
    "",
    "Submitted data:",
    JSON.stringify(submission.formData || {}, null, 2),
    businessFooterText()
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#11203b;">
      <h2 style="margin:0 0 16px;">New paid submission</h2>
      <p><strong>Submission ID:</strong> ${submission.id}</p>
      <p><strong>Type:</strong> ${submission.type || ""}</p>
      <p><strong>Name:</strong> ${submission.name || ""}</p>
      <p><strong>Email:</strong> ${submission.email || ""}</p>
      <p><strong>Phone:</strong> ${submission.phone || ""}</p>
      <p><strong>Amount:</strong> ${(Number(submission.amountCents || 0) / 100).toFixed(2)} ${(submission.currency || "AUD").toUpperCase()}</p>
      <p><strong>PDF ready:</strong> ${submission.pdfReady ? "Yes" : "No"}</p>
      <p><strong>Summary:</strong><br />${(submission.summary || "").replace(/\n/g, "<br />")}</p>
      <pre style="white-space:pre-wrap;background:#f5f7fb;padding:12px;border-radius:10px;border:1px solid #dfe6f2;">${escapeHtml(JSON.stringify(submission.formData || {}, null, 2))}</pre>
      ${businessFooterHtml()}
    </div>
  `;

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to,
    subject,
    text,
    html
  });

  return { sent: true, messageId: info.messageId };
}

export async function sendClientReceipt(submission) {
  const transporter = createTransporter();

  if (!transporter || !submission?.email) {
    return { sent: false, reason: "mail_not_configured_or_missing_recipient" };
  }

  const subject = `${env("BUSINESS_NAME", "Bircan Migration")} payment confirmation`;
  const text = [
    `Hello ${submission.name || "there"},`,
    "",
    "Thank you. Your payment has been received successfully.",
    `Submission ID: ${submission.id}`,
    `Service: ${submission.type || "Migration Service"}`,
    `Amount: ${(Number(submission.amountCents || 0) / 100).toFixed(2)} ${(submission.currency || "AUD").toUpperCase()}`,
    submission.pdfReady && submission.downloadUrl ? `Download: ${submission.downloadUrl}` : "Your PDF report is being prepared.",
    businessFooterText()
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.55;color:#11203b;">
      <h2 style="margin:0 0 16px;">Payment received</h2>
      <p>Hello ${submission.name || "there"},</p>
      <p>Thank you. Your payment has been received successfully.</p>
      <p><strong>Submission ID:</strong> ${submission.id}</p>
      <p><strong>Service:</strong> ${submission.type || "Migration Service"}</p>
      <p><strong>Amount:</strong> ${(Number(submission.amountCents || 0) / 100).toFixed(2)} ${(submission.currency || "AUD").toUpperCase()}</p>
      ${
        submission.pdfReady && submission.downloadUrl
          ? `<p><a href="${submission.downloadUrl}" style="display:inline-block;background:#123a9c;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;">Download your PDF</a></p>`
          : `<p>Your PDF report is being prepared and will be available shortly.</p>`
      }
      ${businessFooterHtml()}
    </div>
  `;

  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: submission.email,
    subject,
    text,
    html
  });

  return { sent: true, messageId: info.messageId };
}

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
