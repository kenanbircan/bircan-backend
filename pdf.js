const crypto = require('crypto');
const PDFDocument = require('pdfkit');

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeText(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(v => safeText(v, '')).filter(Boolean).join(', ') : fallback;
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value).trim() || fallback;
}

function keyNorm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalisePayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.formPayload && typeof payload.formPayload === 'object') return normalisePayload(payload.formPayload);
  if (payload.answers && typeof payload.answers === 'object') return normalisePayload(payload.answers);
  if (payload.form && typeof payload.form === 'object') return normalisePayload(payload.form);
  return payload;
}

function pick(payload, names, fallback = '—') {
  const keys = Object.keys(payload || {});
  for (const name of names) {
    if (payload[name] !== undefined && payload[name] !== null && payload[name] !== '') return payload[name];
    const found = keys.find(k => keyNorm(k) === keyNorm(name));
    if (found && payload[found] !== undefined && payload[found] !== null && payload[found] !== '') return payload[found];
  }
  return fallback;
}

function asLower(value) {
  return safeText(value, '').toLowerCase();
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '' || String(value).trim() === '—';
}

function parseDate(value) {
  if (isBlank(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function calculateAgeAt(dobValue, atValue) {
  const dob = parseDate(dobValue);
  const at = parseDate(atValue) || new Date();
  if (!dob) return null;
  let age = at.getFullYear() - dob.getFullYear();
  const m = at.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < dob.getDate())) age -= 1;
  return age >= 0 && age <= 120 ? age : null;
}

function yes(value) {
  return /^(yes|true|held|current|valid|met|passed)/i.test(safeText(value, ''));
}

function no(value) {
  return /^(no|false|not held|not current|not valid|failed)/i.test(safeText(value, ''));
}

function uncertain(value) {
  return /unsure|unknown|not sure|unclear|pending|not provided|—/i.test(safeText(value, ''));
}

function adverse(value) {
  return /known issue|unresolved|withdrawn|refused|cancel|bar|pic4020|false|character|health issue|high risk|in immigration clearance|condition present/i.test(safeText(value, ''));
}

function addFinding(findings, severity, criterion, evidence, conclusion, action) {
  findings.push({ severity, criterion, evidence: safeText(evidence), conclusion, action });
}

function makeSubclass190Assessment(payload) {
  const findings = [];
  const dob = pick(payload, ['date-of-birth', 'dateOfBirth', 'dob'], '');
  const invitationDate = pick(payload, ['invitation-date', 'invitationDate'], '');
  const ageInput = pick(payload, ['age-at-invitation', 'ageAtInvitation'], '');
  const calculatedAge = !isBlank(ageInput) ? Number(ageInput) : calculateAgeAt(dob, invitationDate);

  const nominationHeld = pick(payload, ['state-nomination-held', 'stateNominationHeld', 'nomination-current', 'nominationCurrent']);
  const invitationHeld = pick(payload, ['invitation-held', 'invitationHeld']);
  const invitedWithin = pick(payload, ['invitation-within-period', 'invitationWithinPeriod']);
  const skillsHeld = pick(payload, ['skills-assessment-held', 'skillsAssessmentHeld']);
  const skillsExpiry = pick(payload, ['skills-assessment-expiry', 'skillsAssessmentExpiry']);
  const occupationMatch = pick(payload, ['occupation-matches-invitation', 'occupationMatchesInvitation']);
  const occupationInstrument = pick(payload, ['occupation-on-instrument', 'occupationOnInstrument', 'state-occupation-list']);
  const english = pick(payload, ['competent-english', 'competentEnglish', 'english-test-type', 'englishTestType']);
  const points = pick(payload, ['assessed-points', 'assessedPoints', 'invited-points', 'invitedPoints']);
  const s48 = pick(payload, ['section48-bar', 'section48Bar']);
  const pic4020 = pick(payload, ['pic4020-integrity', 'pic4020Integrity']);
  const character = pick(payload, ['character-security-issues', 'characterSecurityIssues']);
  const health = pick(payload, ['health-issues', 'healthIssues']);
  const currentLocation = pick(payload, ['current-location', 'currentLocation', 'current-location-validity']);
  const visaStatus = pick(payload, ['current-visa-status', 'currentVisaStatus']);
  const nfa = pick(payload, ['nfa-condition', 'condition-8503', 'condition8503']);
  const firstEntry = pick(payload, ['first-entry-condition', 'firstEntryCondition']);
  const family = pick(payload, ['family-included', 'familyIncluded']);
  const custody = pick(payload, ['minor-custody-issues', 'minorCustodyIssues']);
  const functionalEnglish = pick(payload, ['functional-english-family', 'functionalEnglishFamily']);
  const exclusion491494 = pick(payload, ['exclude-491-494', 'exclude491494']);

  if (calculatedAge === null) {
    addFinding(findings, 'critical', 'Age at invitation', ageInput || dob || invitationDate, 'Age at invitation cannot be verified from the provided answers.', 'Obtain date of birth and invitation date and confirm the applicant was under 45 at invitation.');
  } else if (calculatedAge >= 45) {
    addFinding(findings, 'critical', 'Age at invitation', `${calculatedAge}`, 'The applicant appears to be 45 or older at invitation, which is a threshold issue for subclass 190.', 'Do not lodge until age at invitation is legally verified.');
  } else {
    addFinding(findings, 'satisfied', 'Age at invitation', `${calculatedAge}`, 'On the entered dates, the applicant appears to satisfy the under-45 age requirement.', 'Verify passport and invitation records.');
  }

  if (/withdrawn/i.test(safeText(nominationHeld, ''))) {
    addFinding(findings, 'critical', 'State/Territory nomination', nominationHeld, 'The nomination is recorded as withdrawn. A valid current nomination is required for subclass 190.', 'Do not proceed until a valid nomination is confirmed or a new nomination is obtained.');
  } else if (uncertain(nominationHeld)) {
    addFinding(findings, 'high', 'State/Territory nomination', nominationHeld, 'Current nomination is not confirmed.', 'Obtain nomination approval and check it remains current at application.');
  } else {
    addFinding(findings, 'review', 'State/Territory nomination', nominationHeld, 'Nomination position requires documentary verification.', 'Check state nomination letter, occupation, stream, conditions and validity period.');
  }

  if (uncertain(invitationHeld) || uncertain(invitedWithin)) {
    addFinding(findings, 'high', 'Invitation to apply', `Invitation held: ${safeText(invitationHeld)}; within period: ${safeText(invitedWithin)}`, 'The invitation validity position is not confirmed.', 'Verify SkillSelect invitation date, expiry and lodgement window.');
  } else {
    addFinding(findings, 'review', 'Invitation to apply', `Invitation held: ${safeText(invitationHeld)}; within period: ${safeText(invitedWithin)}`, 'Invitation evidence must be checked against lodgement timing.', 'Attach the SkillSelect invitation and confirm application timing.');
  }

  if (uncertain(skillsHeld) || adverse(skillsHeld)) {
    addFinding(findings, 'high', 'Skills assessment', skillsHeld, 'Skills assessment is not clearly valid and positive.', 'Obtain the full skills assessment outcome, nominated occupation and expiry details.');
  } else {
    addFinding(findings, 'review', 'Skills assessment', `${safeText(skillsHeld)}; expiry: ${safeText(skillsExpiry)}`, 'Skills assessment appears disclosed but must be checked for validity and occupation alignment.', 'Confirm the assessment was valid at invitation and application.');
  }

  if (uncertain(occupationMatch) || uncertain(occupationInstrument)) {
    addFinding(findings, 'high', 'Occupation alignment', `Match: ${safeText(occupationMatch)}; instrument/list: ${safeText(occupationInstrument)}`, 'Occupation alignment is unresolved.', 'Confirm ANZSCO code, assessing authority, invitation occupation and state list requirements.');
  } else {
    addFinding(findings, 'review', 'Occupation alignment', `Match: ${safeText(occupationMatch)}; instrument/list: ${safeText(occupationInstrument)}`, 'Occupation alignment should be verified before lodgement.', 'Cross-check nomination, invitation and skills assessment.');
  }

  if (isBlank(points)) {
    addFinding(findings, 'high', 'Points test', 'No assessed/invited points entered', 'The points score cannot be verified.', 'Calculate points from evidence and confirm the score claimed in SkillSelect.');
  } else {
    const n = Number(points);
    if (Number.isFinite(n) && n < 65) {
      addFinding(findings, 'critical', 'Points test', points, 'Entered points appear below the usual minimum threshold.', 'Do not lodge until points are recalculated and threshold is met.');
    } else {
      addFinding(findings, 'review', 'Points test', points, 'Points position requires document-by-document verification.', 'Reconcile age, English, qualifications, employment, study and nomination points.');
    }
  }

  if (uncertain(english) || /passport-based/i.test(safeText(english, ''))) {
    addFinding(findings, 'high', 'Competent English', english, 'English position requires careful verification, particularly if passport-based.', 'Confirm passport country or English test result meets competent English requirement at the relevant time.');
  } else {
    addFinding(findings, 'review', 'Competent English', english, 'English evidence must be checked for test type, score and validity.', 'Attach test report or passport evidence.');
  }

  [
    ['Section 48 bar / onshore restrictions', s48],
    ['PIC 4020 / integrity', pic4020],
    ['Character and security', character],
    ['Health', health],
    ['No further stay condition', nfa],
    ['First entry condition', firstEntry]
  ].forEach(([criterion, value]) => {
    if (adverse(value)) addFinding(findings, 'critical', criterion, value, `${criterion} is recorded with an adverse or unresolved answer.`, 'Obtain documents and legal review before any lodgement.');
    else if (uncertain(value)) addFinding(findings, 'review', criterion, value, `${criterion} is not fully confirmed.`, 'Verify against visa grant notices, VEVO, Department records and client declarations.');
  });

  if (adverse(currentLocation) || adverse(visaStatus)) {
    addFinding(findings, 'high', 'Location and immigration status', `Location: ${safeText(currentLocation)}; visa status: ${safeText(visaStatus)}`, 'The current location/status answer creates validity and timing risk.', 'Confirm whether the applicant is in or outside Australia, in immigration clearance, holds a substantive visa, or requires bridging visa advice.');
  }

  if (!isBlank(family) && !/^none$/i.test(safeText(family, ''))) {
    if (uncertain(functionalEnglish) || uncertain(custody) || no(pick(payload, ['family-relationship-evidence', 'familyRelationshipEvidence']))) {
      addFinding(findings, 'high', 'Secondary applicants', `Family: ${safeText(family)}; functional English: ${safeText(functionalEnglish)}; custody: ${safeText(custody)}`, 'Secondary applicant evidence is incomplete or uncertain.', 'Obtain identity, relationship, dependency, custody and functional English evidence.');
    } else {
      addFinding(findings, 'review', 'Secondary applicants', family, 'Family member inclusion must be checked against relationship and dependency evidence.', 'Verify each family member’s eligibility and documents.');
    }
  }

  if (!isBlank(exclusion491494)) {
    addFinding(findings, 'review', '491/494 prior visa restriction', exclusion491494, 'Prior 491/494 history may affect skilled visa eligibility timing.', 'Confirm grant dates, holding period and applicable legislative restriction.');
  }

  const critical = findings.filter(f => f.severity === 'critical').length;
  const high = findings.filter(f => f.severity === 'high').length;
  const outcome = critical ? 'Do not lodge without professional rectification' : high ? 'Further review required before lodgement' : 'Potentially capable of lodgement subject to evidence verification';
  const risk = critical ? 'High' : high >= 3 ? 'High to moderate' : high ? 'Moderate' : 'Controlled';

  return {
    subclass: '190',
    title: 'Subclass 190 Skilled Nominated Visa – preliminary advice letter',
    stream: 'Skilled nominated permanent residence',
    outcome,
    risk,
    findings,
    summary: [
      ['Applicant', pick(payload, ['full-name', 'fullName', 'applicantName', 'name'])],
      ['Email', pick(payload, ['email-address', 'emailAddress', 'applicantEmail', 'email'])],
      ['Citizenship', pick(payload, ['country-of-citizenship', 'countryOfCitizenship', 'citizenship', 'nationality'])],
      ['Nominated occupation', pick(payload, ['nominated-occupation', 'nominatedOccupation', 'occupation'])],
      ['Nominating state/territory', pick(payload, ['nominating-state', 'nominatingState'])],
      ['Current location/status', `${safeText(currentLocation)} / ${safeText(visaStatus)}`],
      ['Processing plan', pick(payload, ['plan', 'selectedPlan', 'selected-plan'])]
    ],
    nextSteps: [
      'Obtain the SkillSelect invitation, state nomination approval, skills assessment outcome and English evidence.',
      'Recalculate points from source documents before relying on any auto-filled score.',
      'Resolve any section 48, PIC 4020, health, character, visa condition or immigration clearance issue before lodgement.',
      'Prepare a document checklist mapped to each points claim and each family member included in the application.'
    ]
  };
}

function makeGenericSubclassAssessment(payload, visaType) {
  const findings = [];
  const map = {
    '189': ['Subclass 189 Skilled Independent Visa – preliminary advice letter', 'Skilled independent permanent residence'],
    '491': ['Subclass 491 Skilled Work Regional Visa – preliminary advice letter', 'Skilled regional provisional visa'],
    '482': ['Subclass 482 Skills in Demand / TSS Visa – preliminary advice letter', 'Employer sponsored temporary skilled visa'],
    '186': ['Subclass 186 Employer Nomination Scheme – preliminary advice letter', 'Employer nominated permanent residence'],
    '500': ['Subclass 500 Student Visa – preliminary advice letter', 'Student visa'],
    '600': ['Subclass 600 Visitor Visa – preliminary advice letter', 'Visitor visa'],
    '820': ['Subclass 820 Partner Visa – preliminary advice letter', 'Onshore partner visa'],
    '309': ['Subclass 309 Partner Visa – preliminary advice letter', 'Offshore partner visa'],
    '300': ['Subclass 300 Prospective Marriage Visa – preliminary advice letter', 'Prospective marriage visa'],
    '866': ['Subclass 866 Protection Visa – preliminary advice letter', 'Onshore protection visa']
  };
  const [title, stream] = map[String(visaType)] || [`Subclass ${visaType} Visa – preliminary advice letter`, 'Australian visa assessment'];

  const entries = Object.entries(payload || {});
  const adverseEntries = entries.filter(([, v]) => adverse(v)).slice(0, 14);
  const uncertainEntries = entries.filter(([, v]) => uncertain(v)).slice(0, 14);
  const importantFields = ['full-name', 'email-address', 'country-of-citizenship', 'current-location', 'current-visa-status', 'health-issues', 'character-security-issues', 'pic4020-integrity'];

  importantFields.forEach(k => {
    const v = pick(payload, [k], '');
    if (!isBlank(v) && adverse(v)) addFinding(findings, 'high', k, v, 'The answer indicates a potential legal or evidentiary risk.', 'Verify the issue against documents and obtain instructions before lodgement.');
  });
  adverseEntries.forEach(([k, v]) => addFinding(findings, 'high', k, v, 'The answer is adverse or high risk.', 'Clarify the issue and collect supporting evidence.'));
  uncertainEntries.forEach(([k, v]) => addFinding(findings, 'review', k, v, 'The answer is uncertain and cannot be accepted without evidence.', 'Request documents or further instructions.'));

  if (!findings.length) {
    addFinding(findings, 'review', 'Evidence verification', 'Questionnaire answers supplied', 'No critical blocker was isolated by the rules engine, but the file is not decision-ready until documents are checked.', 'Map each answer to supporting documents and current legal criteria.');
  }

  const high = findings.filter(f => f.severity === 'high' || f.severity === 'critical').length;
  return {
    subclass: String(visaType),
    title,
    stream,
    outcome: high ? 'Further review required before lodgement' : 'Potentially capable of lodgement subject to evidence verification',
    risk: high >= 4 ? 'High to moderate' : high ? 'Moderate' : 'Controlled',
    findings,
    summary: [
      ['Applicant', pick(payload, ['full-name', 'fullName', 'applicantName', 'name'])],
      ['Email', pick(payload, ['email-address', 'emailAddress', 'applicantEmail', 'email'])],
      ['Citizenship', pick(payload, ['country-of-citizenship', 'countryOfCitizenship', 'citizenship', 'nationality'])],
      ['Current location/status', `${safeText(pick(payload, ['current-location', 'currentLocation']))} / ${safeText(pick(payload, ['current-visa-status', 'currentVisaStatus']))}`],
      ['Processing plan', pick(payload, ['plan', 'selectedPlan', 'selected-plan'])]
    ],
    nextSteps: [
      'Confirm the selected stream and all threshold criteria for the subclass.',
      'Request evidence for every favourable answer and every claimed eligibility item.',
      'Resolve any adverse immigration history, health, character, integrity or visa-condition issue before lodgement.',
      'Prepare a final advice letter only after evidence is reconciled against current legislation and policy.'
    ]
  };
}

function buildLegalAssessment(payload, visaType) {
  if (String(visaType) === '190') return makeSubclass190Assessment(payload);
  return makeGenericSubclassAssessment(payload, visaType);
}

function ensureSpace(doc, needed = 80) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
}

function writeHeader(doc, assessment, legal) {
  doc.rect(0, 0, 595.28, 92).fill('#061936');
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('Bircan Migration', 50, 26);
  doc.font('Helvetica').fontSize(10).text('Preliminary migration advice letter', 50, 54);
  doc.font('Helvetica-Bold').fontSize(10).text(`Reference: ${safeText(assessment.id)}`, 360, 30, { width: 185, align: 'right' });
  doc.text(`Risk: ${legal.risk}`, 360, 48, { width: 185, align: 'right' });
  doc.fillColor('#061936').font('Helvetica-Bold').fontSize(17).text(legal.title, 50, 118, { align: 'center' });
  doc.moveDown(1.1);
}

function writeFooter(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - 36;
    doc.font('Helvetica').fontSize(8).fillColor('#667085')
      .text('Generated by Bircan Migration client portal. Preliminary advice only and subject to evidence verification.', 50, y, { width: 390 });
    doc.text(`Page ${i + 1}`, 500, y, { width: 45, align: 'right' });
  }
}

function heading(doc, text) {
  ensureSpace(doc, 70);
  doc.moveDown(0.75);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#061936').text(text);
  doc.moveDown(0.2);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#d8e2f0').stroke();
  doc.moveDown(0.45);
}

function paragraph(doc, text) {
  ensureSpace(doc, 60);
  doc.font('Helvetica').fontSize(9.5).fillColor('#1f2937').text(String(text), { align: 'justify', lineGap: 3 });
  doc.moveDown(0.42);
}

function bullet(doc, text) {
  ensureSpace(doc, 34);
  doc.font('Helvetica').fontSize(9.3).fillColor('#1f2937').text(`• ${String(text)}`, { indent: 12, lineGap: 2 });
}

function pair(doc, label, value) {
  ensureSpace(doc, 24);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#475467').text(`${label}: `, { continued: true });
  doc.font('Helvetica').fillColor('#101828').text(safeText(value));
}

function severityLabel(severity) {
  if (severity === 'critical') return 'Critical';
  if (severity === 'high') return 'High risk';
  if (severity === 'satisfied') return 'Appears satisfied';
  return 'Review';
}

function writeFinding(doc, finding, index) {
  ensureSpace(doc, 110);
  const color = finding.severity === 'critical' ? '#b42318' : finding.severity === 'high' ? '#8a5b00' : finding.severity === 'satisfied' ? '#067647' : '#245ee8';
  doc.roundedRect(50, doc.y, 495, 86, 10).strokeColor('#d8e2f0').stroke();
  const y = doc.y + 10;
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#061936').text(`${index}. ${finding.criterion}`, 64, y, { width: 320 });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(color).text(severityLabel(finding.severity), 430, y, { width: 95, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor('#475467').text(`Evidence: ${safeText(finding.evidence)}`, 64, y + 18, { width: 455, lineGap: 1 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#1f2937').text(`Assessment: ${safeText(finding.conclusion)}`, 64, y + 38, { width: 455, lineGap: 1 });
  doc.font('Helvetica').fontSize(8.5).fillColor('#1f2937').text(`Action: ${safeText(finding.action)}`, 64, y + 58, { width: 455, lineGap: 1 });
  doc.y += 98;
}

function writeAppendix(doc, payload) {
  heading(doc, 'Appendix – questionnaire answers relied upon');
  const entries = Object.entries(payload || {}).filter(([, v]) => !isBlank(v));
  if (!entries.length) {
    bullet(doc, 'No questionnaire answers were available in the assessment record.');
    return;
  }
  entries.slice(0, 90).forEach(([k, v]) => pair(doc, k, v));
  if (entries.length > 90) bullet(doc, `${entries.length - 90} additional fields were omitted from this PDF appendix for length.`);
}

function buildAssessmentPdfBuffer(assessment) {
  return new Promise((resolve, reject) => {
    const visaType = safeText(assessment.visa_type || assessment.visaType || assessment.subclass, 'Visa');
    const rawPayload = assessment.form_payload || assessment.formPayload || assessment.payload || {};
    const payload = normalisePayload(rawPayload);
    const legal = buildLegalAssessment(payload, visaType);
    const generatedAt = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });

    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      bufferPages: true,
      info: {
        Title: `Bircan Migration - Subclass ${visaType} Advice Letter`,
        Author: 'Bircan Migration',
        Subject: `Advice letter for assessment ${assessment.id}`
      }
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    writeHeader(doc, assessment, legal);

    heading(doc, '1. Matter details and instructions');
    pair(doc, 'Reference', assessment.id);
    pair(doc, 'Client email', assessment.client_email || assessment.clientEmail);
    pair(doc, 'Applicant email', assessment.applicant_email || assessment.applicantEmail || pick(payload, ['email-address', 'emailAddress', 'applicantEmail', 'email']));
    pair(doc, 'Applicant name', assessment.applicant_name || assessment.applicantName || pick(payload, ['full-name', 'fullName', 'applicantName', 'name']));
    pair(doc, 'Subclass / stream', `${visaType} / ${legal.stream}`);
    pair(doc, 'Processing plan', assessment.active_plan || assessment.selected_plan || pick(payload, ['plan', 'selectedPlan']));
    pair(doc, 'Generated', generatedAt);
    paragraph(doc, 'This advice letter is generated from the verified client portal assessment record and the questionnaire answers stored against the paid matter. It is a preliminary professional assessment only. It must not be treated as final lodgement advice until supporting documents, current legislation, legislative instruments, Department forms and current policy are checked.');

    heading(doc, '2. Executive outcome');
    pair(doc, 'Preliminary outcome', legal.outcome);
    pair(doc, 'Risk level', legal.risk);
    paragraph(doc, legal.findings.some(f => f.severity === 'critical')
      ? 'The answers disclose at least one threshold or serious adverse issue. The matter should not be lodged until the issue is resolved or a written legal strategy is settled.'
      : 'The matter may be capable of progressing, but the favourable answers remain unverified. The file should move to evidence reconciliation before any final advice or lodgement decision.');

    heading(doc, '3. Applicant and matter summary');
    legal.summary.forEach(([label, value]) => pair(doc, label, value));

    heading(doc, '4. Criterion-by-criterion preliminary assessment');
    legal.findings.forEach((finding, idx) => writeFinding(doc, finding, idx + 1));

    heading(doc, '5. Professional opinion');
    paragraph(doc, `On the information presently available, the matter is assessed as: ${legal.outcome}. The risk level is ${legal.risk}. This opinion is confined to the questionnaire answers and does not certify that the applicant satisfies the criteria. The primary legal risk is that one or more threshold criteria, timing requirements, nomination/invitation requirements, evidence requirements or public interest criteria may not be met once documents are reviewed.`);
    if (legal.findings.filter(f => f.severity === 'critical').length) {
      bullet(doc, 'There are critical issues requiring professional intervention before lodgement.');
    }
    if (legal.findings.filter(f => f.severity === 'high').length) {
      bullet(doc, 'There are high-risk issues requiring evidence and client instructions before the matter can be treated as lodgement-ready.');
    }
    bullet(doc, 'Any final advice must be updated against the law and Department requirements current at the time of decision.');

    heading(doc, '6. Evidence gaps and next steps');
    legal.nextSteps.forEach(item => bullet(doc, item));

    heading(doc, '7. Important notice');
    paragraph(doc, 'This document is a preliminary advice-letter issue copy generated for the client portal. It does not replace a signed letter of advice after full document review. If any answer is incorrect, incomplete or unsupported, the assessment outcome may change. No application should be lodged solely on this automated document.');
    paragraph(doc, 'Yours faithfully,\nKenan Bircan JP\nRegistered Migration Agent | MARN: 1463685\nBircan Migration & Education');

    writeAppendix(doc, payload);
    writeFooter(doc);
    doc.end();
  });
}

module.exports = { buildAssessmentPdfBuffer, sha256, normalisePayload, pick };
