import { analyzeBytes, sanitizeBytes } from './core/analyze.js';
import { verifyC2pa } from './core/c2pa.js';
import { categorySummary, reportToJson, reportToMarkdown } from './core/report.js';
import { escapeHtml, formatBytes, mimeFromExtension, safeFilename } from './core/utils.js';

const $ = (selector) => document.querySelector(selector);
const PROJECT_URL = 'https://github.com/jinyounghub/shareglass';
const elements = {
  dropView: $('#drop-view'),
  loadingView: $('#loading-view'),
  reportView: $('#report-view'),
  input: $('#file-input'),
  dropZone: $('#drop-zone'),
  loadingLabel: $('#loading-label'),
  filePreview: $('#file-preview'),
  fileType: $('#file-type-label'),
  fileName: $('#file-name'),
  fileMeta: $('#file-meta'),
  riskRing: $('#risk-ring'),
  riskScore: $('#risk-score'),
  riskLevel: $('#risk-level'),
  summary: $('#summary-strip'),
  filters: $('#finding-filters'),
  findings: $('#findings-list'),
  safePanel: $('#safe-copy-panel'),
  safeDescription: $('#safe-copy-description'),
  safeActions: $('#safe-actions'),
  provenanceConfirm: $('#provenance-confirm'),
  signatureConfirm: $('#signature-confirm'),
  safeButton: $('#create-safe-copy'),
  safeResult: $('#safe-result'),
  provenancePanel: $('#provenance-panel'),
  provenanceCopy: $('#provenance-copy'),
  verifyC2pa: $('#verify-c2pa'),
  c2paResult: $('#c2pa-result'),
  technical: $('#technical-details'),
  toast: $('#toast'),
  canvas: $('#share-canvas')
};

const state = {
  bytes: null,
  report: null,
  mime: null,
  filter: 'all',
  previewUrl: null,
  safeUrl: null,
  c2pa: null
};

const severityColor = {
  critical: '#ff6b7d',
  high: '#ff6b7d',
  medium: '#ffbf5b',
  low: '#48cce8',
  clear: '#5de09e'
};

function showView(name) {
  elements.dropView.hidden = name !== 'drop';
  elements.loadingView.hidden = name !== 'loading';
  elements.reportView.hidden = name !== 'report';
}

function toast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', error);
  elements.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { elements.toast.hidden = true; }, 3600);
}

function downloadBlob(filename, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeFilename(filename);
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function resetState() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  if (state.safeUrl) URL.revokeObjectURL(state.safeUrl);
  Object.assign(state, { bytes: null, report: null, mime: null, filter: 'all', previewUrl: null, safeUrl: null, c2pa: null });
  elements.input.value = '';
  elements.safeResult.hidden = true;
  elements.c2paResult.hidden = true;
  showView('drop');
  history.replaceState({}, '', location.pathname);
}

function loadingStage(text) {
  elements.loadingLabel.textContent = text;
}

async function inspect(name, bytes, mime = '') {
  showView('loading');
  loadingStage('Reading the file signature locally.');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    state.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    state.mime = mime || mimeFromExtension(name);
    loadingStage('Inspecting hidden structures and metadata.');
    state.report = await analyzeBytes({ name, bytes: state.bytes, mime: state.mime });
    loadingStage('Scoring findings and preparing remediation options.');
    await new Promise((resolve) => setTimeout(resolve, 90));
    renderReport();
    showView('report');
    document.querySelector('.scanner-shell').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    showView('drop');
    toast(error instanceof Error ? error.message : String(error), true);
  }
}

async function inspectFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  await inspect(file.name, bytes, file.type);
}

async function loadSample(name) {
  showView('loading');
  loadingStage(`Loading the synthetic sample ${name}.`);
  try {
    const response = await fetch(`samples/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(`Sample could not be loaded (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await inspect(name, bytes, mimeFromExtension(name));
    history.replaceState({}, '', `?sample=${encodeURIComponent(name)}`);
  } catch (error) {
    showView('drop');
    toast(error instanceof Error ? error.message : String(error), true);
  }
}

function fileBadge(report) {
  if (['jpeg', 'png', 'webp'].includes(report.type.kind)) {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = URL.createObjectURL(new Blob([state.bytes], { type: report.file.mime }));
    elements.filePreview.innerHTML = `<img src="${state.previewUrl}" alt="Local preview">`;
    return;
  }
  const label = report.type.officeType?.toUpperCase() || (report.type.kind === 'pdf' ? 'PDF' : report.type.kind.toUpperCase());
  elements.filePreview.textContent = label;
}

function renderSummary(report) {
  const high = (report.summary.counts.critical || 0) + (report.summary.counts.high || 0);
  const external = report.summary.categories.external || 0;
  const identity = (report.summary.categories.identity || 0) + (report.summary.categories.location || 0);
  const values = [
    ['Actionable', report.summary.actionable],
    ['High risk', high],
    ['Identity / location', identity],
    ['External', external],
    ['Cleanable', report.summary.cleanable]
  ];
  elements.summary.innerHTML = values.map(([label, value]) => `
    <div class="summary-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join('');
}

function renderFilters(report) {
  const levels = [
    ['all', 'All', report.findings.length],
    ['high', 'High', (report.summary.counts.critical || 0) + (report.summary.counts.high || 0)],
    ['medium', 'Medium', report.summary.counts.medium || 0],
    ['low', 'Low', report.summary.counts.low || 0],
    ['info', 'Info', report.summary.counts.info || 0]
  ].filter(([, , count]) => count > 0 || count === report.findings.length);
  elements.filters.innerHTML = levels.map(([id, label, count]) => `
    <button type="button" class="filter-button ${state.filter === id ? 'active' : ''}" data-filter="${id}">${label} ${count}</button>
  `).join('');
  elements.filters.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    renderFilters(report);
    renderFindings(report);
  }));
}

function matchesFilter(item) {
  if (state.filter === 'all') return true;
  if (state.filter === 'high') return ['critical', 'high'].includes(item.severity);
  return item.severity === state.filter;
}

function renderFindings(report) {
  const findings = report.findings.filter(matchesFilter);
  if (!findings.length) {
    elements.findings.innerHTML = `<div class="no-findings"><strong>Nothing in this view</strong><span>Choose another severity filter.</span></div>`;
    return;
  }
  elements.findings.innerHTML = findings.map((item) => `
    <article class="finding-card" data-severity="${escapeHtml(item.severity)}">
      <span class="finding-dot" aria-hidden="true"></span>
      <div>
        <div class="finding-top"><span class="severity-label">${escapeHtml(item.severity)} · ${escapeHtml(item.category)}</span><h4>${escapeHtml(item.title)}</h4></div>
        <p>${escapeHtml(item.description)}</p>
        ${item.evidence ? `<span class="finding-evidence">${escapeHtml(item.evidence)}</span>` : ''}
        ${item.path ? `<span class="finding-path">${escapeHtml(item.path)}</span>` : ''}
      </div>
    </article>
  `).join('');
}

function renderSafeCopy(report) {
  const actions = report.capabilities.sanitizeActions;
  elements.safeResult.hidden = true;
  elements.provenanceConfirm.hidden = !report.capabilities.c2paCandidate;
  elements.provenanceConfirm.querySelector('input').checked = false;
  elements.signatureConfirm.hidden = !(report.metadata.signatures > 0);
  elements.signatureConfirm.querySelector('input').checked = false;

  if (!actions.length) {
    elements.safeActions.innerHTML = `<div class="unsupported-copy">${report.type.kind === 'pdf'
      ? 'PDF is inspection-only in v1. ShareGlass will not risk corrupting cross-reference tables, forms, or signatures.'
      : 'No supported removable metadata was detected in this file.'}</div>`;
    elements.safeDescription.textContent = 'The original file is never changed.';
    elements.safeButton.disabled = true;
    elements.safeButton.textContent = 'No safe-copy action available';
    return;
  }

  elements.safeDescription.textContent = 'Choose what to remove. The original file is never changed.';
  elements.safeActions.innerHTML = actions.map((action) => `
    <label class="safe-action ${action.destructive ? 'destructive' : ''}">
      <input type="checkbox" value="${escapeHtml(action.id)}" ${action.default ? 'checked' : ''}>
      <span><strong>${escapeHtml(action.label)}</strong><span>${escapeHtml(action.description)}</span></span>
    </label>
  `).join('');
  elements.safeButton.disabled = false;
  elements.safeButton.textContent = 'Create & verify safe copy';
  elements.safeActions.querySelectorAll('input').forEach((input) => input.addEventListener('change', updateSafeButton));
  updateSafeButton();
}

function selectedActions() {
  return [...elements.safeActions.querySelectorAll('input:checked')].map((input) => input.value);
}

function updateSafeButton() {
  const count = selectedActions().length;
  elements.safeButton.disabled = count === 0;
  elements.safeButton.textContent = count ? `Create & verify safe copy (${count})` : 'Select an action';
}

function renderProvenance(report) {
  const supported = ['jpeg', 'png', 'webp', 'pdf'].includes(report.type.kind);
  elements.verifyC2pa.disabled = !supported;
  elements.c2paResult.hidden = true;
  if (!supported) {
    elements.provenanceCopy.textContent = 'C2PA verification is currently available for supported images and PDFs. Office package signatures are reported separately.';
    elements.verifyC2pa.textContent = 'Not available for this format';
  } else if (report.capabilities.c2paCandidate) {
    elements.provenanceCopy.textContent = 'A possible C2PA/JUMBF marker was found. Validate it cryptographically with the official browser SDK; your file remains local.';
    elements.verifyC2pa.textContent = 'Validate detected credentials';
  } else {
    elements.provenanceCopy.textContent = 'No structural marker was detected. You can still ask the official C2PA SDK to check the complete file. The SDK and WASM load only after this click.';
    elements.verifyC2pa.textContent = 'Check for Content Credentials';
  }
}

function renderTechnical(report) {
  const rows = [
    ['Detected type', `${report.type.label} (${report.type.kind})`],
    ['MIME', report.file.mime],
    ['File size', `${report.file.size} bytes`],
    ['SHA-256', report.file.sha256],
    ['Content fingerprint', report.contentFingerprint || 'Not available'],
    ['Magic mismatch', report.type.magicMismatch ? 'Yes' : 'No'],
    ['C2PA marker', report.capabilities.c2paCandidate ? 'Possible marker found' : 'Not detected'],
    ['Generated', report.generatedAt]
  ];
  const metadata = JSON.stringify(report.metadata, null, 2);
  elements.technical.innerHTML = rows.map(([key, value]) => `
    <div class="tech-row"><span>${escapeHtml(key)}</span><span>${escapeHtml(value)}</span></div>
  `).join('') + `<div class="tech-row"><span>Detector data</span><span>${escapeHtml(metadata.slice(0, 5000))}</span></div>`;
}

function renderReport() {
  const report = state.report;
  state.filter = 'all';
  state.c2pa = null;
  fileBadge(report);
  elements.fileType.textContent = report.type.label;
  elements.fileName.textContent = report.file.name;
  elements.fileName.title = report.file.name;
  elements.fileMeta.textContent = `${formatBytes(report.file.size)} · SHA-256 ${report.file.sha256.slice(0, 16)}…`;
  elements.riskScore.textContent = report.summary.score;
  elements.riskLevel.textContent = report.summary.level[0].toUpperCase() + report.summary.level.slice(1);
  elements.riskRing.style.setProperty('--score', report.summary.score);
  elements.riskRing.style.setProperty('--ring-color', severityColor[report.summary.level] || severityColor.clear);
  renderSummary(report);
  renderFilters(report);
  renderFindings(report);
  renderSafeCopy(report);
  renderProvenance(report);
  renderTechnical(report);
}

async function createSafeCopy() {
  const actions = selectedActions();
  if (!actions.length) return;
  const provenanceAccepted = elements.provenanceConfirm.hidden || elements.provenanceConfirm.querySelector('input').checked;
  const signatureAccepted = elements.signatureConfirm.hidden || elements.signatureConfirm.querySelector('input').checked;
  if (!provenanceAccepted) {
    toast('Confirm the Content Credentials warning before creating a derivative.', true);
    return;
  }
  if (!signatureAccepted) {
    toast('Confirm the digital signature warning before creating an unsigned copy.', true);
    return;
  }
  const originalText = elements.safeButton.textContent;
  elements.safeButton.disabled = true;
  elements.safeButton.textContent = 'Creating and scanning the copy…';
  try {
    const result = await sanitizeBytes({
      name: state.report.file.name,
      bytes: state.bytes,
      report: state.report,
      actions,
      forceProvenance: provenanceAccepted,
      forceSigned: signatureAccepted
    });
    if (state.safeUrl) URL.revokeObjectURL(state.safeUrl);
    state.safeUrl = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }));
    const fingerprintText = result.verification.sameContent
      ? 'The content fingerprint is unchanged.'
      : actions.includes('office-accept-changes')
        ? 'The content fingerprint changed because tracked revisions were accepted.'
        : 'The content fingerprint changed; review the copy before sending it.';
    elements.safeResult.innerHTML = `
      <strong>Safer copy created and scanned again</strong>
      <p>${result.verification.originalFindings} → ${result.verification.sanitizedFindings} actionable findings. ${escapeHtml(fingerprintText)}</p>
      <div class="safe-result-actions">
        <a class="button primary" href="${state.safeUrl}" download="${escapeHtml(result.name)}">Download ${escapeHtml(result.name)}</a>
        <a class="button star-action" href="${PROJECT_URL}" target="_blank" rel="noopener noreferrer">★ Star ShareGlass</a>
      </div>
      ${(result.warnings || []).map((warning) => `<p>⚠ ${escapeHtml(warning)}</p>`).join('')}
    `;
    elements.safeResult.hidden = false;
    toast(`Safe copy verified: ${result.verification.reducedBy} finding(s) removed.`);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  } finally {
    elements.safeButton.disabled = false;
    elements.safeButton.textContent = originalText;
    updateSafeButton();
  }
}

async function runC2paVerification() {
  elements.verifyC2pa.disabled = true;
  const original = elements.verifyC2pa.textContent;
  elements.verifyC2pa.textContent = 'Loading official SDK and validating…';
  elements.c2paResult.hidden = true;
  try {
    state.c2pa = await verifyC2pa(state.bytes, state.report.file.mime);
    const statusLabel = state.c2pa.status === 'valid' ? 'Manifest read without validation failure'
      : state.c2pa.status === 'invalid' ? 'Validation problem reported'
        : 'No readable manifest';
    elements.c2paResult.innerHTML = `
      <strong>${escapeHtml(statusLabel)}</strong>
      <span>${escapeHtml(state.c2pa.summary || '')}</span>
      ${state.c2pa.claimGenerator ? `<br><span>Claim generator: ${escapeHtml(state.c2pa.claimGenerator)}</span>` : ''}
      ${state.c2pa.activeManifest ? `<br><span>Active manifest: ${escapeHtml(state.c2pa.activeManifest)}</span>` : ''}
      ${state.c2pa.validationCodes?.length ? `<br><span>Status codes: ${escapeHtml(state.c2pa.validationCodes.slice(0, 8).join(', '))}</span>` : ''}
      <br><span>Official @contentauth/c2pa-web ${escapeHtml(state.c2pa.sdkVersion)}</span>
    `;
    elements.c2paResult.hidden = false;
  } catch (error) {
    elements.c2paResult.innerHTML = `<strong>Verification could not run</strong><span>${escapeHtml(error instanceof Error ? error.message : String(error))}</span>`;
    elements.c2paResult.hidden = false;
  } finally {
    elements.verifyC2pa.disabled = false;
    elements.verifyC2pa.textContent = original;
  }
}

function exportJson() {
  downloadBlob(`${state.report.file.name}.shareglass.json`, reportToJson({ ...state.report, c2pa: state.c2pa }), 'application/json');
}

function exportMarkdown() {
  downloadBlob(`${state.report.file.name}.shareglass.md`, reportToMarkdown(state.report), 'text/markdown');
}

async function exportShareCard() {
  const report = state.report;
  const canvas = elements.canvas;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 1200, 630);
  gradient.addColorStop(0, '#07111f');
  gradient.addColorStop(.62, '#0c1b2e');
  gradient.addColorStop(1, '#11243c');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const glow = context.createRadialGradient(1010, 90, 10, 1010, 90, 440);
  glow.addColorStop(0, 'rgba(72,204,232,.26)');
  glow.addColorStop(1, 'rgba(72,204,232,0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = '#73f0cc';
  context.font = '700 26px ui-sans-serif, system-ui';
  context.fillText('◈  ShareGlass', 72, 78);
  context.fillStyle = '#9caec2';
  context.font = '500 18px ui-sans-serif, system-ui';
  context.fillText('LOCAL FILE PRIVACY REPORT', 72, 118);

  context.fillStyle = '#f1f7fd';
  context.font = '750 54px ui-sans-serif, system-ui';
  context.fillText('See what your files reveal.', 72, 205);
  context.fillStyle = '#9caec2';
  context.font = '500 24px ui-sans-serif, system-ui';
  context.fillText(`${report.type.label} · file name hidden · processed locally`, 72, 248);

  context.beginPath();
  context.arc(980, 290, 118, 0, Math.PI * 2);
  context.strokeStyle = 'rgba(255,255,255,.10)';
  context.lineWidth = 18;
  context.stroke();
  context.beginPath();
  context.arc(980, 290, 118, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * report.summary.score / 100);
  context.strokeStyle = severityColor[report.summary.level] || severityColor.clear;
  context.lineWidth = 18;
  context.lineCap = 'round';
  context.stroke();
  context.fillStyle = '#f1f7fd';
  context.font = '760 64px ui-sans-serif, system-ui';
  context.textAlign = 'center';
  context.fillText(String(report.summary.score), 980, 305);
  context.fillStyle = '#9caec2';
  context.font = '700 16px ui-monospace, monospace';
  context.fillText(report.summary.level.toUpperCase(), 980, 342);
  context.textAlign = 'left';

  const categories = categorySummary(report).slice(0, 4);
  const labels = categories.length ? categories : [{ label: 'No actionable findings', count: 0 }];
  labels.forEach((item, index) => {
    const x = 72 + (index % 2) * 330;
    const y = 350 + Math.floor(index / 2) * 88;
    context.fillStyle = 'rgba(255,255,255,.045)';
    context.strokeStyle = 'rgba(159,190,222,.16)';
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(x, y, 302, 68, 14);
    context.fill();
    context.stroke();
    context.fillStyle = '#f1f7fd';
    context.font = '720 25px ui-sans-serif, system-ui';
    context.fillText(String(item.count), x + 20, y + 42);
    context.fillStyle = '#9caec2';
    context.font = '600 16px ui-sans-serif, system-ui';
    context.fillText(item.label, x + 58, y + 41);
  });

  context.fillStyle = '#73f0cc';
  context.font = '650 18px ui-sans-serif, system-ui';
  context.fillText('No upload. No account. No analytics.', 72, 570);
  context.fillStyle = '#6f8299';
  context.font = '500 16px ui-sans-serif, system-ui';
  context.fillText('github.com/jinyounghub/shareglass', 840, 570);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The share card could not be generated.');
  const file = new File([blob], 'shareglass-report.png', { type: 'image/png' });
  const shareData = {
    title: 'ShareGlass local privacy report',
    text: 'I checked what a file reveals before sharing it — entirely in my browser.',
    url: PROJECT_URL,
    files: [file]
  };
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
    try {
      await navigator.share(shareData);
      toast('Share sheet opened.');
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
    }
  }
  downloadBlob(file.name, blob, file.type);
  toast('Share card downloaded.');
}

function handleFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (files.length > 1) toast('ShareGlass currently shows one report at a time. Inspecting the first selected file.');
  inspectFile(files[0]);
}

elements.dropZone.addEventListener('click', () => elements.input.click());
elements.input.addEventListener('change', () => handleFiles(elements.input.files));
for (const event of ['dragenter', 'dragover']) {
  window.addEventListener(event, (input) => {
    input.preventDefault();
    elements.dropZone.classList.add('dragging');
  });
}
for (const event of ['dragleave', 'drop']) {
  window.addEventListener(event, (input) => {
    input.preventDefault();
    elements.dropZone.classList.remove('dragging');
  });
}
window.addEventListener('drop', (event) => handleFiles(event.dataTransfer.files));

document.querySelectorAll('[data-sample]').forEach((button) => button.addEventListener('click', (event) => {
  event.stopPropagation();
  loadSample(button.dataset.sample);
}));
$('#new-file').addEventListener('click', resetState);
$('#export-json').addEventListener('click', exportJson);
$('#export-markdown').addEventListener('click', exportMarkdown);
$('#share-card').addEventListener('click', exportShareCard);
elements.safeButton.addEventListener('click', createSafeCopy);
elements.verifyC2pa.addEventListener('click', runC2paVerification);

const sampleParam = new URLSearchParams(location.search).get('sample');
const allowedSamples = new Set(['private-resume.docx', 'private-photo.png', 'risky-contract.pdf']);
if (sampleParam && allowedSamples.has(sampleParam)) loadSample(sampleParam);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
