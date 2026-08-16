# Threat model

## Assets protected

- private metadata and collaboration traces in files about to be shared;
- the source file, which must not be overwritten;
- the user's browser session and local machine while parsing an untrusted file;
- confidence that a generated copy was actually re-inspected.

## Adversaries and failure modes

1. **Accidental disclosure:** a normal application preserves author, GPS, comments, revisions, links, or custom data the user did not notice.
2. **Hostile file:** crafted lengths, archive paths, compression ratios, CRC mismatches, malformed XML, or parser edge cases attempt denial of service or unexpected behavior.
3. **Misleading cleanup:** a tool claims to remove data but leaves related parts, breaks the file, or changes visible content.
4. **Supply-chain/network exposure:** a dependency or telemetry service receives content or introduces code outside the inspected repository.
5. **False assurance:** an incomplete structural scan is interpreted as proof that the file is safe.

## Controls

- local byte processing and no upload endpoint;
- zero runtime dependencies in the main inspection and sanitization core;
- an overall 300 MB input limit plus archive-entry, expanded-size and compression-ratio bounds;
- streaming decompression ceilings that do not trust ZIP or embedded-stream size declarations;
- bounded PNG compressed-text expansion and bounded PDF Flate stream inspection;
- bounded WebP provenance probing that does not decode image payload chunks;
- archive traversal, duplicate path, encryption, boundary and CRC checks;
- output to a new filename only;
- re-scan and content-fingerprint comparison after sanitization;
- opt-in destructive transformations and signature/provenance gates;
- PDF inspection-only policy;
- CSP that blocks objects, forms, inline scripts, and unlisted origins;
- synthetic fixtures and automated regression tests.

## Out of scope

- malware removal or antivirus guarantees;
- sandboxing macros, JavaScript, media, or embedded executables;
- OCR and visual redaction of private information visible in pixels/pages;
- steganography detection;
- password cracking or encrypted-content inspection;
- legacy binary `.doc`, `.xls`, and `.ppt` formats;
- guarantees about third-party software used to open an output file;
- complete cryptographic C2PA validation when the optional official SDK is unavailable.

## Residual risks

Browser parsers and JavaScript engines can contain vulnerabilities. Very large but permitted files can consume significant memory. XML is processed as bounded text rather than with an external entity-capable parser, avoiding XXE but limiting semantic interpretation. PDF scanning can miss obfuscated/compressed active content. A clear report means “no supported indicator was found,” not “safe.”
