# ShareGlass roadmap

ShareGlass is intentionally narrow: inspect what a file exposes, explain the evidence, create supported safer copies, and verify the result locally. Issues are the canonical place for accepted work; this document describes direction rather than dates or promises.

## Near-term priorities

- Add browser smoke tests for the three one-click synthetic demos and safe-copy flow.
- Expand image inspection to AVIF and HEIC without sending files to a service.
- Add OpenDocument package inspection for ODT, ODS, and ODP.
- Vendor or self-host the optional C2PA WebAssembly assets for fully offline provenance validation.
- Improve accessible keyboard navigation and screen-reader announcements for large reports.
- Research a render-preserving PDF rewrite pipeline before enabling any PDF sanitization.

## Good first contributions

- Improve a finding title or plain-language explanation.
- Add a minimal synthetic fixture for an already supported metadata field.
- Add a regression test for a malformed container or parser boundary.
- Document a format limitation with a reproducible, non-private example.
- Add translations while keeping the English detector IDs and technical evidence stable.

## Non-goals

- Uploading user files to a hosted analysis service.
- Opaque AI-generated risk scores without inspectable evidence.
- Claiming that a clean report proves anonymity, harmlessness, or malware absence.
- Rewriting PDFs through unverified byte replacement.
- Overwriting source files.

Before starting a large format, sanitizer, UI, or dependency change, open an issue and read [CONTRIBUTING.md](CONTRIBUTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
