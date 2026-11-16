import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

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
    'saving an imported listening lesson immediately adds it to the reusable material selector',
    async (page) => {
      page.on('dialog', async (dialog) => dialog.accept());
      await ready(page, 'listening/practice');
      const lesson = JSON.parse(
        await fs.readFile(new URL('../web/lessons/2024-task2-intro.json', import.meta.url), 'utf8'),
      );
      lesson.id = 'saved-import-regression';
      lesson.title = 'Saved import regression fixture';
      await page.locator('#import-package').setInputFiles({
        name: 'saved-import.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(lesson)),
      });
      await page
        .locator('#import-audio')
        .setInputFiles(fileURLToPath(new URL('../web/audio/2024-task2-intro.mp3', import.meta.url)));
      await page.waitForFunction(() => !document.getElementById('play-pause').disabled);
      await submit(page);
      await page.locator('#session-save').click();
      await page.waitForFunction(() =>
        JSON.parse(localStorage.getItem('english30-records-v1') || '[]').some(
          (record) => record.lessonId === 'saved-import-regression',
        ),
      );
      assert.equal(
        await page.locator('#lesson-select option[value="saved-import-regression"]').count(),
        1,
        'the just-saved imported material must be selectable without reloading the page',
      );
      await page.locator('#lesson-select').selectOption('2025-task1-intro');
      await page.waitForFunction(
        () => document.getElementById('lesson-title').textContent !== 'Saved import regression fixture',
      );
      await page.locator('#lesson-select').selectOption('saved-import-regression');
      await page.waitForFunction(
        () =>
          document.getElementById('lesson-title').textContent === 'Saved import regression fixture' &&
          !document.getElementById('play-pause').disabled,
      );
    },
  );

  await scenario(
    'discarding a submitted task resets the global save indicator for the fresh task',
    async (page) => {
      page.on('dialog', async (dialog) => dialog.accept());
      await ready(page, 'listening');
      await submit(page);
      assert.equal(await page.locator('#session-save').isDisabled(), false);
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

  await scenario(
    'combined save rejects replacement audio that does not match the imported lesson',
    async (page) => {
      page.on('dialog', async (dialog) => dialog.accept());
      await ready(page, 'listening/practice');
      const lesson = JSON.parse(
        await fs.readFile(new URL('../web/lessons/2024-task2-intro.json', import.meta.url), 'utf8'),
      );
      lesson.id = 'mismatched-import-regression';
      await page.locator('#import-package').setInputFiles({
        name: 'mismatched-import.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(lesson)),
      });
      await page
        .locator('#import-audio')
        .setInputFiles(fileURLToPath(new URL('../web/audio/2024-task2-intro.mp3', import.meta.url)));
      await page.waitForFunction(() => !document.getElementById('play-pause').disabled);
      await submit(page);
      await page
        .locator('#import-audio')
        .setInputFiles(fileURLToPath(new URL('../web/audio/task1-intro.mp3', import.meta.url)));
      await page.waitForFunction(() =>
        document.getElementById('status').textContent.includes('音频时长与练习包不一致'),
      );
      await page.locator('#session-save').click();
      await page.waitForFunction(() =>
        /已完成回读|保存未完成/.test(document.getElementById('session-save-detail').textContent),
      );
      assert.equal(
        await page.evaluate(() => localStorage.getItem('english30-records-v1')),
        null,
        'a mismatched audio import must not be saved as a successfully verified lesson',
      );
      assert.equal(
        await page.evaluate(async () => {
          const { listeningLibrary } = await import('./listening-library.mjs');
          return !!(await listeningLibrary.load('mismatched-import-regression'));
        }),
        false,
      );
      assert.match(await page.locator('#session-save-detail').textContent(), /保存未完成/);
    },
  );
} finally {
  await browser.close();
}

assert.deepEqual(failures, [], 'listening save guard regressions');
