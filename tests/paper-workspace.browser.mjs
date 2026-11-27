import { allowBeforeUnload, answerConfirmation, confirmIncompleteTask } from './confirmation-helpers.mjs';
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
  allowBeforeUnload(page);
  await page.goto((process.env.TEST_URL || 'http://localhost:4174') + '/#listening');
  const ready = () => page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  async function skipTo(target) {
    await page.locator('.skip-link').focus();
    await page.keyboard.press('Enter');
    assert.equal(await target.evaluate((node) => node === document.activeElement), true);
  }
  await ready();
  const questions = page.locator('#questions');
  await skipTo(questions);
  assert.equal(await questions.getAttribute('tabindex'), '0');
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .locator('.question-input')
      .first()
      .evaluate((node) => node === document.activeElement),
    true,
  );
  assert.equal(await page.getByRole('button', { name: 'DSE 选段' }).count(), 0);
  assert.equal(await page.locator('.transcript-panel.is-floating').count(), 0);
  const captions = page.locator('#paper-float-transcript');
  assert.equal(await captions.isVisible(), false);
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
  await answerConfirmation(page, '切换材料');
  await ready();
  const paper = page.locator('#practice-image');
  const box = (selector) => page.locator(selector).first().boundingBox();
  assert.ok((await paper.boundingBox()).x < (await box('.question-input')).x, '820px paper on the left');
  await page.getByRole('button', { name: '手写作答', exact: true }).click();
  const sheet = page.locator('.practice-page-wrap');
  assert.ok((await sheet.boundingBox()).y < 300, 'switching to ink brings the sheet into the viewport');
  await skipTo(sheet);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '全屏书写', exact: true }).waitFor();
  await skipTo(sheet);
  await page.getByRole('button', { name: '全屏书写', exact: true }).click();
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

  const focusToggle = page.locator('.paper-focus-toggle');
  const position = () => sheet.evaluate((node) => node.scrollTop / node.firstElementChild.offsetHeight);
  const zoom = () => sheet.locator('.paper-page-stage').evaluate((node) => node.style.width);
  const sourcePage = page.locator('#practice-page');
  const audio = page.locator('#audio');
  await page.setViewportSize({ width: 1337, height: 1013 });
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => !document.querySelector('#audio').paused);
  await sheet.evaluate((node) => (node.scrollTop = 160));
  const previous = { position: await position(), zoom: await zoom(), page: await sourcePage.inputValue() };

  async function assertOrdinaryLayout() {
    const [paperBox, actions, player] = await Promise.all([
      sheet.boundingBox(),
      box('.question-actions'),
      box('.player'),
    ]);
    assert.ok(paperBox.height > 100, 'ordinary handwriting leaves room to view the paper');
    assert.ok(paperBox.y + paperBox.height <= actions.y + 1);
    assert.ok(actions.y + actions.height <= player.y + 1, 'actions stay above the player');
    assert.equal(await ink.locator('.ink-stroke').count(), 1);
    assert.equal(await sourcePage.inputValue(), previous.page);
    assert.equal(await zoom(), previous.zoom);
    assert.equal(await audio.evaluate((node) => node.paused), false);
  }

  await focusToggle.click();
  assert.ok(await focusToggle.evaluate((node) => node === document.activeElement));
  await assertOrdinaryLayout();
  assert.ok(
    Math.abs((await position()) - previous.position) < 0.005,
    'the same paper position stays visible',
  );
  const upper = page.getByRole('separator', { name: '调整手写原卷上沿' });
  const titleSpace = page.locator('#paper-title-space');
  const controlsSpace = page.locator('#paper-controls-space');
  const normalHeight = (await sheet.boundingBox()).height;
  const headingHeight = (await titleSpace.boundingBox()).height;
  const upperBounds = await upper.boundingBox();
  const upperPoint = { x: upperBounds.x + upperBounds.width / 2, y: upperBounds.y + upperBounds.height / 2 };
  await page.mouse.move(upperPoint.x, upperPoint.y);
  await page.mouse.down();
  await page.mouse.move(upperPoint.x, upperPoint.y - 1);
  await page.mouse.up();
  assert.equal(await titleSpace.getAttribute('data-compressed'), '');
  assert.equal(
    await titleSpace.getAttribute('inert'),
    null,
    'a one-pixel drag leaves the title controls active',
  );
  assert.equal(await controlsSpace.getAttribute('inert'), null);
  await upper.press('Home');
  await page.mouse.move(upperPoint.x, upperPoint.y);
  await page.mouse.down();
  await page.mouse.move(upperPoint.x, upperPoint.y - 24, { steps: 4 });
  await page.mouse.up();
  assert.ok((await titleSpace.boundingBox()).height < headingHeight);
  assert.equal(await controlsSpace.getAttribute('data-compressed'), null, 'the title gives up space first');
  assert.ok((await sheet.boundingBox()).height > normalHeight + 20);
  await upper.press('End');
  assert.equal(await titleSpace.getAttribute('inert'), '');
  assert.equal(await controlsSpace.getAttribute('inert'), '');
  await assertOrdinaryLayout();
  const raisedBounds = await upper.boundingBox();
  const raisedPoint = {
    x: raisedBounds.x + raisedBounds.width / 2,
    y: raisedBounds.y + raisedBounds.height / 2,
  };
  const resizeTouch = await page.context().newCDPSession(page);
  await resizeTouch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [raisedPoint] });
  await resizeTouch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...raisedPoint, y: raisedPoint.y + 24 }],
  });
  await resizeTouch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await resizeTouch.detach();
  assert.ok((await controlsSpace.boundingBox()).height >= 22, 'touch drag restores space in reverse order');
  assert.equal(await titleSpace.getAttribute('inert'), '');
  await upper.press('Home');
  assert.equal(await titleSpace.getAttribute('inert'), null);
  assert.equal(await controlsSpace.getAttribute('inert'), null);
  assert.equal((await sheet.boundingBox()).height, normalHeight);
  assert.ok(Math.abs((await position()) - previous.position) < 0.005);

  await page.setViewportSize({ width: 1180, height: 820 });
  await focusToggle.click();
  await sheet.focus();
  await page.keyboard.press('Control+a');
  assert.ok(await page.evaluate(() => window.getSelection().isCollapsed));
  for (const type of ['selectstart', 'contextmenu']) {
    assert.equal(
      await ink.evaluate(
        (node, type) => node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })),
        type,
      ),
      false,
    );
    assert.equal(
      await page
        .locator('#lesson-title')
        .evaluate(
          (node, type) => node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })),
          type,
        ),
      true,
    );
  }
  assert.equal(await paper.evaluate((node) => node.draggable), false);
  const handTouch = await page.context().newCDPSession(page);
  const touchTarget = await sheet.boundingBox();
  const touchPoint = { x: touchTarget.x + touchTarget.width / 2, y: touchTarget.y + 60 };
  await handTouch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
  await page.waitForTimeout(650);
  await handTouch.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...touchPoint, y: 30 }],
  });
  await handTouch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await handTouch.detach();
  assert.ok(await page.evaluate(() => window.getSelection().isCollapsed));
  await page.keyboard.press('Escape');
  assert.equal(await focusToggle.getAttribute('aria-expanded'), 'false');
  assert.ok(await focusToggle.evaluate((node) => node === document.activeElement));
  await assertOrdinaryLayout();
  await page.locator('#play-pause').click();
  await page.setViewportSize({ width: 820, height: 1100 });
  await focusToggle.click();

  await page.reload();
  await ready();
  assert.equal(await ink.locator('.ink-stroke').count(), 1, 'ink draft survives refresh');
  await page.getByRole('button', { name: '下一页', exact: true }).first().click();
  assert.equal(await ink.locator('.ink-stroke').count(), 0);
  await page.getByRole('button', { name: '上一页', exact: true }).first().click();
  assert.equal(await ink.locator('.ink-stroke').count(), 1);
  await page.locator('#play-pause').click();
  await page.locator('#submit-answers').click();
  await confirmIncompleteTask(page);
  assert.ok(
    (await box('.reference-answer')).x < (await paper.boundingBox()).x,
    'handwriting review answers on left',
  );
  const reviewPaper = await box('#review-paper-panel');
  const reviewAnswers = await box('.question-panel');
  assert.ok(Math.abs(reviewAnswers.y - reviewPaper.y) < 1);
  assert.ok(Math.abs(reviewAnswers.y + reviewAnswers.height - reviewPaper.y - reviewPaper.height) < 1);
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
  await page.waitForFunction(() => {
    const r = document.querySelector('.transcript-panel.is-floating').getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth;
  });
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
  assert.equal(await captions.textContent(), '打开字幕');
  assert.ok(await captions.evaluate((node) => node === document.activeElement));
  await captions.click();
  await panel.waitFor();
  assert.equal(await captions.getAttribute('aria-expanded'), 'true');
  await captions.click();
  assert.equal(await page.getByRole('button', { name: '展开原卷', exact: true }).count(), 0);
  assert.equal(await first.locator('.reference-source').first().isVisible(), false);
  assert.ok((await paper.boundingBox()).width > (await box('.answer-column')).width);
  assert.ok(
    await first.locator('.reference-answer').evaluate((n) => parseFloat(getComputedStyle(n).fontSize) >= 18),
  );
  assert.equal(await ink.locator('.ink-stroke').count(), 1);
  const toolbar = page.getByRole('group', { name: '原卷批改工具' });
  const drawCorrection = async () => {
    await ink.scrollIntoViewIfNeeded();
    const pos = await ink.boundingBox();
    for (const [event, dx] of [
      ['pointerdown', 12],
      ['pointerup', 38],
    ]) {
      await ink.dispatchEvent(event, {
        pointerId: 7,
        pointerType: 'pen',
        button: 0,
        clientX: pos.x + dx,
        clientY: pos.y + 30,
      });
    }
  };
  await drawCorrection();
  assert.equal(await ink.locator('.ink-stroke').count(), 2);
  await toolbar.getByRole('button', { name: '撤销', exact: true }).click();
  assert.equal(await ink.locator('.submitted-ink .ink-stroke').count(), 1);
  assert.equal(await ink.locator('.ink-stroke').count(), 1);
  await toolbar.getByRole('button', { name: '重做', exact: true }).click();
  await page.getByRole('button', { name: '下一页', exact: true }).first().click();
  assert.equal(await ink.locator('.ink-stroke').count(), 0);
  await page.getByRole('button', { name: '上一页', exact: true }).first().click();
  assert.equal(await ink.locator('.ink-stroke').count(), 2);
  console.log('PASS tablet columns, original-page ink, page changes and handwritten review');
  await page.locator('#session-save').click();
  await answerConfirmation(page, '确认保存');
  await page.waitForFunction(() =>
    document.querySelector('#session-save-status').textContent.includes('已保存'),
  );
  await page.locator('#phase-retest').click();
  assert.equal(await panel.count(), 0);
  assert.equal(await captions.isVisible(), false);
  assert.equal(await ink.locator('.ink-stroke').count(), 0);
  assert.equal(await page.locator('.reference-answer').count(), 0);
  await page.reload();
  await ready();
  assert.equal(await page.locator('body').getAttribute('data-listening-phase'), 'retest');
  assert.equal(await ink.locator('.ink-stroke').count(), 0);
  const lower = page.getByRole('separator', { name: '调整手写原卷下沿' });
  assert.equal(await lower.count(), 0, 'the lower grip is hidden in full-screen writing');
  await page.getByRole('button', { name: '退出全屏' }).click();
  const beforeResize = (await sheet.boundingBox()).height;
  await lower.scrollIntoViewIfNeeded();
  await drag(lower, 0, -70);
  const smaller = (await sheet.boundingBox()).height;
  assert.ok(smaller < beforeResize - 55, 'dragging the lower edge up shortens the sheet');
  await lower.scrollIntoViewIfNeeded();
  await drag(lower, 0, 50);
  const taller = (await sheet.boundingBox()).height;
  assert.ok(taller > smaller + 35, 'dragging the lower edge down extends the sheet');
  await lower.press('ArrowDown');
  assert.ok((await sheet.boundingBox()).height > taller + 12, 'keyboard resizing changes the same edge');
  assert.equal(await ink.locator('.ink-stroke').count(), 0);
  console.log('PASS handwriting frame upper and lower edges resize in both directions');
  await page.locator('#loop-more > summary').click();
  await page.locator('#open-review-marks').click();
  await page.getByRole('button', { name: '恢复这份纪录，继续复盘' }).click();
  assert.equal(await ink.locator('.ink-stroke').count(), 2);
  assert.equal(await ink.locator('.submitted-ink .ink-stroke').count(), 1);
  console.log('PASS explicit save, concealed retest and original stroke restoration');
} finally {
  await browser.close();
}
