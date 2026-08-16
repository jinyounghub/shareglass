import { finding } from '../findings.js';
import {
  ascii,
  concatBytes,
  readUint16BE,
  readUint32BE,
  readUint32LE,
  textDecode,
  truncate,
  unique
} from '../utils.js';
import { crc32, sha256Parts } from '../hash.js';

const TIFF_TAGS = {
  0x010e: ['Image description', 'description'],
  0x010f: ['Camera make', 'make'],
  0x0110: ['Camera model', 'model'],
  0x0131: ['Editing software', 'software'],
  0x0132: ['Modified time', 'datetime'],
  0x013b: ['Artist', 'artist'],
  0x8298: ['Copyright', 'copyright'],
  0x9003: ['Original capture time', 'dateTimeOriginal'],
  0x9004: ['Digitized time', 'dateTimeDigitized'],
  0x9286: ['User comment', 'userComment'],
  0xa420: ['Image unique ID', 'imageUniqueId'],
  0xa430: ['Camera owner', 'cameraOwner'],
  0xa431: ['Camera body serial', 'bodySerial'],
  0xa434: ['Lens model', 'lensModel'],
  0xa435: ['Lens serial', 'lensSerial']
};

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const MAX_TEXT_METADATA_BYTES = 4 * 1024 * 1024;

function xmlDecode(value) {
  return String(value)
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function valueToString(value) {
  if (Array.isArray(value)) return value.map(valueToString).join(', ');
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return String(value ?? '').replace(/\u0000/g, '').trim();
}

function readTiffValue(bytes, endian, type, count, dataOffset) {
  const little = endian === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const get16 = (offset) => view.getUint16(offset, little);
  const get32 = (offset) => view.getUint32(offset, little);
  const getS32 = (offset) => view.getInt32(offset, little);
  const size = TYPE_SIZE[type] || 0;
  if (!size || count < 0 || dataOffset < 0 || dataOffset + size * count > bytes.byteLength) return null;

  if (type === 2) return textDecode(bytes.slice(dataOffset, dataOffset + count)).replace(/\u0000+$/, '');
  if (type === 7) {
    const raw = bytes.slice(dataOffset, dataOffset + count);
    const prefix = ascii(raw, 0, 8);
    if (prefix.startsWith('ASCII')) return textDecode(raw.slice(8)).replace(/\u0000+$/, '');
    return textDecode(raw).replace(/\u0000+$/, '');
  }

  const output = [];
  for (let index = 0; index < count; index += 1) {
    const offset = dataOffset + index * size;
    if (type === 1) output.push(bytes[offset]);
    else if (type === 3) output.push(get16(offset));
    else if (type === 4) output.push(get32(offset));
    else if (type === 5) {
      const denominator = get32(offset + 4);
      output.push(denominator ? get32(offset) / denominator : 0);
    } else if (type === 9) output.push(getS32(offset));
    else if (type === 10) {
      const denominator = getS32(offset + 4);
      output.push(denominator ? getS32(offset) / denominator : 0);
    }
  }
  return output.length === 1 ? output[0] : output;
}

export function parseTiff(bytes) {
  const result = { fields: [], gps: null, valid: false, error: null };
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8) return result;
  const endian = ascii(bytes, 0, 2);
  if (!['II', 'MM'].includes(endian)) {
    result.error = 'Invalid TIFF byte order.';
    return result;
  }
  const little = endian === 'II';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const get16 = (offset) => (offset + 2 <= bytes.byteLength ? view.getUint16(offset, little) : null);
  const get32 = (offset) => (offset + 4 <= bytes.byteLength ? view.getUint32(offset, little) : null);
  if (get16(2) !== 42) {
    result.error = 'Invalid TIFF header.';
    return result;
  }
  result.valid = true;

  const seen = new Set();
  const gpsValues = {};

  function readIfd(ifdOffset, group = 'exif', depth = 0) {
    if (!Number.isInteger(ifdOffset) || depth > 4 || ifdOffset < 8 || ifdOffset + 2 > bytes.byteLength || seen.has(ifdOffset)) return;
    seen.add(ifdOffset);
    const count = get16(ifdOffset);
    if (count === null || count > 4096 || ifdOffset + 2 + count * 12 > bytes.byteLength) return;

    for (let index = 0; index < count; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      const tag = get16(entryOffset);
      const type = get16(entryOffset + 2);
      const valueCount = get32(entryOffset + 4);
      if (tag === null || type === null || valueCount === null) continue;
      const size = (TYPE_SIZE[type] || 0) * valueCount;
      if (!size || size > 16 * 1024 * 1024) continue;
      const valueOffset = size <= 4 ? entryOffset + 8 : get32(entryOffset + 8);
      if (valueOffset === null) continue;
      const value = readTiffValue(bytes, endian, type, valueCount, valueOffset);

      if (tag === 0x8769 && typeof value === 'number') readIfd(value, 'exif', depth + 1);
      else if (tag === 0x8825 && typeof value === 'number') readIfd(value, 'gps', depth + 1);
      else if (tag === 0xa005 && typeof value === 'number') readIfd(value, 'interop', depth + 1);
      else if (group === 'gps') gpsValues[tag] = value;
      else if (TIFF_TAGS[tag] && valueToString(value)) {
        const [label, key] = TIFF_TAGS[tag];
        result.fields.push({ tag, key, label, value: valueToString(value) });
      }
    }
  }

  readIfd(get32(4), 'ifd0');

  const coordinate = (values, ref) => {
    if (!Array.isArray(values) || values.length < 3) return null;
    const decimal = Number(values[0]) + Number(values[1]) / 60 + Number(values[2]) / 3600;
    if (!Number.isFinite(decimal)) return null;
    return ['S', 'W'].includes(String(ref).toUpperCase()) ? -decimal : decimal;
  };
  const latitude = coordinate(gpsValues[2], gpsValues[1]);
  const longitude = coordinate(gpsValues[4], gpsValues[3]);
  if (latitude !== null && longitude !== null) {
    result.gps = {
      latitude,
      longitude,
      altitude: typeof gpsValues[6] === 'number' ? (gpsValues[5] === 1 ? -gpsValues[6] : gpsValues[6]) : null,
      date: valueToString(gpsValues[29] || '') || null
    };
  }
  return result;
}

function findingsFromTiff(parsed, path) {
  const findings = [];
  if (parsed.gps) {
    findings.push(finding({
      category: 'location', severity: 'high', title: 'Exact GPS coordinates',
      description: 'The image contains precise latitude and longitude coordinates.',
      evidence: `${parsed.gps.latitude.toFixed(6)}, ${parsed.gps.longitude.toFixed(6)}${parsed.gps.altitude !== null ? ` · altitude ${parsed.gps.altitude.toFixed(1)} m` : ''}`,
      path, remediation: 'Remove EXIF location metadata before sharing.', cleanable: true,
      cleanAction: 'image-metadata'
    }));
  }
  for (const field of parsed.fields) {
    let severity = 'low';
    let category = 'privacy';
    let title = field.label;
    if (['cameraOwner', 'bodySerial', 'lensSerial', 'imageUniqueId'].includes(field.key)) {
      severity = 'high';
      category = 'identity';
    } else if (['artist', 'copyright', 'userComment', 'description'].includes(field.key)) {
      severity = 'medium';
      category = 'identity';
    } else if (['make', 'model', 'lensModel', 'software'].includes(field.key)) {
      category = 'privacy';
    } else if (field.key.toLowerCase().includes('date') || field.key === 'datetime') {
      category = 'privacy';
    }
    findings.push(finding({
      category, severity, title,
      description: 'Image metadata can disclose information that is not visible in the pixels.',
      evidence: field.value, path,
      remediation: 'Remove image metadata before sharing.', cleanable: true,
      cleanAction: 'image-metadata'
    }));
  }
  return findings;
}

function extractXmpValues(xmp) {
  const values = [];
  const patterns = [
    ['Creator', /<(?:dc:creator|photoshop:AuthorsPosition)[^>]*>([\s\S]*?)<\/(?:dc:creator|photoshop:AuthorsPosition)>/gi],
    ['Creator tool', /(?:xmp:CreatorTool)=["']([^"']+)["']/gi],
    ['Create date', /(?:xmp:CreateDate|photoshop:DateCreated)=["']([^"']+)["']/gi],
    ['Modify date', /(?:xmp:ModifyDate|xmp:MetadataDate)=["']([^"']+)["']/gi],
    ['GPS latitude', /(?:exif:GPSLatitude)=["']([^"']+)["']/gi],
    ['GPS longitude', /(?:exif:GPSLongitude)=["']([^"']+)["']/gi],
    ['Document ID', /(?:xmpMM:DocumentID|xmpMM:InstanceID)=["']([^"']+)["']/gi]
  ];
  for (const [label, regex] of patterns) {
    let match;
    while ((match = regex.exec(xmp)) && values.length < 40) {
      const raw = xmlDecode(match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      if (raw) values.push({ label, value: truncate(raw, 220) });
    }
  }
  return values;
}

export function parseJpegSegments(bytes) {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const segments = [{ marker: 0xd8, start: 0, end: 2, payloadStart: 2, payloadEnd: 2, type: 'SOI' }];
  let offset = 2;
  let scanStart = null;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      scanStart = offset;
      break;
    }
    const start = offset;
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) {
      segments.push({ marker, start, end: offset, payloadStart: offset, payloadEnd: offset, type: 'EOI' });
      break;
    }
    if (marker === 0xda) {
      const length = readUint16BE(bytes, offset);
      if (!length || offset + length > bytes.byteLength) break;
      const end = offset + length;
      segments.push({ marker, start, end, payloadStart: offset + 2, payloadEnd: end, type: 'SOS' });
      scanStart = end;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start, end: offset, payloadStart: offset, payloadEnd: offset, type: 'standalone' });
      continue;
    }
    const length = readUint16BE(bytes, offset);
    if (!length || length < 2 || offset + length > bytes.byteLength) break;
    const payloadStart = offset + 2;
    const end = offset + length;
    segments.push({ marker, start, end, payloadStart, payloadEnd: end, type: `0x${marker.toString(16)}` });
    offset = end;
  }
  return { segments, scanStart, bytes };
}

async function scanJpeg(bytes) {
  const parsed = parseJpegSegments(bytes);
  if (!parsed) return { findings: [], metadata: {}, sanitizable: false, fingerprint: null };
  const findings = [];
  const metadata = { exif: false, xmp: false, iptc: false, comments: 0, c2paCandidate: false };
  const pixelParts = [];
  let previous = 0;

  for (const segment of parsed.segments) {
    const payload = bytes.slice(segment.payloadStart, segment.payloadEnd);
    const prefix = ascii(payload, 0, Math.min(payload.byteLength, 64));
    let removable = false;
    if (segment.marker === 0xe1 && prefix.startsWith('Exif\u0000\u0000')) {
      metadata.exif = true;
      removable = true;
      const tiff = parseTiff(payload.slice(6));
      findings.push(...findingsFromTiff(tiff, 'JPEG APP1 / EXIF'));
      if (!tiff.valid) findings.push(finding({
        category: 'integrity', severity: 'low', title: 'Malformed EXIF block',
        description: 'The EXIF metadata block could not be parsed completely.',
        evidence: tiff.error, path: 'JPEG APP1 / EXIF', cleanable: true, cleanAction: 'image-metadata'
      }));
    } else if (segment.marker === 0xe1 && (prefix.includes('xap/1.0') || prefix.includes('XMP'))) {
      metadata.xmp = true;
      removable = true;
      const xmpStart = prefix.includes('\u0000') ? payload.indexOf(0) + 1 : 0;
      const xmp = textDecode(payload.slice(Math.max(0, xmpStart)));
      const values = extractXmpValues(xmp);
      if (!values.length) {
        findings.push(finding({
          category: 'privacy', severity: 'low', title: 'XMP metadata packet',
          description: 'The file contains an XMP metadata packet.', path: 'JPEG APP1 / XMP',
          cleanable: true, cleanAction: 'image-metadata'
        }));
      }
      for (const item of values) {
        const location = item.label.startsWith('GPS');
        findings.push(finding({
          category: location ? 'location' : item.label === 'Creator' ? 'identity' : 'privacy',
          severity: location ? 'high' : item.label === 'Creator' ? 'medium' : 'low',
          title: `XMP ${item.label}`, description: 'XMP can disclose authorship, tool, time, or location details.',
          evidence: item.value, path: 'JPEG APP1 / XMP', cleanable: true, cleanAction: 'image-metadata'
        }));
      }
    } else if (segment.marker === 0xed) {
      metadata.iptc = true;
      removable = true;
      findings.push(finding({
        category: 'identity', severity: 'medium', title: 'IPTC / Photoshop metadata',
        description: 'The image contains an IPTC or Photoshop metadata block that may include creator and caption fields.',
        evidence: prefix.replace(/[^\x20-\x7e]/g, ' ').trim() || 'APP13 metadata',
        path: 'JPEG APP13', cleanable: true, cleanAction: 'image-metadata'
      }));
    } else if (segment.marker === 0xfe) {
      metadata.comments += 1;
      removable = true;
      findings.push(finding({
        category: 'privacy', severity: 'medium', title: 'JPEG comment',
        description: 'A comment is embedded in the image file.', evidence: textDecode(payload),
        path: 'JPEG COM', cleanable: true, cleanAction: 'image-metadata'
      }));
    } else if (segment.marker === 0xeb) {
      const text = textDecode(payload, 'latin1').toLowerCase();
      if (prefix.startsWith('JP') || text.includes('c2pa') || text.includes('jumb')) {
        metadata.c2paCandidate = true;
      }
    }

    if (removable) {
      if (segment.start > previous) pixelParts.push(bytes.slice(previous, segment.start));
      previous = segment.end;
    }
  }
  if (previous < bytes.byteLength) pixelParts.push(bytes.slice(previous));

  if (metadata.c2paCandidate) findings.push(finding({
    category: 'provenance', severity: 'info', title: 'Content Credentials data detected',
    description: 'The JPEG appears to contain a C2PA/JUMBF provenance manifest. ShareGlass can request validation with the official C2PA SDK.',
    path: 'JPEG APP11', remediation: 'Preserve provenance data unless you intentionally need an unsigned derivative.'
  }));

  return {
    findings,
    metadata,
    sanitizable: metadata.exif || metadata.xmp || metadata.iptc || metadata.comments > 0,
    fingerprint: await sha256Parts(pixelParts.length ? pixelParts : [bytes])
  };
}

async function inflateZlib(bytes, maxOutputBytes = MAX_TEXT_METADATA_BYTES) {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const parts = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxOutputBytes) {
        await reader.cancel('ShareGlass image metadata decompression safety limit');
        return null;
      }
      parts.push(value);
    }
    return concatBytes(parts);
  } catch {
    return null;
  }
}

export function parsePngChunks(bytes) {
  if (bytes.byteLength < 8 || ascii(bytes, 1, 4) !== 'PNG') return null;
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const length = readUint32BE(bytes, offset);
    if (length === null || length > bytes.byteLength - offset - 12) break;
    const type = ascii(bytes, offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crc = readUint32BE(bytes, dataEnd);
    chunks.push({ type, start: offset, end: dataEnd + 4, dataStart, dataEnd, length, crc });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

function parsePngText(type, data) {
  if (type === 'tEXt') {
    const zero = data.indexOf(0);
    return { keyword: textDecode(data.slice(0, zero < 0 ? data.length : zero)), text: textDecode(data.slice(zero + 1)) };
  }
  if (type === 'iTXt') {
    let offset = data.indexOf(0);
    if (offset < 0) return { keyword: '', text: textDecode(data) };
    const keyword = textDecode(data.slice(0, offset));
    const compressed = data[offset + 1] === 1;
    offset += 3;
    const languageEnd = data.indexOf(0, offset);
    offset = languageEnd < 0 ? data.length : languageEnd + 1;
    const translatedEnd = data.indexOf(0, offset);
    offset = translatedEnd < 0 ? data.length : translatedEnd + 1;
    return { keyword, text: compressed ? '(compressed iTXt)' : textDecode(data.slice(offset)) };
  }
  const zero = data.indexOf(0);
  return { keyword: textDecode(data.slice(0, zero < 0 ? data.length : zero)), text: '(compressed zTXt)' };
}

async function scanPng(bytes) {
  const chunks = parsePngChunks(bytes);
  if (!chunks) return { findings: [], metadata: {}, sanitizable: false, fingerprint: null };
  const findings = [];
  const metadata = { text: 0, exif: false, time: false, c2paCandidate: false, invalidCrc: 0 };
  const pixelParts = [];

  for (const chunk of chunks) {
    const data = bytes.subarray(chunk.dataStart, chunk.dataEnd);
    const typeBytes = bytes.subarray(chunk.start + 4, chunk.start + 8);
    if (crc32(concatBytes([typeBytes, data])) !== chunk.crc) {
      metadata.invalidCrc += 1;
      findings.push(finding({
        category: 'integrity', severity: 'high', title: 'Invalid PNG chunk checksum',
        description: 'A PNG chunk failed its CRC integrity check.', evidence: chunk.type,
        path: `PNG ${chunk.type}`
      }));
    }
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT'].includes(chunk.type)) {
      pixelParts.push(typeBytes, data);
    }
    if (['tEXt', 'zTXt', 'iTXt'].includes(chunk.type)) {
      metadata.text += 1;
      const oversized = data.byteLength > MAX_TEXT_METADATA_BYTES;
      const boundedData = oversized ? data.subarray(0, MAX_TEXT_METADATA_BYTES) : data;
      const text = parsePngText(chunk.type, boundedData);
      if (chunk.type === 'zTXt') {
        const zero = boundedData.indexOf(0);
        const inflated = zero >= 0 ? await inflateZlib(boundedData.subarray(zero + 2)) : null;
        if (inflated) text.text = textDecode(inflated);
      }
      if (oversized) text.text = `${truncate(text.text, 180)} · metadata truncated at 4 MB safety limit`;
      const sensitive = /author|artist|creator|copyright|comment|description|software|date|time|location|gps/i.test(text.keyword);
      findings.push(finding({
        category: /author|artist|creator|copyright/i.test(text.keyword) ? 'identity' : 'privacy',
        severity: sensitive ? 'medium' : 'low', title: `PNG text: ${text.keyword || 'unnamed field'}`,
        description: 'A textual metadata field is embedded in the PNG.',
        evidence: text.text, path: `PNG ${chunk.type}`, cleanable: true, cleanAction: 'image-metadata'
      }));
    } else if (chunk.type === 'eXIf') {
      metadata.exif = true;
      findings.push(...findingsFromTiff(parseTiff(data), 'PNG eXIf'));
    } else if (chunk.type === 'tIME') {
      metadata.time = true;
      const value = data.byteLength >= 7
        ? `${(data[0] << 8) | data[1]}-${String(data[2]).padStart(2, '0')}-${String(data[3]).padStart(2, '0')} ${String(data[4]).padStart(2, '0')}:${String(data[5]).padStart(2, '0')}:${String(data[6]).padStart(2, '0')} UTC`
        : 'tIME chunk';
      findings.push(finding({
        category: 'privacy', severity: 'low', title: 'PNG modification time',
        description: 'The PNG stores a modification timestamp.', evidence: value,
        path: 'PNG tIME', cleanable: true, cleanAction: 'image-metadata'
      }));
    } else if (chunk.type === 'caBX' || chunk.type.toLowerCase() === 'c2pa') {
      metadata.c2paCandidate = true;
    }
  }
  if (metadata.c2paCandidate) findings.push(finding({
    category: 'provenance', severity: 'info', title: 'Content Credentials data detected',
    description: 'The PNG contains a C2PA provenance chunk. ShareGlass can request validation with the official C2PA SDK.',
    path: 'PNG caBX', remediation: 'Preserve provenance data unless you intentionally need an unsigned derivative.'
  }));

  return {
    findings,
    metadata,
    sanitizable: metadata.text > 0 || metadata.exif || metadata.time,
    fingerprint: await sha256Parts(pixelParts.length ? pixelParts : [bytes])
  };
}

export function parseWebpChunks(bytes) {
  if (bytes.byteLength < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') return null;
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const type = ascii(bytes, offset, offset + 4);
    const length = readUint32LE(bytes, offset + 4);
    if (length === null || offset + 8 + length > bytes.byteLength) break;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    chunks.push({ type, start: offset, end: dataEnd + (length & 1), dataStart, dataEnd, length });
    offset = dataEnd + (length & 1);
  }
  return chunks;
}

async function scanWebp(bytes) {
  const chunks = parseWebpChunks(bytes);
  if (!chunks) return { findings: [], metadata: {}, sanitizable: false, fingerprint: null };
  const findings = [];
  const metadata = { exif: false, xmp: false, c2paCandidate: false };
  const pixelParts = [];
  const imageChunkTypes = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF']);
  for (const chunk of chunks) {
    const data = bytes.subarray(chunk.dataStart, chunk.dataEnd);
    const upperType = chunk.type.toUpperCase();
    if (chunk.type === 'EXIF') {
      metadata.exif = true;
      const tiff = ascii(data, 0, 6) === 'Exif\u0000\u0000' ? data.subarray(6) : data;
      findings.push(...findingsFromTiff(parseTiff(tiff), 'WebP EXIF'));
    } else if (chunk.type === 'XMP ') {
      metadata.xmp = true;
      const bounded = data.subarray(0, Math.min(data.byteLength, MAX_TEXT_METADATA_BYTES));
      const values = extractXmpValues(textDecode(bounded));
      const suffix = data.byteLength > bounded.byteLength ? ' · metadata truncated at 4 MB safety limit' : '';
      findings.push(finding({
        category: 'privacy', severity: values.length ? 'medium' : 'low', title: 'WebP XMP metadata',
        description: 'The WebP contains an XMP metadata packet.',
        evidence: (values.map((item) => `${item.label}: ${item.value}`).join(' · ') || 'XMP packet') + suffix,
        path: 'WebP XMP', cleanable: true, cleanAction: 'image-metadata'
      }));
    } else if (imageChunkTypes.has(chunk.type)) {
      pixelParts.push(data);
    } else {
      const marker = textDecode(data.subarray(0, Math.min(data.byteLength, 4096)), 'latin1').toLowerCase();
      if (upperType === 'C2PA' || upperType === 'JUMB' || marker.includes('c2pa') || marker.includes('jumb')) {
        metadata.c2paCandidate = true;
      }
    }
  }
  if (metadata.c2paCandidate) findings.push(finding({
    category: 'provenance', severity: 'info', title: 'Content Credentials data detected',
    description: 'The WebP appears to contain C2PA provenance data.', path: 'WebP container'
  }));
  return {
    findings, metadata,
    sanitizable: metadata.exif || metadata.xmp,
    fingerprint: await sha256Parts(pixelParts.length ? pixelParts : [bytes])
  };
}

export async function scanImage(kind, bytes) {
  if (kind === 'jpeg') return scanJpeg(bytes);
  if (kind === 'png') return scanPng(bytes);
  if (kind === 'webp') return scanWebp(bytes);
  return { findings: [], metadata: {}, sanitizable: false, fingerprint: null };
}

export function imageMetadataSummary(result) {
  const metadata = result?.metadata || {};
  return unique(Object.entries(metadata)
    .filter(([, value]) => value === true || (typeof value === 'number' && value > 0))
    .map(([key]) => key));
}
