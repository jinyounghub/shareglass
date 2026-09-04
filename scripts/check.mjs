import { access, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SHAREGLASS_VERSION } from '../src/core/analyze.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const required = [
  'index.html', 'app.css', 'manifest.webmanifest', 'robots.txt', 'sitemap.xml', 'sw.js', 'README.md', 'ROADMAP.md', 'LICENSE',
  'PRIVACY.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'CITATION.cff', '.gitattributes',
  'assets/shareglass-mark.svg', 'assets/icon-192.png', 'assets/icon-512.png',
  'assets/social-card.png', 'assets/demo-report.png',
  'src/app.js', 'src/core/analyze.js', 'bin/shareglass.mjs',
  'samples/private-photo.png', 'samples/private-resume.docx', 'samples/risky-contract.pdf',
  'playwright.config.js', 'browser-tests/samples.spec.js',
  '.github/workflows/ci.yml', '.github/workflows/pages.yml', '.github/workflows/codeql.yml',
  '.github/workflows/release.yml', '.github/CODEOWNERS',
  'docs/README.ko.md', 'docs/THREAT_MODEL.md', 'docs/SAFE_COPY.md', 'docs/LAUNCH.md'
];
for (const path of required) await access(resolve(root, path));

async function walk(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '.git'].includes(entry.name)) result.push(...await walk(path));
    } else if (/\.(?:js|mjs)$/i.test(entry.name)) result.push(path);
  }
  return result;
}

const modules = await walk(root);
for (const file of modules) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) throw new Error(check.stderr || `Syntax check failed: ${file}`);
}

const html = await readFile(resolve(root, 'index.html'), 'utf8');
for (const id of ['file-input', 'drop-zone', 'report-view', 'create-safe-copy', 'share-canvas']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Missing required UI element #${id}`);
}
if (!html.includes("default-src 'self'")) throw new Error('The web app must retain a restrictive Content Security Policy.');
if (!html.includes('rel="canonical" href="https://jinyounghub.github.io/shareglass/"')) {
  throw new Error('The public web app must retain its canonical URL.');
}

const localHtmlReferences = [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((value) => !/^(?:https?:|#|data:|blob:|mailto:)/i.test(value));
for (const reference of new Set(localHtmlReferences)) {
  const path = reference.split(/[?#]/, 1)[0];
  if (path) await access(resolve(root, path));
}

const manifest = JSON.parse(await readFile(resolve(root, 'manifest.webmanifest'), 'utf8'));
if (manifest.short_name !== 'ShareGlass' || manifest.start_url !== './') {
  throw new Error('Unexpected PWA manifest identity or start URL.');
}
for (const icon of manifest.icons || []) await access(resolve(root, icon.src));

const serviceWorker = await readFile(resolve(root, 'sw.js'), 'utf8');
const cachedPaths = [...serviceWorker.matchAll(/['"](\.\/[A-Za-z0-9_./-]+)['"]/g)].map((match) => match[1]);
for (const cachedPath of new Set(cachedPaths)) await access(resolve(root, cachedPath.slice(2) || '.'));

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
if (packageJson.name !== '@jin0/shareglass') throw new Error('Unexpected npm package name.');
if (packageJson.version !== SHAREGLASS_VERSION) throw new Error('package.json and app version are out of sync.');
if (packageLock.name !== packageJson.name || packageLock.version !== packageJson.version) {
  throw new Error('package-lock.json is out of sync with package.json.');
}
if (packageJson.devDependencies?.['@playwright/test'] !== packageLock.packages?.['node_modules/@playwright/test']?.version) {
  throw new Error('The Playwright dependency and lockfile version are out of sync.');
}
if (packageJson.engines?.node !== '>=22') throw new Error('Supported Node.js engine declaration changed unexpectedly.');

const workflowText = (await Promise.all(
  (await readdir(resolve(root, '.github/workflows'))).filter((name) => name.endsWith('.yml'))
    .map((name) => readFile(resolve(root, '.github/workflows', name), 'utf8'))
)).join('\n');
for (const stale of ['actions/checkout@v4', 'actions/setup-node@v4', 'actions/upload-artifact@v4', 'github/codeql-action/init@v3']) {
  if (workflowText.includes(stale)) throw new Error(`Stale GitHub Action reference: ${stale}`);
}
if (workflowText.includes('\t')) throw new Error('Workflow YAML must not contain tab indentation.');

console.log(`Checked ${modules.length} JavaScript modules, ${required.length} required assets, ${new Set(cachedPaths).size} offline assets, and package/workflow integrity.`);
