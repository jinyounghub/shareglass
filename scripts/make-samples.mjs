import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateDocx, createPrivatePng, createRiskyPdf } from './sample-builders.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const samples = resolve(root, 'samples');
await mkdir(samples, { recursive: true });
await writeFile(resolve(samples, 'private-photo.png'), createPrivatePng());
await writeFile(resolve(samples, 'private-resume.docx'), createPrivateDocx());
await writeFile(resolve(samples, 'risky-contract.pdf'), createRiskyPdf());
console.log('Synthetic ShareGlass samples written.');
