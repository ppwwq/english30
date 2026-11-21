import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const report = { cases: [], errors: [], physicalDevice: false };
const reportPath =
  process.argv.find((arg) => arg.startsWith('--report='))?.slice(9) ||
  fileURLToPath(new URL('./artifacts/paper-study-guards-browser.json', import.meta.url));
const ready = (page) =>
  page.waitForFunction(
    () => document.querySelector('#paper-play') && !document.querySelector('#paper-play').disabled,
  );
async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1080, height: 810 }, hasTouch: true });
  try {
    const page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const url = new URL(process.env.TEST_URL || 'http://127.0.0.1:4173/');
    url.hash = 'library';
    await page.goto(url.href);
    await ready(page);
    await page.locator('#paper-drill').evaluate((details) => {
      details.open = true;
    });
    await run(page);
    report.cases.push(name);
    console.log('PASS', name);
  } finally {
    await context.close();
  }
}
async function submitDrill(page) {
  await page.locator('#paper-drill-play').click();
  await page.waitForFunction(() => !document.querySelector('#paper-drill-play').disabled);
  await page.locator('#paper-drill-answer').fill('test answer');
  await page.locator('#paper-drill-submit').click();
  return page.evaluate(async () => (await import('/training-core.mjs')).studyStore.getState().records.at(-1));
}
try {
  await scenario('returning after an interrupted drill play keeps its play button usable', async (page) => {
    const second = await page.locator('#paper-drill-sentence option').nth(1).getAttribute('value');
    await page.locator('#paper-drill-sentence').selectOption(second);
    // Interrupt the actual seek promise through the two public controls.
    await page.evaluate(() => {
      document.querySelector('#paper-drill-play').click();
      document.querySelector('#home-back').click();
    });
    await page.locator('#home-panel').waitFor();
    await page.locator('.main-navigation [data-view=library]').click();
    assert.equal(await page.locator('#paper-drill-play').isDisabled(), false);
    assert.equal(await page.locator('#paper-audio').evaluate((audio) => audio.paused), true);
    await page.locator('#paper-drill-play').click();
    await page.waitForFunction(() => !document.querySelector('#paper-audio').paused);
    assert.equal(await page.locator('#audio').evaluate((audio) => audio.paused), true);
  });
  await scenario(
    'showing Task subtitles marks every existing draft as assisted, while a concealed retest starts clean',
    async (page) => {
      const ids = await page
        .locator('#paper-drill-sentence option')
        .evaluateAll((options) => options.slice(0, 2).map((option) => option.value));
      await page.locator('#paper-drill-sentence').selectOption(ids[1]);
      await page.locator('#paper-review').click();
      await page.locator('#paper-drill-sentence').selectOption(ids[0]);
      const assisted = await submitDrill(page);
      assert.equal(assisted.assisted, true);
      await page.locator('#paper-drill-retest').click();
      assert.equal(await page.locator('#paper-transcript-panel').isVisible(), false);
      const retest = await submitDrill(page);
      assert.equal(retest.phase, 'retest');
      assert.equal(retest.assisted, false);
    },
  );
  await scenario(
    'subtitles exposed for another year do not contaminate an untouched first draft',
    async (page) => {
      await page.locator('#paper-year').selectOption('2013');
      await ready(page);
      await page.locator('#paper-review').click();
      await page.locator('#paper-review').click();
      await page.locator('#paper-year').selectOption('2025');
      await ready(page);
      const first = await submitDrill(page);
      assert.equal(first.phase, 'first');
      assert.equal(first.assisted, false);
    },
  );
  await scenario(
    'restoring saved mark state refreshes existing words without replacing the current draft or focus',
    async (page) => {
      await page.locator('#paper-review').click();
      const word = page.locator('.paper-word').nth(8);
      await word.click();
      await page.locator('#paper-word-mark').click();
      await page.locator('#session-save').click();
      const backup = await page.evaluate(async () =>
        (await import('/training-core.mjs')).studyStore.exportBackup(),
      );
      await word.click();
      await page.locator('#paper-word-mark').click();
      assert.equal(await word.evaluate((element) => element.classList.contains('is-marked')), false);
      await word.click();
      await page.locator('#paper-audio').evaluate((audio) => audio.pause());
      const wordHandle = await word.elementHandle();
      await page.locator('#paper-drill-answer').fill('keep this unsaved sentence');
      await page.locator('#paper-drill-answer').focus();
      await page.evaluate(
        async (value) => (await import('/training-core.mjs')).studyStore.replaceState(value.study),
        backup,
      );
      assert.equal(await wordHandle.evaluate((element) => element.isConnected), true);
      assert.equal(await word.evaluate((element) => element.classList.contains('is-marked')), true);
      assert.equal(await page.locator('#paper-word-mark').textContent(), '移除复习标记');
      assert.equal(await page.locator('#paper-drill-answer').inputValue(), 'keep this unsaved sentence');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'paper-drill-answer');
    },
  );
  await scenario(
    'a mark limit failure keeps the existing marks intact and reports the failed change',
    async (page) => {
      await page.locator('#paper-review').click();
      await page.locator('.paper-word').nth(8).click();
      await page.locator('#paper-word-mark').click();
      await page.evaluate(async () => {
        const { studyStore } = await import('/training-core.mjs');
        const mark = studyStore.getState().paperMarks[0];
        studyStore.setPaperMarks(
          Array.from({ length: 10000 }, (_, i) => ({
            ...mark,
            key: `${mark.sessionId}:guard-cap-${i}`,
          })),
        );
      });
      await page.locator('.paper-word').nth(8).click();
      await page.locator('#paper-audio').evaluate((audio) => audio.pause());
      for (let retry = 0; retry < 2; retry++) {
        await page.locator('#paper-word-mark').click();
        assert.match(await page.locator('#paper-study-status').textContent(), /标记未能暂存/);
        assert.equal(await page.locator('#paper-mark-count').textContent(), '10000');
        assert.equal(await page.locator('#paper-word-mark').textContent(), '加入复习标记');
        assert.equal(
          await page
            .locator('.paper-word')
            .nth(8)
            .evaluate((word) => word.classList.contains('is-marked')),
          false,
        );
        assert.equal(
          await page.evaluate(
            async () => (await import('/training-core.mjs')).studyStore.getState().paperMarks.length,
          ),
          10000,
        );
      }
    },
  );
  await scenario(
    'a full record store rejects dictation without freezing the editable response',
    async (page) => {
      await page.locator('#paper-drill-play').click();
      await page.waitForFunction(() => !document.querySelector('#paper-audio').paused);
      await page.locator('#paper-drill-answer').fill('We need two tickets.');
      await page.evaluate(async () => {
        const { studyStore } = await import('/training-core.mjs');
        const state = studyStore.getState();
        state.records = Array.from({ length: 10000 }, (_, i) => ({
          id: `capacity-${i}`,
          module: 'writing',
          taskId: 'capacity-fixture',
          phase: 'first',
          createdAt: '2026-11-15T09:00:00Z',
        }));
        studyStore.replaceState(state);
      });
      for (let i = 0; i < 2; i++) {
        await page.locator('#paper-drill-submit').click();
        assert.match(await page.locator('#paper-drill-message').textContent(), /纪录已达/);
        assert.equal(await page.locator('#paper-drill-answer').isDisabled(), false);
      }
    },
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await browser.close();
  console.log(JSON.stringify(report, null, 2));
}
