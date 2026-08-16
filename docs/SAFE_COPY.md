# Safe-copy guarantees and limits

## Invariants

For every supported safe-copy operation, ShareGlass:

1. treats the source bytes as immutable;
2. writes a separate output file;
3. rebuilds container checksums and indexes where applicable;
4. analyzes the new bytes from the beginning;
5. reports findings before and after;
6. compares a format-specific content fingerprint when one is available.

A matching fingerprint means that the normalized content selected for that fingerprint did not change. It does not mean that the two files are byte-identical or render identically in every application.

## Images

Image sanitizers preserve JPEG scan data, PNG image-data chunks, and WebP image/animation chunks while removing recognized metadata containers. The content fingerprint covers preserved image payloads.

Removing metadata can invalidate Content Credentials or another signature. ShareGlass blocks a suspected provenance-bearing image unless the caller explicitly confirms an unsigned derivative.

## Office Open XML

The writer rebuilds the ZIP package in deterministic stored-entry form. Supported actions include:

- clearing core and application properties;
- removing Word comment parts and markers;
- removing cached thumbnails;
- removing custom XML and custom properties;
- replacing external relationship targets with `https://shareglass.invalid/removed`;
- accepting tracked Word changes;
- removing Office package signature parts when explicitly authorized.

External link neutralization preserves visible link text but changes the target. Custom XML removal can break content bindings and enterprise workflows. Accepting revisions is a visible-document decision. These actions are opt-in and generate warnings.

The content fingerprint normalizes visible extracted document text and selected structural content. Open the output in the application that will be used by the recipient before sending it.

## PDF

ShareGlass v1 does not write PDFs. A correct implementation must account for xref tables/streams, incremental updates, object streams, encryption, forms, annotations, embedded files, page rendering, and signatures. Byte replacement is not a safe sanitizer.
