# ShareGlass 1.0.0

ShareGlass shows what Office documents, PDFs, and images may reveal before they are shared. The browser app performs inspection locally, requires no account, and has no telemetry or upload endpoint.

## Included

- JPEG, PNG, and WebP metadata inspection and safe-copy generation
- DOCX, XLSX, and PPTX package inspection
- Verified Office safe copies for supported transformations
- PDF metadata, active-content, attachment, signature, and provenance inspection
- Optional Content Credentials validation with the official browser SDK
- JSON, Markdown, and share-card reports
- A zero-runtime-dependency Node.js CLI
- Synthetic fixtures, automated tests, PWA assets, CI, CodeQL, Pages, and release workflows

## Safety boundaries

- PDF rewriting is inspection-only in this release.
- Safe copies never overwrite the source file.
- Signed Office files and provenance-bearing images require explicit confirmation before an unsigned derivative is created.
- Findings are structural indicators, not proof that a file is harmless, anonymous, or malware-free.
