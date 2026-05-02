/**
 * dashboard-persuasion-ux.js
 * Bircan Migration — Client Dashboard Persuasion UX
 *
 * Purpose:
 * Adds compliant, conversion-grade client journey UI to account-dashboard.html.
 * This module does NOT change legal outcomes. It only explains the current
 * position in senior migration-agent voice and directs the client to safe next steps.
 *
 * Drop-in use:
 *   <link rel="stylesheet" href="dashboard-persuasion-ux.css">
 *   <script src="dashboard-persuasion-ux.js"></script>
 *   <script>
 *     window.BircanDashboardPersuasionUX.render({
 *       container: '#persuasionUx',
 *       matters: window.dashboardMatters || []
 *     });
 *   </script>
 */
(function () {
  'use strict';

  const HARD_STOP_TERMS = [
    'PIC 4020', 'FALSE DOCUMENT', 'MISLEADING', 'CHARACTER', 'S501',
    'NOT_LODGEABLE', 'INVALID_OR_NOT_LODGEABLE', 'INVALID APPLICATION',
    'SECTION 48', 'NO FURTHER STAY', '8503', '8534', '8535'
  ];

  function text(v) { return v == null ? '' : String(v); }
  function upper(v) { return text(v).toUpperCase(); }
  function titleCase(v) {
    return text(v).replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
  }
  function safeHtml(v) {
    return text(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  function getMatterValue(m, keys) {
    for (const k of keys) {
      if (m && m[k] !== undefined && m[k] !== null && text(m[k]).trim() !== '') return m[k];
    }
    const fp = m && (m.form_payload || m.formPayload || m.payload || {});
    for (const k of keys) {
      if (fp && fp[k] !== undefined && fp[k] !== null && text(fp[k]).trim() !== '') return fp[k];
    }
    const decision = m && (m.decision || m.rawDecision || m.adviceBundle || {});
    for (const k of keys) {
      if (decision && decision[k] !== undefined && decision[k] !== null && text(decision[k]).trim() !== '') return decision[k];
    }
    return '';
  }
  function hasHardStop(m) {
    const hay = upper(JSON.stringify(m || {}));
    return HARD_STOP_TERMS.some(term => hay.includes(upper(term)));
  }
  function normaliseLodgement(m) {
    return upper(getMatterValue(m, ['lodgementPosition', 'lodgement_position', 'status', 'decisionStatus', 'decision_status']));
  }
  function normaliseRisk(m) {
    return upper(getMatterValue(m, ['riskLevel', 'risk_level', 'risk']));
  }
  function isPotentiallyViable(m) {
    const lodgement = normaliseLodgement(m);
    return lodgement.includes('POTENTIALLY') || lodgement.includes('SUBJECT_TO_EVIDENCE') || lodgement.includes('PDF_READY');
  }
  function classifyMatter(m) {
    if (hasHardStop(m)) return 'hard-stop';
    const risk = normaliseRisk(m);
    const lodgement = normaliseLodgement(m);
    if (lodgement.includes('NOT_READY') || lodgement.includes('INFORMATION_REQUIRED')) return 'info-required';
    if (isPotentiallyViable(m)) return 'potentially-viable';
    if (risk.includes('LOW')) return 'strong';
    if (risk.includes('HIGH') || risk.includes('CRITICAL')) return 'review-required';
    return 'neutral';
  }
  function subclassTitle(m) {
    const subclass = getMatterValue(m, ['visa_type', 'visaType', 'subclass']) || 'visa';
    const title = getMatterValue(m, ['subclassTitle', 'subclass_title', 'title']);
    return title ? `Subclass ${safeHtml(subclass)} — ${safeHtml(title)}` : `Subclass ${safeHtml(subclass)} assessment`;
  }
  function primaryIssue(m) {
    return getMatterValue(m, ['primaryReason', 'primary_reason', 'generation_error']) || 'supporting evidence and final review';
  }
  function ctaFor(m) {
    const kind = classifyMatter(m);
    if (kind === 'hard-stop') return { label: 'Request legal review', tone: 'danger', note: 'This matter requires professional review before any further action.' };
    if (kind === 'potentially-viable' || kind === 'strong') return { label: 'Proceed to document review', tone: 'positive', note: 'The next step is to verify documents and confirm readiness.' };
    if (kind === 'info-required') return { label: 'Complete missing information', tone: 'warning', note: 'More instructions are needed before final advice can be formed.' };
    return { label: 'Review next steps', tone: 'neutral', note: 'Review the pathway and evidence checklist before progressing.' };
  }
  function clientNarrative(m) {
    const kind = classifyMatter(m);
    const issue = safeHtml(primaryIssue(m));
    if (kind === 'hard-stop') {
      return `In my view, this matter should not be positively framed until the identified legal issue has been reviewed. The immediate priority is to assess ${issue} before any lodgement activity is considered.`;
    }
    if (kind === 'potentially-viable') {
      return `Based on the information currently available, this pathway appears capable of progressing, subject to verification of the supporting evidence. The key issue to resolve before lodgement is ${issue}.`;
    }
    if (kind === 'strong') {
      return `The current assessment indicates a favourable preliminary position, subject to final verification and professional review before lodgement.`;
    }
    if (kind === 'info-required') {
      return `Further information is required before I can form a reliable view about this pathway. The next step is to complete the missing instructions and supporting evidence.`;
    }
    return `This matter requires structured review before a final position can be confirmed. The dashboard steps below are designed to move the matter forward safely.`;
  }
  function progressSteps(m) {
    const kind = classifyMatter(m);
    if (kind === 'hard-stop') {
      return [
        ['Legal review', 'Review the identified blocker before any action.'],
        ['Evidence audit', 'Check original documents and Department history.'],
        ['Strategy decision', 'Decide whether the matter can safely proceed.']
      ];
    }
    return [
      ['Confirm pathway', 'Review the preliminary assessment and key risk issue.'],
      ['Verify evidence', 'Upload or provide documents needed to support the claim.'],
      ['Agent review', 'Conduct final review before lodgement or further action.']
    ];
  }
  function renderMatterCard(m, index) {
    const cta = ctaFor(m);
    const kind = classifyMatter(m);
    const risk = getMatterValue(m, ['riskLevel', 'risk_level', 'risk']) || 'Pending review';
    const lodgement = getMatterValue(m, ['lodgementPosition', 'lodgement_position', 'decisionStatus', 'decision_status', 'status']) || 'Assessment in progress';
    const ref = getMatterValue(m, ['id', 'assessmentId', 'assessment_id', 'reference']) || `matter-${index + 1}`;
    const steps = progressSteps(m).map((s, i) => `
      <div class="bmux-step">
        <div class="bmux-step-dot">${i + 1}</div>
        <div><strong>${safeHtml(s[0])}</strong><span>${safeHtml(s[1])}</span></div>
      </div>`).join('');

    return `
      <article class="bmux-card bmux-${kind}">
        <div class="bmux-card-head">
          <div>
            <p class="bmux-eyebrow">Active pathway</p>
            <h3>${subclassTitle(m)}</h3>
            <p class="bmux-ref">Reference: ${safeHtml(ref)}</p>
          </div>
          <span class="bmux-risk">${safeHtml(titleCase(risk))}</span>
        </div>
        <div class="bmux-position">
          <strong>${safeHtml(titleCase(lodgement))}</strong>
          <p>${clientNarrative(m)}</p>
        </div>
        <div class="bmux-steps">${steps}</div>
        <div class="bmux-action-row">
          <button type="button" class="bmux-btn bmux-btn-${safeHtml(cta.tone)}" data-bmux-action="${safeHtml(cta.label)}" data-bmux-ref="${safeHtml(ref)}">${safeHtml(cta.label)}</button>
          <p>${safeHtml(cta.note)}</p>
        </div>
      </article>`;
  }
  function renderSummary(matters) {
    const viable = matters.filter(m => ['potentially-viable', 'strong'].includes(classifyMatter(m))).length;
    const review = matters.filter(m => ['hard-stop', 'review-required'].includes(classifyMatter(m))).length;
    const info = matters.filter(m => classifyMatter(m) === 'info-required').length;
    return `
      <section class="bmux-summary">
        <div>
          <p class="bmux-eyebrow">Client pathway dashboard</p>
          <h2>Your migration strategy position</h2>
          <p class="bmux-summary-copy">This dashboard presents the next practical steps based on the current preliminary assessment. It does not replace final migration advice or original document review.</p>
        </div>
        <div class="bmux-metrics">
          <div><strong>${viable}</strong><span>potentially viable</span></div>
          <div><strong>${info}</strong><span>information required</span></div>
          <div><strong>${review}</strong><span>legal review</span></div>
        </div>
      </section>`;
  }
  function renderEmpty() {
    return `
      <section class="bmux-empty">
        <p class="bmux-eyebrow">No active pathway yet</p>
        <h2>Start with a preliminary assessment</h2>
        <p>Once an assessment is submitted, this area will show the client’s pathway position, evidence priorities and next safe step.</p>
      </section>`;
  }
  function render(options) {
    const opts = options || {};
    const container = typeof opts.container === 'string' ? document.querySelector(opts.container) : opts.container;
    if (!container) return false;
    const matters = Array.isArray(opts.matters) ? opts.matters : [];
    container.classList.add('bmux-root');
    if (!matters.length) {
      container.innerHTML = renderEmpty();
      return true;
    }
    container.innerHTML = renderSummary(matters) + `<section class="bmux-grid">${matters.map(renderMatterCard).join('')}</section>`;
    container.querySelectorAll('[data-bmux-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const event = new CustomEvent('bircan:dashboardPersuasionAction', {
          detail: { action: btn.getAttribute('data-bmux-action'), reference: btn.getAttribute('data-bmux-ref') }
        });
        window.dispatchEvent(event);
      });
    });
    return true;
  }
  window.BircanDashboardPersuasionUX = { render, classifyMatter, hasHardStop };
})();
