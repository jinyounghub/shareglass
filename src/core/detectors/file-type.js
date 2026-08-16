import { ascii, extensionOf, mimeFromExtension } from '../utils.js';
import { openZip } from '../zip.js';

const TYPES = {
  jpeg: { kind: 'jpeg', mime: 'image/jpeg', label: 'JPEG image', extensions: ['jpg', 'jpeg'] },
  png: { kind: 'png', mime: 'image/png', label: 'PNG image', extensions: ['png'] },
  webp: { kind: 'webp', mime: 'image/webp', label: 'WebP image', extensions: ['webp'] },
  pdf: { kind: 'pdf', mime: 'application/pdf', label: 'PDF document', extensions: ['pdf'] },
  docx: {
    kind: 'ooxml', officeType: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'Word document', extensions: ['docx', 'docm']
  },
  xlsx: {
    kind: 'ooxml', officeType: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'Excel workbook', extensions: ['xlsx', 'xlsm']
  },
  pptx: {
    kind: 'ooxml', officeType: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PowerPoint presentation', extensions: ['pptx', 'pptm']
  },
  zip: { kind: 'zip', mime: 'application/zip', label: 'ZIP archive', extensions: ['zip'] },
  unknown: { kind: 'unknown', mime: 'application/octet-stream', label: 'Unknown file', extensions: [] }
};

function isPrefix(bytes, values) {
  if (bytes.byteLength < values.length) return false;
  return values.every((value, index) => bytes[index] === value);
}

function finalize(type, name, providedMime) {
  const extension = extensionOf(name);
  const expectedMime = mimeFromExtension(name);
  const extensionMatches = !extension || type.extensions.includes(extension);
  const extensionMime = extensionMatches && expectedMime !== 'application/octet-stream' ? expectedMime : type.mime;
  const mimeMatches = !providedMime || providedMime === 'application/octet-stream' || providedMime === type.mime || providedMime === extensionMime;
  return {
    ...type,
    mime: extensionMime,
    extension,
    extensionMatches,
    mimeMatches,
    claimedMime: providedMime || extensionMime,
    magicMismatch: !extensionMatches || !mimeMatches
  };
}

export async function detectFileType(name, bytes, providedMime = '') {
  if (isPrefix(bytes, [0xff, 0xd8, 0xff])) return finalize(TYPES.jpeg, name, providedMime);
  if (isPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return finalize(TYPES.png, name, providedMime);
  }
  if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return finalize(TYPES.webp, name, providedMime);
  }
  if (bytes.byteLength >= 5 && ascii(bytes, 0, 5) === '%PDF-') {
    return finalize(TYPES.pdf, name, providedMime);
  }
  if (isPrefix(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    try {
      const zip = await openZip(bytes, {
        maxEntries: 10_000,
        maxUncompressedBytes: 350 * 1024 * 1024
      });
      if (zip.has('word/document.xml')) return { ...finalize(TYPES.docx, name, providedMime), zip };
      if (zip.has('xl/workbook.xml')) return { ...finalize(TYPES.xlsx, name, providedMime), zip };
      if (zip.has('ppt/presentation.xml')) return { ...finalize(TYPES.pptx, name, providedMime), zip };
      return { ...finalize(TYPES.zip, name, providedMime), zip };
    } catch (error) {
      return {
        ...finalize(TYPES.zip, name, providedMime),
        invalidArchive: true,
        archiveError: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return finalize(TYPES.unknown, name, providedMime);
}
