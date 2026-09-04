import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(root, 'dist');
const frameDir = resolve(root, 'tmp', 'readme-demo');
const output = resolve(root, 'assets', 'privacy-reveal.gif');
const host = '127.0.0.1';
const port = Number(process.env.SHAREGLASS_DEMO_PORT || 4174);
const baseUrl = `http://${host}:${port}`;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function serveStatic() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', baseUrl);
      const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const filePath = resolve(dist, `.${pathname}`);
      if (filePath !== dist && !filePath.startsWith(`${dist}/`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const bytes = await readFile(filePath);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream'
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
}

function encodeGif(timelinePath) {
  const candidates = [
    { width: 1000, colors: 96, fps: 8 },
    { width: 960, colors: 80, fps: 7 },
    { width: 900, colors: 64, fps: 6 }
  ];
  for (const candidate of candidates) {
    const filter = [
      `[0:v]fps=${candidate.fps},scale=${candidate.width}:-2:flags=lanczos,split[frames][palette-input]`,
      `[palette-input]palettegen=max_colors=${candidate.colors}:stats_mode=diff[palette]`,
      '[frames][palette]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle'
    ].join(';');
    const result = spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', timelinePath,
      '-filter_complex', filter,
      '-loop', '0', output
    ], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'ffmpeg failed to encode the README demo.');
    const size = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require('fs').statSync(${JSON.stringify(output)}).size))`], { encoding: 'utf8' });
    if (Number(size.stdout) <= 4 * 1024 * 1024) return candidate;
  }
  throw new Error('The README demo remains larger than 4 MiB after the fallback encodes.');
}

await rm(frameDir, { recursive: true, force: true });
await mkdir(frameDir, { recursive: true });
await mkdir(resolve(root, 'assets'), { recursive: true });

const server = serveStatic();
await new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(port, host, resolveListen);
});

const frames = [];
const externalRequests = [];
const writeRequests = [];
let browser;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    serviceWorkers: 'block'
  });
  const page = await context.newPage();
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(baseUrl) && !/^(?:blob:|data:)/.test(url)) externalRequests.push(url);
    if (!['GET', 'HEAD'].includes(request.method())) writeRequests.push(`${request.method()} ${url}`);
  });
  page.on('pageerror', (error) => { throw error; });

  const capture = async (label, duration) => {
    await page.waitForTimeout(100);
    const filename = `${String(frames.length).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: resolve(frameDir, filename), animations: 'disabled' });
    frames.push({ filename, duration });
  };

  const addRecorderStyle = async () => {
    await page.addStyleTag({ content: `
      html { scroll-behavior: auto !important; }
      * { animation-duration: 0.001s !important; transition-duration: 0.001s !important; }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      #shareglass-demo-pointer {
        position: fixed; left: 0; top: 0; width: 22px; height: 22px;
        border: 3px solid #fff; border-radius: 50%; background: rgba(72, 204, 232, .34);
        box-shadow: 0 0 0 2px rgba(7, 17, 31, .75), 0 3px 12px rgba(0, 0, 0, .45);
        transform: translate(-80px, -80px); pointer-events: none; z-index: 2147483647;
      }
      #shareglass-demo-pointer[data-click="true"] { transform-origin: center; border-color: #73f0cc; background: rgba(115, 240, 204, .5); }
    ` });
    await page.evaluate(() => {
      const pointer = document.createElement('div');
      pointer.id = 'shareglass-demo-pointer';
      pointer.setAttribute('aria-hidden', 'true');
      document.body.append(pointer);
    });
  };

  const movePointer = async (locator, click = false) => {
    const box = await locator.boundingBox();
    if (!box) throw new Error('Could not position the demo pointer.');
    await locator.hover();
    await page.evaluate(({ x, y, clickState }) => {
      const pointer = document.querySelector('#shareglass-demo-pointer');
      pointer.dataset.click = String(clickState);
      pointer.style.transform = `translate(${Math.round(x - 11)}px, ${Math.round(y - 11)}px)`;
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2, clickState: click });
  };

  const hidePointer = async () => {
    await page.evaluate(() => {
      const pointer = document.querySelector('#shareglass-demo-pointer');
      pointer.dataset.click = 'false';
      pointer.style.transform = 'translate(-80px, -80px)';
    });
  };

  const alignTop = async (locator, offset = 16) => {
    await locator.evaluate((element, topOffset) => {
      window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - topOffset);
    }, offset);
    await page.waitForTimeout(80);
  };

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#drop-view').waitFor({ state: 'visible' });
  await addRecorderStyle();
  await alignTop(page.locator('.scanner-shell'));
  await hidePointer();
  await capture('local-home', 1.4);

  const sampleButton = page.locator('[data-sample="private-resume.docx"]');
  await movePointer(sampleButton);
  await capture('choose-synthetic-resume', 0.8);

  let delayedFixture = true;
  await page.route('**/samples/private-resume.docx', async (route) => {
    if (delayedFixture) {
      delayedFixture = false;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 450));
    }
    await route.continue();
  });
  await movePointer(sampleButton, true);
  await sampleButton.click();
  await page.locator('#loading-view').waitFor({ state: 'visible' });
  await capture('local-inspection', 0.6);

  await page.locator('#report-view').waitFor({ state: 'visible' });
  await page.locator('#file-name').waitFor({ state: 'visible' });
  if ((await page.locator('#file-name').innerText()) !== 'private-resume.docx') throw new Error('Unexpected demo filename.');
  if ((await page.locator('#risk-level').innerText()) !== 'Critical') throw new Error('Unexpected demo risk level.');
  await alignTop(page.locator('.scanner-shell'));
  await hidePointer();
  await capture('critical-report', 1.5);

  const mediumFilter = page.locator('[data-filter="medium"]');
  await movePointer(mediumFilter, true);
  await mediumFilter.click();
  await alignTop(page.locator('.findings-panel'), 20);
  await hidePointer();
  await page.getByRole('heading', { name: 'Document author' }).waitFor({ state: 'visible' });
  await capture('hidden-identity', 1.2);

  const highFilter = page.locator('[data-filter="high"]');
  await movePointer(highFilter, true);
  await highFilter.click();
  await alignTop(page.locator('.findings-panel'), 20);
  await hidePointer();
  await page.getByRole('heading', { name: 'Comments and reviewer identities' }).waitFor({ state: 'visible' });
  await capture('collaboration-history', 1.2);

  await alignTop(page.locator('#safe-copy-panel'), 18);
  await hidePointer();
  await capture('default-safe-copy-actions', 1.2);

  const safeButton = page.locator('#create-safe-copy');
  await safeButton.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 80));
  await movePointer(safeButton);
  await capture('verify-safe-copy', 0.7);

  await movePointer(safeButton, true);
  await page.evaluate(() => document.querySelector('#create-safe-copy').click());
  try {
    await page.waitForFunction(() => document.querySelector('#create-safe-copy')?.textContent.includes('Creating'), null, { timeout: 300 });
    await capture('rescan-in-progress', 0.4);
  } catch {
    // The in-browser rewrite can finish before a frame is captured; the verified result is authoritative.
  }

  await page.locator('#safe-result').waitFor({ state: 'visible' });
  const safeText = await page.locator('#safe-result').innerText();
  if (!/19\s*→\s*5 actionable findings/.test(safeText)) throw new Error(`Unexpected safe-copy summary: ${safeText}`);
  if (!/content fingerprint is unchanged/i.test(safeText)) throw new Error('The safe-copy result did not confirm the unchanged content fingerprint.');
  await alignTop(page.locator('#safe-result'), 90);
  await hidePointer();
  await capture('verified-improvement', 2.0);

  await page.locator('#new-file').click();
  await page.locator('#drop-view').waitFor({ state: 'visible' });
  await alignTop(page.locator('.scanner-shell'));
  await hidePointer();
  await capture('clean-loop', 1.3);

  if (externalRequests.length) throw new Error(`Demo made external requests: ${[...new Set(externalRequests)].join(', ')}`);
  if (writeRequests.length) throw new Error(`Demo made write requests: ${[...new Set(writeRequests)].join(', ')}`);

  const timeline = ['ffconcat version 1.0'];
  for (const frame of frames) {
    timeline.push(`file '${frame.filename}'`, `duration ${frame.duration.toFixed(2)}`);
  }
  timeline.push(`file '${frames.at(-1).filename}'`);
  const timelinePath = resolve(frameDir, 'timeline.ffconcat');
  await writeFile(timelinePath, `${timeline.join('\n')}\n`);

  const encoding = encodeGif(timelinePath);
  const outputStat = await stat(output);
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: 'samples/private-resume.docx',
    durationSeconds: frames.reduce((total, frame) => total + frame.duration, 0),
    frames: frames.length,
    outputBytes: outputStat.size,
    encoding
  };
  await writeFile(resolve(frameDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest, null, 2));
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
