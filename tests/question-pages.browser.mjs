import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
try {
  const page = await browser.newPage({ viewport: { width: 1133, height: 1000 } });
  page.on('dialog', (dialog) => dialog.accept());
  page.setDefaultTimeout(7000);
  await page.goto((process.env.TEST_URL || 'http://localhost:4174') + '/#listening');
  await page.locator('#practice-year').selectOption('2024');
  const ready = () =>
    page.waitForFunction(
      () =>
        document.querySelector('#lesson-title').textContent.includes('2024') &&
        !document.querySelector('#play-pause').disabled,
    );
  await ready();
  const visible = () =>
    page
      .locator('#questions .question-card:visible')
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.questionId));
  assert.deepEqual(await visible(), ['q1', 'q2', 'q3', 'q4', 'q5']);
  await page.locator('#answer-q5').fill('first page');
  await page.getByRole('button', { name: '下一页', exact: true }).first().click();
  assert.deepEqual(await visible(), ['q6', 'q7', 'q8', 'q9', 'q10', 'q11', 'q12']);
  await page.locator('#answer-q12').fill('second page');
  await page.reload();
  await ready();
  assert.equal(await page.locator('#practice-page').inputValue(), '4');
  assert.equal(await page.locator('#answer-q12').inputValue(), 'second page');
  await page.getByRole('button', { name: '上一组题目', exact: true }).click();
  assert.equal(await page.locator('#practice-page').inputValue(), '3');
  assert.equal(await page.locator('#answer-q5').inputValue(), 'first page');
  await page.locator('#practice-page').fill('2');
  await page.locator('#practice-page').press('Enter');
  assert.deepEqual(await visible(), []);
  await page.getByRole('button', { name: '回到本 Task 题页' }).click();
  assert.equal(await page.locator('#practice-page').inputValue(), '3');
  await page.getByRole('button', { name: '下一组题目', exact: true }).click();
  await page.locator('#play-pause').click();
  await page.locator('#submit-answers').click();
  assert.deepEqual(await visible(), ['q6', 'q7', 'q8', 'q9', 'q10', 'q11', 'q12']);
  assert.equal(await page.locator('#answer-q12').inputValue(), 'second page');
  await page.getByRole('button', { name: '看评分原页' }).click();
  assert.equal((await visible())[0], 'q6');
  console.log('PASS 2024 A1 sheet and answer paging, drafts, non-question pages and marking review');
} finally {
  await browser.close();
}
