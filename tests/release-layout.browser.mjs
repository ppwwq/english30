import { allowBeforeUnload, confirmIncompleteTask } from './confirmation-helpers.mjs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium, webkit } = require('playwright');
const engine = process.env.TEST_ENGINE === 'webkit' ? webkit : chromium;
const browser = await engine.launch({
  headless: true,
  executablePath: engine === chromium ? process.env.CHROMIUM_EXECUTABLE : undefined,
  ignoreDefaultArgs: engine === chromium ? ['--hide-scrollbars'] : undefined,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
allowBeforeUnload(page);
const sheet = page.locator('.practice-page-wrap');
const questions = page.locator('#questions');
const studyGrid = page.locator('.study-grid');

async function dragScrollbar(pane) {
  const gutter = await pane.evaluate((node) => {
    node.scrollTop = 0;
    const width = node.offsetWidth - node.clientWidth;
    const trackHeight = node.clientHeight - 2 * width;
    return { width, thumbTop: width + (trackHeight * node.clientHeight) / node.scrollHeight / 2 };
  });
  assert.ok(gutter.width >= 10, 'the answer pane shows a scrollbar wide enough to grab');
  const { x, y, width } = await pane.boundingBox();
  await page.mouse.move(x + width - gutter.width / 2, y + gutter.thumbTop);
  await page.mouse.down();
  await page.mouse.move(x + width - gutter.width / 2, y + gutter.thumbTop + 45, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction((node) => node.scrollTop > 0, await pane.elementHandle(), {
    timeout: 3000,
  });
}

async function assertIndependentScroll(pane, other, input) {
  const page = pane.page();
  await pane.scrollIntoViewIfNeeded();
  const geometry = await pane.evaluate((node) => ({
    name: node.id || node.className,
    visible: node.clientHeight,
    content: node.scrollHeight,
    extent: node.scrollHeight - node.clientHeight,
  }));
  assert.ok(geometry.extent > 0, `no content to scroll in ${JSON.stringify(geometry)}`);
  if (input === 'keyboard') {
    assert.equal(await pane.evaluate((node) => node.tabIndex), 0, 'scroll pane is in the tab order');
    await pane.focus();
  }
  await pane.evaluate((node) => {
    node.scrollTop = 0;
  });
  const originalOtherScroll = await other.evaluate((node) => node.scrollTop);
  const originalPageScroll = await page.evaluate(() => scrollY);
  if (input === 'keyboard') {
    await page.keyboard.press('PageDown');
  } else {
    const { x, y, width, height } = await pane.boundingBox();
    const player = await page.locator('.player').boundingBox();
    const point = { x: x + width / 2, y: Math.min(y + height / 2, player.y - 8) };
    assert.ok(
      await pane.evaluate((node, p) => node.contains(document.elementFromPoint(p.x, p.y)), point),
      `${geometry.name} is under the scroll pointer`,
    );
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel(0, 165);
  }
  await page
    .waitForFunction((node) => node.scrollTop > 0, await pane.elementHandle(), { timeout: 3000 })
    .catch((cause) => {
      throw new Error(`${input} did not scroll ${geometry.name}`, { cause });
    });
  await pane.evaluate(
    (node) =>
      new Promise((resolve) => {
        let previous = node.scrollTop;
        let stableFrames = 0;
        function frame() {
          const current = node.scrollTop;
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames < 4) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      }),
  );
  assert.equal(
    await other.evaluate((node) => node.scrollTop),
    originalOtherScroll,
    `${geometry.name} scrolling leaves the other pane in place`,
  );
  assert.equal(await page.evaluate(() => scrollY), originalPageScroll, 'page does not scroll');
}

try {
  await page.goto(process.env.TEST_URL || 'http://127.0.0.1:4174');
  await page.locator('#home-panel').waitFor();
  assert.deepEqual(
    await page.locator('.home-resources').evaluate((node) => {
      const css = getComputedStyle(node);
      return [css.borderTopWidth, css.borderBottomWidth];
    }),
    ['0px', '0px'],
  );
  await page.locator('.main-navigation [data-view=listening]').click();
  await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  await page.locator('#practice-image').evaluate((img) => img.decode());
  const header = await page.locator('.transcript-panel > .panel-header').boundingBox();
  const modes = await page.locator('#paper-mode-slot button').last().boundingBox();
  assert.ok(header.x + header.width - modes.x - modes.width < 32);
  assert.ok(modes.y >= header.y && modes.y + modes.height <= header.y + header.height);
  for (const width of [390, 810, 1129, 1246, 1600]) {
    await page.setViewportSize({ width, height: 1198 });
    const paper = await page.locator('.transcript-panel').boundingBox();
    const answers = await page.locator('.question-panel').boundingBox();
    if (width < 760) {
      assert.ok(answers.y + answers.height <= paper.y, 'phone stacks answers above the paper');
    } else {
      assert.ok(paper.x + paper.width <= answers.x);
      assert.equal(answers.y, paper.y, 'top edges align');
      assert.equal(answers.y + answers.height, paper.y + paper.height, 'bottom edges align');
    }
    if (width === 1246) {
      const cards = page.locator('#questions > .question-card:visible');
      assert.equal(await cards.count(), 4);
      const gaps = [];
      let lastInputBottom;
      for (const card of await cards.all()) {
        const label = await card.locator('label').boundingBox();
        const input = await card.locator('.question-input').boundingBox();
        if (lastInputBottom !== undefined) gaps.push(label.y - lastInputBottom);
        assert.ok(input.y - (label.y + label.height) < 16, 'each prompt stays with its input');
        lastInputBottom = input.y + input.height;
      }
      const footer = await page.locator('.question-actions:visible').boundingBox();
      const tail = footer.y - lastInputBottom;
      assert.ok(
        Math.min(...gaps) > 40,
        `spare height goes between the four answer groups: ${gaps.join(', ')}`,
      );
      assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 2, 'spacing is balanced across prompts');
      assert.ok(tail > 0 && tail < Math.min(...gaps), 'no large empty area after Q4');
      console.log('Q1–Q4 gaps / space below Q4 (px)', gaps.map(Math.round), Math.round(tail));
    }
  }
  for (const [width, height] of [
    [1024, 768],
    [1194, 834],
    [1366, 1024],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(
      (height) => parseFloat(document.documentElement.style.getPropertyValue('--visible-height')) === height,
      height,
    );
    if (height <= 900)
      await studyGrid.evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const paper = await page.locator('.transcript-panel').boundingBox();
    const answers = await page.locator('.question-panel').boundingBox();
    const player = await page.locator('.player').boundingBox();
    assert.ok(
      Math.abs(answers.y - paper.y) < 1,
      `top edges align at ${width}×${height}: ${JSON.stringify({ paper, answers })}`,
    );
    assert.ok(
      Math.abs(answers.y + answers.height - paper.y - paper.height) < 1,
      `bottom edges align at ${width}×${height}`,
    );
    assert.ok(
      answers.height > 300 && answers.y + answers.height <= player.y,
      `both panes clear the player at ${width}×${height}: ${JSON.stringify({ answers, player })}`,
    );
    const visiblePaper = await sheet.evaluate((node) => node.clientHeight);
    const visibleQuestions = await questions.evaluate((node) => node.clientHeight);
    const firstQuestion = await questions.locator('.question-card:visible').first().boundingBox();
    assert.ok(visiblePaper >= 195, `at least 195px of paper at ${width}×${height}: ${visiblePaper}`);
    assert.ok(visibleQuestions >= firstQuestion.height - 1, `one complete prompt fits at ${width}×${height}`);
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--visible-height') === '768px',
  );
  await studyGrid.evaluate((node) => node.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.getByRole('button', { name: '放大题页', exact: true }).click();
  await assertIndependentScroll(sheet, questions, 'wheel');
  await assertIndependentScroll(questions, sheet, 'wheel');
  await assertIndependentScroll(sheet, questions, 'keyboard');
  await assertIndependentScroll(questions, sheet, 'keyboard');
  if (engine === chromium) {
    const sheetPosition = await sheet.evaluate((node) => node.scrollTop);
    await dragScrollbar(questions);
    assert.equal(await sheet.evaluate((node) => node.scrollTop), sheetPosition);
  }
  await page.getByRole('button', { name: '适合宽度', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  const marking = page.getByRole('button', { name: '看评分原页', exact: true });
  assert.equal(await marking.count(), 0);
  await page.locator('.question-input').first().fill('7000');
  await page.locator('#play-pause').click();
  await page.locator('#submit-answers').click();
  await confirmIncompleteTask(page);
  assert.equal(await page.locator('#practice-picker').isVisible(), false);
  assert.equal(await page.locator('.main-navigation').isVisible(), false);
  for (const width of [1150, 1100, 1080, 810, 760, 390]) {
    await page.setViewportSize({ width, height: 810 });
    const paper = await page.locator('#review-paper-panel').boundingBox();
    const answers = await page.locator('.question-panel').boundingBox();
    if (width < 760) assert.ok(answers.y + answers.height <= paper.y);
    else {
      assert.ok(Math.abs(answers.y - paper.y) < 1);
      assert.ok(Math.abs(answers.y + answers.height - paper.y - paper.height) < 1);
      if (width <= 1100) {
        const controls = page.locator(
          '.app-header :is(.brand, #home-back, #change-paper, .session-state summary, #session-review, #session-save)',
        );
        const centers = await controls.evaluateAll((nodes) =>
          nodes.map((el) => {
            const box = el.getBoundingClientRect();
            return box.top + box.height / 2;
          }),
        );
        assert.ok(Math.max(...centers) - Math.min(...centers) < 3, `one header row at ${width}px`);
      }
    }
  }
  await page.setViewportSize({ width: 1194, height: 834 });
  const originalResponses = page.locator('#original-responses');
  await page.getByRole('button', { name: '放大题页', exact: true }).click();
  await assertIndependentScroll(sheet, questions, 'wheel');
  await assertIndependentScroll(originalResponses, questions, 'wheel');
  await questions.locator('.question-review-tools:visible summary').first().click();
  await assertIndependentScroll(questions, sheet, 'wheel');
  await assertIndependentScroll(questions, sheet, 'keyboard');
  await page.getByRole('button', { name: '适合宽度', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('#home-back').click();
  await page.locator('#home-panel').waitFor();
  await page.goBack();
  await page.locator('#review-paper-panel').waitFor();
  assert.equal(await page.locator('#practice-picker').isVisible(), false);
  assert.equal(await page.locator('#original-responses .question-input').count(), 13);
  assert.equal(await page.locator('#original-responses .question-input').first().inputValue(), '7000');
  assert.equal(await page.locator('#questions .question-input').count(), 0);
  assert.equal(await marking.isVisible(), true, 'review offers the original marking page');
  await page.locator('#practice-page').fill('5');
  await page.locator('#practice-page').press('Enter');
  await page.getByRole('button', { name: '放大题页', exact: true }).click();
  const original = page.locator('#practice-image');
  await original.evaluate((img) => img.decode());
  const originalPage = await original.getAttribute('src');
  await sheet.evaluate((node) => node.scrollTo(80, 130));
  const answerPosition = await questions.evaluate((node) => {
    node.scrollTop = 230;
    return node.scrollTop;
  });
  await marking.click();
  assert.match(await original.getAttribute('alt'), /2025 MS.pdf 第 6 页/);
  assert.equal(await questions.evaluate((node) => node.scrollTop), answerPosition);
  await page.getByRole('button', { name: '下一页', exact: true }).first().click();
  await page.getByRole('button', { name: '返回题页', exact: true }).click();
  assert.equal(await original.getAttribute('src'), originalPage);
  assert.deepEqual(await sheet.evaluate((node) => [node.scrollLeft, node.scrollTop]), [80, 130]);
  assert.equal(await questions.evaluate((node) => node.scrollTop), answerPosition);
  for (const id of ['q11', 'q12', 'q13']) {
    const text = await page.locator(`#questions [data-question-id=${id}] .reference-answer`).textContent();
    assert.match(text, /free/);
    assert.match(text, /swimming/);
    assert.match(text, /people|friends/);
  }
  assert.equal(await page.getByText('提交后才显示答案和原音证据。', { exact: true }).isVisible(), false);
  assert.equal(await page.locator('#listening-retest').isVisible(), false);
  assert.equal(
    await page
      .getByText('这题暂无可靠短句定位，请先对照原音与评分参考；不强行生成听写答案。', { exact: true })
      .count(),
    0,
  );
  await page.locator('#phase-retest').click();
  assert.equal(await marking.count(), 0);
  assert.equal(await page.locator('.reference-answer,.evidence-link,.word').count(), 0);
  assert.equal(await page.locator('.question-input').first().inputValue(), '');
  const b1Page = await browser.newPage({ viewport: { width: 1366, height: 1024 } });
  const b1Url = new URL(process.env.TEST_URL || 'http://127.0.0.1:4174');
  b1Url.hash = 'listening';
  await b1Page.goto(b1Url.href);
  await b1Page.locator('#practice-part').selectOption('B1');
  await b1Page.locator('#practice-task').selectOption('5');
  const b1Questions = b1Page.locator('#questions');
  const longAnswer = b1Questions.locator('textarea.question-input');
  await longAnswer.fill('This line belongs to the same written answer.\n'.repeat(60));
  await assertIndependentScroll(longAnswer, b1Questions, 'wheel');

  const resizePage = await browser.newPage({ viewport: { width: 1337, height: 1013 }, hasTouch: true });
  allowBeforeUnload(resizePage);
  await resizePage.goto(b1Url.href);
  await resizePage.waitForFunction(() => !document.getElementById('play-pause').disabled);
  const player = resizePage.locator('.player');
  assert.ok((await player.boundingBox()).height <= 64, 'first listen uses the compact player');
  assert.equal(
    await resizePage.locator('#lesson-title').evaluate((node) => getComputedStyle(node).fontSize),
    '32px',
  );
  const grip = resizePage.getByRole('separator', { name: '调整原卷预览高度' });
  const preview = resizePage.locator('#paper-preview');
  const state = () =>
    preview.evaluate((element) => ({
      height: Math.round(element.getBoundingClientRect().height),
      zoomed: element.classList.contains('is-zoomed'),
      page: document.getElementById('practice-page').value,
    }));
  await resizePage.getByRole('button', { name: '放大题页', exact: true }).click();
  const beforeDrag = await state();
  const handle = await grip.boundingBox();
  const handleX = handle.x + handle.width / 2;
  const handleY = handle.y + handle.height / 2;
  await resizePage.mouse.move(handleX, handleY);
  await resizePage.mouse.down();
  await resizePage.mouse.move(handleX, handleY - 48, { steps: 4 });
  await resizePage.mouse.up();
  assert.deepEqual(await state(), { ...beforeDrag, height: beforeDrag.height - 48 });
  await grip.press('ArrowDown');
  assert.deepEqual(await state(), { ...beforeDrag, height: beforeDrag.height - 32 });
  await grip.press('End');
  assert.deepEqual(await state(), { ...beforeDrag, height: 640 });
  assert.equal(await grip.getAttribute('aria-valuenow'), '640');
  await resizePage.setViewportSize({ width: 1180, height: 820 });
  await resizePage.waitForFunction(() => document.getElementById('paper-preview').offsetHeight === 615);
  const resizedPaper = await resizePage.locator('.transcript-panel').boundingBox();
  const resizedAnswers = await resizePage.locator('.question-panel').boundingBox();
  assert.ok(Math.abs(resizedPaper.y - resizedAnswers.y) < 1);
  assert.ok(Math.abs(resizedPaper.height - resizedAnswers.height) < 1);
  await grip.press('Home');
  assert.equal((await state()).height, 160);
  const resizeAnswer = resizePage.locator('.question-input:visible').first();
  await resizeAnswer.fill('7000');
  await resizePage.locator('#play-pause').click();
  const resizeSubmit = resizePage.locator('#submit-answers');
  await resizeSubmit.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const submitBox = await resizeSubmit.boundingBox();
  const resizedPlayer = await resizePage.locator('.player').boundingBox();
  assert.ok(submitBox.y >= 0 && submitBox.y + submitBox.height <= resizedPlayer.y);
  await resizeSubmit.click();
  await confirmIncompleteTask(resizePage);
  assert.ok((await player.boundingBox()).height <= 64, 'review uses the compact player');
  const more = resizePage.locator('#loop-more > summary');
  await more.click();
  const menu = await resizePage.locator('.player-menu').boundingBox();
  assert.ok(menu.y + menu.height <= (await player.boundingBox()).y + 1);
  await resizePage.locator('#open-review-marks').click();
  const marks = resizePage.getByRole('dialog', { name: '本次复习标记' });
  await marks.waitFor();
  await resizePage.keyboard.press('Escape');
  await marks.waitFor({ state: 'hidden' });
  await resizePage.waitForFunction(
    () => document.activeElement === document.querySelector('#loop-more > summary'),
  );
  assert.equal((await state()).height, 160, 'review remembers the adjusted viewport');
  assert.equal(await resizePage.locator('#original-responses .question-input').first().inputValue(), '7000');
  await resizePage.locator('#phase-retest').click();
  assert.equal((await state()).height, 160, 'retest remembers the adjusted viewport');

  await resizePage.setViewportSize({ width: 390, height: 844 });
  await resizePage.reload();
  await grip.scrollIntoViewIfNeeded();
  assert.equal(await resizePage.locator('[data-preview-resized]').count(), 0, 'reload restores default size');
  await grip.press('Home');
  assert.equal((await state()).height, 160, 'phone keeps the preview resize control');
  if (engine === chromium) {
    await grip.evaluate((node) => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    const touch = await resizePage.context().newCDPSession(resizePage);
    const box = await grip.boundingBox();
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [center] });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...center, y: center.y + 64 }],
    });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal((await state()).height, 224, 'touch drag changes only the preview height');
    await touch.detach();
  }
  await resizePage.close();
  console.log(
    'PASS pane alignment and scrolling, concealed retest, and paper preview resizing by pointer and keyboard',
  );
} finally {
  await browser.close();
}
