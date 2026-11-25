import { allowBeforeUnload, confirmIncompleteTask } from './confirmation-helpers.mjs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
allowBeforeUnload(page);
try {
  await page.goto(`${process.env.TEST_URL || 'http://127.0.0.1:4175'}/#listening`);
  await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  await page.locator('#practice-part').selectOption('B1');
  await page.locator('#practice-task').selectOption('5');
  await page.waitForFunction(
    () =>
      document.querySelector('#lesson-title').textContent.includes('Task 5') &&
      !document.querySelector('#play-pause').disabled,
  );
  assert.equal(await page.locator('.scoring-point').count(), 0);
  await page.getByRole('button', { name: '手写作答', exact: true }).click();
  const header = page.locator('.paper-writing-header');
  for (const width of [390, 680, 820]) {
    await page.setViewportSize({ width, height: 1080 });
    const labels = header.locator('.paper-control-label:visible');
    const expected = width === 390 ? ['退出全屏'] : ['Data File', '回到原题', '打字', '手写', '退出全屏'];
    assert.deepEqual(await labels.allTextContents(), expected);
    if (width >= 680) {
      const tops = await header
        .locator('button:visible, select, input:visible')
        .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
      assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, 'paper controls fit one row');
    }
  }
  await page.getByRole('button', { name: '打字作答', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.question-input').fill('my own answer');
  await page.locator('#play-pause').click();
  await page.locator('#submit-answers').click();
  await confirmIncompleteTask(page);
  assert.equal(await page.locator('#original-responses textarea').inputValue(), 'my own answer');
  assert.equal(await page.locator('.scoring-point').count(), 13);
  assert.match(await page.locator('[data-point-id="5.1"]').innerText(), /one games, one Asia/);
  assert.match(await page.locator('[data-point-id="5.1"]').innerText(), /原音/);
  assert.match(await page.locator('[data-point-id="5.4"] a').getAttribute('href'), /p-0f9d7f187a64\/0005/);
  await page.locator('#phase-retest').click();
  assert.equal(
    await page.locator('.scoring-point,.scoring-rubric,.reference-answer,.evidence-link,.word').count(),
    0,
  );
  console.log('PASS B1 direct content points, DF navigation, original response and concealed retest');
} finally {
  await browser.close();
}
