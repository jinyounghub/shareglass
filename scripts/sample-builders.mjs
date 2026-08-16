import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/core/hash.js';
import { concatBytes, textEncode, writeUint16LE, writeUint32LE } from '../src/core/utils.js';
import { createZip } from '../src/core/zip.js';

function writeUint32BE(target, offset, value) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function pngChunk(type, data = new Uint8Array()) {
  const typeBytes = textEncode(type);
  const output = new Uint8Array(12 + data.byteLength);
  writeUint32BE(output, 0, data.byteLength);
  output.set(typeBytes, 4);
  output.set(data, 8);
  writeUint32BE(output, 8 + data.byteLength, crc32(concatBytes([typeBytes, data])));
  return output;
}

function textChunk(keyword, value) {
  return pngChunk('tEXt', concatBytes([textEncode(keyword), new Uint8Array([0]), textEncode(value)]));
}

function createExifTiff() {
  const strings = [
    ['make', 'Northwind Camera Co.\0'],
    ['model', 'NW Pocket Pro\0'],
    ['software', 'Northwind Studio 7.4\0'],
    ['artist', 'Avery Example\0'],
    ['date', '2026:08:14 18:42:11\0']
  ];
  const ifd0Entries = 6;
  const ifd0Start = 8;
  const ifd0Size = 2 + ifd0Entries * 12 + 4;
  let cursor = ifd0Start + ifd0Size;
  const stringOffsets = {};
  for (const [key, value] of strings) {
    stringOffsets[key] = cursor;
    cursor += textEncode(value).byteLength;
  }
  if (cursor & 1) cursor += 1;
  const gpsIfdOffset = cursor;
  const gpsEntries = 4;
  const gpsIfdSize = 2 + gpsEntries * 12 + 4;
  const latOffset = gpsIfdOffset + gpsIfdSize;
  const lonOffset = latOffset + 24;
  const total = lonOffset + 24;
  const tiff = new Uint8Array(total);
  tiff[0] = 0x49; tiff[1] = 0x49;
  writeUint16LE(tiff, 2, 42);
  writeUint32LE(tiff, 4, ifd0Start);
  writeUint16LE(tiff, ifd0Start, ifd0Entries);

  const writeEntry = (base, index, tag, type, count, valueOrOffset, inlineBytes = null) => {
    const offset = base + 2 + index * 12;
    writeUint16LE(tiff, offset, tag);
    writeUint16LE(tiff, offset + 2, type);
    writeUint32LE(tiff, offset + 4, count);
    if (inlineBytes) tiff.set(inlineBytes.slice(0, 4), offset + 8);
    else writeUint32LE(tiff, offset + 8, valueOrOffset);
  };

  writeEntry(ifd0Start, 0, 0x010f, 2, textEncode(strings[0][1]).byteLength, stringOffsets.make);
  writeEntry(ifd0Start, 1, 0x0110, 2, textEncode(strings[1][1]).byteLength, stringOffsets.model);
  writeEntry(ifd0Start, 2, 0x0131, 2, textEncode(strings[2][1]).byteLength, stringOffsets.software);
  writeEntry(ifd0Start, 3, 0x013b, 2, textEncode(strings[3][1]).byteLength, stringOffsets.artist);
  writeEntry(ifd0Start, 4, 0x0132, 2, textEncode(strings[4][1]).byteLength, stringOffsets.date);
  writeEntry(ifd0Start, 5, 0x8825, 4, 1, gpsIfdOffset);
  writeUint32LE(tiff, ifd0Start + 2 + ifd0Entries * 12, 0);

  for (const [key, value] of strings) tiff.set(textEncode(value), stringOffsets[key]);

  writeUint16LE(tiff, gpsIfdOffset, gpsEntries);
  writeEntry(gpsIfdOffset, 0, 1, 2, 2, 0, new Uint8Array([0x4e, 0x00, 0x00, 0x00]));
  writeEntry(gpsIfdOffset, 1, 2, 5, 3, latOffset);
  writeEntry(gpsIfdOffset, 2, 3, 2, 2, 0, new Uint8Array([0x45, 0x00, 0x00, 0x00]));
  writeEntry(gpsIfdOffset, 3, 4, 5, 3, lonOffset);
  writeUint32LE(tiff, gpsIfdOffset + 2 + gpsEntries * 12, 0);

  const rationals = (offset, values) => values.forEach(([numerator, denominator], index) => {
    writeUint32LE(tiff, offset + index * 8, numerator);
    writeUint32LE(tiff, offset + index * 8 + 4, denominator);
  });
  // Seoul City Hall area: 37°33'59.6" N, 126°58'41.7" E
  rationals(latOffset, [[37, 1], [33, 1], [596, 10]]);
  rationals(lonOffset, [[126, 1], [58, 1], [417, 10]]);
  return tiff;
}

export function createPrivatePng(width = 960, height = 560) {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      const glow = Math.max(0, 1 - Math.hypot(x - width * .72, y - height * .28) / (width * .55));
      raw[offset] = Math.round(10 + 28 * glow + 14 * x / width);
      raw[offset + 1] = Math.round(24 + 125 * glow + 28 * y / height);
      raw[offset + 2] = Math.round(43 + 150 * glow + 46 * x / width);
      if (x > 90 && x < width - 90 && y > 100 && y < height - 100) {
        const edge = Math.min(x - 90, width - 90 - x, y - 100, height - 100 - y);
        if (edge < 3) { raw[offset] = 115; raw[offset + 1] = 240; raw[offset + 2] = 204; }
      }
    }
  }
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return concatBytes([
    signature,
    pngChunk('IHDR', ihdr),
    textChunk('Author', 'Avery Example'),
    textChunk('Software', 'Northwind Studio 7.4'),
    textChunk('Comment', 'Synthetic ShareGlass demo — contains intentionally private metadata'),
    pngChunk('eXIf', createExifTiff()),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw, { level: 8 }))),
    pngChunk('IEND')
  ]);
}

export function createPrivateDocx(thumbnail = createPrivatePng(240, 140)) {
  const entries = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.png"/>
</Relationships>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>Executive résumé — external draft</dc:title><dc:creator>Avery Example</dc:creator><cp:lastModifiedBy>Taylor Example</cp:lastModifiedBy><cp:keywords>confidential; executive search; compensation</cp:keywords><dcterms:created xsi:type="dcterms:W3CDTF">2026-08-12T09:12:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-08-15T22:31:00Z</dcterms:modified><cp:lastPrinted>2026-08-15T22:33:00Z</cp:lastPrinted><cp:revision>14</cp:revision>
</cp:coreProperties>` },
    { name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Office Word</Application><AppVersion>16.0000</AppVersion><Company>Northwind Example Labs</Company><Manager>Casey Example</Manager><Template>C:\\Users\\example\\Company Templates\\executive-resume.dotx</Template><TotalTime>184</TotalTime></Properties>` },
    { name: 'docProps/custom.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="EmployeeID"><vt:lpwstr>NW-1042</vt:lpwstr></property><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="InternalRecruiter"><vt:lpwstr>recruiting@northwind.example</vt:lpwstr></property></Properties>` },
    { name: 'docProps/thumbnail.png', data: thumbnail },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>Avery Example</w:t></w:r></w:p>
<w:p><w:r><w:t>Operations &amp; People Leader · Seoul</w:t></w:r></w:p>
<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>avery@example.test · +00 000 000 0000</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>
<w:p><w:r><w:t>Built reliable HR, finance, and workplace operations across multiple offices.</w:t></w:r></w:p>
<w:p><w:ins w:id="1" w:author="Taylor Example" w:date="2026-08-15T22:28:00Z"><w:r><w:t>Led a 42-person distributed organization.</w:t></w:r></w:ins></w:p>
<w:p><w:del w:id="2" w:author="Taylor Example" w:date="2026-08-15T22:29:00Z"><w:r><w:delText>Current salary: KRW 92,000,000.</w:delText></w:r></w:del></w:p>
<w:p><w:hyperlink r:id="rId4"><w:r><w:rPr><w:color w:val="48CCE8"/><w:u w:val="single"/></w:rPr><w:t>Internal employee profile</w:t></w:r></w:hyperlink></w:p>
<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>Background-check reference: CASE-NW-882190</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="900" w:bottom="720" w:left="900"/></w:sectPr>
</w:body></w:document>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://internal.example.test/people/NW-1042?source=resume" TargetMode="External"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:/Users/example/Company%20Templates/executive-resume.dotx" TargetMode="External"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml" Target="../customXml/item1.xml"/>
</Relationships>` },
    { name: 'word/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>` },
    { name: 'word/settings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:trackRevisions/><w:updateFields w:val="true"/></w:settings>` },
    { name: 'word/comments.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Taylor Example" w:initials="TR" w:date="2026-08-15T22:21:00Z"><w:p><w:r><w:t>Remove the personal phone number before sending this outside the company.</w:t></w:r></w:p></w:comment></w:comments>` },
    { name: 'customXml/item1.xml', data: `<?xml version="1.0" encoding="UTF-8"?><employee xmlns="urn:northwind:hr"><id>NW-1042</id><backgroundCheck>CASE-NW-882190</backgroundCheck><salaryBand>Executive-3</salaryBand></employee>` },
    { name: 'customXml/_rels/item1.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>` }
  ];
  return createZip(entries);
}

function escapePdf(value) {
  return String(value).replace(/([\\()])/g, '\\$1').replace(/\r?\n/g, '\\n');
}

export function createRiskyPdf() {
  const content = `BT /F1 24 Tf 72 720 Td (ShareGlass synthetic contract) Tj 0 -42 Td /F1 12 Tf (This file contains intentionally risky metadata and actions.) Tj 0 -30 Td (Click the blue link only in a sandbox.) Tj ET`;
  const embedded = 'Internal note: customer account 8842; do not distribute.\n';
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /Names << /EmbeddedFiles << /Names [(internal-notes.txt) 8 0 R] >> >> /AcroForm 10 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [7 0 R] >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /S /JavaScript /JS (app.alert\\('Synthetic ShareGlass demo: embedded JavaScript ran.'\\);) >>`,
    `<< /Type /Annot /Subtype /Link /Rect [72 600 360 625] /Border [0 0 1] /C [0 0.5 1] /A << /S /URI /URI (${escapePdf('https://tracking.example.test/open?id=contract-8842')}) >> >>`,
    `<< /Type /Filespec /F (internal-notes.txt) /UF (internal-notes.txt) /EF << /F 9 0 R >> >>`,
    `<< /Type /EmbeddedFile /Subtype /text#2Fplain /Length ${embedded.length} >>\nstream\n${embedded}endstream`,
    `<< /Fields [] /NeedAppearances true >>`,
    `<< /Author (Avery Example) /Creator (Northwind Example Generator 4.2) /Producer (Northwind Example PDF Engine) /Title (Customer 8842 confidential agreement) /Subject (Internal negotiation draft) /Keywords (confidential, customer-8842, legal) /CreationDate (D:20260815184411+09'00') >>`
  ];
  let pdf = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 11 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}
