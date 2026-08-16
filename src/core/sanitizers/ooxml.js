import { createZip } from '../zip.js';
import { textDecode, textEncode } from '../utils.js';

function removeTag(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return xml
    .replace(new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}>`, 'gi'), '')
    .replace(new RegExp(`<${escaped}(?:\\s[^>]*)?\\s*\\/>`, 'gi'), '');
}

function cleanCoreProperties(xml) {
  let output = xml;
  for (const tag of [
    'dc:creator', 'cp:lastModifiedBy', 'cp:keywords', 'cp:category',
    'cp:contentStatus', 'cp:lastPrinted', 'cp:revision',
    'dcterms:created', 'dcterms:modified'
  ]) output = removeTag(output, tag);
  return output;
}

function cleanAppProperties(xml) {
  let output = xml;
  for (const tag of [
    'Company', 'Manager', 'Template', 'Application', 'AppVersion',
    'TotalTime', 'HyperlinkBase'
  ]) output = removeTag(output, tag);
  return output;
}

function getAttr(fragment, name) {
  const match = fragment.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return match ? match[1] ?? match[2] ?? '' : '';
}

function targetIsExternal(attrs) {
  const mode = getAttr(attrs, 'TargetMode');
  const target = getAttr(attrs, 'Target');
  return /^external$/i.test(mode) || /^(?:https?:|ftp:|file:|mailto:|\\\\|[A-Za-z]:\\)/i.test(target);
}

function removeRelationships(xml, predicate) {
  return xml.replace(/<Relationship\b([^>]*)\/?\s*>/gi, (full, attrs) => predicate(attrs, full) ? '' : full);
}

function neutralizeExternalRelationships(xml) {
  let changed = 0;
  const output = xml.replace(/<Relationship\b([^>]*)\/?\s*>/gi, (full, attrs) => {
    if (!targetIsExternal(attrs)) return full;
    const target = getAttr(attrs, 'Target');
    if (target.includes('shareglass.invalid/removed')) return full;
    changed += 1;
    let next = full.replace(/\bTarget\s*=\s*(?:"[^"]*"|'[^']*')/i, 'Target="https://shareglass.invalid/removed"');
    if (/\bTargetMode\s*=/i.test(next)) {
      next = next.replace(/\bTargetMode\s*=\s*(?:"[^"]*"|'[^']*')/i, 'TargetMode="External"');
    } else {
      next = next.replace(/\/?\s*>$/, (ending) => ` TargetMode="External"${ending}`);
    }
    return next;
  });
  return { xml: output, changed };
}

function removeContentTypeOverrides(xml, matcher) {
  return xml.replace(/<Override\b([^>]*)\/?\s*>/gi, (full, attrs) => {
    const partName = getAttr(attrs, 'PartName');
    const contentType = getAttr(attrs, 'ContentType');
    return matcher(partName, contentType) ? '' : full;
  });
}

function removeCommentMarkup(xml) {
  let output = xml
    .replace(/<w:commentRange(?:Start|End)\b[^>]*\/?\s*>/gi, '')
    .replace(/<w:commentReference\b[^>]*\/?\s*>/gi, '');
  output = output.replace(/<w:r\b([^>]*)>\s*(?:<w:rPr>[\s\S]*?<\/w:rPr>)?\s*<\/w:r>/gi, '');
  return output;
}

function acceptTrackedChanges(xml) {
  let output = xml;
  let previous;
  do {
    previous = output;
    output = output
      .replace(/<w:(?:del|moveFrom)\b[^>]*>[\s\S]*?<\/w:(?:del|moveFrom)>/gi, '')
      .replace(/<w:(?:ins|moveTo)\b[^>]*>([\s\S]*?)<\/w:(?:ins|moveTo)>/gi, '$1');
  } while (output !== previous);

  output = output
    .replace(/<w:(?:rPrChange|pPrChange|tblPrChange|trPrChange|tcPrChange|sectPrChange|numberingChange)\b[^>]*>[\s\S]*?<\/w:(?:rPrChange|pPrChange|tblPrChange|trPrChange|tcPrChange|sectPrChange|numberingChange)>/gi, '')
    .replace(/<w:trackRevisions\b[^>]*\/?\s*>/gi, '');
  return output;
}

function removeCustomXmlWrappers(xml) {
  let output = xml.replace(/<w:customXmlPr\b[^>]*>[\s\S]*?<\/w:customXmlPr>/gi, '');
  let previous;
  do {
    previous = output;
    output = output.replace(/<w:customXml\b[^>]*>([\s\S]*?)<\/w:customXml>/gi, '$1');
  } while (output !== previous);
  return output;
}

function isXml(name) {
  return /\.xml$/i.test(name);
}

function isRelationships(name) {
  return /\.rels$/i.test(name);
}

export async function sanitizeOoxml(zip, officeType, options = {}) {
  const settings = {
    properties: options.properties !== false,
    comments: options.comments !== false && officeType === 'docx',
    customData: Boolean(options.customData),
    thumbnail: options.thumbnail !== false,
    externalLinks: Boolean(options.externalLinks),
    acceptChanges: Boolean(options.acceptChanges),
    forceSigned: Boolean(options.forceSigned)
  };

  const hasSignatures = zip.names.some((name) => name.startsWith('_xmlsignatures/'));
  if (hasSignatures && !settings.forceSigned) {
    throw new Error('This Office package is digitally signed. Enable “create an unsigned copy” before sanitizing it.');
  }

  const removed = [];
  const warnings = [];
  const transformedNames = [];
  const outputEntries = [];
  const commentPart = /^(?:word\/(?:comments(?:Extended|Ids)?|people)\.xml|xl\/(?:comments\d+|threadedComments\/threadedComment\d+|persons\/person)\.xml|ppt\/comments\/)/i;
  const signaturePart = /^_xmlsignatures\//i;
  const customPart = /^customXml\//i;
  const thumbnailPart = /^docProps\/thumbnail\./i;

  for (const entry of zip.entries) {
    const name = entry.name;
    if (entry.isDirectory) continue;
    if (hasSignatures && settings.forceSigned && signaturePart.test(name)) {
      removed.push(name);
      continue;
    }
    if (settings.comments && commentPart.test(name)) {
      removed.push(name);
      continue;
    }
    if (settings.customData && (customPart.test(name) || name === 'docProps/custom.xml')) {
      removed.push(name);
      continue;
    }
    if (settings.thumbnail && thumbnailPart.test(name)) {
      removed.push(name);
      continue;
    }

    const original = await zip.read(entry);
    if (!original) continue;
    let data = original;

    if (isXml(name) || isRelationships(name)) {
      let xml = textDecode(data);
      const before = xml;

      if (settings.properties && name === 'docProps/core.xml') xml = cleanCoreProperties(xml);
      if (settings.properties && name === 'docProps/app.xml') xml = cleanAppProperties(xml);

      if (settings.comments && officeType === 'docx' && /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(name)) {
        xml = removeCommentMarkup(xml);
      }
      if (settings.acceptChanges && officeType === 'docx' && /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes|settings)\.xml$/i.test(name)) {
        xml = acceptTrackedChanges(xml);
      }
      if (settings.customData && officeType === 'docx' && /^word\/.+\.xml$/i.test(name)) {
        xml = removeCustomXmlWrappers(xml);
      }

      if (isRelationships(name)) {
        if (settings.comments) {
          xml = removeRelationships(xml, (attrs) =>
            /\/(?:comments|commentsExtended|commentsIds|people)$/i.test(getAttr(attrs, 'Type')) ||
            /(?:^|\/)(?:comments|commentsExtended|commentsIds|people)\.xml$/i.test(getAttr(attrs, 'Target'))
          );
        }
        if (settings.customData) {
          xml = removeRelationships(xml, (attrs) =>
            /\/customXml(?:Props)?$/i.test(getAttr(attrs, 'Type')) || /customXml\//i.test(getAttr(attrs, 'Target')) ||
            /\/custom-properties$/i.test(getAttr(attrs, 'Type'))
          );
        }
        if (settings.thumbnail) {
          xml = removeRelationships(xml, (attrs) =>
            /\/metadata\/thumbnail$/i.test(getAttr(attrs, 'Type')) || /thumbnail\./i.test(getAttr(attrs, 'Target'))
          );
        }
        if (hasSignatures && settings.forceSigned) {
          xml = removeRelationships(xml, (attrs) => /digital-signature/i.test(getAttr(attrs, 'Type')) || /_xmlsignatures/i.test(getAttr(attrs, 'Target')));
        }
        if (settings.externalLinks) {
          const result = neutralizeExternalRelationships(xml);
          xml = result.xml;
          if (result.changed) removed.push(`${name}: ${result.changed} external target(s) neutralized`);
        }
      }

      if (name === '[Content_Types].xml') {
        if (settings.comments) {
          xml = removeContentTypeOverrides(xml, (partName, contentType) =>
            /\/(?:comments|commentsExtended|commentsIds|people)\.xml$/i.test(partName) ||
            /comments|person/i.test(contentType)
          );
        }
        if (settings.customData) {
          xml = removeContentTypeOverrides(xml, (partName, contentType) =>
            /^\/customXml\//i.test(partName) || partName === '/docProps/custom.xml' || /custom-properties/i.test(contentType)
          );
        }
        if (settings.thumbnail) {
          xml = removeContentTypeOverrides(xml, (partName) => /^\/docProps\/thumbnail\./i.test(partName));
        }
        if (hasSignatures && settings.forceSigned) {
          xml = removeContentTypeOverrides(xml, (partName, contentType) => /^\/_xmlsignatures\//i.test(partName) || /digital-signature/i.test(contentType));
        }
      }

      if (xml !== before) {
        data = textEncode(xml);
        transformedNames.push(name);
      }
    }
    outputEntries.push({ name, data });
  }

  if (settings.acceptChanges) warnings.push('Tracked changes were accepted in the sanitized copy. Review the visible result before sending it.');
  if (settings.customData) warnings.push('Custom XML and custom properties were removed. Documents with content bindings may lose automation features.');
  if (settings.externalLinks) warnings.push('External relationship targets were replaced with a reserved .invalid address; visible link text was preserved.');
  if (hasSignatures && settings.forceSigned) warnings.push('The original digital signature was removed because any package modification invalidates it.');

  return {
    bytes: createZip(outputEntries),
    removed,
    transformed: transformedNames,
    warnings,
    options: settings
  };
}
