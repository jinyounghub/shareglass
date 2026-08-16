import { detectFileType } from './detectors/file-type.js';
import { scanImage } from './detectors/image.js';
import { scanOoxml } from './detectors/ooxml.js';
import { scanPdf } from './detectors/pdf.js';
import { dedupeFindings, finding, summarizeFindings } from './findings.js';
import { sha256 } from './hash.js';
import { sanitizeImage } from './sanitizers/image.js';
import { sanitizeOoxml } from './sanitizers/ooxml.js';
import { mimeFromExtension, outputFilename } from './utils.js';

export const SHAREGLASS_VERSION = '1.0.0';
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const severity = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
    if (severity) return severity;
    return a.category.localeCompare(b.category) || a.title.localeCompare(b.title);
  });
}

function sanitizeActions(type, scan) {
  if (['jpeg', 'png', 'webp'].includes(type.kind)) {
    return scan.sanitizable ? [{
      id: 'image-metadata',
      label: 'Remove EXIF, XMP, IPTC, comments and timestamps',
      description: 'Pixel/image payload is preserved. Suspected Content Credentials are removed only after explicit confirmation.',
      default: true,
      destructive: false
    }] : [];
  }
  if (type.kind === 'ooxml') {
    const findings = scan.findings;
    const has = (action) => findings.some((item) => item.cleanAction === action);
    const actions = [];
    if (has('office-properties')) actions.push({
      id: 'office-properties', label: 'Remove author and application properties',
      description: 'Clears creator, last editor, timestamps, company, template and application fingerprints.',
      default: true, destructive: false
    });
    if (has('office-comments') && type.officeType === 'docx') actions.push({
      id: 'office-comments', label: 'Remove Word comments and reviewer identities',
      description: 'Deletes comment parts and their in-document markers.',
      default: true, destructive: true
    });
    if (has('office-thumbnail')) actions.push({
      id: 'office-thumbnail', label: 'Remove cached thumbnail',
      description: 'Removes the package preview image.', default: true, destructive: false
    });
    if (has('office-customxml')) actions.push({
      id: 'office-customxml', label: 'Remove custom properties and XML',
      description: 'May affect content controls or enterprise workflows that depend on custom XML.',
      default: false, destructive: true
    });
    if (has('office-external-links')) actions.push({
      id: 'office-external-links', label: 'Neutralize external relationship targets',
      description: 'Replaces URLs and file paths with a reserved .invalid address while preserving visible text.',
      default: false, destructive: true
    });
    if (has('office-accept-changes') && type.officeType === 'docx') actions.push({
      id: 'office-accept-changes', label: 'Accept tracked changes',
      description: 'Keeps insertions and removes deleted/moved-from content. Review the result carefully.',
      default: false, destructive: true
    });
    return actions;
  }
  return [];
}

function c2paCandidate(scan) {
  return Boolean(scan?.metadata?.c2paCandidate);
}

export async function analyzeBytes(input) {
  const name = String(input.name || 'unnamed-file');
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  const providedMime = input.mime || mimeFromExtension(name);
  if (!bytes.byteLength) throw new Error('The selected file is empty.');
  if (bytes.byteLength > (input.maxFileBytes || MAX_FILE_BYTES)) {
    throw new Error(`The file is larger than the ${Math.round((input.maxFileBytes || MAX_FILE_BYTES) / 1024 / 1024)} MB safety limit.`);
  }

  const type = await detectFileType(name, bytes, providedMime);
  const findings = [];
  if (type.magicMismatch) findings.push(finding({
    category: 'compatibility', severity: 'medium', title: 'File type mismatch',
    description: 'The filename or browser-provided MIME type does not match the file signature.',
    evidence: `Detected ${type.label}; extension .${type.extension || '(none)'}; claimed ${type.claimedMime}`,
    path: 'File header'
  }));
  if (type.invalidArchive) findings.push(finding({
    category: 'integrity', severity: 'critical', title: 'Invalid or unsafe ZIP package',
    description: 'The archive could not be opened safely, so Office content was not inspected.',
    evidence: type.archiveError, path: 'ZIP central directory'
  }));

  let scan = { findings: [], metadata: {}, sanitizable: false, fingerprint: null, contentFingerprint: null };
  if (['jpeg', 'png', 'webp'].includes(type.kind)) scan = await scanImage(type.kind, bytes);
  else if (type.kind === 'ooxml' && type.zip) scan = await scanOoxml(type.zip, type.officeType, name);
  else if (type.kind === 'pdf') scan = await scanPdf(bytes);
  else if (type.kind === 'zip' && !type.invalidArchive) findings.push(finding({
    category: 'compatibility', severity: 'info', title: 'Generic ZIP archive',
    description: 'ShareGlass currently inspects ZIP-based Microsoft Office packages, not arbitrary archives.',
    path: 'ZIP package'
  }));
  else if (type.kind === 'unknown') findings.push(finding({
    category: 'compatibility', severity: 'info', title: 'Unsupported file type',
    description: 'ShareGlass v1 supports JPEG, PNG, WebP, PDF, DOCX, XLSX and PPTX files.',
    path: 'File header'
  }));

  const allFindings = sortFindings(dedupeFindings([...findings, ...scan.findings]));
  const digest = await sha256(bytes);
  const actions = sanitizeActions(type, scan);
  const summary = summarizeFindings(allFindings);
  const provenanceCandidate = c2paCandidate(scan);

  return {
    schema: 'https://shareglass.dev/report/v1',
    shareglassVersion: SHAREGLASS_VERSION,
    generatedAt: new Date().toISOString(),
    file: {
      name,
      size: bytes.byteLength,
      mime: type.mime,
      claimedMime: providedMime,
      sha256: digest
    },
    type: {
      kind: type.kind,
      officeType: type.officeType || null,
      label: type.label,
      extension: type.extension,
      magicMismatch: type.magicMismatch
    },
    findings: allFindings,
    summary,
    metadata: scan.metadata || {},
    contentFingerprint: scan.contentFingerprint || scan.fingerprint || null,
    textPreview: scan.textPreview || null,
    capabilities: {
      inspect: !type.invalidArchive,
      sanitize: actions.length > 0,
      sanitizeActions: actions,
      c2paCandidate: provenanceCandidate,
      c2paValidation: provenanceCandidate && ['jpeg', 'png', 'webp', 'pdf'].includes(type.kind),
      pdfSanitization: false
    }
  };
}

export async function sanitizeBytes(input) {
  const originalReport = input.report || await analyzeBytes(input);
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  const selected = new Set(input.actions || originalReport.capabilities.sanitizeActions.filter((action) => action.default).map((action) => action.id));
  if (!selected.size) throw new Error('Select at least one sanitization action.');
  let result;

  if (['jpeg', 'png', 'webp'].includes(originalReport.type.kind)) {
    if (originalReport.capabilities.c2paCandidate && !input.forceProvenance) {
      throw new Error('This file may contain Content Credentials. Confirm creation of an unsigned derivative before removing image metadata.');
    }
    result = sanitizeImage(originalReport.type.kind, bytes, {
      removeProvenance: Boolean(input.forceProvenance)
    });
  } else if (originalReport.type.kind === 'ooxml') {
    result = await sanitizeOoxml(input.zip || (await detectFileType(originalReport.file.name, bytes, originalReport.file.mime)).zip, originalReport.type.officeType, {
      properties: selected.has('office-properties'),
      comments: selected.has('office-comments'),
      customData: selected.has('office-customxml'),
      thumbnail: selected.has('office-thumbnail'),
      externalLinks: selected.has('office-external-links'),
      acceptChanges: selected.has('office-accept-changes'),
      forceSigned: Boolean(input.forceSigned)
    });
  } else {
    throw new Error('Safe-copy generation is not available for this file type in ShareGlass v1.');
  }

  const name = outputFilename(originalReport.file.name, '.safe');
  const report = await analyzeBytes({ name, bytes: result.bytes, mime: originalReport.file.mime });
  const sameContent = Boolean(
    originalReport.contentFingerprint &&
    report.contentFingerprint &&
    originalReport.contentFingerprint === report.contentFingerprint
  );
  return {
    ...result,
    name,
    mime: originalReport.file.mime,
    report,
    verification: {
      sameContent,
      originalFingerprint: originalReport.contentFingerprint,
      sanitizedFingerprint: report.contentFingerprint,
      originalFindings: originalReport.summary.actionable,
      sanitizedFindings: report.summary.actionable,
      reducedBy: Math.max(0, originalReport.summary.actionable - report.summary.actionable)
    }
  };
}
