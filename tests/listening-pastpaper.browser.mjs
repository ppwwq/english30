import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import { fileURLToPath } from 'node:url';

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const base = new URL(process.env.TEST_URL || 'http://127.0.0.1:4174');
const report = { cases: [], errors: [], physicalDevice: false };
const reportPath =
  process.argv.find((arg) => arg.startsWith('--report='))?.slice(9) ||
  fileURLToPath(new URL('./artifacts/listening-pastpaper-browser.json', import.meta.url));
const ready = (page, title = '') =>
  page.waitForFunction(
    (expected) =>
      !document.querySelector('#play-pause').disabled &&
      document.querySelector('#lesson-title').textContent.includes(expected),
    title,
  );
async function check(name, run, hash = 'listening') {
  const result = { name, passed: false };
  report.cases.push(result);
  const context = await browser.newContext({
    viewport: { width: 1080, height: 810 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const dialogs = { accept: true };
  page.on('pageerror', (error) => report.errors.push({ name, message: error.message }));
  page.on('dialog', (dialog) => (dialogs.accept ? dialog.accept() : dialog.dismiss()));
  try {
    base.hash = hash;
    await page.goto(base.href);
    await ready(page);
    await run(page, result, dialogs);
    result.passed = true;
    console.log('PASS', name);
  } catch (error) {
    result.failure = error.stack;
    result.status = await page
      .locator('#status')
      .textContent()
      .catch(() => 'unavailable');
    process.exitCode = 1;
    console.log('FAIL', name, error.message);
  } finally {
    await context.close();
  }
}
try {
  await check(
    'original practice selects Year, Part and Task with original question pages and concealed first answers',
    async (page) => {
      assert.equal(await page.locator('body').getAttribute('data-view'), 'listening');
      assert.equal(await page.locator('body').getAttribute('data-listening-mode'), 'papers');
      assert.equal(await page.locator('#paper-host').isVisible(), false);
      assert.equal(await page.locator('#listening-panel').isVisible(), true);
      await page.locator('#practice-year').selectOption('2013');
      await ready(page, '2013');
      await page.locator('#practice-part').selectOption('B1');
      await ready(page, 'Part B1');
      await page.locator('#practice-task').selectOption('6');
      await ready(page, 'Task 6');
      assert.match(await page.locator('#lesson-title').textContent(), /2013.*Part B1.*Task 6/);
      assert.equal(await page.locator('#practice-page').inputValue(), '2');
      assert.equal(await page.locator('#practice-image').isVisible(), true);
      assert.ok((await page.locator('textarea.question-input').count()) > 0);
      assert.equal(await page.locator('.word, .evidence-link, .reference-answer').count(), 0);
      assert.equal(await page.locator('#practice-document option[data-reference]').count(), 0);
      assert.equal(new URL(page.url()).hash, '#listening');
      assert.equal(await page.locator('#lesson-select').isVisible(), false);
    },
  );
  await check(
    'cancelling an original-to-excerpt mode change preserves the original draft and selectors',
    async (page, result, dialogs) => {
      await page.locator('.question-input').first().fill('original draft kept');
      await page.locator('#play-pause').tap();
      await page.waitForFunction(() => !document.querySelector('#audio').paused);
      dialogs.accept = false;
      await page.evaluate(() => {
        location.hash = 'listening/practice';
      });
      await page.waitForFunction(
        () => location.hash === '#listening' && document.body.dataset.listeningMode === 'papers',
      );
      assert.equal(await page.locator('.question-input').first().inputValue(), 'original draft kept');
      assert.equal(await page.locator('#practice-year').inputValue(), '2025');
      assert.equal(await page.locator('#practice-picker').isVisible(), true);
      assert.equal(new URL(page.url()).hash, '#listening');
      assert.equal(await page.locator('#audio').evaluate((audio) => audio.paused), true);
      dialogs.accept = true;
      await page.evaluate(() => {
        location.hash = 'listening/practice';
      });
      await page.waitForFunction(() => document.body.dataset.listeningMode === 'practice');
      await ready(page);
      assert.equal(await page.locator('#lesson-select').isVisible(), true);
      assert.equal(new URL(page.url()).hash, '#listening/practice');
    },
  );
  await check(
    'cancelling an excerpt-to-original change preserves the excerpt draft, and other navigation keeps it',
    async (page, result, dialogs) => {
      const title = await page.locator('#lesson-title').textContent();
      await page.locator('.question-input').first().fill('focused draft kept');
      dialogs.accept = false;
      await page.locator('.main-navigation [data-view=listening]').tap();
      await page.waitForFunction(() => document.body.dataset.listeningMode === 'practice');
      assert.equal(await page.locator('#lesson-title').textContent(), title);
      assert.equal(await page.locator('.question-input').first().inputValue(), 'focused draft kept');
      assert.equal(await page.locator('#practice-picker').isVisible(), false);
      await page.locator('.main-navigation [data-view=library]').tap();
      await page.locator('#paper-year').waitFor({ state: 'visible' });
      await page.locator('.main-navigation [data-view=listening]').tap();
      assert.equal(await page.locator('.question-input').first().inputValue(), 'focused draft kept');
    },
    'listening/practice',
  );
  await check(
    'library document browsing keeps its Paper selection independently of listening practice',
    async (page) => {
      await page.locator('#practice-year').selectOption('2013');
      await ready(page, '2013');
      await page.locator('.main-navigation [data-view=library]').tap();
      await page.locator('#paper-year').waitFor({ state: 'visible' });
      await page.locator('#paper-paper').selectOption('1');
      await page.waitForFunction(() => document.querySelector('#paper-audio-panel').hidden);
      await page.locator('.main-navigation [data-view=listening]').tap();
      await ready(page, '2013');
      assert.equal(await page.locator('#practice-year').inputValue(), '2013');
      assert.equal(await page.locator('#paper-host').isVisible(), false);
      await page.locator('.main-navigation [data-view=library]').tap();
      assert.equal(await page.locator('#paper-paper').inputValue(), '1');
      assert.equal(await page.locator('#paper-paper').isVisible(), true);
      assert.equal(await page.locator('#audio').evaluate((audio) => audio.paused), true);
    },
  );
  await check('a delayed year load cannot replace a newer year selection', async (page) => {
    let release, started;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const requested = new Promise((resolve) => {
      started = resolve;
    });
    await page.route('**/papers/practice/paper-2013-exam-a-task-1.json', async (route) => {
      started();
      await waiting;
      await route.continue().catch(() => {});
    });
    await page.locator('#practice-year').selectOption('2013');
    await requested;
    await page.locator('#practice-year').selectOption('2014');
    await ready(page, '2014');
    release();
    await page.waitForTimeout(500);
    assert.match(await page.locator('#lesson-title').textContent(), /2014/);
    assert.equal(await page.locator('#practice-year').inputValue(), '2014');
    assert.equal(await page.locator('#audio').evaluate((audio) => audio.paused), true);
  });
  await check(
    'returning to excerpts during a delayed original load cannot install a hidden original lesson',
    async (page) => {
      const title = await page.locator('#lesson-title').textContent();
      let release, started;
      const waiting = new Promise((resolve) => {
        release = resolve;
      });
      const requested = new Promise((resolve) => {
        started = resolve;
      });
      await page.route('**/papers/practice/paper-2025-exam-a-task-1.json', async (route) => {
        started();
        await waiting;
        await route.continue().catch(() => {});
      });
      await page.locator('.main-navigation [data-view=listening]').tap();
      await requested;
      await page.evaluate(() => {
        location.hash = 'listening/practice';
      });
      await page.waitForFunction(() => document.body.dataset.listeningMode === 'practice');
      release();
      await page.waitForTimeout(650);
      assert.equal(await page.locator('body').getAttribute('data-listening-mode'), 'practice');
      assert.equal(await page.locator('#lesson-title').textContent(), title);
      assert.equal(await page.locator('#practice-sources').isVisible(), false);
      assert.equal(await page.locator('#audio').evaluate((audio) => audio.paused), true);
      await ready(page);
    },
    'listening/practice',
  );
  await check(
    'Sample discloses missing audio and restores all practice controls when returning to a real paper',
    async (page) => {
      await page.locator('#practice-year').selectOption('2012');
      await ready(page, '2012');
      await page.locator('#practice-variant').selectOption('sample');
      await page.waitForFunction(() =>
        document.querySelector('#lesson-title').textContent.includes('Sample'),
      );
      assert.equal(await page.locator('#play-pause').isDisabled(), true);
      assert.equal(await page.locator('#submit-answers').isDisabled(), true);
      assert.equal(await page.locator('#audio').getAttribute('src'), null);
      assert.match(await page.locator('#status').textContent(), /缺失|不匹配/);
      await page.locator('#practice-variant').selectOption('exam');
      await ready(page, '2012 正式卷');
      for (const id of ['play-pause', 'seek'])
        assert.equal(await page.locator(`#${id}`).isDisabled(), false, `${id} must recover after Sample`);
      for (const id of ['mark-moment', 'submit-answers'])
        assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id} waits for real listening`);
      await page.locator('#play-pause').tap();
      await page.waitForFunction(() => !document.querySelector('#audio').paused);
      await page.locator('#submit-answers').tap();
      await page.locator('.word').first().waitFor({ state: 'visible' });
      for (const id of ['phase-retest', 'repeat-sentence', 'loop-start', 'playback-rate', 'save-record'])
        assert.equal(
          await page.locator(`#${id}`).isDisabled(),
          false,
          `${id} must be usable in review after Sample`,
        );
    },
  );
  await check(
    'original practice and excerpts fit iPad portrait and phone widths before and after submission',
    async (page, result) => {
      result.viewports = [];
      for (const [width, height] of [
        [810, 1080],
        [390, 844],
      ]) {
        await page.setViewportSize({ width, height });
        for (const mode of ['papers', 'practice']) {
          if (mode === 'papers') {
            await page.locator('.main-navigation [data-view=listening]').tap();
          } else {
            await page.evaluate(() => {
              location.hash = 'listening/practice';
            });
          }
          await page.waitForFunction((expected) => document.body.dataset.listeningMode === expected, mode);
          await ready(page);
          for (const phase of ['first', 'review']) {
            if (phase === 'review' && (await page.locator('#submit-answers').isVisible())) {
              await page.locator('#play-pause').tap();
              await page.waitForFunction(() => !document.querySelector('#audio').paused);
              await page.locator('#submit-answers').tap();
              await page.locator('.word').first().waitFor({ state: 'visible' });
            }
            const sizes = await page.evaluate(() => ({
              width: document.documentElement.clientWidth,
              scroll: document.documentElement.scrollWidth,
            }));
            result.viewports.push({ width, mode, phase, ...sizes });
            assert.ok(sizes.scroll <= sizes.width + 1, JSON.stringify({ width, mode, phase, ...sizes }));
          }
        }
      }
    },
  );
  assert.deepEqual(report.errors, []);
  report.passed = report.cases.every((result) => result.passed);
} finally {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await browser.close();
}
