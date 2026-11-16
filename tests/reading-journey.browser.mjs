import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const report = { cases: [], errors: [], physicalDevice: false };
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
const cases = process.argv.find((arg) => arg.startsWith('--case='))?.slice(7);
try {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  // Serve the actual module and its assets in an isolated browser without a shared local server.
  await page.route('http://reading.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html lang="zh-Hans"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#E8EFF6;font-family:system-ui}</style><main id="module"></main></html>',
      });
    const file = path.resolve(webRoot, '.' + decodeURIComponent(pathname));
    if (!file.startsWith(webRoot)) return route.fulfill({ status: 403, body: '' });
    try {
      const mime = {
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.mp3': 'audio/mpeg',
        '.webp': 'image/webp',
      };
      await route.fulfill({
        contentType: mime[path.extname(file)] || 'application/octet-stream',
        body: await fs.readFile(file),
      });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  });
  await page.goto('http://reading.test/');
  await page.evaluate(async () => {
    const { mountReading } = await import('/reading.mjs');
    window.reader = mountReading({
      host: document.querySelector('#module'),
      bridge: {
        navigate: (view) => {
          window.lastNavigation = view;
        },
      },
    });
  });
  await page.locator('[data-rd-answer="a-q7iv"]').waitFor();
  if (!cases || cases === 'evidence') {
    await page.locator('[data-rd-answer="a-q7iv"]').fill('my first answer');
    await page.locator('[data-rd-action="select-question"][data-q="a-q7iv"]').click();
    const current = page.locator('[data-rd-evidence-context]');
    await current.waitFor();
    assert.match(await current.innerText(), /7\(iv\)/);
    assert.match(await current.innerText(), /Seeing that celebrities have similar experiences/);
    assert.equal(
      await page.locator('.is-reference').count(),
      0,
      'choosing evidence must not reveal the answer',
    );
    await page.locator('[data-rd-segment="a3s3"]').click();
    const position = await current.boundingBox();
    assert.ok(
      position.y >= 0 && position.y + position.height < 1180,
      'current question stays visible while choosing evidence',
    );
    await page.screenshot({ path: 'tests/artifacts/reading-evidence-context.png' });
    await page.getByRole('button', { name: '返回本题', exact: true }).click();
    assert.equal(await page.locator('[data-rd-answer="a-q7iv"]').inputValue(), 'my first answer');
    assert.equal(
      await page.locator('[data-rd-answer="a-q7iv"]').evaluate((el) => document.activeElement === el),
      true,
    );
    report.cases.push(
      'Evidence selection keeps the current prompt visible and returns to its unchanged answer without revealing reference evidence.',
    );
  }
  if (!cases || cases === 'save') {
    await page.evaluate(() => window.reader.show('reading', { taskId: 'reading-2025-a', kind: 'retest' }));
    await page.locator('[data-rd-answer="a-q1"][value="A"]').check();
    await page.locator('[data-rd-answer="a-q4"]').fill('life for normal citizens');
    await page.locator('[data-rd-action="submit"]').click();
    await page.locator('[data-rd-self="a-q4"]').selectOption('yes');
    const summary = page.locator('[data-rd-result-summary]');
    await summary.waitFor();
    assert.match(await summary.innerText(), /参考匹配\s*1/);
    assert.match(await summary.innerText(), /自核正确\s*1/);
    assert.match(await summary.innerText(), /待自核\s*0/);
    assert.equal(await page.evaluate(() => window.reader.getRecords().at(-1).correct), undefined);
    await page.locator('[data-rd-paraphrase]').fill('这段复述还没有提交。');
    assert.equal(await page.evaluate(() => window.reader.getSaveState().hasUnsubmittedChanges), true);
    await page.locator('[data-rd-action="save"]').click();
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('english30-study-v1')).records.at(-1).details.paraphrase,
      ),
      '',
      'saving must not include an unsubmitted paraphrase',
    );
    await page.locator('[data-rd-action="submit-paraphrase"]').click();
    await page.locator('[data-rd-action="save"]').click();
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem('english30-study-v1')).records.at(-1).details.paraphrase,
      ),
      '这段复述还没有提交。',
    );
    await page.locator('[data-rd-action="open-review"]').click();
    assert.equal(await page.evaluate(() => window.lastNavigation), 'review');
    await page.locator('[data-rd-action="open-library"]').click();
    assert.equal(await page.evaluate(() => window.lastNavigation), 'library');
    assert.match(await page.locator('.rd-submit-block').innerText(), /同题复测只检验当场修正/);
    await page.evaluate(() => window.reader.show('integrated'));
    await page.locator('#rd-draft').fill('Dear students, please join our school event next Friday.');
    await page.locator('[data-rd-action="integrated-submit"]').click();
    await page.locator('#rd-draft').fill('This revision has not been submitted yet.');
    assert.equal(await page.evaluate(() => window.reader.getSaveState().hasUnsubmittedChanges), true);
    await page.locator('[data-rd-action="integrated-save"]').click();
    const records = await page.evaluate(() => JSON.parse(localStorage.getItem('english30-study-v1')).records);
    assert.equal(
      records.filter((r) => r.module === 'integrated').length,
      1,
      'saving must not submit the edited draft implicitly',
    );
    assert.match(records.at(-1).answers.draft, /Dear students/);
    assert.equal(await page.locator('#rd-draft').inputValue(), 'This revision has not been submitted yet.');
    assert.match(await page.locator('.rd-notice').innerText(), /未提交/);
    report.cases.push(
      'Reading keeps reference matches separate from self-checks; saving B1 preserves submitted work without silently submitting revisions.',
    );
  }
  if (!cases || cases === 'integrated') {
    await page.evaluate(() =>
      window.reader.show('integrated', { taskId: 'integrated-2025-b1-t6', kind: 'retest' }),
    );
    assert.equal(
      await page.locator('[data-rd-source]').count(),
      0,
      'concealed retest must not pre-label the information categories',
    );
    assert.equal(await page.locator('.rd-source-result').count(), 0);
    await page
      .locator('#rd-draft')
      .fill('Dear Mr Brown, please join our school event next Friday. Yours sincerely, Nico Lin');
    await page.locator('[data-rd-action="integrated-submit"]').click();
    assert.equal(await page.locator('[data-rd-source-card]:visible').count(), 1);
    await page.locator('[data-rd-source-step]').selectOption('date');
    assert.equal(
      await page.locator('[data-rd-source-card]:visible').getAttribute('data-rd-source-card'),
      'date',
    );
    await page
      .locator('[data-rd-source-card="date"] [data-rd-action="source-link"][data-source="audio"]')
      .click();
    assert.equal(await page.locator('[data-rd-action="back-to-check"]').isVisible(), true);
    await page.locator('[data-rd-action="back-to-check"]').click();
    await page.locator('[data-rd-source-card="date"] [data-rd-action="edit-draft"]').click();
    assert.equal(await page.locator('#rd-draft').evaluate((el) => document.activeElement === el), true);
    await page
      .locator('#rd-draft')
      .fill('Dear Mr Brown, please join our school event on 13 October. Yours sincerely, Nico Lin');
    await page.locator('[data-rd-action="back-to-check"]').click();
    assert.match(await page.locator('[data-rd-source-card="date"] .rd-own-draft').innerText(), /13 October/);
    await page.locator('[data-rd-confirmed="date"]').check();
    await page.locator('[data-rd-action="source-next"]').click();
    assert.equal(
      await page.locator('[data-rd-source-card]:visible').getAttribute('data-rd-source-card'),
      'time',
    );
    await page.screenshot({ path: 'tests/artifacts/b1-item-review.png' });
    await page.locator('[data-rd-action="integrated-reset"]').first().click();
    assert.equal(await page.locator('.rd-source-result').count(), 0);
    assert.equal(await page.locator('#rd-draft').inputValue(), '');
    report.cases.push(
      'B1 reviews one information item at a time, links sources and own draft, and hides diagnostic scaffolds on retest.',
    );
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
  await fs.writeFile(
    new URL('./artifacts/reading-journey.json', import.meta.url),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
