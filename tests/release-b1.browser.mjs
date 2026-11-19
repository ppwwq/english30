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
page.on('dialog', (d) => d.accept());
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
  await page.locator('.question-input').fill('my own answer');
  await page.locator('#play-pause').click();
  await page.locator('#submit-answers').click();
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
