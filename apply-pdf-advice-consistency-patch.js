
/**
 * Bircan Migration PDF advice consistency patch
 * Applies to server.js in the backend root.
 *
 * Fixes:
 * 1) English criterion incorrectly receiving age finding/consequence.
 * 2) Labour Agreement selected pathway incorrectly receiving age finding in summary.
 * 3) Legal outcome summary now uses criterion-specific summary fields where available.
 *
 * Usage:
 *   node apply-pdf-advice-consistency-patch.js
 */
const fs = require('fs');
const path = require('path');

const serverPath = path.join(process.cwd(), 'server.js');
if (!fs.existsSync(serverPath)) {
  console.error('server.js not found. Run this script from the backend root folder.');
  process.exit(1);
}

let s = fs.readFileSync(serverPath, 'utf8');
const backup = serverPath + `.backup-${Date.now()}`;
fs.writeFileSync(backup, s);

function insertAfter(anchor, insertion) {
  if (!s.includes(anchor)) throw new Error('Anchor not found: ' + anchor.slice(0, 120));
  if (s.includes('BIRCAN_ADVICE_CRITERION_SPECIFIC_PATCH')) return;
  s = s.replace(anchor, anchor + insertion);
}

function replaceOnce(search, replacement, label) {
  if (!s.includes(search)) throw new Error('Could not find block for ' + label);
  s = s.replace(search, replacement);
}

// 1) Add helpers immediately after lowerAnswer line.
insertAfter(
  "  const lowerAnswer = String(answer || '').toLowerCase();\n",
  `
  // BIRCAN_ADVICE_CRITERION_SPECIFIC_PATCH v2026-05-13
  // Keep each criterion's finding/consequence tied to that criterion.
  // This prevents English, Labour Agreement and pathway rows from inheriting age wording.
  const criterionIs = (pattern) => pattern.test(lowerCriterion);
  const setCriterionSummary = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.summaryFinding) finding = obj.summaryFinding;
    if (obj.legalConsequence) legal_consequence = obj.legalConsequence;
    if (obj.delegateRisk) delegateRisk = obj.delegateRisk;
  };
`
);

// 2) Insert explicit English block before age block.
const ageBlockStart = "  } else if (/age/.test(lowerCriterion)) {";
if (!s.includes("criterionIs(/english language|english requirement|english/")) {
  s = s.replace(ageBlockStart, `  } else if (criterionIs(/english language|english requirement|english/)) {
    if (/\\b(no|none|not available|not yet|missing|unknown|false)\\b/i.test(String(answer || ''))) {
      finding = 'English evidence has not been verified. The file should not proceed on assumed English eligibility unless a valid test result, eligible passport evidence, exemption or Labour Agreement concession is identified and checked against the current legal threshold.';
      legal_consequence = 'If the English requirement, exemption or concession cannot be established with valid evidence at the relevant time, the visa pathway may become unsuitable or exposed to refusal risk.';
      delegateRisk = 'Moderate Delegate Risk';
    } else {
      finding = 'English evidence has been disclosed in the questionnaire, but the original test report, eligible passport evidence, exemption basis or Labour Agreement concession must be verified before lodgement-ready advice is issued.';
      legal_consequence = 'The English position may be supportable only if the evidence is valid, current and meets the applicable threshold or concession for the selected stream.';
      delegateRisk = 'Managed Delegate Risk';
    }
${ageBlockStart}`);
}

// 3) Insert explicit Labour Agreement/pathway block before salary block.
const salaryBlockStart = "  if (/salary|market|remuneration|employment conditions/.test(lowerCriterion)) {";
if (!s.includes("criterionIs(/labou?r agreement coverage|selected pathway|pathway selection|occupation terms/")) {
  s = s.replace(salaryBlockStart, `  if (criterionIs(/labou?r agreement coverage|selected pathway|pathway selection|occupation terms/)) {
    finding = 'The selected Labour Agreement pathway must be assessed against the executed agreement itself. The critical issue is whether the agreement covers the employer, nominated occupation, nomination limits, salary settings, English or age concessions, and any conditions attached to the agreement.';
    legal_consequence = 'If the executed agreement does not expressly support the nominated occupation, employer, concessions or nomination settings, the selected pathway may not be viable and an alternative pathway should be considered.';
    delegateRisk = 'Elevated Delegate Risk';
  } else if (/salary|market|remuneration|employment conditions/.test(lowerCriterion)) {`);
}

// 4) Make legal outcome summary prefer summaryFinding/legalConsequence and avoid cross-criterion leakage.
const oldSummary = `  const legalOutcomeSummary = (findings || []).slice(0, 12).map(f => ({
    area: f.criterion,
    currentPosition: f.finding || 'Requires professional verification against original evidence.',
    risk: riskBandFromDelegateRisk(f.delegateRisk),
    blocksLodgement: /elevated|critical|block|cannot|not satisfied|missing|refus|cancel/i.test(\`\${f.delegateRisk} \${f.finding} \${f.legal_consequence}\`) ? 'Potentially, until resolved' : 'No, subject to verification'
  }));`;

const newSummary = `  const legalOutcomeSummary = (findings || []).slice(0, 12).map(f => {
    const combined = \`\${f.delegateRisk || ''} \${f.finding || ''} \${f.legal_consequence || ''} \${f.recommendation || ''}\`;
    return {
      area: f.criterion,
      currentPosition: f.summaryFinding || f.finding || 'Requires professional verification against original evidence.',
      risk: riskBandFromDelegateRisk(f.delegateRisk),
      blocksLodgement: /elevated|critical|block|cannot|not satisfied|missing|refus|cancel|not verified|not established/i.test(combined) ? 'Potentially, until resolved' : 'No, subject to verification'
    };
  });`;

if (s.includes(oldSummary)) {
  replaceOnce(oldSummary, newSummary, 'legalOutcomeSummary');
}

// 5) Ensure returned finding object carries summaryFinding if return block is present.
const returnNeedle = "    finding,\n    legal_consequence,";
if (s.includes(returnNeedle) && !s.includes("    summaryFinding: finding,")) {
  s = s.replace(returnNeedle, "    finding,\n    summaryFinding: finding,\n    legal_consequence,");
}

fs.writeFileSync(serverPath, s);
console.log('Patch applied to server.js');
console.log('Backup created:', backup);
console.log('Now run: npm run check');
