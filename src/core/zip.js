import {
  concatBytes,
  readUint32LE,
  textDecode,
  textEncode,
  writeUint16LE,
  writeUint32LE
} from './utils.js';
import { crc32 } from './hash.js';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 65_557;

export class ZipError extends Error {
  constructor(message, code = 'ZIP_ERROR') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

function uint16(view, offset) {
  return view.getUint16(offset, true);
}

function uint32(view, offset) {
  return view.getUint32(offset, true);
}

function findEocd(bytes) {
  const start = Math.max(0, bytes.byteLength - MAX_EOCD_SEARCH);
  for (let offset = bytes.byteLength - 22; offset >= start; offset -= 1) {
    if (readUint32LE(bytes, offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

async function inflateRaw(bytes, maxOutputBytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('This browser cannot decompress Office files.', 'UNSUPPORTED_DEFLATE');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxOutputBytes) {
        await reader.cancel('ShareGlass ZIP decompression safety limit');
        throw new ZipError('Archive entry expands beyond its declared or configured limit.', 'ZIP_BOMB');
      }
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError(`Archive entry could not be decompressed: ${error instanceof Error ? error.message : String(error)}`, 'INVALID_ZIP');
  }
  return concatBytes(parts);
}

export async function openZip(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const limits = {
    maxEntries: options.maxEntries ?? 8_000,
    maxUncompressedBytes: options.maxUncompressedBytes ?? 300 * 1024 * 1024,
    maxEntryBytes: options.maxEntryBytes ?? 120 * 1024 * 1024,
    maxCompressionRatio: options.maxCompressionRatio ?? 500
  };

  const eocdOffset = findEocd(bytes);
  if (eocdOffset < 0) throw new ZipError('End of central directory was not found.', 'INVALID_ZIP');
  const eocd = new DataView(bytes.buffer, bytes.byteOffset + eocdOffset, bytes.byteLength - eocdOffset);
  const diskNumber = uint16(eocd, 4);
  const centralDisk = uint16(eocd, 6);
  const entriesOnDisk = uint16(eocd, 8);
  const totalEntries = uint16(eocd, 10);
  const centralSize = uint32(eocd, 12);
  const centralOffset = uint32(eocd, 16);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ZipError('Multi-disk ZIP archives are not supported.', 'MULTI_DISK');
  }
  if (totalEntries > limits.maxEntries) {
    throw new ZipError(`Archive contains too many entries (${totalEntries}).`, 'TOO_MANY_ENTRIES');
  }
  if (centralOffset + centralSize > bytes.byteLength) {
    throw new ZipError('Central directory points outside the file.', 'INVALID_ZIP');
  }

  const entries = [];
  let offset = centralOffset;
  let totalUncompressed = 0;
  const names = new Set();

  for (let index = 0; index < totalEntries; index += 1) {
    if (readUint32LE(bytes, offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError('Invalid central directory entry.', 'INVALID_ZIP');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    const flags = uint16(view, 8);
    const compression = uint16(view, 10);
    const crc = uint32(view, 16);
    const compressedSize = uint32(view, 20);
    const uncompressedSize = uint32(view, 24);
    const nameLength = uint16(view, 28);
    const extraLength = uint16(view, 30);
    const commentLength = uint16(view, 32);
    const externalAttributes = uint32(view, 38);
    const localOffset = uint32(view, 42);
    const recordLength = 46 + nameLength + extraLength + commentLength;
    if (offset + recordLength > bytes.byteLength) {
      throw new ZipError('Truncated central directory.', 'INVALID_ZIP');
    }

    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);
    const name = textDecode(nameBytes, 'utf-8').replaceAll('\\', '/');
    if (!name || name.startsWith('/') || name.includes('\u0000') || name.split('/').some((segment) => segment === '..')) {
      throw new ZipError(`Unsafe archive path: ${name || '(empty)'}`, 'ZIP_SLIP');
    }
    if (names.has(name)) throw new ZipError(`Duplicate archive path: ${name}`, 'DUPLICATE_ENTRY');
    names.add(name);

    totalUncompressed += uncompressedSize;
    if (uncompressedSize > limits.maxEntryBytes || totalUncompressed > limits.maxUncompressedBytes) {
      throw new ZipError('Archive expands beyond the configured safety limit.', 'ZIP_BOMB');
    }
    if (
      compressedSize > 0 &&
      uncompressedSize > 1024 * 1024 &&
      uncompressedSize / compressedSize > limits.maxCompressionRatio
    ) {
      throw new ZipError(`Suspicious compression ratio in ${name}.`, 'ZIP_BOMB');
    }
    if (localOffset + 30 > bytes.byteLength || readUint32LE(bytes, localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipError(`Invalid local header for ${name}.`, 'INVALID_ZIP');
    }
    const local = new DataView(
      bytes.buffer,
      bytes.byteOffset + localOffset,
      bytes.byteLength - localOffset
    );
    const localNameLength = uint16(local, 26);
    const localExtraLength = uint16(local, 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.byteLength) {
      throw new ZipError(`Truncated archive entry: ${name}`, 'INVALID_ZIP');
    }

    entries.push({
      name,
      flags,
      compression,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset,
      isDirectory: name.endsWith('/') || Boolean(externalAttributes & 0x10),
      encrypted: Boolean(flags & 0x1)
    });
    offset += recordLength;
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const cache = new Map();

  async function readEntry(entryOrName) {
    const entry = typeof entryOrName === 'string' ? byName.get(entryOrName) : entryOrName;
    if (!entry) return null;
    if (entry.isDirectory) return new Uint8Array();
    if (entry.encrypted) throw new ZipError(`Encrypted entry cannot be read: ${entry.name}`, 'ENCRYPTED');
    if (cache.has(entry.name)) return cache.get(entry.name).slice();
    const compressed = bytes.slice(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    let output;
    if (entry.compression === 0) output = compressed;
    else if (entry.compression === 8) output = await inflateRaw(compressed, Math.min(entry.uncompressedSize, limits.maxEntryBytes));
    else throw new ZipError(`Unsupported compression method ${entry.compression}.`, 'UNSUPPORTED_COMPRESSION');
    if (output.byteLength !== entry.uncompressedSize) {
      throw new ZipError(`Size mismatch while reading ${entry.name}.`, 'INVALID_ZIP');
    }
    if (crc32(output) !== entry.crc32) {
      throw new ZipError(`CRC mismatch while reading ${entry.name}.`, 'INVALID_ZIP');
    }
    cache.set(entry.name, output);
    return output.slice();
  }

  return {
    bytes,
    entries,
    names: [...byName.keys()],
    has: (name) => byName.has(name),
    get: (name) => byName.get(name) || null,
    read: readEntry,
    async readText(name) {
      const data = await readEntry(name);
      return data ? textDecode(data) : null;
    }
  };
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, date: day };
}

export function createZip(entries, options = {}) {
  const now = options.date instanceof Date ? options.date : new Date('2026-01-01T00:00:00Z');
  const stamp = dosDateTime(now);
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  let count = 0;

  const normalized = entries.map((entry) => ({
    name: String(entry.name).replaceAll('\\', '/'),
    data: entry.data instanceof Uint8Array ? entry.data : textEncode(entry.data ?? '')
  }));
  const outputNames = new Set();
  for (const entry of normalized) {
    const segments = entry.name.split('/');
    if (!entry.name || entry.name.startsWith('/') || entry.name.includes('\u0000') || segments.some((segment) => segment === '..')) {
      throw new ZipError(`Unsafe output archive path: ${entry.name || '(empty)'}`, 'ZIP_SLIP');
    }
    if (outputNames.has(entry.name)) throw new ZipError(`Duplicate output archive path: ${entry.name}`, 'DUPLICATE_ENTRY');
    outputNames.add(entry.name);
  }

  for (const entry of normalized) {
    const nameBytes = textEncode(entry.name);
    const checksum = crc32(entry.data);
    const local = new Uint8Array(30 + nameBytes.byteLength);
    writeUint32LE(local, 0, LOCAL_SIGNATURE);
    writeUint16LE(local, 4, 20);
    writeUint16LE(local, 6, 0x0800);
    writeUint16LE(local, 8, 0);
    writeUint16LE(local, 10, stamp.time);
    writeUint16LE(local, 12, stamp.date);
    writeUint32LE(local, 14, checksum);
    writeUint32LE(local, 18, entry.data.byteLength);
    writeUint32LE(local, 22, entry.data.byteLength);
    writeUint16LE(local, 26, nameBytes.byteLength);
    writeUint16LE(local, 28, 0);
    local.set(nameBytes, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + nameBytes.byteLength);
    writeUint32LE(central, 0, CENTRAL_SIGNATURE);
    writeUint16LE(central, 4, 0x0314);
    writeUint16LE(central, 6, 20);
    writeUint16LE(central, 8, 0x0800);
    writeUint16LE(central, 10, 0);
    writeUint16LE(central, 12, stamp.time);
    writeUint16LE(central, 14, stamp.date);
    writeUint32LE(central, 16, checksum);
    writeUint32LE(central, 20, entry.data.byteLength);
    writeUint32LE(central, 24, entry.data.byteLength);
    writeUint16LE(central, 28, nameBytes.byteLength);
    writeUint16LE(central, 30, 0);
    writeUint16LE(central, 32, 0);
    writeUint16LE(central, 34, 0);
    writeUint16LE(central, 36, 0);
    writeUint32LE(central, 38, entry.name.endsWith('/') ? 0x10 : 0);
    writeUint32LE(central, 42, localOffset);
    central.set(nameBytes, 46);
    centralParts.push(central);

    localOffset += local.byteLength + entry.data.byteLength;
    count += 1;
  }

  const central = concatBytes(centralParts);
  const eocd = new Uint8Array(22);
  writeUint32LE(eocd, 0, EOCD_SIGNATURE);
  writeUint16LE(eocd, 4, 0);
  writeUint16LE(eocd, 6, 0);
  writeUint16LE(eocd, 8, count);
  writeUint16LE(eocd, 10, count);
  writeUint32LE(eocd, 12, central.byteLength);
  writeUint32LE(eocd, 16, localOffset);
  writeUint16LE(eocd, 20, 0);
  return concatBytes([...localParts, central, eocd]);
}
