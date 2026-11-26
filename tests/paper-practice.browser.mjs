import { allowBeforeUnload, answerConfirmation, confirmIncompleteTask } from './confirmation-helpers.mjs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage({
  viewport: { width: 810, height: 1080 },
  hasTouch: true,
  isMobile: true,
});
const base = process.env.TEST_URL || 'http://127.0.0.1:4174';
const report = { cases: [], errors: [], physicalDevice: false };
page.on('pageerror', (e) => report.errors.push(e.message));
allowBeforeUnload(page);
async function check(name, fn) {
  await fn();
  report.cases.push(name);
  console.log('PASS', name);
}
const ready = () =>
  page.waitForFunction(() => !document.getElementById('play-pause').disabled, { timeout: 30000 });
try {
  await page.goto(base + '/#listening');
  await page.locator('#practice-year').waitFor({ timeout: 8000 });
  await ready();
  await check('all original years retain Year Part Task selection in focused player', async () => {
    assert.equal(await page.locator('#practice-year option').count(), 14);
    assert.equal(await page.locator('#listening-panel').isVisible(), true);
    assert.equal(await page.locator('#paper-host').isVisible(), false);
    assert.equal(await page.locator('#practice-year').inputValue(), '2025');
    assert.equal(await page.locator('#practice-task').inputValue(), '1');
    assert.equal(await page.locator('#transcript .word').count(), 0);
    assert.equal(await page.locator('#practice-document option[data-reference]').count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('english30-records-v1')), null);
  });
  await check(
    'unverified answers stay pending and self-assessment persists without fake auto score',
    async () => {
      await page.locator('#practice-year').selectOption('2023');
      await ready();
      await page.locator('.question-input').first().fill('my answer');
      await page.locator('#play-pause').tap();
      await page.waitForFunction(() => !document.getElementById('audio').paused);
      await page.locator('#submit-answers').tap();
      await confirmIncompleteTask(page);
      await page.locator('#transcript .word').first().waitFor();
      assert.match(await page.locator('.result-summary').textContent(), /待自核/);
      assert.ok((await page.locator('#practice-document option[data-reference]').count()) > 0);
      await page.locator('.question-review-tools > summary').first().click();
      await page.locator('.self-check').first().selectOption('correct');
      await page.locator('#session-save').tap();
      await answerConfirmation(page, '确认保存');
      const result = await page.evaluate(
        () =>
          Object.values(
            JSON.parse(localStorage.getItem('english30-records-v1')).at(-1).attempts.at(-1).results,
          )[0],
      );
      assert.equal(result.correct, null);
      assert.equal(result.selfAssessment, 'correct');
      await page.locator('#phase-retest').tap();
      assert.equal(await page.locator('#transcript .word').count(), 0);
      assert.equal(await page.locator('.reference-answer').count(), 0);
      assert.equal(await page.locator('#practice-document option[data-reference]').count(), 0);
      assert.equal(await page.locator('.question-input').first().inputValue(), '');
    },
  );
  await check('B1 original Task has long response and shared listening context', async () => {
    await page.locator('#practice-part').selectOption('B1');
    await ready();
    await page.locator('#practice-task').selectOption('6');
    await ready();
    assert.equal(await page.locator('textarea.question-input').count(), 1);
    assert.match(await page.locator('#lesson-meta').textContent(), /共用/);
    assert.equal(await page.locator('#practice-task').inputValue(), '6');
  });
  await check('Sample with missing original audio cannot submit or play stale audio', async () => {
    await page.locator('#practice-year').selectOption('2012');
    await ready();
    await page.locator('#practice-variant').selectOption('sample');
    await page.waitForFunction(() => document.getElementById('play-pause').disabled);
    assert.equal(await page.locator('#submit-answers').isDisabled(), true);
    assert.match(await page.locator('#status').textContent(), /音频/);
    assert.equal(await page.locator('#audio').getAttribute('src'), null);
    await page.locator('#practice-variant').selectOption('practice');
    await ready();
    assert.equal(await page.locator('#submit-answers').isDisabled(), true);
    await page.locator('#play-pause').tap();
    await page.waitForFunction(() => !document.querySelector('#submit-answers').disabled);
  });
  assert.deepEqual(report.errors, []);
} finally {
  await fs.mkdir('tests/artifacts', { recursive: true });
  await fs.writeFile('tests/artifacts/paper-practice-browser.json', JSON.stringify(report, null, 2));
  await browser.close();
}
