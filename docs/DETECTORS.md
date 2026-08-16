# Detector catalog and limitations

This document describes what ShareGlass v1 actually checks. It is intentionally narrower than a malware scanner or a full rendering engine.

## Images

### JPEG

Parses segment boundaries until Start of Scan and recognizes EXIF APP1, XMP APP1, IPTC/Photoshop APP13, COM, and C2PA/JUMBF indicators. EXIF data is parsed as TIFF IFD structures, including the GPS IFD.

Limitations: manufacturer-specific MakerNote structures are not recursively decoded; steganographic content and pixel-level identities are out of scope; ICC profiles are not considered private metadata.

### PNG

Parses every chunk with size and CRC validation. Reports `tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME`, XMP text and C2PA-related chunks/keywords.

Compressed text is decoded only within a bounded expansion budget; oversized values remain structural findings instead of being materialized in memory. Limitations: arbitrary private application chunks cannot be classified without a known identifier.

### WebP

Parses RIFF chunks and reports EXIF/XMP payloads, relevant VP8X feature flags, and provenance markers.

Limitations: animation frames and image payloads are not rendered or semantically analyzed.

## Office Open XML

The OOXML detector opens DOCX/XLSX/PPTX as OPC ZIP packages and examines:

- `docProps/core.xml`, `app.xml`, and `custom.xml`;
- package and part relationship files, including external URLs and local paths;
- Word comments, people, revisions, hidden runs, field codes and custom XML;
- Excel comments/threaded comments, hidden sheets and external links;
- PowerPoint comments, notes and hidden slides;
- embedded packages, OLE objects, ActiveX, VBA, digital signatures and cached thumbnails;
- zero-width and bidirectional control characters in XML text.

Limitations: ShareGlass does not execute macros, calculate spreadsheet formulas, render documents, inspect legacy binary Office formats, or infer whether visible business information is confidential.

## PDF

The v1 detector scans bounded PDF syntax for:

- Info dictionary values and XMP metadata;
- URI actions and URL-like strings;
- JavaScript, OpenAction, Additional Actions, Launch and SubmitForm indicators;
- EmbeddedFiles, FileSpec, RichMedia and attachments;
- AcroForm/XFA structures;
- Encrypt and signature dictionaries;
- multiple EOF/startxref markers suggesting incremental updates;
- C2PA/JUMBF indicators.

Limitations: this is structural detection rather than a full ISO 32000 parser. Obfuscated, encrypted, compressed object-stream, malformed, or dynamically constructed content can evade detection. ShareGlass does not render pages and does not claim to replace a PDF malware sandbox.

## Severity model

- **Critical:** executable/automatic active content or another immediately dangerous sharing condition.
- **High:** precise location, embedded files, exposed collaboration history, macros, signatures that block safe rewriting, or sensitive external dependencies.
- **Medium:** direct identity data, external links, custom/hidden content, interactive forms, or structural mismatches requiring review.
- **Low:** application fingerprints, timestamps, benign document descriptors, and lower-impact metadata.
- **Info:** unsupported or contextual structures that do not independently imply exposure.

The score is a capped summary. It is not a probability and should not be compared across unrelated security products.
