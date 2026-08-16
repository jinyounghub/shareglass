import { finding } from '../findings.js';
import { sha256, sha256Parts } from '../hash.js';
import { textDecode, textEncode, truncate, unique } from '../utils.js';

function xmlDecode(value) {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function stripXml(value) {
  return xmlDecode(String(value).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extractTag(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return match ? stripXml(match[1]) : null;
}

function extractAttributes(fragment) {
  const output = {};
  const regex = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = regex.exec(fragment))) output[match[1]] = xmlDecode(match[2] ?? match[3] ?? '');
  return output;
}

function parseRelationships(xml, path) {
  const output = [];
  const regex = /<Relationship\b([^>]*)\/?\s*>/gi;
  let match;
  while ((match = regex.exec(xml))) {
    const attrs = extractAttributes(match[1]);
    output.push({
      id: attrs.Id || attrs.id || null,
      type: attrs.Type || attrs.type || '',
      target: attrs.Target || attrs.target || '',
      targetMode: attrs.TargetMode || attrs.targetMode || '',
      path,
      raw: match[0]
    });
  }
  return output;
}

function relationshipLabel(type) {
  const tail = String(type).split('/').pop() || 'relationship';
  return {
    hyperlink: 'External hyperlink',
    image: 'Externally linked image',
    attachedTemplate: 'External document template',
    externalLink: 'External workbook data link',
    oleObject: 'External OLE object',
    package: 'External package',
    audio: 'Externally linked audio',
    video: 'Externally linked video'
  }[tail] || `External ${tail}`;
}

function relationshipSeverity(type, target) {
  if (/attachedTemplate|externalLink|oleObject|package|image|audio|video/i.test(type)) return 'high';
  if (/^file:|^[A-Za-z]:\\|^\\\\/.test(target)) return 'high';
  return 'medium';
}

function countMatches(value, regex) {
  return (String(value).match(regex) || []).length;
}

function docxText(xml) {
  if (!xml) return '';
  return xml
    .replace(/<w:tab\b[^>]*\/>/gi, '\t')
    .replace(/<w:(?:br|cr)\b[^>]*\/>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/gi, '')
    .replace(/<w:moveFrom\b[^>]*>[\s\S]*?<\/w:moveFrom>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function pptxText(xml) {
  if (!xml) return '';
  const values = [];
  const regex = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi;
  let match;
  while ((match = regex.exec(xml))) values.push(xmlDecode(match[1]));
  return values.join('\n');
}

async function calculateContentFingerprint(zip, officeType) {
  if (officeType === 'docx') {
    return sha256(textEncode(docxText(await zip.readText('word/document.xml'))));
  }
  if (officeType === 'pptx') {
    const slideNames = zip.names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort();
    const parts = [];
    for (const name of slideNames) parts.push(textEncode(`${name}\n${pptxText(await zip.readText(name))}\n`));
    return sha256Parts(parts);
  }
  if (officeType === 'xlsx') {
    const selected = zip.names
      .filter((name) => name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .sort();
    const parts = [];
    for (const name of selected) {
      const bytes = await zip.read(name);
      if (bytes) parts.push(textEncode(name), bytes);
    }
    return sha256Parts(parts);
  }
  return null;
}

async function readIfPresent(zip, name) {
  try {
    return zip.has(name) ? await zip.readText(name) : null;
  } catch {
    return null;
  }
}

export async function scanOoxml(zip, officeType, fileName = '') {
  const findings = [];
  const metadata = {
    officeType,
    encryptedEntries: 0,
    externalRelationships: [],
    comments: 0,
    customXml: 0,
    embeddedObjects: 0,
    signatures: 0,
    macros: false,
    trackedChanges: 0,
    hiddenItems: 0,
    zeroWidthCharacters: 0,
    bidiControls: 0
  };

  for (const entry of zip.entries) {
    if (entry.encrypted) metadata.encryptedEntries += 1;
  }
  if (metadata.encryptedEntries) findings.push(finding({
    category: 'structure', severity: 'high', title: 'Encrypted package entries',
    description: 'Some Office package parts are encrypted and could not be inspected.',
    evidence: `${metadata.encryptedEntries} encrypted entries`, path: 'OOXML package'
  }));

  const core = await readIfPresent(zip, 'docProps/core.xml');
  if (core) {
    const fields = [
      ['dc:creator', 'Document author', 'identity', 'medium', 'office-properties'],
      ['cp:lastModifiedBy', 'Last editor', 'identity', 'medium', 'office-properties'],
      ['cp:keywords', 'Document keywords', 'privacy', 'low', 'office-properties'],
      ['dc:subject', 'Document subject', 'privacy', 'low', 'office-properties'],
      ['cp:category', 'Document category', 'privacy', 'low', 'office-properties'],
      ['dcterms:created', 'Created time', 'privacy', 'low', 'office-properties'],
      ['dcterms:modified', 'Modified time', 'privacy', 'low', 'office-properties'],
      ['cp:lastPrinted', 'Last printed time', 'privacy', 'low', 'office-properties']
    ];
    for (const [tag, title, category, severity, cleanAction] of fields) {
      const value = extractTag(core, tag);
      if (!value) continue;
      findings.push(finding({
        category, severity, title,
        description: 'This value is stored in the Office document properties and is not normally visible on the page.',
        evidence: value, path: 'docProps/core.xml', cleanable: true, cleanAction
      }));
    }
  }

  const app = await readIfPresent(zip, 'docProps/app.xml');
  if (app) {
    for (const [tag, title, category, severity] of [
      ['Company', 'Company name', 'identity', 'medium'],
      ['Manager', 'Manager name', 'identity', 'medium'],
      ['Template', 'Document template', 'privacy', 'low'],
      ['Application', 'Creating application', 'privacy', 'low'],
      ['AppVersion', 'Application version', 'privacy', 'low'],
      ['HyperlinkBase', 'Hyperlink base', 'external', 'medium']
    ]) {
      const value = extractTag(app, tag);
      if (!value) continue;
      findings.push(finding({
        category, severity, title,
        description: 'The Office application properties disclose this value.', evidence: value,
        path: 'docProps/app.xml', cleanable: true, cleanAction: 'office-properties'
      }));
    }
  }

  const customProps = await readIfPresent(zip, 'docProps/custom.xml');
  if (customProps) {
    const names = [];
    const regex = /<property\b([^>]*)>([\s\S]*?)<\/property>/gi;
    let match;
    while ((match = regex.exec(customProps)) && names.length < 30) {
      const attrs = extractAttributes(match[1]);
      names.push(`${attrs.name || 'Unnamed'}: ${truncate(stripXml(match[2]), 100)}`);
    }
    findings.push(finding({
      category: 'privacy', severity: 'medium', title: 'Custom document properties',
      description: 'Custom properties may contain internal workflow fields or identifiers.',
      evidence: names.join(' · ') || 'Custom properties part present', path: 'docProps/custom.xml',
      cleanable: true, cleanAction: 'office-customxml'
    }));
  }

  const relationshipFiles = zip.names.filter((name) => name.endsWith('.rels'));
  for (const name of relationshipFiles) {
    const xml = await readIfPresent(zip, name);
    if (!xml) continue;
    for (const rel of parseRelationships(xml, name)) {
      const external = /^external$/i.test(rel.targetMode) || /^(?:https?:|ftp:|file:|mailto:|\\\\|[A-Za-z]:\\)/i.test(rel.target);
      if (!external || rel.target.includes('shareglass.invalid/removed')) continue;
      metadata.externalRelationships.push(rel);
      findings.push(finding({
        category: 'external', severity: relationshipSeverity(rel.type, rel.target),
        title: relationshipLabel(rel.type),
        description: 'Opening or updating this document may contact an external location or reveal that the file was opened.',
        evidence: rel.target, path: name, cleanable: true, cleanAction: 'office-external-links',
        remediation: 'Review the relationship and neutralize it in a copy when it is not required.'
      }));
    }
  }

  const commentNames = zip.names.filter((name) =>
    /(?:^|\/)(?:comments|threadedComments|persons)(?:\d+)?\.xml$/i.test(name) ||
    /word\/(?:commentsExtended|commentsIds|people)\.xml$/i.test(name)
  );
  metadata.comments = commentNames.length;
  if (commentNames.length) {
    let count = 0;
    const excerpts = [];
    for (const name of commentNames.slice(0, 20)) {
      const xml = await readIfPresent(zip, name);
      if (!xml) continue;
      count += countMatches(xml, /<(?:w:comment|comment|threadedComment)\b/gi);
      const authors = [...xml.matchAll(/(?:w:author|author)=["']([^"']+)["']/gi)].map((match) => match[1]);
      excerpts.push(...authors);
    }
    findings.push(finding({
      category: 'collaboration', severity: 'high', title: 'Comments and reviewer identities',
      description: 'The package contains comments, reviewer information, or threaded discussion data.',
      evidence: `${count || commentNames.length} comment records${unique(excerpts).length ? ` · authors: ${unique(excerpts).join(', ')}` : ''}`,
      path: commentNames.join(', '), cleanable: officeType === 'docx',
      cleanAction: officeType === 'docx' ? 'office-comments' : null,
      remediation: officeType === 'docx' ? 'Remove comments from a copy before external sharing.' : 'Remove comments in Office before external sharing.'
    }));
  }

  const customXmlNames = zip.names.filter((name) => name.startsWith('customXml/') && !name.endsWith('/'));
  metadata.customXml = customXmlNames.length;
  if (customXmlNames.length) findings.push(finding({
    category: 'structure', severity: 'medium', title: 'Custom XML data',
    description: 'Custom XML parts can carry workflow data that is not visible in the document.',
    evidence: `${customXmlNames.length} custom XML parts`, path: 'customXml/',
    cleanable: true, cleanAction: 'office-customxml',
    remediation: 'Remove only after confirming the document does not rely on custom XML bindings.'
  }));

  const thumbnailNames = zip.names.filter((name) => /^docProps\/thumbnail\./i.test(name));
  if (thumbnailNames.length) findings.push(finding({
    category: 'privacy', severity: 'low', title: 'Cached document thumbnail',
    description: 'A preview image is stored inside the Office package and can reveal an earlier visible state.',
    evidence: thumbnailNames.join(', '), path: 'docProps/', cleanable: true, cleanAction: 'office-thumbnail'
  }));

  const embeddedNames = zip.names.filter((name) => /\/(?:embeddings|objects)\//i.test(name) && !name.endsWith('/'));
  metadata.embeddedObjects = embeddedNames.length;
  if (embeddedNames.length) findings.push(finding({
    category: 'embedded', severity: 'high', title: 'Embedded files or OLE objects',
    description: 'The document contains embedded objects that may expose source files or active content.',
    evidence: embeddedNames.slice(0, 12).join(', '), path: 'OOXML package',
    remediation: 'Open the document in a sandbox and remove unneeded embedded objects.'
  }));

  const macroNames = zip.names.filter((name) => /vbaProject|vbaData|activeX|\.bin$/i.test(name));
  metadata.macros = macroNames.length > 0 || /\.(?:docm|xlsm|pptm)$/i.test(fileName);
  if (metadata.macros) findings.push(finding({
    category: 'active', severity: 'critical', title: 'Macros or ActiveX content',
    description: 'This Office file can contain executable VBA or ActiveX content.',
    evidence: macroNames.slice(0, 12).join(', ') || 'Macro-enabled file extension', path: 'OOXML package',
    remediation: 'Do not enable macros unless the source and code are trusted.'
  }));

  const signatureNames = zip.names.filter((name) => name.startsWith('_xmlsignatures/') && !name.endsWith('/'));
  metadata.signatures = signatureNames.length;
  if (signatureNames.length) findings.push(finding({
    category: 'integrity', severity: 'info', title: 'Office digital signature',
    description: 'The package contains an XML digital signature. Any sanitization will invalidate it.',
    evidence: `${signatureNames.length} signature parts`, path: '_xmlsignatures/'
  }));

  if (officeType === 'docx') {
    const documentXml = await readIfPresent(zip, 'word/document.xml');
    const settingsXml = await readIfPresent(zip, 'word/settings.xml');
    const tracked = countMatches(documentXml, /<w:(?:ins|del|moveFrom|moveTo)\b/gi) + countMatches(settingsXml, /<w:trackRevisions\b/gi);
    metadata.trackedChanges = tracked;
    if (tracked) findings.push(finding({
      category: 'collaboration', severity: 'high', title: 'Tracked revisions',
      description: 'Inserted, deleted, or moved content is still present in the document package.',
      evidence: `${tracked} revision markers`, path: 'word/document.xml / word/settings.xml',
      cleanable: true, cleanAction: 'office-accept-changes',
      remediation: 'Review the document, then accept all changes in a copy.'
    }));
    const hidden = countMatches(documentXml, /<w:(?:vanish|webHidden)\b/gi);
    metadata.hiddenItems += hidden;
    if (hidden) findings.push(finding({
      category: 'structure', severity: 'medium', title: 'Hidden Word text',
      description: 'The document contains runs formatted as hidden or web-hidden.',
      evidence: `${hidden} hidden text markers`, path: 'word/document.xml'
    }));
    const fieldCodes = [...(documentXml || '').matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/gi)]
      .map((match) => stripXml(match[1]))
      .filter((value) => /DDEAUTO|DDE|INCLUDETEXT|INCLUDEPICTURE|LINK|DATABASE/i.test(value));
    if (fieldCodes.length) findings.push(finding({
      category: 'active', severity: 'high', title: 'External or dynamic field codes',
      description: 'Word field instructions can retrieve external data or invoke legacy DDE behavior.',
      evidence: fieldCodes.slice(0, 8).join(' · '), path: 'word/document.xml'
    }));
  }

  if (officeType === 'xlsx') {
    const workbook = await readIfPresent(zip, 'xl/workbook.xml');
    const hiddenSheets = [...(workbook || '').matchAll(/<sheet\b([^>]*)\/>/gi)]
      .map((match) => extractAttributes(match[1]))
      .filter((attrs) => /^(?:hidden|veryHidden)$/i.test(attrs.state || ''));
    metadata.hiddenItems += hiddenSheets.length;
    if (hiddenSheets.length) findings.push(finding({
      category: 'structure', severity: 'high', title: 'Hidden workbook sheets',
      description: 'Hidden and very-hidden worksheets can contain data that recipients can restore.',
      evidence: hiddenSheets.map((sheet) => `${sheet.name || 'Unnamed'} (${sheet.state})`).join(', '),
      path: 'xl/workbook.xml'
    }));
    const externalLinks = zip.names.filter((name) => name.startsWith('xl/externalLinks/') && !name.endsWith('/'));
    if (externalLinks.length) findings.push(finding({
      category: 'external', severity: 'high', title: 'External workbook link parts',
      description: 'The workbook contains cached or live links to another workbook.',
      evidence: externalLinks.join(', '), path: 'xl/externalLinks/'
    }));
  }

  if (officeType === 'pptx') {
    const hiddenSlides = [];
    for (const name of zip.names.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))) {
      const xml = await readIfPresent(zip, name);
      if (/\bshow=["']0["']/i.test(xml || '')) hiddenSlides.push(name);
    }
    metadata.hiddenItems += hiddenSlides.length;
    if (hiddenSlides.length) findings.push(finding({
      category: 'structure', severity: 'medium', title: 'Hidden presentation slides',
      description: 'Slides marked hidden remain inside the presentation and can be revealed.',
      evidence: hiddenSlides.join(', '), path: 'ppt/slides/'
    }));
    const notes = zip.names.filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name));
    if (notes.length) findings.push(finding({
      category: 'collaboration', severity: 'medium', title: 'Presenter notes',
      description: 'Speaker notes are stored inside the presentation even when they are not shown during a slide show.',
      evidence: `${notes.length} notes slides`, path: 'ppt/notesSlides/'
    }));
  }

  const textXmlNames = zip.names.filter((name) => name.endsWith('.xml') && !name.startsWith('_xmlsignatures/')).slice(0, 2_000);
  let zeroWidth = 0;
  let bidi = 0;
  const affected = [];
  for (const name of textXmlNames) {
    const xml = await readIfPresent(zip, name);
    if (!xml) continue;
    const zeroCount = countMatches(xml, /[\u200B\u200C\u200D\u2060\uFEFF]/g);
    const bidiCount = countMatches(xml, /[\u202A-\u202E\u2066-\u2069]/g);
    if (zeroCount || bidiCount) affected.push(name);
    zeroWidth += zeroCount;
    bidi += bidiCount;
  }
  metadata.zeroWidthCharacters = zeroWidth;
  metadata.bidiControls = bidi;
  if (bidi) findings.push(finding({
    category: 'active', severity: 'high', title: 'Bidirectional control characters',
    description: 'Invisible Unicode direction controls can make displayed text differ from its logical order.',
    evidence: `${bidi} controls in ${affected.slice(0, 8).join(', ')}`, path: 'OOXML text parts'
  }));
  if (zeroWidth) findings.push(finding({
    category: 'structure', severity: 'medium', title: 'Zero-width Unicode characters',
    description: 'Invisible characters can hide identifiers, defeat text matching, or alter copied text.',
    evidence: `${zeroWidth} characters in ${affected.slice(0, 8).join(', ')}`, path: 'OOXML text parts'
  }));

  return {
    findings,
    metadata,
    sanitizable: findings.some((item) => item.cleanable),
    contentFingerprint: await calculateContentFingerprint(zip, officeType),
    textPreview: officeType === 'docx' ? truncate(docxText(await readIfPresent(zip, 'word/document.xml')), 800) : null
  };
}

export { docxText, parseRelationships };
