import { allowBeforeUnload, answerConfirmation } from './confirmation-helpers.mjs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const report = { cases: [], errors: [], physicalDevice: false };
try {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  allowBeforeUnload(page);
  await page.route('**/__reading-test.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#f6f3eb;font-family:Arial,sans-serif}</style><main id="module"></main></html>',
    }),
  );
  await page.goto((process.env.TEST_URL || 'http://127.0.0.1:4173') + '/__reading-test.html');
  await page.evaluate(async () => {
    const { mountReading } = await import('/reading.mjs');
    window.reader = mountReading({ host: document.querySelector('#module') });
  });
  await page.waitForSelector('[data-rd-answer="a-q1"]');
  assert.equal(await page.locator('.rd-feedback').count(), 0);
  assert.equal(await page.locator('.rd-bridge').count(), 0);
  await page.locator('[data-rd-answer="a-q1"][value="A"]').check();
  await page.locator('[data-rd-segment="a1s1"]').tap();
  assert.equal(await page.locator('[data-rd-segment="a1s1"]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-rd-answer="a-q3"][data-index="0"]').fill('split up');
  await page.locator('[data-rd-answer="a-q3"][data-index="1"]').fill('called it quits');
  await page.locator('[data-rd-action="select-question"][data-q="a-q3"]').tap();
  await page.locator('[data-rd-segment="a1s2"]').tap();
  await page.locator('[data-rd-segment="a1s3"]').tap();
  await page.locator('[data-rd-answer="a-q4"]').fill('life for normal citizens');
  await page.locator('[data-rd-answer="a-q5i"]').fill('we are interested in celebrities');
  await page.locator('[data-rd-answer="a-q7i"]').fill('goals');
  await page.locator('[data-rd-answer="a-q7iv"]').fill('humanises');
  await page.locator('[data-rd-action="submit"]').tap();
  assert.equal(await page.locator('.rd-feedback').count(), 6);
  assert.equal(await page.evaluate(() => localStorage.getItem('english30-study-v1')), null);
  assert.equal(await page.evaluate(() => window.reader.getRecords()[0].details.pending), 2);
  await page.locator('[data-rd-self="a-q4"]').selectOption('yes');
  await page.locator('[data-rd-self="a-q5i"]').selectOption('no');
  assert.equal(await page.evaluate(() => window.reader.getRecords()[0].correct), undefined);
  assert.deepEqual(await page.evaluate(() => window.reader.getRecords()[0].details.matching), {
    matched: 4,
    selfConfirmed: 1,
    pending: 0,
    needsPractice: 1,
  });
  await page.locator('[data-rd-action="save"]').tap();
  await answerConfirmation(page, '确认保存');
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem('english30-study-v1')).records.length),
    1,
  );
  report.cases.push(
    'Touch evidence selection, answer gate, pending self-check, explicit save/read-back passed.',
  );
  await page.locator('[data-rd-set]').selectOption('reading-2025-b1');
  assert.equal(await page.locator('.rd-feedback').count(), 0);
  assert.equal(await page.locator('[data-rd-answer="b-q22"]').count(), 4);
  await page.locator('[data-rd-answer="b-q23i"]').fill('Videos');
  await page.route('**/*.mp3', (route) => route.abort());
  await page.evaluate(() => window.reader.show('integrated'));
  await page.locator('[data-rd-action="audio-retry"]').waitFor();
  await page.unroute('**/*.mp3');
  await page.locator('[data-rd-action="audio-retry"]').click();
  await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  assert.equal(await page.locator('.rd-source-result').count(), 0);
  assert.equal(await page.locator('.rd-transcript').count(), 0);
  const audio = await page.locator('audio').evaluate((a) => ({ duration: a.duration, src: a.currentSrc }));
  assert.equal(new URL(audio.src).origin, new URL(page.url()).origin);
  assert.ok(Math.abs(audio.duration - 522) < 1);
  await page.locator('[data-rd-speed]').selectOption('1.25');
  await page.locator('[data-rd-loop]').check();
  await page.locator('audio').evaluate(async (a) => {
    a.currentTime = 120;
    await a.play();
  });
  await page.waitForTimeout(250);
  assert.ok(
    await page
      .locator('audio')
      .evaluate((a) => a.currentTime > 120 && a.currentTime < 123 && a.playbackRate === 1.25),
  );
  await page.locator('audio').evaluate((a) => {
    a.currentTime = a.duration - 0.15;
  });
  await page.waitForTimeout(700);
  assert.ok(await page.locator('audio').evaluate((a) => a.currentTime < 3 && !a.paused));
  await page.locator('audio').evaluate((a) => a.pause());
  await page.locator('[data-rd-integrated="notes"]').fill('13 October / Main Hall / discussion / questions');
  await page.locator('[data-rd-integrated="to"]').fill('Frank Brown');
  await page.locator('[data-rd-integrated="subject"]').fill('Invitation to our opening event');
  await page
    .locator('[data-rd-integrated="draft"]')
    .fill(
      'Dear Mr Brown, We would like to invite you to our Asian Games Week Opening Event. Please join us at school. Yours sincerely, Nico Lin',
    );
  await page.locator('[data-rd-source="date"][value="audio"]').check();
  await page.locator('[data-rd-action="integrated-submit"]').tap();
  assert.equal(await page.locator('.rd-source-result').count(), 7);
  assert.equal(await page.locator('.rd-transcript').count(), 1);
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem('english30-study-v1')).records.length),
    1,
  );
  await page.locator('.rd-language-review summary').click();
  await page.locator('[data-rd-language="reader"]').check();
  await page.locator('[data-rd-confirmed="guest"]').check();
  await page.locator('[data-rd-action="integrated-save"]').tap();
  await answerConfirmation(page, '确认保存');
  const record = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('english30-study-v1')).records.at(-1),
  );
  assert.equal(record.module, 'integrated');
  assert.equal(record.correct, undefined);
  assert.equal(record.details.checklist.reader, true);
  assert.equal(record.details.sourceChoices.date[0], 'audio');
  report.cases.push(
    'B1 full Blob audio loads, seeks, changes speed and loops; initial draft and source checklist save without invented scoring.',
  );
  await page
    .locator('[data-rd-integrated="draft"]')
    .fill('Dear Mr Brown, Here is my independently revised invitation. Yours sincerely, Nico Lin');
  await page.locator('[data-rd-action="integrated-submit"]').tap();
  const records = await page.evaluate(() => window.reader.getRecords());
  assert.equal(records.length, 3);
  assert.equal(records.at(-1).phase, 'review');
  assert.ok(records[1].answers.draft.includes('Asian Games Week'));
  await page.evaluate(() => window.reader.show('reading', { taskId: 'reading-2025-b1' }));
  assert.equal(await page.locator('[data-rd-answer="b-q23i"]').inputValue(), 'Videos');
  await page.evaluate(() => window.reader.show('reading', { taskId: 'reading-2025-a', kind: 'review' }));
  assert.equal(await page.locator('[data-rd-answer="a-q7iv"]').inputValue(), 'humanises');
  assert.equal(await page.locator('.rd-feedback').count(), 6);
  await page.evaluate(() => window.reader.show('reading', { taskId: 'reading-2025-a', kind: 'retest' }));
  assert.equal(await page.locator('[data-rd-answer="a-q7iv"]').inputValue(), '');
  assert.equal(await page.locator('.rd-feedback').count(), 0);
  await page.evaluate(() =>
    window.reader.show('integrated', { taskId: 'integrated-2025-b1-t6', kind: 'review' }),
  );
  assert.equal(await page.locator('.rd-source-result').count(), 7);
  assert.ok(
    (await page.locator('[data-rd-integrated="draft"]').inputValue()).includes('independently revised'),
  );
  await page.evaluate(() => window.reader.show('reading', { taskId: 'reading-2025-b1' }));
  await page.setViewportSize({ width: 768, height: 1024 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await fs.mkdir('tests/artifacts', { recursive: true });
  await page.screenshot({ path: 'tests/artifacts/reading-ipad-portrait.png', fullPage: true });
  report.cases.push(
    'Revised draft retains first attempt, navigation retains current work, review restores records, retest hides answers, portrait layout has no horizontal overflow.',
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await fs.mkdir('tests/artifacts', { recursive: true });
  await fs.writeFile('tests/artifacts/reading-browser-report.json', JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
