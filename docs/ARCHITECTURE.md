# Architecture

ShareGlass is a static browser application and a Node.js CLI built on one dependency-free ECMAScript module core.

## Data flow

```text
File/bytes
   │
   ▼
detectFileType ── validates filename/MIME against magic bytes
   │
   ├── scanImage  ── JPEG segments / PNG chunks / RIFF chunks / TIFF IFD
   ├── scanOoxml  ── bounded ZIP reader / OPC parts / XML relationships
   └── scanPdf    ── bounded byte-to-text structural inspection
   │
   ▼
normalize findings ── category / severity / evidence / path / clean action
   │
   ▼
risk summary + JSON report + UI/CLI rendering
```

Safe-copy operations use the same report as their policy input, create new bytes, invoke `analyzeBytes` again, and compare content fingerprints.

## Design constraints

### No runtime dependencies

The core uses Web Platform APIs available in current browsers and Node.js 22+: `Uint8Array`, Web Crypto, `Blob`, `DecompressionStream`, and ECMAScript modules. Avoiding dependency trees keeps the static deployment inspectable and reduces supply-chain exposure.

### Bounded parsers

`zip.js` validates central-directory boundaries, duplicate and traversal paths, encryption, CRC values, entry counts, uncompressed totals, per-entry sizes, and suspicious compression ratios before returning content. Deflated entries are consumed through a bounded stream so a forged uncompressed-size field cannot turn into unbounded output.

Every format detector imposes explicit limits on collection counts, evidence lengths, and decompressed auxiliary data. PNG compressed text is capped, PDF Flate streams are capped, and WebP provenance probing reads only bounded non-image prefixes. A detector must not perform recursive or declaration-trusting unbounded parsing.

### Findings, not logs

Detectors return normalized findings. UI text, CLI text, JSON, and Markdown are derived from the same objects. A finding should provide enough evidence to be independently understood without exposing more private data than necessary.

### Conservative rewriting

A sanitizer is accepted only when ShareGlass can write a structurally valid container and re-open it with its own parser. Unsupported transformations remain inspection-only. PDF rewriting is excluded from v1 for this reason.

### Optional provenance validation

Structural C2PA/JUMBF markers are detected by the core. Cryptographic interpretation is isolated in `c2pa.js` and loads the official browser SDK only after user action. This keeps routine inspection offline-capable and the core dependency-free.

## Public API

```js
import { analyzeBytes, sanitizeBytes } from './src/core/analyze.js';

const report = await analyzeBytes({
  name: file.name,
  mime: file.type,
  bytes: new Uint8Array(await file.arrayBuffer())
});

const result = await sanitizeBytes({
  name: file.name,
  bytes,
  report,
  actions: ['office-properties', 'office-comments']
});
```

The report schema is versioned independently through its `schema` field. Consumers should ignore unknown fields and use finding IDs only within one report; titles/categories and clean-action IDs are the stable semantic interface in v1.
