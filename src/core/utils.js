const UTF8 = new TextDecoder('utf-8', { fatal: false });
const LATIN1 = new TextDecoder('latin1', { fatal: false });
const UTF8_ENCODER = new TextEncoder();

export function textDecode(bytes, encoding = 'utf-8') {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  return encoding === 'latin1' ? LATIN1.decode(bytes) : UTF8.decode(bytes);
}

export function textEncode(value) {
  return UTF8_ENCODER.encode(String(value));
}

export function concatBytes(parts) {
  const normalized = parts.filter(Boolean).map((part) =>
    part instanceof Uint8Array ? part : new Uint8Array(part)
  );
  const length = normalized.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of normalized) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function sliceBytes(bytes, start, end) {
  return bytes instanceof Uint8Array
    ? bytes.slice(start, end)
    : new Uint8Array(bytes).slice(start, end);
}

export function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function ascii(bytes, start = 0, end = bytes.byteLength) {
  let out = '';
  const limit = Math.min(end, bytes.byteLength);
  for (let i = start; i < limit; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

export function hex(bytes, limit = bytes.byteLength) {
  return [...bytes.slice(0, limit)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let current = value / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && current >= 1024; i += 1) {
    current /= 1024;
    unit = units[i];
  }
  return `${current >= 10 ? current.toFixed(1) : current.toFixed(2)} ${unit}`;
}

export function formatDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function safeFilename(value) {
  return String(value || 'file')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'file';
}

export function outputFilename(name, suffix = '.safe') {
  const clean = safeFilename(name);
  const index = clean.lastIndexOf('.');
  if (index <= 0) return `${clean}${suffix}`;
  return `${clean.slice(0, index)}${suffix}${clean.slice(index)}`;
}

export function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
}

export function truncate(value, length = 180) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function mimeFromExtension(name = '') {
  const extension = name.toLowerCase().split('.').pop();
  return {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    docm: 'application/vnd.ms-word.document.macroEnabled.12',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pptm: 'application/vnd.ms-powerpoint.presentation.macroEnabled.12'
  }[extension] || 'application/octet-stream';
}

export function extensionOf(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

export function findAll(text, regex, limit = 50) {
  const matches = [];
  const expression = regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
  let match;
  while ((match = expression.exec(text)) && matches.length < limit) {
    matches.push(match);
    if (match[0] === '') expression.lastIndex += 1;
  }
  return matches;
}

export function readUint16BE(bytes, offset) {
  if (offset + 2 > bytes.byteLength) return null;
  return (bytes[offset] << 8) | bytes[offset + 1];
}

export function readUint32BE(bytes, offset) {
  if (offset + 4 > bytes.byteLength) return null;
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  ) >>> 0;
}

export function readUint32LE(bytes, offset) {
  if (offset + 4 > bytes.byteLength) return null;
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  ) >>> 0;
}

export function writeUint16LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

export function writeUint32LE(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

export function isProbablyUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ftp:', 'file:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
}
