# Contributing

Contributions that make one detector more accurate, add a safe synthetic fixture, improve an explanation, or tighten a parser bound are especially useful. See [ROADMAP.md](ROADMAP.md) and the open issues for scoped contribution ideas.

## Before opening a pull request

1. Discuss large UI, schema, dependency, or format changes in an issue.
2. Do not commit real private files. Build a minimal synthetic fixture under `samples/` or generate it in `scripts/sample-builders.mjs`.
3. Keep the core free of runtime dependencies unless the security and maintenance trade-off is compelling and discussed first.
4. Add a regression test for every detector or sanitizer change.
5. Run `npm run ci`.

## Finding requirements

A new finding should have:

- a stable category and severity;
- a concise title;
- plain-language description;
- bounded, minimally revealing evidence;
- the precise container/part path;
- a clean-action ID only when a verified sanitizer exists.

## Sanitizer requirements

A sanitizer must never overwrite the source. It must produce a structurally readable output, be re-scanned by ShareGlass, document destructive behavior, and include a content-fingerprint or equivalent regression check where practical.

## Pull request scope

Prefer small pull requests. Include what changed, why the current behavior was insufficient, how the fixture reproduces it, and the exact validation commands used.
