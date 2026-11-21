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
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
try {
  await page.goto(`${process.env.TEST_URL || 'http://127.0.0.1:4174'}/#listening`);
  await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  await page.locator('#practice-image').evaluate((img) => img.decode());
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
      assert.ok(Math.min(...gaps) > 40, 'spare height goes between the four answer groups');
      assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 2, 'spacing is balanced across prompts');
      assert.ok(tail > 0 && tail < Math.min(...gaps), 'no large empty area after Q4');
      console.log('Q1–Q4 gaps / space below Q4 (px)', gaps.map(Math.round), Math.round(tail));
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const marking = page.getByRole('button', { name: '看评分原页', exact: true });
  assert.equal(await marking.count(), 0);
  await page.locator('.question-input').first().fill('7000');
  await page.locator('#play-pause').click();
  await page.locator('#submit-answers').click();
  assert.equal(await page.locator('#original-responses .question-input').count(), 13);
  assert.equal(await page.locator('#original-responses .question-input').first().inputValue(), '7000');
  assert.equal(await page.locator('#questions .question-input').count(), 0);
  assert.equal(await marking.isVisible(), true, 'review offers the original marking page');
  await page.locator('#practice-page').fill('5');
  await page.locator('#practice-page').press('Enter');
  await page.getByRole('button', { name: '放大题页', exact: true }).click();
  const sheet = page.locator('.practice-page-wrap');
  const original = page.locator('#practice-image');
  await original.evaluate((img) => img.decode());
  const originalPage = await original.getAttribute('src');
  await sheet.evaluate((node) => node.scrollTo(80, 130));
  const questions = page.locator('#questions');
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
  console.log('PASS split review, complete reason alternatives and concealed retest');
} finally {
  await browser.close();
}
