import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { analyzeBytes, sanitizeBytes } from '../src/core/analyze.js';
import { createZip, openZip, ZipError } from '../src/core/zip.js';
import { crc32 } from '../src/core/hash.js';
import { parseWebpChunks } from '../src/core/detectors/image.js';
import { sanitizeWebp } from '../src/core/sanitizers/image.js';
import { concatBytes, textDecode, textEncode, writeUint16LE, writeUint32LE } from '../src/core/utils.js';
import { reportToMarkdown } from '../src/core/report.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = async (name) => new Uint8Array(await readFile(resolve(root, 'samples', name)));

function pngChunk(type, data) {
  const name = textEncode(type);
  const output = new Uint8Array(12 + data.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.byteLength, false);
  output.set(name, 4);
  output.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(concatBytes([name, data])), false);
  return output;
}


function addCompressedPngText(bytes, expandedBytes) {
  const keyword = textEncode('Comment');
  const compressed = new Uint8Array(deflateSync(expandedBytes));
  const data = concatBytes([keyword, new Uint8Array([0, 0]), compressed]);
  return concatBytes([
    bytes.slice(0, bytes.byteLength - 12),
    pngChunk('zTXt', data),
    bytes.slice(bytes.byteLength - 12)
  ]);
}

function addPngC2pa(bytes) {
  return concatBytes([
    bytes.slice(0, bytes.byteLength - 12),
    pngChunk('caBX', textEncode('synthetic c2pa manifest')),
    bytes.slice(bytes.byteLength - 12)
  ]);
}

function riffChunk(type, data) {
  const output = new Uint8Array(8 + data.byteLength + (data.byteLength & 1));
  output.set(textEncode(type), 0);
  writeUint32LE(output, 4, data.byteLength);
  output.set(data, 8);
  return output;
}

function createMetadataWebp() {
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x0c;
  const body = concatBytes([
    riffChunk('VP8X', vp8x),
    riffChunk('EXIF', textEncode('Exif\\0\\0synthetic')),
    riffChunk('XMP ', textEncode('<x:xmpmeta>synthetic</x:xmpmeta>')),
    riffChunk('VP8L', new Uint8Array([0x2f, 0, 0, 0, 0]))
  ]);
  const output = new Uint8Array(12 + body.byteLength);
  output.set(textEncode('RIFF'), 0);
  writeUint32LE(output, 4, output.byteLength - 8);
  output.set(textEncode('WEBP'), 8);
  output.set(body, 12);
  return output;
}


function createDeflatedZip(name, payload, declaredSize = payload.byteLength) {
  const compressed = new Uint8Array(deflateRawSync(payload));
  const nameBytes = textEncode(name);
  const checksum = crc32(payload);
  const local = new Uint8Array(30 + nameBytes.byteLength);
  writeUint32LE(local, 0, 0x04034b50);
  writeUint16LE(local, 4, 20);
  writeUint16LE(local, 6, 0x0800);
  writeUint16LE(local, 8, 8);
  writeUint32LE(local, 14, checksum);
  writeUint32LE(local, 18, compressed.byteLength);
  writeUint32LE(local, 22, declaredSize);
  writeUint16LE(local, 26, nameBytes.byteLength);
  local.set(nameBytes, 30);

  const central = new Uint8Array(46 + nameBytes.byteLength);
  writeUint32LE(central, 0, 0x02014b50);
  writeUint16LE(central, 4, 0x0314);
  writeUint16LE(central, 6, 20);
  writeUint16LE(central, 8, 0x0800);
  writeUint16LE(central, 10, 8);
  writeUint32LE(central, 16, checksum);
  writeUint32LE(central, 20, compressed.byteLength);
  writeUint32LE(central, 24, declaredSize);
  writeUint16LE(central, 28, nameBytes.byteLength);
  writeUint32LE(central, 42, 0);
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  writeUint32LE(eocd, 0, 0x06054b50);
  writeUint16LE(eocd, 8, 1);
  writeUint16LE(eocd, 10, 1);
  writeUint32LE(eocd, 12, central.byteLength);
  writeUint32LE(eocd, 16, local.byteLength + compressed.byteLength);
  return concatBytes([local, compressed, central, eocd]);
}

function titles(report) {
  return new Set(report.findings.map((item) => item.title));
}

test('ZIP writer and reader round-trip without dependencies', async () => {
  const bytes = createZip([
    { name: 'hello.txt', data: textEncode('hello') },
    { name: 'nested/value.txt', data: textEncode('value') }
  ]);
  const zip = await openZip(bytes);
  assert.deepEqual(zip.names, ['hello.txt', 'nested/value.txt']);
  assert.equal(textDecode(await zip.read('hello.txt')), 'hello');
  assert.equal(textDecode(await zip.read('nested/value.txt')), 'value');
});

test('ZIP writer rejects duplicate and traversal paths', () => {
  assert.throws(() => createZip([
    { name: 'duplicate.txt', data: textEncode('one') },
    { name: 'duplicate.txt', data: textEncode('two') }
  ]), (error) => error instanceof ZipError && error.code === 'DUPLICATE_ENTRY');
  assert.throws(() => createZip([
    { name: '../outside.txt', data: textEncode('nope') }
  ]), (error) => error instanceof ZipError && error.code === 'ZIP_SLIP');
});

test('ZIP reader stops deflate output that exceeds the declared size', async () => {
  const payload = new Uint8Array(2 * 1024 * 1024).fill(0x41);
  const zip = await openZip(createDeflatedZip('compressed.txt', payload, 32));
  await assert.rejects(
    () => zip.read('compressed.txt'),
    (error) => error instanceof ZipError && error.code === 'ZIP_BOMB'
  );
});

test('PNG inspection finds exact GPS and identity metadata', async () => {
  const bytes = await fixture('private-photo.png');
  const report = await analyzeBytes({ name: 'private-photo.png', bytes });
  const found = titles(report);
  assert.equal(report.type.kind, 'png');
  assert.equal(report.summary.level, 'high');
  assert.ok(found.has('Exact GPS coordinates'));
  assert.ok(found.has('Artist'));
  const gps = report.findings.find((item) => item.title === 'Exact GPS coordinates');
  assert.match(gps.evidence, /^37\.\d+, 126\.\d+$/);
  assert.equal(report.capabilities.sanitizeActions[0].id, 'image-metadata');
});

test('PNG compressed text is bounded during metadata decompression', async () => {
  const source = addCompressedPngText(await fixture('private-photo.png'), new Uint8Array(6 * 1024 * 1024).fill(0x41));
  const report = await analyzeBytes({ name: 'compressed-text.png', bytes: source });
  const item = report.findings.find((finding) => finding.title === 'PNG text: Comment' && /compressed zTXt/i.test(finding.evidence || ''));
  assert.ok(item);
});

test('image safe copy removes metadata and preserves image payload', async () => {
  const bytes = await fixture('private-photo.png');
  const report = await analyzeBytes({ name: 'private-photo.png', bytes });
  const cleaned = await sanitizeBytes({ name: 'private-photo.png', bytes, report });
  assert.equal(cleaned.report.summary.actionable, 0);
  assert.equal(cleaned.verification.sameContent, true);
  assert.ok(cleaned.bytes.byteLength < bytes.byteLength);
});


test('provenance-bearing PNG requires confirmation and removes stale manifest in the derivative', async () => {
  const source = addPngC2pa(await fixture('private-photo.png'));
  const report = await analyzeBytes({ name: 'credentialed.png', bytes: source });
  assert.equal(report.capabilities.c2paCandidate, true);
  await assert.rejects(
    () => sanitizeBytes({ name: 'credentialed.png', bytes: source, report }),
    /Content Credentials/
  );
  const cleaned = await sanitizeBytes({
    name: 'credentialed.png', bytes: source, report, forceProvenance: true
  });
  assert.equal(cleaned.report.capabilities.c2paCandidate, false);
  assert.equal(cleaned.report.summary.actionable, 0);
  assert.equal(cleaned.verification.sameContent, true);
  assert.ok(cleaned.removed.includes('C2PA manifest'));
});

test('WebP sanitization removes EXIF/XMP and clears VP8X metadata flags', async () => {
  const source = createMetadataWebp();
  const report = await analyzeBytes({ name: 'metadata.webp', bytes: source });
  assert.equal(report.type.kind, 'webp');
  assert.equal(report.metadata.exif, true);
  assert.equal(report.metadata.xmp, true);
  const cleaned = sanitizeWebp(source);
  const chunks = parseWebpChunks(cleaned.bytes);
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['VP8X', 'VP8L']);
  const vp8x = chunks.find((chunk) => chunk.type === 'VP8X');
  assert.equal(cleaned.bytes[vp8x.dataStart] & 0x0c, 0);
});

test('DOCX inspection finds collaboration, identity, external, and custom data', async () => {
  const bytes = await fixture('private-resume.docx');
  const report = await analyzeBytes({ name: 'private-resume.docx', bytes });
  const found = titles(report);
  assert.equal(report.type.kind, 'ooxml');
  assert.equal(report.type.officeType, 'docx');
  assert.equal(report.summary.level, 'critical');
  for (const title of [
    'Document author', 'Comments and reviewer identities', 'Tracked revisions',
    'External document template', 'Custom XML data', 'Cached document thumbnail', 'Hidden Word text'
  ]) assert.ok(found.has(title), `Expected finding: ${title}`);
});

test('DOCX default safe copy removes default privacy traces', async () => {
  const bytes = await fixture('private-resume.docx');
  const report = await analyzeBytes({ name: 'private-resume.docx', bytes });
  const cleaned = await sanitizeBytes({ name: 'private-resume.docx', bytes, report });
  const found = titles(cleaned.report);
  assert.equal(cleaned.verification.sameContent, true);
  assert.ok(!found.has('Document author'));
  assert.ok(!found.has('Comments and reviewer identities'));
  assert.ok(!found.has('Cached document thumbnail'));
  assert.ok(found.has('Tracked revisions'));
  assert.ok(found.has('Custom XML data'));
});

test('DOCX advanced safe copy removes optional structures without changing visible text', async () => {
  const bytes = await fixture('private-resume.docx');
  const report = await analyzeBytes({ name: 'private-resume.docx', bytes });
  const cleaned = await sanitizeBytes({
    name: 'private-resume.docx', bytes, report,
    actions: [
      'office-properties', 'office-comments', 'office-thumbnail',
      'office-customxml', 'office-external-links', 'office-accept-changes'
    ]
  });
  const found = titles(cleaned.report);
  assert.equal(cleaned.verification.sameContent, true);
  assert.deepEqual([...found], ['Hidden Word text']);
  assert.ok(cleaned.warnings.length >= 3);
});



test('macro-enabled Office MIME types are recognized without a false mismatch', async () => {
  const bytes = createZip([
    { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>Macro fixture</w:t></w:r></w:p></w:body></w:document>' },
    { name: 'word/vbaProject.bin', data: new Uint8Array([1, 2, 3, 4]) }
  ]);
  const mime = 'application/vnd.ms-word.document.macroEnabled.12';
  const report = await analyzeBytes({ name: 'macro.docm', mime, bytes });
  assert.equal(report.type.magicMismatch, false);
  assert.equal(report.file.mime, mime);
  assert.ok(titles(report).has('Macros or ActiveX content'));
});

test('XLSX inspection finds very-hidden sheets and external workbook data', async () => {
  const bytes = createZip([
    { name: 'xl/workbook.xml', data: '<workbook><sheets><sheet name="Visible" state="visible"/><sheet name="Payroll" state="veryHidden"/></sheets></workbook>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="file:///Users/alex/finance.xlsx" TargetMode="External"/></Relationships>' },
    { name: 'xl/externalLinks/externalLink1.xml', data: '<externalLink/>' },
    { name: 'docProps/core.xml', data: '<cp:coreProperties><dc:creator>Alex Morgan</dc:creator></cp:coreProperties>' }
  ]);
  const report = await analyzeBytes({ name: 'workbook.xlsx', bytes });
  const found = titles(report);
  assert.equal(report.type.officeType, 'xlsx');
  assert.ok(found.has('Hidden workbook sheets'));
  assert.ok(found.has('External workbook data link'));
  assert.ok(found.has('External workbook link parts'));
  assert.ok(found.has('Document author'));
});

test('PPTX inspection finds hidden slides, presenter notes, and external media', async () => {
  const bytes = createZip([
    { name: 'ppt/presentation.xml', data: '<p:presentation/>' },
    { name: 'ppt/slides/slide1.xml', data: '<p:sld show="0"><p:cSld><a:t>Hidden roadmap</a:t></p:cSld></p:sld>' },
    { name: 'ppt/notesSlides/notesSlide1.xml', data: '<p:notes><a:t>Do not share pricing</a:t></p:notes>' },
    { name: 'ppt/slides/_rels/slide1.xml.rels', data: '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="https://media.example/demo.mp4" TargetMode="External"/></Relationships>' },
    { name: 'docProps/core.xml', data: '<cp:coreProperties><cp:lastModifiedBy>Alex Morgan</cp:lastModifiedBy></cp:coreProperties>' }
  ]);
  const report = await analyzeBytes({ name: 'deck.pptx', bytes });
  const found = titles(report);
  assert.equal(report.type.officeType, 'pptx');
  assert.ok(found.has('Hidden presentation slides'));
  assert.ok(found.has('Presenter notes'));
  assert.ok(found.has('Externally linked video'));
  assert.ok(found.has('Last editor'));
});

test('PDF inspection reports active content and embedded files but does not offer unsafe rewriting', async () => {
  const bytes = await fixture('risky-contract.pdf');
  const report = await analyzeBytes({ name: 'risky-contract.pdf', bytes });
  const found = titles(report);
  assert.equal(report.type.kind, 'pdf');
  assert.equal(report.summary.level, 'critical');
  assert.ok(found.has('Embedded JavaScript'));
  assert.ok(found.has('Embedded files or rich media'));
  assert.ok(found.has('External links'));
  assert.equal(report.capabilities.pdfSanitization, false);
  assert.equal(report.capabilities.sanitize, false);
});

test('Markdown report includes integrity hash and actionable evidence', async () => {
  const bytes = await fixture('private-photo.png');
  const report = await analyzeBytes({ name: 'private-photo.png', bytes });
  const markdown = reportToMarkdown(report);
  assert.match(markdown, /ShareGlass report/);
  assert.match(markdown, /Exact GPS coordinates/);
  assert.match(markdown, new RegExp(report.file.sha256));
});

test('CLI version and threshold validation behave predictably', () => {
  const cli = resolve(root, 'bin/shareglass.mjs');
  const version = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), '1.0.0');
  const invalid = spawnSync(process.execPath, [cli, 'scan', resolve(root, 'samples/private-photo.png'), '--fail-on', 'severe'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /must be one of/);
});

test('CLI applies default DOCX cleaning even when advanced flags are supplied', async () => {
  const output = resolve(root, 'test', 'cli-output.safe.docx');
  await rm(output, { force: true });
  const result = spawnSync(process.execPath, [
    resolve(root, 'bin/shareglass.mjs'), 'clean', resolve(root, 'samples/private-resume.docx'),
    '--out', output, '--custom-data', '--neutralize-links'
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Findings: 19 → 2/);
  const cleaned = await analyzeBytes({ name: 'cli-output.safe.docx', bytes: new Uint8Array(await readFile(output)) });
  assert.ok(!titles(cleaned).has('Document author'));
  assert.ok(!titles(cleaned).has('Comments and reviewer identities'));
  await rm(output, { force: true });
});
