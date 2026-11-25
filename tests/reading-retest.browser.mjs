import { allowBeforeUnload, answerConfirmation } from './confirmation-helpers.mjs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
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
const reportPath =
  process.argv.find((arg) => arg.startsWith('--report='))?.slice(9) ||
  fileURLToPath(new URL('./artifacts/reading-retest-browser.json', import.meta.url));
try {
  const context = await browser.newContext({ viewport: { width: 1080, height: 810 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  allowBeforeUnload(page);
  const url = new URL(process.env.TEST_URL || 'http://127.0.0.1:4173/');
  url.hash = 'integrated';
  await page.goto(url.href);
  await page.locator('#rd-draft').waitFor();
  assert.equal(await page.locator('.rd-phase').textContent(), '有支架练习');
  const firstDraft = 'Dear students, please come to our meeting next Friday. Thank you.';
  await page.locator('#rd-draft').fill(firstDraft);
  await page.locator('#home-back').click();
  await page.locator('#home-avatar').click();
  await page.locator('#session-save-status').filter({ hasText: '当前输入尚未提交' }).waitFor();
  assert.equal(await page.locator('#session-save').isDisabled(), true);
  await page.goBack();
  await page.goBack();
  await page.locator('#rd-draft').waitFor();
  assert.equal(await page.locator('#rd-draft').inputValue(), firstDraft);
  await page.locator('[data-rd-action=integrated-submit]').click();
  assert.equal(
    await page.locator('[data-rd-action="integrated-save"], [data-rd-action="open-review"]').count(),
    0,
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('english30-study-v1')), null);
  await page.locator('#home-back').click();
  await page.locator('#home-avatar').click();
  await page.locator('#session-save-status').filter({ hasText: '已提交，尚未保存' }).waitFor();
  const save = page.locator('#session-save');
  await save.click();
  await answerConfirmation(page, '确认保存');
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('english30-study-v1'))?.records.length === 1,
  );
  const firstRecords = await page.evaluate(
    () => JSON.parse(localStorage.getItem('english30-study-v1')).records,
  );
  assert.equal(firstRecords.length, 1);
  assert.equal(firstRecords[0].phase, 'first');
  const firstId = firstRecords[0].id;
  await page.locator('#session-save-status').filter({ hasText: '已保存到此浏览器' }).waitFor();
  assert.equal(await save.isDisabled(), true);
  await page.goto(url.href);
  await page.reload();
  await page.locator('#rd-draft').waitFor();
  assert.equal(await page.locator('#rd-draft').inputValue(), '');
  assert.equal(await page.locator('.rd-phase').textContent(), '关提示同题复测');
  await page.locator('#rd-draft').fill('Dear students, I invite you to our school event next Friday.');
  await page.locator('[data-rd-action=integrated-submit]').click();
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem('english30-study-v1')).records.length),
    1,
  );
  await save.click();
  await answerConfirmation(page, '确认保存');
  await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('english30-study-v1'))?.records.length === 2,
  );
  const records = await page.evaluate(() => JSON.parse(localStorage.getItem('english30-study-v1')).records);
  assert.equal(records.length, 2);
  assert.equal(records[0].id, firstId);
  assert.equal(records[0].phase, 'first');
  assert.equal(records[0].answers.draft, firstDraft);
  assert.equal(records[1].phase, 'retest');
  report.cases.push('saved B1 first attempt survives reload and the next independent attempt is a retest');
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
