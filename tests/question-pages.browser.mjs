import { allowBeforeUnload, confirmIncompleteTask } from './confirmation-helpers.mjs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium, webkit } = require('playwright');
const browser = process.env.WEBKIT_EXECUTABLE
  ? await webkit.launch({ executablePath: process.env.WEBKIT_EXECUTABLE })
  : await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
try {
  const page = await browser.newPage({ viewport: { width: 903, height: 1198 } });
  allowBeforeUnload(page);
  page.setDefaultTimeout(7000);
  await page.goto((process.env.TEST_URL || 'http://localhost:4174') + '/#listening', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
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
  await confirmIncompleteTask(page);
  assert.deepEqual(await visible(), ['q6', 'q7', 'q8', 'q9', 'q10', 'q11', 'q12']);
  assert.equal(await page.locator('#answer-q12').inputValue(), 'second page');
  const tools = page.getByRole('group', { name: '原卷批改工具' });
  const canvas = page.getByLabel('原卷批注', { exact: true });
  assert.ok(await tools.isVisible());
  await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox();
  for (const [event, dx] of [
    ['pointerdown', 20],
    ['pointerup', 44],
  ]) {
    await canvas.dispatchEvent(event, {
      pointerId: 8,
      pointerType: 'pen',
      button: 0,
      clientX: bounds.x + dx,
      clientY: bounds.y + 60,
    });
  }
  assert.equal(await canvas.locator('.ink-stroke').getAttribute('fill'), '#a53540');
  await page.reload();
  await ready();
  assert.ok(await tools.isVisible());
  assert.equal(await canvas.locator('.ink-stroke').count(), 1);
  assert.equal(await page.locator('#answer-q12').inputValue(), 'second page');
  const captions = page.locator('.player-bottom #paper-float-transcript');
  for (const width of [903, 390]) {
    await page.setViewportSize({ width, height: 1198 });
    assert.ok(await captions.isVisible());
    const group = await tools.boundingBox();
    if (width === 903) {
      for (const name of ['钢笔', '铅笔', '荧光笔', '橡皮擦'])
        assert.ok(await tools.getByRole('button', { name, exact: true }).isVisible());
    }
    for (const button of await tools.getByRole('button').all()) {
      if (!(await button.isVisible())) continue;
      const r = await button.boundingBox();
      assert.ok(r.x >= group.x - 1 && r.x + r.width <= group.x + group.width + 1, 'toolbar fits the sheet');
    }
    await tools.getByRole('button', { name: /选择笔色/ }).click();
    await tools.getByRole('button', { name: '红色笔迹', exact: true }).click();
    if (process.env.REVIEW_SCREENSHOTS) {
      await page.locator('#practice-sources').evaluate((node) => node.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: process.env.REVIEW_SCREENSHOTS + '/inline-review-' + width + '.png' });
    }
  }
  await page.getByRole('button', { name: '看评分原页' }).click();
  assert.equal(await tools.isVisible(), false);
  await page.getByRole('button', { name: '返回题页' }).click();
  assert.equal(await canvas.locator('.ink-stroke').count(), 1);
  assert.equal((await visible())[0], 'q6');
  console.log('PASS 2024 A1 sheet and answer paging, drafts, non-question pages and marking review');
} finally {
  await browser.close();
}
