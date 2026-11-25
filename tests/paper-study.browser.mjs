import { answerConfirmation } from './confirmation-helpers.mjs';
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
const context = await browser.newContext({
  viewport: { width: 810, height: 1080 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const errors = [],
  cases = [];
page.on('pageerror', (e) => errors.push(e.message));
const base = process.env.TEST_URL || 'http://127.0.0.1:4173';
const ready = () =>
  page.waitForFunction(
    () => document.querySelector('#paper-play') && !document.querySelector('#paper-play').disabled,
  );
const records = () => page.evaluate(async () => (await import('/training-core.mjs')).studyStore.getState());
try {
  await page.goto(base + '/#library');
  await ready();
  await page.locator('#paper-drill summary').tap({ timeout: 3000 });
  await page.locator('#paper-drill-submit').tap();
  assert.match(await page.locator('#paper-drill-message').innerText(), /先听/);
  assert.equal(await page.locator('#paper-drill-feedback').isVisible(), false);
  await page.locator('#paper-drill-play').tap();
  await page.waitForFunction(() => !document.querySelector('#paper-audio').paused);
  await page.locator('#paper-drill-answer').fill("I don't know.");
  await page.locator('#paper-drill-submit').tap();
  assert.equal(await page.locator('#paper-drill-feedback').isVisible(), true);
  assert.equal(await page.locator('#paper-drill-answer').isDisabled(), true);
  const first = (await records()).records.at(-1);
  assert.equal(first.phase, 'first');
  assert.equal(first.assisted, false);
  assert.equal(first.correct, 0);
  assert.ok(first.details.paper.sentenceId);
  cases.push('hidden reference, play gate, immutable first response and word-level feedback');
  await page.locator('#paper-drill-error').selectOption('认识但听不出');
  await page.locator('#paper-drill-record-error').tap();
  assert.deepEqual((await records()).records.at(-1).errorTypes, ['认识但听不出']);
  await page.locator('#paper-drill-retest').tap();
  assert.equal(await page.locator('#paper-drill-feedback').isVisible(), false);
  assert.equal(await page.locator('#paper-drill-answer').inputValue(), '');
  await page.locator('#paper-drill-play').tap();
  await page.waitForFunction(() => !document.querySelector('#paper-audio').paused);
  await page.locator('#paper-drill-answer').fill(first.details.reference);
  await page.locator('#paper-drill-submit').tap();
  assert.equal((await records()).records.at(-1).phase, 'retest');
  assert.equal((await records()).records.at(-1).assisted, false);
  cases.push('error cause retained and concealed retest does not overwrite the first attempt');
  await page.locator('#paper-review').tap();
  await page.locator('.paper-word').nth(8).tap();
  await page.locator('#paper-word-mark').tap();
  assert.equal((await records()).paperMarks.length, 1);
  assert.equal(await page.evaluate(() => localStorage.getItem('english30-study-v1')), null);
  const save = page.getByRole('button', { name: '保存本次学习纪录', exact: true });
  const confirmSave = async (accept) => {
    await save.tap();
    const dialog = await answerConfirmation(page, accept ? '确认保存' : '取消');
    assert.match(dialog, /短句听写：2 条/);
    assert.match(dialog, /复习标记/);
  };
  await confirmSave(false);
  assert.equal(await page.evaluate(() => localStorage.getItem('english30-study-v1')), null);
  assert.equal(await save.isEnabled(), true);
  await confirmSave(true);
  await page.waitForFunction(() =>
    document.querySelector('#session-save-detail').textContent.includes('已完成回读验证'),
  );
  await page.reload();
  await ready();
  assert.equal((await records()).paperMarks.length, 1);
  assert.equal((await records()).records.length, 2);
  await page.getByRole('button', { name: '复习与备份', exact: true }).tap();
  await page.locator('.training-review-row').getByRole('button', { name: '关提示再测', exact: true }).tap();
  await ready();
  await page.locator('#paper-drill-answer').waitFor();
  assert.equal(await page.locator('#paper-drill-sentence').inputValue(), first.details.paper.sentenceId);
  assert.equal(await page.locator('#paper-drill-answer').inputValue(), '');
  assert.equal(await page.locator('#paper-transcript-panel').isVisible(), false);
  assert.equal(await page.locator('#paper-drill-feedback').isVisible(), false);
  cases.push(
    'marks and attempts persist only after explicit save; global review returns to hidden original sentence',
  );
  await page.locator('#paper-part').selectOption('B2');
  await ready();
  assert.equal(await page.locator('#paper-drill-play').isDisabled(), true);
  for (const width of [810, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  cases.push('A/B1 scope and tablet/phone layout');
  assert.deepEqual(errors, []);
} finally {
  await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
  await fs.writeFile(
    new URL('./artifacts/paper-study-browser.json', import.meta.url),
    JSON.stringify({ cases, errors, physicalDevice: false }, null, 2),
  );
  await browser.close();
}
console.log(JSON.stringify({ cases, errors }));
