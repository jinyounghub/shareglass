# Security policy

## Supported version

Security fixes are applied to the latest release and the default branch.

## Reporting a vulnerability

Use GitHub's **Report a vulnerability** / private security advisory feature for this repository. Do not publish a proof of concept, crafted private document, or exploitable parser detail in a public issue before a fix is available.

Include:

- the affected ShareGlass version or commit;
- browser/Node.js version and operating system;
- the smallest synthetic reproducer possible;
- expected and observed behavior;
- whether the issue exposes data, corrupts output, bypasses a safety gate, or causes code execution/denial of service.

Never submit a real document containing another person's private information. Replace it with a synthetic fixture.

## Security boundaries

ShareGlass is a pre-sharing inspection tool, not an antivirus engine or execution sandbox. A report with no findings is not proof that a file is benign. See `docs/THREAT_MODEL.md` for supported protections and residual risks.
