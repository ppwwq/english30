import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { allowBeforeUnload, answerConfirmation } from './confirmation-helpers.mjs';

const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url);
const engines = require('playwright');
const engine = process.env.TEST_ENGINE || 'chromium';
const browser = await engines[engine].launch({
  ...(engine === 'chromium' && { executablePath: process.env.CHROMIUM_EXECUTABLE || undefined }),
});
const base = process.env.TEST_URL || 'http://127.0.0.1:4173';

try {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 820 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
  });
  allowBeforeUnload(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(base);
  await page.locator('a[data-view="reading-paper"]').click();
  const app = page.locator('#reading-paper-host');
  const article = app.locator('[data-kind="text"].reading-paper-document');
  const sheet = app.locator('[data-kind="question"].reading-paper-document');
  const sheetBox = sheet.locator('.reading-paper-page');
  const focus = sheet.locator('.reading-paper-focus');
  const submit = app.getByRole('button', { name: '交卷', exact: true });
  const compare = app.getByRole('button', { name: '对答案', exact: true });
  const windows = app.locator('.reading-paper-window');
  const articleWindow = app.locator('.reading-paper-window[data-window="text"]');
  const answerWindow = app.locator('.reading-paper-window[data-window="question"]');
  const referenceWindow = app.locator('.reading-paper-window[data-window="reference"]');
  const quitComparison = app.getByRole('button', { name: '结束对答案', exact: true });
  const textarea = sheet.locator('textarea');
  const firstQuestion = sheet.locator('[data-question]');
  const part = app.locator('[data-choice="part"]');
  await article.locator('img').waitFor();
  await sheet.locator('img').waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#reading-paper-host img')].every((img) => img.naturalWidth > 0),
  );
  assert.equal(new URL(page.url()).hash, '#reading-paper');
  assert.ok((await sheet.boundingBox()).x > (await article.boundingBox()).x);
  assert.equal(
    (await sheetBox.boundingBox()).y,
    (await article.locator('.reading-paper-page').boundingBox()).y,
  );
  assert.equal(await submit.isDisabled(), true);
  assert.equal(await compare.count(), 0);
  assert.equal(await windows.count(), 0);
  assert.equal(
    requests.some((url) => url.includes('p-9f8236cfe333')),
    false,
  );

  await article.getByRole('button', { name: '下一页' }).click();
  const articlePage = await article.locator('img').getAttribute('src');
  await sheet.getByRole('button', { name: '下一页' }).click();
  const paperPage = await sheet.locator('img').getAttribute('src');
  await page.setViewportSize({ width: 834, height: 1194 });
  assert.equal(await article.isVisible(), true);
  assert.equal(await sheet.isVisible(), false);
  await app.getByRole('button', { name: '题答卷', exact: true }).tap();
  assert.equal(await article.isVisible(), false);
  assert.equal(await sheet.locator('img').getAttribute('src'), paperPage);
  await sheet.getByRole('button', { name: '打字', exact: true }).tap();
  await textarea.fill('My first answer.');
  await firstQuestion.selectOption('2');
  await textarea.fill('My second answer.');
  await part.selectOption('B1');
  await answerConfirmation(page, '取消');
  assert.equal(await part.inputValue(), 'A');
  assert.equal(await textarea.inputValue(), 'My second answer.');
  await firstQuestion.selectOption('1');
  assert.equal(await textarea.inputValue(), 'My first answer.');
  await sheet.getByRole('button', { name: '手写', exact: true }).tap();
  await focus.tap();
  assert.equal(await app.getAttribute('data-focused'), 'true');
  const ink = sheet.locator('.paper-ink');
  const rect = await ink.boundingBox();
  const visible = await sheetBox.boundingBox();
  const x = rect.x + rect.width / 3;
  const y = visible.y + 35;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 35, y + 15, { steps: 5 });
  await page.mouse.up();
  await sheet.locator('.ink-stroke').first().waitFor();
  await focus.press('Escape');
  assert.equal(await app.getAttribute('data-focused'), 'false');
  assert.equal(await focus.evaluate((node) => node === document.activeElement), true);
  await page.reload();
  await sheet.locator('.ink-stroke').first().waitFor();
  assert.equal(await sheet.locator('img').getAttribute('src'), paperPage);
  assert.equal(await page.evaluate(() => localStorage.getItem('english30-study-v1')), null);
  await sheet.getByRole('button', { name: '打字', exact: true }).tap();
  assert.equal(await textarea.inputValue(), 'My first answer.');
  await submit.tap();
  await compare.waitFor().catch(async (error) => {
    throw Error(
      `${error.message}\n${await app.locator('.reading-paper-status').textContent()}\n${errors.join('\n')}`,
    );
  });
  await sheet.getByRole('button', { name: '卷面', exact: true }).tap();
  assert.equal(await page.evaluate(() => localStorage.getItem('english30-study-v1')), null);
  assert.equal(await sheet.locator('.submitted-ink .ink-stroke').count(), 1);
  await compare.tap();
  await referenceWindow.locator('img').waitFor();
  await page.waitForFunction(
    () => document.querySelector('.reading-paper-window[data-window="reference"] img')?.naturalWidth > 0,
  );
  for (const reviewWindow of [articleWindow, answerWindow, referenceWindow])
    assert.equal(await reviewWindow.isVisible(), true);
  assert.equal(await app.getByRole('dialog').count(), 0);
  assert.equal(await article.locator('img').getAttribute('src'), articlePage);
  assert.equal(await sheet.locator('img').getAttribute('src'), paperPage);
  assert.equal(await sheet.locator('.submitted-ink .ink-stroke').count(), 1);
  assert.match(await referenceWindow.locator('img').getAttribute('src'), /p-9f8236cfe333/);

  await page.setViewportSize({ width: 1180, height: 820 });
  const beforeMove = await articleWindow.boundingBox();
  await articleWindow.locator('[data-window-move]').press('ArrowRight');
  const movedByKey = await articleWindow.boundingBox();
  assert.ok(movedByKey.x > beforeMove.x, 'arrow keys move the focused window');
  await drag(articleWindow.locator('[data-window-move]'), 56, 0);
  const movedByMouse = await articleWindow.boundingBox();
  assert.ok(movedByMouse.x > movedByKey.x + 30, 'dragging the title moves the original text window');
  const resize = articleWindow.locator('[data-window-resize]');
  await resize.press('ArrowRight');
  const resizedByKey = await articleWindow.boundingBox();
  assert.ok(resizedByKey.width > movedByMouse.width, 'arrow keys resize the focused window');
  await drag(resize, 52, -42);
  const resizedByMouse = await articleWindow.boundingBox();
  assert.ok(resizedByMouse.width > resizedByKey.width + 25, 'dragging the corner widens the window');
  assert.ok(resizedByMouse.height < resizedByKey.height - 20, 'dragging the corner shortens the window');

  await articleWindow.locator('[data-window-close]').tap();
  await articleWindow.waitFor({ state: 'hidden' });
  assert.equal(await referenceWindow.isVisible(), true);
  await app.getByRole('button', { name: '显示阅读原文', exact: true }).tap();
  await articleWindow.waitFor();
  assert.equal(await article.locator('img').getAttribute('src'), articlePage);
  assert.equal((await articleWindow.boundingBox()).width, resizedByMouse.width);
  await answerWindow.locator('[data-window-close]').tap();
  await answerWindow.waitFor({ state: 'hidden' });
  await app.getByRole('button', { name: '显示题答卷', exact: true }).tap();
  await answerWindow.waitFor();
  assert.equal(await sheet.locator('.submitted-ink .ink-stroke').count(), 1);
  const referencePage = await referenceWindow.locator('img').getAttribute('src');
  await referenceWindow.locator('[data-window-close]').tap();
  await referenceWindow.waitFor({ state: 'hidden' });
  await app.getByRole('button', { name: '显示评分参考', exact: true }).tap();
  await referenceWindow.waitFor();
  assert.equal(await referenceWindow.locator('img').getAttribute('src'), referencePage);
  await app.getByRole('button', { name: '切到题答卷视窗', exact: true }).tap();
  assert.equal(
    await answerWindow.locator('[data-window-move]').evaluate((handle) => handle === document.activeElement),
    true,
  );
  assert.ok(
    Number(await answerWindow.evaluate((pane) => getComputedStyle(pane).zIndex)) >
      Number(await referenceWindow.evaluate((pane) => getComputedStyle(pane).zIndex)),
    'switching to an open window brings it to the front',
  );

  if (engine === 'chromium') {
    const touch = await page.context().newCDPSession(page);
    const handle = articleWindow.locator('[data-window-move]');
    await handle.scrollIntoViewIfNeeded();
    const grip = await handle.boundingBox();
    const point = { x: Math.round(grip.x + grip.width / 2), y: Math.round(grip.y + grip.height / 2) };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x - 32, y: point.y }],
    });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.ok((await articleWindow.boundingBox()).x < resizedByMouse.x - 20, 'touch can drag a window');
    const closeGrip = await articleWindow.locator('[data-window-close]').boundingBox();
    const closePoint = {
      x: Math.round(closeGrip.x + closeGrip.width / 2),
      y: Math.round(closeGrip.y + closeGrip.height / 2),
    };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [closePoint] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await articleWindow.waitFor({ state: 'hidden' });
    await touch.detach();
  }

  await quitComparison.click();
  assert.equal(await referenceWindow.isVisible(), false);
  assert.equal(await article.locator('img').getAttribute('src'), articlePage);
  assert.equal(await sheet.locator('img').getAttribute('src'), paperPage);
  assert.equal(await sheet.locator('.submitted-ink .ink-stroke').count(), 1);

  async function drag(handle, dx, dy) {
    await handle.scrollIntoViewIfNeeded();
    const { x, y, width, height } = await handle.boundingBox();
    await page.mouse.move(x + width / 2, y + height / 2);
    await page.mouse.down();
    await page.mouse.move(x + width / 2 + dx, y + height / 2 + dy, { steps: 6 });
    await page.mouse.up();
  }

  await app.locator('[data-check-question]').selectOption('1');
  await app.locator('[data-check-result]').selectOption('retry');
  await app.locator('[data-check-error]').selectOption('答案不完整');
  await page.locator('#session-save').click();
  await answerConfirmation(page, '确认保存');
  await page.waitForFunction(() => !!localStorage.getItem('english30-study-v1'));
  const [record] = await page.evaluate(() => JSON.parse(localStorage.getItem('english30-study-v1')).records);
  assert.equal(record.taskId, 'reading-paper:2025-exam:A');
  assert.equal(record.phase, 'first');
  assert.equal(record.assisted, false);
  assert.equal(record.correct, null);
  assert.deepEqual(record.answers, { 1: 'My first answer.', 2: 'My second answer.' });
  assert.equal(record.details.readingPaper.ink, undefined);
  assert.match(Object.values(record.details.readingPaper.inkFiles)[0], /^[0-9a-f]{64}$/);
  assert.deepEqual(record.details.readingPaper.checks, { 1: { status: 'retry', error: '答案不完整' } });
  await page.reload();
  await compare.waitFor();
  await page.setViewportSize({ width: 834, height: 1194 });
  await app.getByRole('button', { name: '题答卷', exact: true }).tap();
  await sheet.getByRole('button', { name: '打字答案', exact: true }).tap();
  assert.equal(await textarea.inputValue(), 'My first answer.');
  await page.locator('#session-review').click();
  const reviewItem = page
    .locator('.training-review-row')
    .filter({ hasText: '2025 Paper 1 · 正式卷 · Part A' });
  await reviewItem.getByRole('button', { name: '关提示再测' }).click();
  await app.getByText('无提示复测', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, '#reading-paper');
  assert.equal(await app.locator('.reading-paper-phase').textContent(), '无提示复测');
  assert.equal(await textarea.inputValue(), '');
  assert.equal(await sheet.locator('.ink-stroke').count(), 0);
  assert.equal(await compare.count(), 0);
  assert.equal(await windows.count(), 0);
  assert.equal(await submit.isDisabled(), true);
  await sheet.getByRole('button', { name: '打字', exact: true }).tap();
  await textarea.fill('Unsubmitted retest draft.');
  await page.locator('#session-review').click();
  await page.reload();
  await reviewItem.getByRole('button', { name: '关提示再测' }).click();
  await answerConfirmation(page, '取消');
  await reviewItem.waitFor();
  await page.locator('#home-back').click();
  await page.locator('a[data-view="reading-paper"]').click();
  await textarea.waitFor();
  assert.equal(await textarea.inputValue(), 'Unsubmitted retest draft.');
  await app.locator('[data-choice="year"]').selectOption('2022');
  await answerConfirmation(page, '切换试卷');
  await part.selectOption('B1');
  await app.getByRole('button', { name: '题答卷', exact: true }).tap();
  assert.match(await sheet.locator('img').getAttribute('src'), /p-956807ac5e5a\/0010\.webp$/);
  await sheet.locator('[data-page]').selectOption('3');
  assert.match(await sheet.locator('img').getAttribute('src'), /p-956807ac5e5a\/0014\.webp$/);
  assert.deepEqual(errors, []);
  console.log(
    `PASS ${engine}: Paper 1 landscape/portrait, draft reload, typed answers and ink, three-window comparison, explicit save, manual checks, concealed review routing, and 2022 clean pages.`,
  );
} finally {
  await browser.close();
}
