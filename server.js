// PATCHED server.js (AI integrated minimal)
import fetch from 'node-fetch';
import { generateAssessmentPdf } from "./pdf.js";
import { updateSubmission } from "./storage.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function generateAIAnalysis(submission){
  const prompt = `
You are a migration lawyer.
Assess this case:

Client: ${submission.client?.fullName}
Visa: ${submission.visa?.subclass}

Provide:
- summary
- strengths (array)
- concerns (array)
- missingInformation (array)
- nextSteps (array)
- clientLetterDraft
`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    })
  });

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";

  return {
    summary: text,
    strengths: ["Auto-generated"],
    concerns: ["Review required"],
    missingInformation: ["Further documents required"],
    nextSteps: ["Proceed to formal advice"],
    clientLetterDraft: text
  };
}

export async function markCheckoutPaidAndGenerate(submission){
  let updated = submission;

  if(!updated.analysis){
    const analysis = await generateAIAnalysis(updated);
    updated = await updateSubmission(updated.id, {
      analysis,
      analysisStatus: "completed"
    });
  }

  const filePath = await generateAssessmentPdf(updated);

  await updateSubmission(updated.id, {
    pdfStatus: "ready",
    pdf: { filePath }
  });

  return updated;
}
