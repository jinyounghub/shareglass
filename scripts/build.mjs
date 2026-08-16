import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

for (const path of ['index.html', 'app.css', 'manifest.webmanifest', 'sw.js', 'assets', 'src', 'samples']) {
  await cp(resolve(root, path), resolve(dist, path), { recursive: true });
}

const indexPath = resolve(dist, 'index.html');
const html = await readFile(indexPath, 'utf8');
await writeFile(indexPath, html.replace('</head>', '  <meta name="shareglass-build" content="1.0.0">\n</head>'));
console.log(`Built static app at ${dist}`);
