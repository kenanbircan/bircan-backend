'use strict';

/**
 * adviceHtmlPdfRenderer.js
 *
 * Converts the existing server advice bundle into print-safe HTML and exports it
 * through Chromium/Playwright. This avoids manual PDF coordinate drawing and gives
 * browser-grade wrapping, pagination and page-break control.
 */

const RENDERER_VERSION = 'advice-html-pdf-renderer-v121-premium-template-20260522';

const BRAND = {
  name: 'Bircan Migration & Education',
  subtitle: 'Professional Migration Assessment',
  agent: 'Kenan Bircan JP',
  marn: '1463685'
};

const INTERNAL_KEYS = new Set([
  'internalLegalAudit', 'internalAuditObject', 'criteriaRegistryAudit', 'rawRegistryFindings',
  'criteriaRegistryFindings', 'debug', 'rawDebug', 'sourceHash', 'sourceHashes', 'quality_flags',
  'prompt', 'systemPrompt', 'developerPrompt', 'chainOfThought'
]);

const FORBIDDEN_CLIENT_PHRASES = [
  'criteria registry', 'knowledgebase source mapping', 'saved assessment answers', 'engine output',
  'risk controls', 'internalLegalAudit', 'rawRegistryFindings', 'criteriaRegistryAudit', 'quality_flags',
  'source hash', 'Grant Criterion Control', 'Registry-controlled pathway', 'Registry controlled pathway'
];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(v => v !== undefined && v !== null && v !== '') : [value];
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function stripInternalKeys(value) {
  if (Array.isArray(value)) return value.map(stripInternalKeys).filter(v => v !== undefined && v !== null && v !== '');
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (INTERNAL_KEYS.has(key)) continue;
    out[key] = stripInternalKeys(val);
  }
  return out;
}

function cleanText(value) {
  if (value === undefined || value === null) return '';
  let out = String(value)
    .normalize('NFKC')
    .replace(/[\uFFFC-\uFFFF]/g, ' ')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\u00AD/g, '')
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/\bcriteria registry\b/gi, 'legal criteria framework')
    .replace(/\bsubclass criteria registry\b/gi, 'subclass legal criteria framework')
    .replace(/\bknowledgebase source mapping\b/gi, 'source review')
    .replace(/\bsource-mapped registry\b/gi, 'verified legal sources')
    .replace(/\bsaved assessment answers\b/gi, 'current instructions')
    .replace(/\bengine output\b/gi, 'assessment findings')
    .replace(/\brisk controls\b/gi, 'professional review controls')
    .replace(/\bGrant Criterion Control\b/gi, 'Grant criterion requirement')
    .replace(/\bRegistry-controlled pathway\b/gi, 'stream/pathway')
    .replace(/\bRegistry controlled pathway\b/gi, 'stream/pathway')
    .replace(/\bPrimary pathway\b/gi, 'stream/pathway')
    .replace(/This preliminary assessment considered the Subclass ([0-9]+)\s*([^.]*) framework using the current instructions, subclass legal criteria framework, source review, evidence validation and professional review controls\./gi,
      'This assessment considered the Subclass $1 $2 framework, including stream eligibility, nomination-related issues, applicant eligibility, evidence requirements and relevant public interest considerations.')
    .replace(/Exact clause references should be used only where verified in the verified legal sources and remain subject to RMA review\./gi,
      'Final clause-level references should be confirmed against the current legislation and instruments before lodgement advice is issued.')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (/\bIELTS\b/i.test(out)) {
    out = out.replace(/\b(listening|reading|writing|speaking)\s+([0-9]{2})(\b|[,;)])/gi, (m, comp, raw, end) => {
      const n = Number(raw);
      if (n >= 10 && n <= 90) return `${comp} ${(n / 10).toFixed(1)}${end}`;
      return m;
    });
  }
  return out;
}

function html(value) {
  return cleanText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function humanizeObject(value) {
  if (!isPlainObject(value)) return cleanText(value);
  const issue = pick(value.issue, value.title, value.area, value.criterion, value.criterionLabel, value.criterionName);
  const position = pick(value.position, value.summary, value.fullText, value.finding, value.professionalPosition);
  const risk = pick(value.overallRisk, value.risk, value.riskLevel, value.status, value.statusLabel);
  const evidence = pick(value.requiredEvidence, value.evidenceRequired, value.evidence, value.documentsRequired, value.evidenceGap);
  const action = pick(value.requiredAction, value.action, value.recommendation, value.nextStep);
  const parts = [];
  if (issue) parts.push(cleanText(issue));
  if (position) parts.push(cleanText(position));
  if (risk) parts.push(`Risk/status: ${cleanText(risk)}`);
  if (evidence) parts.push(`Evidence required: ${Array.isArray(evidence) ? evidence.map(cleanText).join(', ') : cleanText(evidence)}`);
  if (action) parts.push(`Action: ${cleanText(action)}`);
  if (parts.length) return cleanText(parts.join(' - '));
  return Object.entries(value)
    .filter(([k, v]) => !INTERNAL_KEYS.has(k) && v !== undefined && v !== null && v !== '')
    .slice(0, 6)
    .map(([k, v]) => `${cleanText(k).replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim()}: ${Array.isArray(v) ? v.map(cleanText).join(', ') : (isPlainObject(v) ? humanizeObject(v) : cleanText(v))}`)
    .join('; ');
}

function toText(value, fallback = '—') {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.map(v => toText(v, '')).filter(Boolean).join(', ') || fallback;
  if (typeof value === 'object') return humanizeObject(value) || fallback;
  return cleanText(value) || fallback;
}

function professionalStatus(value) {
  const s = cleanText(value).toLowerCase();
  if (!s) return 'Not verified';
  if (/likely[_\s-]*satisfied|appears supportable|supportable/.test(s)) return 'Appears supportable, subject to evidence';
  if (/not[_\s-]*satisfied|adverse|not supportable/.test(s)) return 'Presently adverse on current information';
  if (/not[_\s-]*applicable|n\/a/.test(s)) return 'Not presently applicable';
  if (/unclear|unknown|review|required|verify|reconcil|manual/.test(s)) return 'Requires evidence reconciliation';
  return cleanText(value);
}

function getAdviceModel(bundle) {
  return stripInternalKeys(pick(
    bundle.clientAdviceObject,
    bundle.clientAdvice,
    bundle.advice,
    bundle.adviceBundle,
    bundle.professionalAdvice,
    bundle
  )) || {};
}

function getSubclass(assessment, bundle, model) {
  return cleanText(pick(
    assessment.subclass, assessment.visa_subclass, assessment.selectedSubclass,
    bundle.subclass, model.subclass, model.visaSubclass, '186'
  )).replace(/^subclass\s+/i, '');
}

function getStream(assessment, bundle, model) {
  return cleanText(pick(
    assessment.stream, assessment.pathway, assessment.selected_stream, assessment.selectedStream,
    bundle.stream, bundle.pathway, model.stream, model.pathway, model.selectedStream
  ));
}

function body(value) { return cleanText(toText(value, '')); }

function issueKey(value) {
  const text = body(isPlainObject(value) ? pick(value.issue, value.title, value.area, value.criterion, humanizeObject(value)) : value).toLowerCase();
  if (/english/.test(text)) return 'english';
  if (/age/.test(text)) return 'age';
  if (/salary|market|remuneration|amsr/.test(text)) return 'salary-market';
  if (/direct entry|skill|skills assessment|qualification/.test(text)) return 'direct-entry-skills';
  if (/occupation|anzsco|duties/.test(text)) return 'occupation-anzsco';
  if (/sponsor|employer|nomination|genuine|operational need/.test(text)) return 'employer-nomination';
  if (/health/.test(text)) return 'health';
  if (/character|integrity|public interest/.test(text)) return 'character-integrity';
  if (/migration history|compliance|refusal|cancellation|section 48|8503/.test(text)) return 'migration-history';
  if (/valid|identity|application/.test(text)) return 'validity-identity';
  if (/stream|pathway/.test(text)) return 'stream-pathway';
  return text.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'issue';
}

function uniqueByKey(items, limit = 40) {
  const seen = new Set();
  const out = [];
  for (const item of asArray(items)) {
    const key = issueKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function findingTitle(f) { return body(isPlainObject(f) ? pick(f.issue, f.title, f.area, f.criterionLabel, f.criterionName, f.criterion, 'Assessment issue') : f); }
function findingStatus(f) { return professionalStatus(isPlainObject(f) ? pick(f.statusLabel, f.status, f.riskStatus, f.result, f.position) : 'Requires evidence reconciliation'); }
function findingRequirement(f) { return body(isPlainObject(f) ? pick(f.legalRequirement, f.requirement, f.requirementSummary, f.criterionText, f.legalTest) : ''); }
function findingFacts(f) { return body(isPlainObject(f) ? pick(f.applicationToFacts, f.factsApplication, f.analysis, f.reasoning, f.finding, f.summary) : ''); }
function findingGap(f) { return body(isPlainObject(f) ? pick(f.evidenceStillRequired, f.evidenceGap, f.requiredEvidence, f.evidenceRequired, f.documentsRequired) : ''); }
function findingAction(f) { return body(isPlainObject(f) ? pick(f.requiredAction, f.action, f.nextStep, f.recommendation) : ''); }
function findingConsequence(f) { return body(isPlainObject(f) ? pick(f.consequenceIfUnresolved, f.consequence, f.riskConsequence, f.professionalConsequence) : ''); }

function specificRequirement(title, existing) {
  const lower = cleanText(title).toLowerCase();
  const generic = !existing || /selected stream must be legally available|nominated position and employer material must demonstrate/i.test(existing);
  if (!generic) return existing;
  if (/direct entry|skill|skills assessment|qualification/.test(lower)) return 'For the Direct Entry stream, the applicant must demonstrate that the nominated occupation, skills assessment, qualifications, employment history and any registration or licensing requirements are supportable at the relevant time.';
  if (/salary|market|remuneration|amsr/.test(lower)) return 'The remuneration position must be consistent with the nomination, employment contract, payroll records, market salary evidence and any applicable threshold, concession or instrument setting.';
  if (/occupation|anzsco|duties/.test(lower)) return 'The applicant’s actual duties, qualifications, employment history and any registration or licensing evidence must align with the nominated occupation and relevant ANZSCO profile.';
  if (/sponsor|employer|nomination|genuine|operational need/.test(lower)) return 'The nomination must be supported by a genuine, available and properly documented position connected to the sponsor’s business operations and ongoing workforce need.';
  if (/english/.test(lower)) return 'The applicant must hold acceptable English evidence, exemption evidence or concession evidence that is valid for the selected stream at the relevant time.';
  if (/age/.test(lower)) return 'The applicant must satisfy the applicable age requirement for the selected stream or establish a valid exemption, concession or alternative pathway.';
  if (/health/.test(lower)) return 'The applicant and any included family members must satisfy the applicable health requirements or address any health-related issue before final advice is relied upon.';
  if (/character|integrity|public interest/.test(lower)) return 'The applicant must satisfy character and integrity requirements, including truthful disclosure, document consistency and any relevant public interest criterion.';
  if (/migration history|compliance|refusal|cancellation|section 48|8503/.test(lower)) return 'Prior visa history, refusals, cancellations, visa conditions, section 48 issues and no-further-stay restrictions must be reviewed before lodgement strategy is finalised.';
  if (/valid|identity|application/.test(lower)) return 'The visa application must first be validly made, including correct form, charge, applicant identity, location and stream-specific validity prerequisites.';
  if (/stream|pathway/.test(lower)) return 'The selected stream must be legally available on the facts and must be tested against the stream-specific criteria and any applicable instrument, agreement or transitional setting.';
  return existing || 'This requirement must be verified against the applicable subclass framework before final lodgement advice is issued.';
}

function collectFindings(model, bundle) {
  const candidates = [
    model.findings, model.legalFindings, model.criteriaFindings, model.issueFindings, model.criterionMatrix,
    model.lodgementReadinessMatrix, model.riskFindings, model.clientFindings,
    bundle.findings, bundle.legalFindings, bundle.criteriaFindings
  ].flatMap(asArray);
  return uniqueByKey(candidates.filter(Boolean), 32);
}

function ensureMandatoryFindings(assessment, subclass, stream, findings) {
  const out = [...findings];
  const keys = new Set(out.map(issueKey));
  const add = (key, issue, status, facts, evidence, action) => {
    if (keys.has(key)) return;
    keys.add(key);
    out.push({ issue, status, applicationToFacts: facts, evidenceStillRequired: evidence, requiredAction: action });
  };
  add('stream-pathway', 'Subclass and stream selection', 'Requires evidence reconciliation', `The selected pathway is recorded as ${stream || 'not confirmed'}.`, 'Visa history, stream selection record, nomination pathway material and any transitional or concession evidence.', 'Confirm the selected stream is legally available and strategically strongest before lodgement.');
  add('employer-nomination', 'Genuine position and operational need', 'Appears supportable, subject to evidence', 'The employer and nomination instructions must be reconciled against objective business and position evidence.', 'Position description, organisational chart, contracts, client/work pipeline, payroll capacity and evidence of ongoing operational need.', 'Demonstrate that the role is genuine, ongoing and commercially supported by objective employer records.');
  add('direct-entry-skills', 'Direct Entry skills and occupation pathway', 'Requires evidence reconciliation', 'The Direct Entry pathway must be verified against skills assessment, occupation eligibility and supporting employment evidence.', 'Skills assessment, qualifications, employment references, CV, licensing and occupation evidence.', 'Confirm skills and occupation evidence before relying on Direct Entry.');
  add('salary-market', 'Salary and market position', 'Requires evidence reconciliation', 'The recorded salary must be tested against the nomination, contract, payroll and market salary evidence.', 'Contract, payslips, superannuation, market salary evidence, award/enterprise agreement material and nomination salary records.', 'Confirm the salary position is internally consistent and defensible.');
  add('english', 'English language requirement or concession', 'Requires evidence reconciliation', 'English evidence or any concession must be verified against the selected stream.', 'Original English test report or exemption/concession evidence.', 'Verify English component scores, validity and any exemption/concession.');
  add('age', 'Age', 'Requires evidence reconciliation', 'Age must be checked against passport/date of birth evidence and any applicable exemption or concession.', 'Passport/date of birth evidence and any age exemption, concession or pathway-specific material.', 'Verify age, timing and any exemption/concession before final advice.');
  return out;
}

function uniqueText(items, limit = 12) {
  const seen = new Set();
  const out = [];
  for (const item of asArray(items)) {
    const text = body(item);
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function priorityCategory(title) {
  const lower = cleanText(title).toLowerCase();
  if (/sponsor|employer|nomination|genuine|position|salary|market/.test(lower)) return 'Employer, nomination and salary evidence';
  if (/direct entry|skill|occupation|anzsco|qualification|licen|registration|employment continuity|work history/.test(lower)) return 'Direct Entry skills, occupation and employment evidence';
  if (/english|age|identity|valid|passport|location/.test(lower)) return 'Applicant eligibility and identity evidence';
  if (/health|character|integrity|migration|compliance|refusal|cancellation/.test(lower)) return 'Health, character and immigration-history evidence';
  return 'Additional evidence';
}

function groupedEvidence(findings) {
  const groups = new Map();
  for (const f of findings) {
    const title = findingTitle(f);
    const gap = findingGap(f);
    const action = findingAction(f);
    if (!gap && !action) continue;
    const group = priorityCategory(title);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(`${title}: ${gap || 'Evidence to be verified.'}${action ? ` Required action: ${action}` : ''}`);
  }
  return Array.from(groups.entries()).map(([group, items]) => ({ group, items: uniqueText(items, 10) })).filter(g => g.items.length);
}

function kv(rows) {
  return `<div class="kv">${rows.map(([k, v]) => `<div class="kv-row"><div class="kv-key">${html(k)}</div><div class="kv-val">${html(v || '—')}</div></div>`).join('')}</div>`;
}

function para(text, cls = '') { return body(text) ? `<p class="${cls}">${html(text)}</p>` : ''; }
function h1(text) { return `<h1>${html(text)}</h1>`; }
function h2(text) { return `<h2>${html(text)}</h2>`; }
function list(items) { return `<ul>${uniqueText(items, 30).map(item => `<li>${html(item)}</li>`).join('')}</ul>`; }
function block(label, value) { return body(value) ? `<div class="advice-block"><div class="block-label">${html(label)}</div><div class="block-value">${html(value)}</div></div>` : ''; }

function executiveNarrative(model, subclass, stream, findings) {
  const position = body(pick(model.currentProfessionalPosition, model.lodgementPosition, model.agentPosition && model.agentPosition.position, 'Potentially viable subject to evidence reconciliation'));
  const risk = body(pick(model.overallRisk, model.riskLevel, model.agentPosition && model.agentPosition.risk, 'Evidence review required'));
  const issues = uniqueText(pick(model.topMaterialBlockers, model.materialBlockers, model.clientAdviceObject && model.clientAdviceObject.topMaterialBlockers, findings.map(findingTitle)), 5);
  return `On the current instructions, the Subclass ${subclass}${stream ? ` ${stream}` : ''} pathway is ${position.toLowerCase()}. The matter is not lodgement-ready until the priority evidence is reconciled. The main issues to resolve are ${issues.length ? issues.join('; ') : 'the criterion-by-criterion evidence position'}. Overall risk is ${risk.toLowerCase()}. The advice is preliminary and must be checked against original evidence, Departmental records, current law and final migration-agent review before lodgement action.`;
}

function recommendationParagraphs(model) {
  const rec = pick(model.finalRecommendation, model.recommendation, model.agentPosition && model.agentPosition.recommendation, {});
  if (isPlainObject(rec)) {
    const position = body(pick(rec.position, 'Do not lodge yet'));
    const risk = body(pick(rec.overallRisk, rec.risk, rec.riskLevel, model.overallRisk, 'Evidence review required'));
    const summary = body(pick(rec.summary, rec.fullText, model.lodgementPosition, 'The matter should proceed to formal evidence review before filing.'));
    const next = body(pick(rec.nextStep, rec.requiredAction, model.nextStep, 'Reconcile the priority evidence before final lodgement advice.'));
    return [`${position}. On the present information, the matter should not be treated as lodgement-ready.`, summary, `Current risk position: ${risk}.`, `Next step: ${next}`];
  }
  return [body(rec || 'The matter should proceed to formal evidence review and lodgement-readiness assessment before filing.')];
}

function buildAssessmentHtml(assessment = {}, adviceBundle = {}) {
  const cleanAssessment = stripInternalKeys(assessment || {});
  const cleanBundle = stripInternalKeys(adviceBundle || {});
  const model = getAdviceModel(cleanBundle);
  const subclass = getSubclass(cleanAssessment, cleanBundle, model);
  const stream = getStream(cleanAssessment, cleanBundle, model);
  let findings = collectFindings(model, cleanBundle);
  findings = ensureMandatoryFindings(cleanAssessment, subclass, stream, findings);

  const generated = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' });
  const blockers = uniqueText(pick(model.topMaterialBlockers, model.materialBlockers, model.clientAdviceObject && model.clientAdviceObject.topMaterialBlockers, findings.map(findingTitle)), 6);
  const evidenceGroups = groupedEvidence(findings);

  const findingsHtml = findings.slice(0, 24).map((f, i) => {
    const title = findingTitle(f);
    return `<section class="finding avoid-break">
      <h2>${i + 1}. ${html(title)}</h2>
      ${block('Status', findingStatus(f))}
      ${block('Legal requirement', specificRequirement(title, findingRequirement(f)))}
      ${block('Application to current instructions', findingFacts(f) || 'The available instructions must be reconciled against original evidence before final advice.')}
      ${block('Evidence still required', findingGap(f) || 'Supporting evidence is required before final lodgement advice.')}
      ${block('Consequence if unresolved', findingConsequence(f) || 'This issue may affect lodgement readiness if unresolved.')}
      ${block('Required action', findingAction(f) || 'Resolve before final lodgement advice.')}
    </section>`;
  }).join('');

  const riskHtml = findings.slice(0, 18).map((f, i) => `<section class="risk avoid-break">
    <h2>${i + 1}. ${html(findingTitle(f))}</h2>
    ${block('Risk/status', findingStatus(f))}
    ${block('Professional consequence', findingConsequence(f) || 'Requires evidence review before final advice.')}
    ${block('Required action', findingAction(f) || 'Resolve before lodgement.')}
  </section>`).join('');

  const actionItems = uniqueText(pick(model.priorityActionPlan, model.actionPlan, model.nextSteps, model.requiredActions), 8);
  const fallbackActions = uniqueText(findings.slice(0, 8).map(f => `${findingTitle(f)}: ${findingAction(f) || 'Resolve before final advice.'}`), 8);

  const appendixHtml = findings.slice(0, 24).map((f, i) => {
    const title = findingTitle(f);
    return `<section class="appendix-item avoid-break">
      <h2>${i + 1}. ${html(title)}</h2>
      ${block('Status', findingStatus(f))}
      ${block('Requirement', specificRequirement(title, findingRequirement(f)))}
      ${block('Gap/action', `${findingGap(f) || 'Evidence gap to be resolved.'} ${findingAction(f) || 'Resolve before final lodgement advice.'}`)}
    </section>`;
  }).join('');

  return htmlDocument(`${html(BRAND.name)} - Professional Migration Advice`, `
    <section class="cover page-break-after">
      <div class="cover-band">
        <div class="brand-mark">BM</div>
        <div>
          <div class="brand">${html(BRAND.name)}</div>
          <div class="subtitle">${html(BRAND.subtitle)} · MARA Code of Conduct</div>
        </div>
      </div>
      <div class="gold-rule"></div>
      <div class="cover-kicker">Confidential client advice</div>
      <h1 class="cover-title">Professional Migration<br/>Advice Letter</h1>
      <div class="matter-card">
      ${kv([
        ['Matter', `Subclass ${subclass || '—'}${stream ? ' - ' + stream : ''}`],
        ['Reference', pick(cleanAssessment.id, cleanAssessment.reference, cleanAssessment.assessment_id, '—')],
        ["Applicant's name", pick(cleanAssessment.applicant_name, model.applicantName, model.clientName, '—')],
        ['Applicant email', pick(cleanAssessment.applicant_email, model.applicantEmail, '—')],
        ['Client email', pick(cleanAssessment.client_email, model.clientEmail, cleanAssessment.applicant_email, '—')],
        ['Generated', generated]
      ])}
      </div>
      <div class="cover-note">
        ${h2('Confidential professional advice')}
        ${para('This advice letter is prepared from the information presently available and is subject to review of original evidence, current law, Departmental records, conflict checks and final migration-agent review before lodgement action. No guarantee of visa grant is given.')}
      </div>
    </section>

    <main>
      ${h1('1. Executive professional advice')}
      ${para(executiveNarrative(model, subclass, stream, findings), 'lead')}
      ${kv([
        ['Pathway assessed', `Subclass ${subclass}${stream ? ' - ' + stream : ''}`],
        ['Current professional position', pick(model.currentProfessionalPosition, model.lodgementPosition, model.agentPosition && model.agentPosition.position, 'Potentially viable subject to evidence reconciliation')],
        ['Overall risk', pick(model.overallRisk, model.riskLevel, model.agentPosition && model.agentPosition.risk, 'Evidence review required')],
        ['Lodgement-readiness position', 'Not lodgement-ready until priority evidence is reconciled and reviewed']
      ])}
      ${h2('Main issues to resolve')}
      ${list(blockers.length ? blockers : findings.slice(0, 5).map(findingTitle))}

      ${h1('2. Facts, assumptions and evidence status')}
      ${kv([
        ['Applicant identity', pick(cleanAssessment.applicant_name, model.applicantName, 'Not confirmed')],
        ['Current location / visa status', pick(model.currentLocationVisaStatus, model.facts && model.facts.currentStatus, 'Not confirmed')],
        ['Stream/pathway evidence', pick(model.streamEvidenceStatus, 'Not verified')],
        ['Evidence status', pick(model.evidenceStatus, model.evidenceSummary, 'Original evidence not yet fully reviewed')]
      ])}

      ${h1('3. Legal framework applied')}
      ${para(pick(model.legalFramework, model.framework, `This assessment considered the Subclass ${subclass} ${stream || ''} framework, including stream eligibility, nomination-related issues, applicant eligibility, evidence requirements, health, character, migration-history and other public interest considerations. Final clause-level references should be confirmed against the current legislation and instruments before lodgement advice is issued.`))}

      ${h1('4. Application of law to the client’s facts')}
      ${para('The following findings apply the identified requirements to the information currently available. Status labels separate matters that appear supportable from matters that remain unclear or higher risk.')}
      ${findingsHtml}

      ${h1('5. Evidence gaps and document request')}
      ${para('Before final lodgement advice can be issued, the following evidence should be obtained and reconciled against the current instructions. The request is grouped by practical file-control priority.')}
      ${evidenceGroups.map((g, i) => `<section class="avoid-break">${h2(`Priority ${i + 1} - ${g.group}`)}${list(g.items)}</section>`).join('')}

      ${h1('6. Risk assessment')}
      ${para(pick(model.riskAssessmentSummary, model.riskSummary, 'The matter should be treated as not lodgement-ready until the identified legal criteria, evidence gaps and public interest matters have been reconciled.'))}
      ${riskHtml}

      ${h1('7. Lodgement-readiness action plan')}
      ${list((actionItems.length ? actionItems : fallbackActions).map((x, i) => `Priority ${i + 1} - ${x}`))}

      ${h1('8. Final professional recommendation')}
      ${recommendationParagraphs(model).map((p, i) => para(p, i === 0 ? 'strong' : '')).join('')}

      ${h1('9. Important limitations')}
      ${para('This advice is preliminary and based on the information presently available. It is subject to review of original documents, current law and policy, Departmental records, conflict checks and final professional review before lodgement. No guarantee of visa grant is given.')}
      <div class="signature">
        <p><strong>Yours faithfully,</strong></p>
        <p><strong>${html(BRAND.agent)}</strong><br/><strong>Registered Migration Agent | MARN: ${html(BRAND.marn)}</strong><br/><strong>${html(BRAND.name)}</strong></p>
      </div>

      <section class="page-break-before appendix">
        ${h1('Appendix A - Criterion-by-criterion lodgement-readiness matrix')}
        ${para('This appendix records the issue, status, requirement, evidence gap and action for file control. Dense table formatting is deliberately avoided so criterion content remains readable.')}
        ${appendixHtml}
      </section>
    </main>
  `);
}

function buildAppealHtml(assessment = {}, adviceBundle = {}) {
  const model = stripInternalKeys(pick(adviceBundle.appealAdviceModel, adviceBundle.advice, adviceBundle)) || {};
  const issues = asArray(pick(model.issues, model.findings, model.reviewIssues)).slice(0, 20);
  return htmlDocument(`${html(BRAND.name)} - Appeal Advice`, `
    <main>
      ${h1(pick(model.title, 'Visa refusal review advice'))}
      ${kv([
        ['Reference', pick(assessment.reference, assessment.assessment_id, assessment.id, '—')],
        ['Applicant', pick(assessment.applicant_name, assessment.applicantName, model.applicantName, '—')],
        ['Generated', new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })]
      ])}
      ${para(pick(model.executiveAdvice, model.summary, 'This appeal assessment is prepared from the information presently available and requires review of the decision record, application file and relevant time limits.'), 'lead')}
      ${h1('Issues for review')}
      ${list(issues.map(x => isPlainObject(x) ? pick(x.issue, x.title, x.finding, x.summary) : x))}
      ${h1('Recommendation')}
      ${para(pick(model.recommendation, model.finalRecommendation, 'A final appeal recommendation should be issued only after the decision record, reasons, evidence and time limits are reviewed.'))}
      ${h1('Important limitations')}
      ${para('This advice is preliminary and based on the information presently available. It is subject to review of original documents, current law and policy, Departmental records, conflict checks and final professional review before lodgement. No guarantee of visa grant is given.')}
    </main>
  `);
}

function htmlDocument(title, bodyContent) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  @page { size: A4; margin: 16mm 15mm 18mm 15mm; }
  * { box-sizing: border-box; }
  body { margin: 0; color: #172033; font-family: Arial, Helvetica, sans-serif; font-size: 10.2pt; line-height: 1.48; overflow-wrap: anywhere; word-break: normal; hyphens: auto; background: #fff; }
  h1, h2, h3, p, li, div { max-width: 100%; }
  h1 { margin: 0 0 9pt 0; color: #0b2545; font-size: 15.8pt; line-height: 1.18; page-break-after: avoid; letter-spacing: -0.01em; }
  h2 { margin: 13pt 0 6pt 0; color: #0b2545; font-size: 11.4pt; line-height: 1.25; page-break-after: avoid; }
  p { margin: 0 0 8pt 0; }
  .lead { font-size: 10.8pt; color: #1f2f46; }
  .strong { font-weight: 700; }
  ul { margin: 4pt 0 10pt 17pt; padding: 0; }
  li { margin: 0 0 4pt 0; padding-left: 2pt; }
  .cover { min-height: 245mm; padding: 0; position: relative; }
  .cover-band { background: #0b2545; color: #fff; border-radius: 14pt; padding: 18pt 20pt; display: flex; align-items: center; gap: 14pt; margin-bottom: 12pt; }
  .brand-mark { width: 42pt; height: 42pt; border-radius: 50%; border: 1.5pt solid rgba(212,175,55,.95); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15pt; letter-spacing: .04em; color: #d4af37; flex: 0 0 auto; }
  .brand { color: #fff; font-weight: 700; font-size: 14.2pt; margin-bottom: 2pt; }
  .subtitle { color: #d8e1ef; font-size: 9.2pt; }
  .gold-rule { height: 3pt; background: #d4af37; border-radius: 999px; width: 35%; margin: 0 0 22pt 0; }
  .cover-kicker { color: #7b8798; text-transform: uppercase; letter-spacing: .12em; font-size: 8.2pt; font-weight: 700; margin-bottom: 8pt; }
  .cover-title { font-size: 30pt; line-height: 1.04; margin: 0 0 20pt 0; color: #0b2545; letter-spacing: -0.03em; }
  .matter-card { border: 1px solid #dbe3ee; border-radius: 14pt; padding: 10pt; background: #f8fafc; box-shadow: 0 8pt 22pt rgba(11,37,69,.08); margin-bottom: 16pt; page-break-inside: avoid; }
  .cover-note { border-left: 4pt solid #d4af37; padding: 8pt 0 2pt 12pt; color: #26364a; }
  .kv { width: 100%; border: 1px solid #dbe3ee; border-radius: 9pt; overflow: hidden; margin: 5pt 0 12pt 0; page-break-inside: avoid; background: #fff; }
  .kv-row { display: grid; grid-template-columns: 34% 66%; border-bottom: 1px solid #dbe3ee; min-height: 23pt; }
  .kv-row:last-child { border-bottom: 0; }
  .kv-key { background: #eef3f9; color: #26364a; font-weight: 700; padding: 6.5pt 8pt; }
  .kv-val { background: #fff; padding: 6.5pt 8pt; color: #172033; }
  .advice-block { border: 1px solid #dbe3ee; border-radius: 9pt; background: #fbfdff; padding: 7pt 8.5pt; margin: 0 0 6.5pt 0; page-break-inside: avoid; }
  .block-label { color: #0b2545; font-size: 8.5pt; font-weight: 700; margin-bottom: 2.5pt; text-transform: uppercase; letter-spacing: .035em; }
  .block-value { color: #172033; }
  .finding, .risk, .appendix-item { border-top: 1px solid #e4ebf3; padding-top: 5pt; margin-top: 9pt; }
  .avoid-break { page-break-inside: avoid; break-inside: avoid; }
  .page-break-after { page-break-after: always; }
  .page-break-before { page-break-before: always; }
  .signature { margin-top: 18pt; }
  .appendix h1 { margin-top: 0; }
</style>
</head>
<body>${bodyContent}</body>
</html>`;
}

function assertNoForbiddenClientText(renderedHtml) {
  const lower = cleanText(renderedHtml).toLowerCase();
  const hit = FORBIDDEN_CLIENT_PHRASES.find(phrase => lower.includes(String(phrase).toLowerCase()));
  if (hit) throw new Error(`PDF blocked: client-facing advice contains internal phrase: ${hit}`);
}

async function renderHtmlToPdfBuffer(renderedHtml) {
  assertNoForbiddenClientText(renderedHtml);
  let playwright;
  try {
    playwright = require('playwright');
  } catch (err) {
    throw new Error('Playwright is not installed. Add dependency "playwright" and redeploy, or allow PDFKIT_LEGACY_FALLBACK=true.');
  }

  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1240, height: 1754 } });
    await page.setContent(renderedHtml, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

async function buildAssessmentPdfBuffer(assessment = {}, adviceBundle = {}) {
  const renderedHtml = buildAssessmentHtml(assessment, adviceBundle);
  return renderHtmlToPdfBuffer(renderedHtml);
}

async function buildAppealAdvicePdfBuffer(assessment = {}, adviceBundle = {}) {
  const renderedHtml = buildAppealHtml(assessment, adviceBundle);
  return renderHtmlToPdfBuffer(renderedHtml);
}

module.exports = {
  buildAssessmentPdfBuffer,
  buildAppealAdvicePdfBuffer,
  buildAssessmentHtml,
  buildAppealHtml,
  RENDERER_VERSION
};
