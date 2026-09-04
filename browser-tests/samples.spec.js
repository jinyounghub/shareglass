import { expect, test } from '@playwright/test';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const samples = [
  {
    name: 'private-resume.docx',
    type: 'Word document',
    risk: 'Critical',
    findings: [
      'Document author',
      'Comments and reviewer identities',
      'Tracked revisions',
      'External document template'
    ]
  },
  {
    name: 'private-photo.png',
    type: 'PNG image',
    risk: 'High',
    findings: ['Exact GPS coordinates', 'Artist']
  },
  {
    name: 'risky-contract.pdf',
    type: 'PDF document',
    risk: 'Critical',
    findings: ['Embedded JavaScript', 'Embedded files or rich media', 'External links']
  }
];

function watchForUploads(page) {
  const unsafeRequests = [];
  page.on('request', (request) => {
    if (!READ_ONLY_METHODS.has(request.method())) {
      unsafeRequests.push(`${request.method()} ${request.url()}`);
    }
  });
  return unsafeRequests;
}

function summaryValue(page, label) {
  return page.locator('#summary-strip .summary-item', { hasText: label }).locator('strong');
}

for (const sample of samples) {
  test(`one-click demo inspects ${sample.name} without uploading it`, async ({ page }) => {
    const unsafeRequests = watchForUploads(page);
    const sampleResponse = page.waitForResponse((response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname.endsWith(`/samples/${sample.name}`)
    );

    await page.goto(`/?sample=${encodeURIComponent(sample.name)}`);
    await expect(page.locator('#report-view')).toBeVisible();
    await expect(page.locator('#file-name')).toHaveText(sample.name);
    await expect(page.locator('#file-type-label')).toHaveText(sample.type);
    await expect(page.locator('#risk-level')).toHaveText(sample.risk);
    await expect(summaryValue(page, 'Actionable')).not.toHaveText('0');

    for (const title of sample.findings) {
      await expect(page.locator('#findings-list h4', { hasText: title })).toBeVisible();
    }

    expect((await sampleResponse).ok()).toBe(true);
    expect(unsafeRequests).toEqual([]);
  });
}

test('DOCX safe-copy flow creates a separate file and re-scans it', async ({ page }) => {
  const unsafeRequests = watchForUploads(page);
  await page.goto('/?sample=private-resume.docx');
  await expect(page.locator('#report-view')).toBeVisible();

  const before = Number(await summaryValue(page, 'Actionable').innerText());
  expect(before).toBeGreaterThan(0);
  await expect(page.locator('#safe-actions input:checked')).not.toHaveCount(0);

  await page.locator('#create-safe-copy').click();
  const result = page.locator('#safe-result');
  await expect(result).toBeVisible();
  await expect(result.locator('strong')).toHaveText('Safer copy created and scanned again');
  await expect(result.locator('a[download]')).toHaveAttribute('download', 'private-resume.safe.docx');

  const verification = await result.locator('p').first().innerText();
  const counts = verification.match(/^(\d+)\s*→\s*(\d+) actionable findings\./);
  expect(counts, verification).not.toBeNull();
  expect(Number(counts[1])).toBe(before);
  expect(Number(counts[2])).toBeLessThan(before);
  expect(verification).toContain('The content fingerprint is unchanged.');
  expect(unsafeRequests).toEqual([]);
});
