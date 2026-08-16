# ShareGlass launch checklist

This document keeps launch work reproducible and avoids publishing a repository that has code but no immediately visible product.

## Repository settings

- Repository: `jinyounghub/shareglass`
- Visibility: public
- Description: **See what your files reveal before you share them. Local-first privacy and provenance inspector for Office, PDF, and images.**
- Homepage: `https://jinyounghub.github.io/shareglass/`
- Topics: `privacy`, `metadata`, `exif`, `office`, `pdf`, `docx`, `c2pa`, `local-first`, `security`, `pwa`
- Enable issues and private vulnerability reporting.
- Use GitHub Actions as the Pages source.

`scripts/publish-github.sh` applies the repository metadata and Pages source after an authenticated GitHub CLI session is available.

## Before tagging v1.0.0

- [ ] `npm run samples`
- [ ] `npm run ci`
- [ ] Inspect the three synthetic fixtures with the CLI.
- [ ] Confirm that the source files contain no real personal or company data.
- [ ] Confirm that `assets/demo-report.png` reflects an actual fixture report.
- [ ] Confirm the Pages deployment from the `main` branch is green.
- [ ] Test drag-and-drop, safe-copy download, JSON/Markdown export, and offline reload in a normal browser.
- [ ] Confirm the README live-demo link and CI badge resolve.

## Release

```bash
git tag -a v1.0.0 -m "ShareGlass v1.0.0"
git push origin v1.0.0
```

The release workflow runs the full test/build pipeline and attaches both the npm tarball and complete source archive. Publishing to npm is intentionally gated behind the repository variable `PUBLISH_NPM=true`.

The first package version was published directly with 2FA after its release tarball was verified. Once the package existed, its npm Trusted Publisher was connected to `jinyounghub/shareglass` and `.github/workflows/release.yml`:

```bash
npm trust github @jin0/shareglass \
  --repo jinyounghub/shareglass \
  --file release.yml \
  --allow-publish \
  --yes
```

Future tagged releases publish through GitHub Actions OIDC. The workflow requests `id-token: write`, runs on GitHub-hosted `ubuntu-latest` with Node.js 24 and a current npm CLI, and does not use a long-lived npm publish token. Trusted Publishing adds provenance automatically. Set `PUBLISH_NPM=true` only after `npm trust list @jin0/shareglass --json` confirms the repository and workflow mapping.

## Announcement angle

Lead with a result, not architecture:

> I dropped a synthetic résumé into ShareGlass. It found the author, previous company, reviewer names, comments, tracked changes, a local template path, and an external link—without uploading the file.

Use the report image or a short drag-drop-to-result capture. Do not claim that ShareGlass proves a file is anonymous or malware-free.
