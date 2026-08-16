import { finding } from '../findings.js';
import { sha256 } from '../hash.js';
import { ascii, concatBytes, findAll, textDecode, truncate, unique } from '../utils.js';

function decodePdfLiteral(value) {
  if (!value) return '';
  if (value.startsWith('<') && value.endsWith('>') && !value.startsWith('<<')) {
    const clean = value.slice(1, -1).replace(/\s+/g, '');
    const bytes = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return out;
    }
    return textDecode(bytes, 'latin1');
  }
  let input = value.startsWith('(') && value.endsWith(')') ? value.slice(1, -1) : value;
  input = input.replace(/\\([0-7]{1,3}|n|r|t|b|f|\(|\)|\\|\r?\n)/g, (_, token) => {
    if (/^[0-7]+$/.test(token)) return String.fromCharCode(Number.parseInt(token, 8));
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\', '\n': '', '\r\n': '' }[token] ?? token;
  });
  if (input.charCodeAt(0) === 0xfe && input.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < input.length; i += 2) out += String.fromCharCode((input.charCodeAt(i) << 8) | input.charCodeAt(i + 1));
    return out;
  }
  return input.replace(/\u0000/g, '').trim();
}

async function inflatePdfStreams(bytes, rawText) {
  if (typeof DecompressionStream === 'undefined') return [];
  const outputs = [];
  const streamRegex = /stream\r?\n/g;
  let match;
  while ((match = streamRegex.exec(rawText)) && outputs.length < 80) {
    const streamStart = match.index + match[0].length;
    const dictionaryStart = rawText.lastIndexOf('<<', match.index);
    const dictionaryEnd = rawText.lastIndexOf('>>', match.index);
    if (dictionaryStart < 0 || dictionaryEnd < dictionaryStart || dictionaryEnd - dictionaryStart > 16_000) continue;
    const dictionary = rawText.slice(dictionaryStart, dictionaryEnd + 2);
    if (!/\/FlateDecode\b/.test(dictionary)) continue;
    const end = rawText.indexOf('endstream', streamStart);
    if (end < 0 || end - streamStart > 32 * 1024 * 1024) continue;
    let dataEnd = end;
    while (dataEnd > streamStart && [0x0a, 0x0d].includes(bytes[dataEnd - 1])) dataEnd -= 1;
    try {
      const stream = new Blob([bytes.slice(streamStart, dataEnd)]).stream().pipeThrough(new DecompressionStream('deflate'));
      const reader = stream.getReader();
      const parts = [];
      let total = 0;
      let exceeded = false;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 32 * 1024 * 1024) {
          exceeded = true;
          await reader.cancel('ShareGlass PDF stream safety limit');
          break;
        }
        parts.push(value);
      }
      if (!exceeded) outputs.push(textDecode(concatBytes(parts), 'latin1'));
    } catch {
      // Some valid PDFs use predictors or malformed streams; raw scanning still runs.
    }
  }
  return outputs;
}

function extractMetadata(text) {
  const output = [];
  const regex = /\/(Author|Creator|Producer|Title|Subject|Keywords)\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>)/g;
  let match;
  while ((match = regex.exec(text)) && output.length < 80) {
    const value = decodePdfLiteral(match[2]);
    if (value) output.push({ key: match[1], value: truncate(value, 260) });
  }
  const xmpPatterns = [
    ['Author', /<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi],
    ['Creator tool', /<xmp:CreatorTool[^>]*>([\s\S]*?)<\/xmp:CreatorTool>/gi],
    ['Create date', /<xmp:CreateDate[^>]*>([\s\S]*?)<\/xmp:CreateDate>/gi],
    ['Modify date', /<xmp:ModifyDate[^>]*>([\s\S]*?)<\/xmp:ModifyDate>/gi],
    ['Metadata date', /<xmp:MetadataDate[^>]*>([\s\S]*?)<\/xmp:MetadataDate>/gi],
    ['Document ID', /<xmpMM:DocumentID[^>]*>([\s\S]*?)<\/xmpMM:DocumentID>/gi]
  ];
  for (const [key, regexXmp] of xmpPatterns) {
    let item;
    while ((item = regexXmp.exec(text)) && output.length < 100) {
      const value = item[1].replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      if (value) output.push({ key, value: truncate(value, 260) });
    }
  }
  return output;
}

function extractUrls(text) {
  const urls = [];
  for (const match of findAll(text, /\/URI\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]+>)/g, 80)) {
    const decoded = decodePdfLiteral(match[1]);
    if (decoded) urls.push(decoded);
  }
  for (const match of findAll(text, /(?:https?:\/\/|mailto:)[^\s<>\[\]()"']+/gi, 80)) urls.push(match[0]);
  return unique(urls).slice(0, 80);
}

export async function scanPdf(bytes) {
  const rawText = textDecode(bytes, 'latin1');
  const inflated = await inflatePdfStreams(bytes, rawText);
  const texts = [rawText, ...inflated];
  const combined = texts.join('\n');
  const findings = [];
  const version = (rawText.match(/^%PDF-([0-9.]+)/) || [])[1] || null;
  const metadataFields = extractMetadata(combined);
  const urls = extractUrls(combined);
  const encrypted = /\/Encrypt\b/.test(rawText);
  const javascript = /\/(?:JavaScript|JS)\b/.test(combined);
  const openAction = /\/OpenAction\b|\/AA\b/.test(combined);
  const launch = /\/Launch\b|\/SubmitForm\b|\/ImportData\b/.test(combined);
  const embedded = /\/EmbeddedFiles\b|\/FileSpec\b|\/EmbeddedFile\b|\/RichMedia\b/.test(combined);
  const forms = /\/AcroForm\b|\/XFA\b/.test(combined);
  const signatures = /\/Type\s*\/Sig\b|\/ByteRange\s*\[/.test(combined);
  const c2paCandidate = /c2pa|jumbf|content credentials/i.test(combined);
  const eofCount = (rawText.match(/%%EOF/g) || []).length;
  const startXrefCount = (rawText.match(/startxref/g) || []).length;

  const seenMetadata = new Set();
  for (const item of metadataFields) {
    const key = `${item.key}|${item.value}`;
    if (seenMetadata.has(key)) continue;
    seenMetadata.add(key);
    const identity = /author/i.test(item.key);
    findings.push(finding({
      category: identity ? 'identity' : 'privacy',
      severity: identity ? 'medium' : /date|document id/i.test(item.key) ? 'low' : 'low',
      title: `PDF ${item.key}`,
      description: 'This metadata is stored in the PDF structure and may not be visible on the page.',
      evidence: item.value, path: 'PDF Info/XMP',
      remediation: 'Remove metadata with a PDF editor that rewrites and validates the document.'
    }));
  }

  if (urls.length) findings.push(finding({
    category: 'external', severity: 'medium', title: 'External links',
    description: 'The PDF contains web or email links. Opening a link can disclose that the document was viewed.',
    evidence: urls.slice(0, 12).join(' · '), path: 'PDF annotations/actions'
  }));
  if (javascript) findings.push(finding({
    category: 'active', severity: 'critical', title: 'Embedded JavaScript',
    description: 'The PDF contains JavaScript actions that may execute in compatible readers.',
    evidence: openAction ? 'JavaScript with automatic or additional actions' : 'JavaScript action', path: 'PDF actions',
    remediation: 'Open only in a hardened viewer and remove active content using a trusted PDF sanitizer.'
  }));
  if (openAction && !javascript) findings.push(finding({
    category: 'active', severity: 'high', title: 'Automatic document action',
    description: 'The PDF defines an action that may run when the document or a page is opened.',
    path: 'PDF OpenAction/AA'
  }));
  if (launch) findings.push(finding({
    category: 'active', severity: 'critical', title: 'Launch or submit action',
    description: 'The PDF can attempt to launch a target, submit form data, or import external data.',
    path: 'PDF actions'
  }));
  if (embedded) findings.push(finding({
    category: 'embedded', severity: 'high', title: 'Embedded files or rich media',
    description: 'The PDF contains, or references structures for, embedded files or rich media.',
    path: 'PDF name tree / file specification'
  }));
  if (forms) findings.push(finding({
    category: 'structure', severity: 'medium', title: 'Interactive form data',
    description: 'Form fields or XFA data may contain entered values that are not obvious in a flattened view.',
    path: 'PDF AcroForm/XFA'
  }));
  if (encrypted) findings.push(finding({
    category: 'structure', severity: 'high', title: 'Encrypted PDF',
    description: 'The PDF is encrypted. Some metadata or objects may not be inspectable without the password.',
    path: 'PDF trailer'
  }));
  if (signatures) findings.push(finding({
    category: 'integrity', severity: 'info', title: 'Digital signature data',
    description: 'The PDF contains a digital signature or byte range. Rewriting the file will normally invalidate it.',
    path: 'PDF signature dictionary'
  }));
  if (eofCount > 1 || startXrefCount > 1) findings.push(finding({
    category: 'structure', severity: 'medium', title: 'Incremental save history',
    description: 'The PDF has multiple cross-reference endings, indicating incremental updates. Earlier object versions may remain in the file.',
    evidence: `${eofCount} EOF markers · ${startXrefCount} startxref markers`, path: 'PDF structure'
  }));
  if (c2paCandidate) findings.push(finding({
    category: 'provenance', severity: 'info', title: 'Possible Content Credentials data',
    description: 'The PDF contains strings associated with C2PA/JUMBF provenance. The official SDK can perform a full validation when supported.',
    path: 'PDF metadata/boxes'
  }));

  return {
    findings,
    metadata: {
      version,
      encrypted,
      javascript,
      openAction,
      launch,
      embedded,
      forms,
      signatures,
      c2paCandidate,
      incrementalUpdates: Math.max(eofCount, startXrefCount) > 1,
      inflatedStreamsInspected: inflated.length,
      urls
    },
    sanitizable: false,
    fingerprint: await sha256(bytes)
  };
}
