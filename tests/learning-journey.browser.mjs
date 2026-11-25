import { allowBeforeUnload, answerConfirmation, confirmIncompleteTask } from './confirmation-helpers.mjs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage({ viewport: { width: 820, height: 1180 }, hasTouch: true });
const base = process.env.TEST_URL || 'http://127.0.0.1:4173';
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
allowBeforeUnload(page);
try {
  await page.goto(base + '/#listening');
  await page.locator('#session-save').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#session-review').isVisible(), true);
  assert.equal(await page.locator('#session-save').isDisabled(), true);
  await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  await page.locator('#answer-q1').fill('100');
  assert.equal(await page.evaluate(() => localStorage.getItem('english30-records-v1')), null);
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => !document.querySelector('#audio').paused);
  await page.locator('#submit-answers').click();
  await confirmIncompleteTask(page);
  await page.locator('[data-question-id="q1"] .question-review-tools > summary').click();
  await page.locator('[data-question-id="q1"] [data-practice-drill]').click();
  await page.locator('#focused-drill-dialog').waitFor();
  assert.equal(await page.locator('#original-responses').isVisible(), true);
  assert.equal(await page.locator('#focused-drill-dialog').evaluate((n) => n.tagName), 'SECTION');
  assert.equal(await page.locator('#focus-paper-drill-pause').isVisible(), true);
  assert.equal(await page.locator('#focus-paper-drill-reference').textContent(), '');
  const playbackConfirmed = page.getByText('听完后写下你听到的内容，再提交对照。', { exact: true });
  await page.locator('#focus-paper-drill-play').click();
  await playbackConfirmed.waitFor();
  await page.locator('#focus-paper-drill-pause').click();
  assert.equal(await page.locator('#audio').evaluate((a) => a.paused), true);
  await page.locator('#focus-paper-drill-play').click();
  await playbackConfirmed.waitFor();
  await page.locator('#focus-paper-drill-answer').fill('About 7000.');
  await page.locator('#focus-paper-drill-submit').click();
  await page.locator('#focus-paper-drill-feedback').waitFor();
  assert.ok((await page.locator('#focus-paper-drill-reference').textContent()).length > 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('english30-study-v1')), null);
  await page.locator('#focus-paper-drill-retest').click();
  assert.equal(await page.locator('#focus-paper-drill-feedback').isVisible(), false);
  assert.equal(await page.locator('#focus-paper-drill-answer').inputValue(), '');
  await page.locator('#focus-paper-drill-blank').click();
  assert.ok(
    (await page.locator('#focus-paper-drill-reference').textContent()).length > 0,
    'explicit reveal works before playing',
  );
  await page.locator('#focus-paper-drill-next').click();
  assert.equal(await page.getByRole('button', { name: '保存本次学习纪录', exact: true }).count(), 1);
  assert.equal(await page.locator('#focused-drill-question').textContent(), 'Q2');
  await page.locator('#focused-drill-return').click();
  assert.equal(await page.locator('#answer-q1').inputValue(), '100');
  await page.locator('#session-save').click();
  const summary = await answerConfirmation(page, '确认保存');
  await page.waitForFunction(
    () => localStorage.getItem('english30-study-v1') && localStorage.getItem('english30-records-v1'),
  );
  assert.match(summary, /听力：/);
  assert.match(summary, /短句听写：/);
  assert.equal(await page.getByRole('dialog').count(), 0);
  const data = await page.evaluate(() => ({
    study: JSON.parse(localStorage.getItem('english30-study-v1')),
    listening: JSON.parse(localStorage.getItem('english30-records-v1')),
  }));
  assert.equal(data.study.records.at(-1).module, 'dictation');
  assert.equal(data.study.records.at(-1).assisted, true);
  assert.equal(data.listening.at(-1).attempts[0].results.q1.answer, '100');
  assert.match(await page.locator('#session-save-status').textContent(), /已保存/);
  await page.locator('#phase-retest').click();
  assert.equal(await page.locator('#transcript .word').count(), 0);
  assert.equal(await page.locator('[data-practice-drill]').count(), 0);
  assert.equal(await page.locator('#practice-part').inputValue(), 'A');
  await page.getByRole('button', { name: 'B1 综合训练 · 2025 Task 6' }).click();
  await page.locator('[data-rd-action="integrated-submit"]').waitFor();
  assert.equal(await page.locator('body').getAttribute('data-view'), 'integrated');
  assert.equal(await page.locator('#home-back').isVisible(), true);
  await page.locator('#session-review').click();
  await page.waitForFunction(() => document.body.dataset.view === 'review');
  assert.deepEqual(errors, []);
  await fs.mkdir('tests/artifacts', { recursive: true });
  await page.screenshot({ path: 'tests/artifacts/learning-journey-review.png', fullPage: true });
  console.log('PASS unified save, evidence-to-drill return, concealed retest, direct B1, global review');
} finally {
  await browser.close();
}
