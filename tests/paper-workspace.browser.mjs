import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
try {
  const page = await browser.newPage({ viewport: { width: 820, height: 1100 }, hasTouch: true });
  page.setDefaultTimeout(8000);
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto((process.env.TEST_URL || 'http://localhost:4174') + '/#listening');
  const ready = () => page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  await ready();
  assert.equal(await page.getByRole('button', { name: 'DSE 选段' }).count(), 0);
  assert.equal(await page.locator('.transcript-panel.is-floating').count(), 0);
  assert.equal(await page.locator('input[type=file]').count(), 0, 'study site offers bundled DSE materials');
  await page.locator('#practice-task').selectOption('2');
  await ready();
  await page.locator('.question-input').first().fill('my unfinished response');
  await page.reload();
  await ready();
  assert.equal(await page.locator('#practice-task').inputValue(), '2');
  assert.equal(await page.locator('.question-input').first().inputValue(), 'my unfinished response');
  assert.equal(await page.evaluate(() => localStorage.getItem('english30-records-v1')), null);
  await page.locator('#practice-task').selectOption('1');
  await ready();
  const paper = page.locator('#practice-image');
  const box = (selector) => page.locator(selector).first().boundingBox();
  assert.ok((await paper.boundingBox()).x < (await box('.question-input')).x, '820px paper on the left');
  await page.getByRole('button', { name: '手写作答', exact: true }).click();
  const sheet = page.locator('.practice-page-wrap');
  assert.ok((await sheet.boundingBox()).y < 300, 'switching to ink brings the sheet into the viewport');
  const ink = page.locator('.paper-ink');
  await ink.scrollIntoViewIfNeeded();
  const bounds = await ink.boundingBox();
  assert.ok(bounds.width > 700);
  await ink.dispatchEvent('pointerdown', {
    pointerId: 1,
    pointerType: 'pen',
    clientX: bounds.x + 60,
    clientY: bounds.y + 40,
    button: 0,
  });
  await ink.dispatchEvent('pointerup', {
    pointerId: 1,
    pointerType: 'pen',
    clientX: bounds.x + 80,
    clientY: bounds.y + 48,
    button: 0,
  });
  assert.equal(await ink.locator('.ink-stroke').count(), 1);
  await page.reload();
  await ready();
  assert.equal(await ink.locator('.ink-stroke').count(), 1, 'ink draft survives refresh');
  await page.getByRole('button', { name: '下一页', exact: true }).first().click();
  assert.equal(await ink.locator('.ink-stroke').count(), 0);
  await page.getByRole('button', { name: '上一页', exact: true }).first().click();
  assert.equal(await ink.locator('.ink-stroke').count(), 1);
  await page.locator('#play-pause').click();
  await page.locator('#submit-answers').click();
  assert.ok(
    (await box('.reference-answer')).x < (await paper.boundingBox()).x,
    'handwriting review answers on left',
  );
  const first = page.locator('#questions .question-card').first();
  assert.ok(await first.locator('.evidence-link').first().isVisible());
  await first.locator('.evidence-link').first().click();
  const panel = page.locator('.transcript-panel.is-floating');
  await panel.waitFor({ state: 'visible' });
  assert.ok((await panel.locator('.sentence').count()) > 5);
  await panel.locator('.is-playing').first().waitFor();
  const transcript = panel.locator('#transcript');
  assert.ok(
    await transcript.evaluate((node) => node.scrollTop > 0),
    'evidence follows the recording inside the window',
  );
  const id = await panel.locator('.sentence.is-current .word').first().getAttribute('data-word-id');
  const word = panel.locator(`.word[data-word-id="${id}"]`);
  const label = await word.innerText();
  await word.click();
  assert.equal(await panel.locator('#word-text').textContent(), label);
  await panel.locator('#mark-unknown').click();
  assert.equal(await word.getAttribute('class').then((value) => value.includes('is-unknown')), true);
  await panel.locator('#dismiss-word').click();
  await transcript.hover();
  await page.mouse.wheel(0, 220);
  await page.waitForFunction(
    () => document.querySelector('#follow-toggle').getAttribute('aria-pressed') === 'false',
  );
  await panel.locator('#follow-toggle').click();
  assert.equal(await panel.locator('#follow-toggle').getAttribute('aria-pressed'), 'true');
  const handle = panel.locator('.caption-grip');
  async function drag(node, dx, dy) {
    const rect = await node.boundingBox();
    const x = rect.x + rect.width / 2,
      y = rect.y + rect.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 5 });
    await page.mouse.up();
  }
  const before = await panel.boundingBox();
  await drag(handle, 135, -85);
  const after = await panel.boundingBox();
  assert.ok(after.x - before.x > 100 && before.y - after.y > 70, 'subtitle window moves across the viewport');
  await drag(panel.locator('.caption-resize'), 70, 45);
  const resized = await panel.boundingBox();
  assert.ok(resized.width - after.width > 55 && resized.height - after.height > 35);
  await panel.getByRole('button', { name: '最大化字幕' }).click();
  assert.ok((await panel.boundingBox()).width > 780);
  await panel.getByRole('button', { name: '还原大小' }).click();
  assert.ok(Math.abs((await panel.boundingBox()).width - resized.width) < 1);
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await panel.boundingBox();
  assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 390);
  const touch = await page.context().newCDPSession(page);
  const corner = await panel.locator('.caption-resize').boundingBox();
  const point = { x: corner.x + 20, y: corner.y + 20 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await touch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: point.x - 74, y: point.y - 42 }],
  });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const shrunk = await panel.boundingBox();
  assert.ok(shrunk.width < narrow.width - 50 && shrunk.height < narrow.height - 30);
  await page.setViewportSize({ width: 820, height: 1100 });
  await panel.getByRole('button', { name: '收起浮窗' }).click();
  assert.equal(await panel.count(), 0);
  await page.getByRole('button', { name: '浮动字幕', exact: true }).click();
  await panel.waitFor();
  await page.getByRole('button', { name: '展开原卷', exact: true }).click();
  assert.ok(await page.locator('dialog[open] .transcript-panel.is-floating #transcript').isVisible());
  await page.getByRole('button', { name: '返回核对', exact: true }).click();
  await panel.waitFor();
  await panel.getByRole('button', { name: '收起浮窗' }).click();
  assert.equal(await first.locator('.reference-source').first().isVisible(), false);
  assert.ok((await paper.boundingBox()).width > (await box('.answer-column')).width);
  assert.ok(
    await first.locator('.reference-answer').evaluate((n) => parseFloat(getComputedStyle(n).fontSize) >= 18),
  );
  assert.equal(await ink.locator('.ink-stroke').count(), 1);
  console.log('PASS tablet columns, original-page ink, page changes and handwritten review');
  await page.locator('#session-save').click();
  await page.waitForFunction(() =>
    document.querySelector('#session-save-status').textContent.includes('已保存'),
  );
  await page.locator('#phase-retest').click();
  assert.equal(await panel.count(), 0);
  assert.equal(await ink.locator('.ink-stroke').count(), 0);
  assert.equal(await page.locator('.reference-answer').count(), 0);
  await page.reload();
  await ready();
  assert.equal(await page.locator('body').getAttribute('data-listening-phase'), 'retest');
  assert.equal(await ink.locator('.ink-stroke').count(), 0);
  await page.getByRole('button', { name: '收起书写区' }).click();
  await page.locator('.review-drawer > summary').click();
  await page.getByRole('button', { name: '恢复这份纪录，继续复盘' }).click();
  assert.equal(await ink.locator('.ink-stroke').count(), 1);
  console.log('PASS explicit save, concealed retest and original stroke restoration');
} finally {
  await browser.close();
}
