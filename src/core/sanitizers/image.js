import { ascii, concatBytes, textDecode, writeUint32LE } from '../utils.js';
import { parseJpegSegments, parsePngChunks, parseWebpChunks } from '../detectors/image.js';

function jpegC2paCandidate(marker, payload) {
  if (marker !== 0xeb) return false;
  const prefix = ascii(payload, 0, Math.min(64, payload.byteLength));
  const text = textDecode(payload, 'latin1').toLowerCase();
  return prefix.startsWith('JP') || text.includes('c2pa') || text.includes('jumb');
}

export function sanitizeJpeg(bytes, options = {}) {
  const parsed = parseJpegSegments(bytes);
  if (!parsed) throw new Error('Invalid JPEG file.');
  const parts = [];
  let offset = 0;
  const removed = [];
  for (const segment of parsed.segments) {
    const payload = bytes.slice(segment.payloadStart, segment.payloadEnd);
    const prefix = ascii(payload, 0, Math.min(64, payload.byteLength));
    const remove =
      (segment.marker === 0xe1 && (prefix.startsWith('Exif\u0000\u0000') || prefix.includes('xap/1.0') || prefix.includes('XMP'))) ||
      segment.marker === 0xed ||
      segment.marker === 0xfe ||
      (options.removeProvenance && jpegC2paCandidate(segment.marker, payload));
    if (!remove) continue;
    if (segment.start > offset) parts.push(bytes.slice(offset, segment.start));
    offset = segment.end;
    removed.push(
      options.removeProvenance && jpegC2paCandidate(segment.marker, payload)
        ? 'C2PA/JUMBF manifest'
        : segment.marker === 0xe1 ? 'EXIF/XMP' : segment.marker === 0xed ? 'IPTC' : 'comment'
    );
  }
  if (offset < bytes.byteLength) parts.push(bytes.slice(offset));
  return { bytes: concatBytes(parts), removed };
}

export function sanitizePng(bytes, options = {}) {
  const chunks = parsePngChunks(bytes);
  if (!chunks) throw new Error('Invalid PNG file.');
  const removable = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  const parts = [bytes.slice(0, 8)];
  const removed = [];
  for (const chunk of chunks) {
    const provenance = chunk.type === 'caBX' || chunk.type.toLowerCase() === 'c2pa';
    if (removable.has(chunk.type) || (options.removeProvenance && provenance)) {
      removed.push(provenance ? 'C2PA manifest' : chunk.type);
    } else parts.push(bytes.slice(chunk.start, chunk.end));
  }
  return { bytes: concatBytes(parts), removed };
}


function webpC2paCandidate(type, data) {
  const upperType = type.toUpperCase();
  if (upperType === 'C2PA' || upperType === 'JUMB') return true;
  if (['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'EXIF', 'XMP '].includes(type)) return false;
  const prefix = textDecode(data.subarray(0, Math.min(data.byteLength, 4096)), 'latin1').toLowerCase();
  return prefix.includes('c2pa') || prefix.includes('jumb');
}

export function sanitizeWebp(bytes, options = {}) {
  const chunks = parseWebpChunks(bytes);
  if (!chunks) throw new Error('Invalid WebP file.');
  const parts = [bytes.slice(0, 12)];
  const removed = [];
  for (const chunk of chunks) {
    const data = bytes.subarray(chunk.dataStart, chunk.dataEnd);
    const provenance = webpC2paCandidate(chunk.type, data);
    if (['EXIF', 'XMP '].includes(chunk.type) || (options.removeProvenance && provenance)) {
      removed.push(provenance && options.removeProvenance ? 'C2PA manifest' : chunk.type.trim());
      continue;
    }
    const encoded = bytes.slice(chunk.start, chunk.end);
    if (chunk.type === 'VP8X' && encoded.byteLength >= 9) {
      // VP8X feature bits: EXIF 0x08, XMP 0x04. Clear flags when the
      // corresponding chunks are removed so the container remains coherent.
      encoded[8] &= ~0x0c;
    }
    parts.push(encoded);
  }
  const output = concatBytes(parts);
  writeUint32LE(output, 4, output.byteLength - 8);
  return { bytes: output, removed };
}

export function sanitizeImage(kind, bytes, options = {}) {
  if (kind === 'jpeg') return sanitizeJpeg(bytes, options);
  if (kind === 'png') return sanitizePng(bytes, options);
  if (kind === 'webp') return sanitizeWebp(bytes, options);
  throw new Error(`Unsupported image type: ${kind}`);
}
