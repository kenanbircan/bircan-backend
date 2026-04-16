import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

function safe(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

export async function generateSubmissionPdf(submission, outputPath) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      info: {
        Title: `${process.env.BUSINESS_NAME || "Bircan Migration"} Submission Report`,
        Author: process.env.BUSINESS_NAME || "Bircan Migration"
      }
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const businessName = process.env.BUSINESS_NAME || "Bircan Migration";
    const businessWebsite = process.env.BUSINESS_WEBSITE || "https://bircanmigration.com.au";
    const businessEmail = process.env.BUSINESS_EMAIL || "";
    const businessPhone = process.env.BUSINESS_PHONE || "";

    doc.fontSize(22).text(businessName, { align: "left" });
    doc.moveDown(0.2);
    doc.fontSize(10).fillColor("#555555").text([businessWebsite, businessEmail, businessPhone].filter(Boolean).join(" • "));
    doc.moveDown(1);

    doc.fillColor("#111111").fontSize(18).text("Submission Report");
    doc.moveDown(0.6);

    drawSectionTitle(doc, "Overview");
    drawKeyValue(doc, "Submission ID", submission.id);
    drawKeyValue(doc, "Service Type", submission.type || "Migration Service");
    drawKeyValue(doc, "Client Name", submission.name);
    drawKeyValue(doc, "Client Email", submission.email);
    drawKeyValue(doc, "Phone", submission.phone);
    drawKeyValue(doc, "Status", submission.status);
    drawKeyValue(doc, "Payment Status", submission.paymentStatus || "");
    drawKeyValue(doc, "Amount", `${(Number(submission.amountCents || 0) / 100).toFixed(2)} ${(submission.currency || "AUD").toUpperCase()}`);
    drawKeyValue(doc, "Created At", submission.createdAt);
    drawKeyValue(doc, "Paid At", submission.paidAt || "");

    doc.moveDown(0.6);
    drawSectionTitle(doc, "Summary");
    doc.fontSize(11).fillColor("#222222").text(safe(submission.summary || "No summary provided."), {
      lineGap: 4
    });

    doc.moveDown(0.8);
    drawSectionTitle(doc, "Form Data");
    const formData = submission.formData || {};
    const entries = Object.entries(formData);

    if (entries.length === 0) {
      doc.fontSize(11).text("No form data captured.");
    } else {
      for (const [key, value] of entries) {
        const rendered = Array.isArray(value) ? value.join(", ") : typeof value === "object" && value ? JSON.stringify(value) : safe(value);
        drawKeyValue(doc, prettifyKey(key), rendered);
      }
    }

    doc.moveDown(1);
    doc.fontSize(9).fillColor("#666666").text("Generated automatically by the Bircan Migration backend workflow.", { align: "center" });

    doc.end();

    stream.on("finish", () => resolve(outputPath));
    stream.on("error", reject);
  });
}

function drawSectionTitle(doc, title) {
  doc.fontSize(13).fillColor("#123a9c").text(title);
  doc.moveDown(0.3);
}

function drawKeyValue(doc, label, value) {
  doc.font("Helvetica-Bold").fontSize(10).fillColor("#111111").text(`${safe(label)}: `, {
    continued: true
  });
  doc.font("Helvetica").fillColor("#333333").text(safe(value || "-"));
}

function prettifyKey(key) {
  return safe(key)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
