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
const context = await browser.newContext();
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
try {
  await page.goto(`${process.env.TEST_URL || 'http://127.0.0.1:4174'}/#listening`);
  await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  await page.evaluate(() => localStorage.setItem('english30-records-v1', '[]'));
  await page.reload();
  await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  assert.doesNotMatch(await page.locator('#session-save-status').textContent(), /^已保存/);
  await page.locator('#practice-year').selectOption('2012');
  await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  await page.locator('#practice-variant').selectOption('sample');
  await page.waitForFunction(() => document.querySelector('#lesson-title').textContent.includes('Sample'));
  assert.equal(await page.locator('#time-total').textContent(), '—');
  assert.equal(await page.locator('#time-current').textContent(), '0:00');
  assert.equal(await page.locator('#practice-sources').isVisible(), true);
  assert.equal(await page.locator('#practice-document option').filter({ hasText: 'SP MS.pdf' }).count(), 1);
  assert.equal(await page.locator('#practice-year').inputValue(), '2012');
  assert.equal(await page.locator('#play-pause').isDisabled(), true);
  assert.equal(await page.locator('#original-responses .question-input').count(), 0);
  await page.locator('#practice-variant').selectOption('exam');
  await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  assert.equal(await page.locator('#practice-part option[value=B2]').count(), 0);
  console.log('PASS fresh save state, Sample identity and read-only sources, A+B1 scope');
} finally {
  await browser.close();
}
