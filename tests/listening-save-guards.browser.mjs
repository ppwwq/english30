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
const base = process.env.TEST_URL || 'http://127.0.0.1:4173';
const failures = [];

async function scenario(name, run) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await run(page);
    assert.deepEqual(errors, []);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    await context.close();
  }
}

async function ready(page, hash) {
  await page.goto(`${base}/#${hash}`);
  await page.waitForFunction(() => !document.getElementById('play-pause').disabled);
}

async function submit(page) {
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => !document.getElementById('audio').paused);
  await page.locator('#submit-answers').click();
}

try {
  await scenario(
    'saving a first attempt does not acknowledge or silently discard the current retest draft',
    async (page) => {
      const dialogs = [];
      page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        if (dialog.message().includes('切换材料')) await dialog.dismiss();
        else await dialog.accept();
      });
      await ready(page, 'listening');
      await page.locator('#answer-q1').fill('my first answer');
      await submit(page);
      await page.locator('#phase-retest').click();
      await page.locator('#answer-q1').fill('keep my unsubmitted retest');
      await page.locator('#session-save').click();
      await page.waitForFunction(() => !!localStorage.getItem('english30-records-v1'));
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('english30-records-v1')));
      assert.equal(saved.at(-1).attempts[0].results.q1.answer, 'my first answer');
      assert.equal(saved.at(-1).attempts.length, 1);
      await page.locator('#practice-task').selectOption('2');
      // The selector's async event handler must settle its confirmation and reset selection.
      await page.waitForTimeout(200);
      assert.equal(
        dialogs.filter((message) => message.includes('切换材料')).length,
        1,
        'switching must warn about the retest draft excluded from the saved snapshot',
      );
      assert.equal(await page.locator('#practice-task').inputValue(), '1');
      assert.equal(await page.locator('#answer-q1').inputValue(), 'keep my unsubmitted retest');
    },
  );

  await scenario(
    'discarding a submitted task resets the global save indicator for the fresh task',
    async (page) => {
      page.on('dialog', async (dialog) => dialog.accept());
      await ready(page, 'listening');
      await submit(page);
      assert.equal(await page.locator('#session-save').isDisabled(), false);
      await page.locator('#change-paper').click();
      await page.locator('#practice-task').selectOption('2');
      await page.waitForFunction(
        () =>
          document.getElementById('lesson-meta').textContent.includes('Task 2') &&
          !document.getElementById('play-pause').disabled,
      );
      assert.equal(
        await page.locator('#session-save').isDisabled(),
        true,
        'discarding the previous task must clear its stale pending-save state',
      );
      assert.equal(await page.locator('#session-save-status').textContent(), '尚未提交');
    },
  );

  await scenario('only built-in DSE material can be selected', async (page) => {
    await ready(page, 'listening/practice');
    assert.equal(await page.locator('input[type=file]').count(), 0);
    assert.equal(await page.locator('#lesson-select option').count(), 3);
  });
} finally {
  await browser.close();
}

assert.deepEqual(failures, [], 'listening save guard regressions');
