import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import { fileURLToPath } from 'node:url';

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE ||
    new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_EXECUTABLE || undefined,
});
const context = await browser.newContext({
  viewport: { width: 1080, height: 810 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const base = (process.env.TEST_URL || 'http://127.0.0.1:4173').replace(/\/#.*$/, '').replace(/\/$/, '');
const report = { cases: [], errors: [], physicalDevice: false };
const reportPath =
  process.argv.find((arg) => arg.startsWith('--report='))?.slice(9) ||
  fileURLToPath(new URL('./artifacts/listening-pastpaper-browser.json', import.meta.url));
page.on('pageerror', (error) => report.errors.push(error.message));
page.on('dialog', (dialog) => dialog.accept());
const ready = () =>
  page.waitForFunction(
    () => document.querySelector('#paper-play') && !document.querySelector('#paper-play').disabled,
  );
const check = async (name, run) => {
  await run();
  report.cases.push(name);
  console.log('PASS', name);
};
try {
  await page.goto(base + '/#listening');
  await check(
    'listening opens original papers directly and selects real Year, Part and Task without leaving listening',
    async () => {
      await page.locator('#paper-year').waitFor({ state: 'visible', timeout: 5000 });
      await ready();
      assert.equal(await page.locator('body').getAttribute('data-view'), 'listening');
      assert.equal(
        await page.locator('button[data-listening-mode=papers]').getAttribute('aria-pressed'),
        'true',
      );
      assert.equal(await page.locator('#listening-panel').isVisible(), false);
      await page.locator('#paper-year').selectOption('2013');
      await ready();
      await page.locator('#paper-part').selectOption('B1');
      await ready();
      await page.locator('#paper-task').selectOption('6');
      await ready();
      assert.match(await page.locator('#paper-source-title').textContent(), /2013 B1/);
      assert.equal(await page.locator('#paper-page').inputValue(), '2');
      assert.equal(new URL(page.url()).hash, '#listening');
      assert.equal(await page.locator('#paper-paper').isVisible(), false);
    },
  );
  await check('original replay, word following and Task loops remain usable inside listening', async () => {
    await page.locator('#paper-part').selectOption('A');
    await ready();
    await page.locator('#paper-review').tap();
    await page.locator('.paper-word').nth(8).tap();
    await page.waitForFunction(
      () =>
        document.querySelector('#paper-audio').paused &&
        document.querySelector('#paper-play').textContent === '播放',
    );
    await page.locator('#paper-word-mark').tap();
    assert.equal(await page.locator('#paper-mark-count').textContent(), '1');
    await page.locator('#paper-task-loop').tap();
    await page.waitForFunction(() => !document.querySelector('#paper-audio').paused);
    assert.equal(await page.locator('#paper-task-loop').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => document.querySelector('.paper-sentence.is-current'));
  });
  await check(
    'switching to focused practice cancels original audio and keeps the focused draft across modes',
    async () => {
      await page.locator('button[data-listening-mode=practice]').tap();
      assert.equal(await page.locator('#paper-audio').evaluate((audio) => audio.paused), true);
      assert.equal(await page.locator('#paper-host').isVisible(), false);
      assert.equal(await page.locator('#listening-panel').isVisible(), true);
      assert.equal(new URL(page.url()).hash, '#listening/practice');
      await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
      await page.locator('.question-input').first().fill('my listening draft');
      await page.locator('#play-pause').tap();
      await page.waitForFunction(() => !document.querySelector('#audio').paused);
      await page.locator('button[data-listening-mode=papers]').tap();
      await ready();
      assert.equal(await page.locator('#audio').evaluate((audio) => audio.paused), true);
      assert.equal(await page.locator('#paper-year').inputValue(), '2013');
      assert.equal(await page.locator('#paper-mark-count').textContent(), '1');
      await page.locator('button[data-listening-mode=practice]').tap();
      assert.equal(await page.locator('.question-input').first().inputValue(), 'my listening draft');
    },
  );
  await check('library keeps its own Paper selection while listening remains Paper 3', async () => {
    await page.locator('.main-navigation [data-view=library]').tap();
    await ready();
    await page.locator('#paper-paper').selectOption('1');
    await page.waitForFunction(() => document.querySelector('#paper-audio-panel').hidden);
    await page.locator('.main-navigation [data-view=listening]').tap();
    await page.locator('button[data-listening-mode=papers]').tap();
    await ready();
    assert.equal(await page.locator('#paper-paper').inputValue(), '3');
    assert.equal(await page.locator('#paper-year').inputValue(), '2013');
    await page.locator('.main-navigation [data-view=library]').tap();
    assert.equal(await page.locator('#paper-paper').inputValue(), '1');
    assert.equal(await page.locator('#paper-paper').isVisible(), true);
  });
  await check('leaving a delayed paper load for focused practice cannot revive hidden audio', async () => {
    await page.route('**/papers/sessions/2014-exam.json', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    await page.locator('.main-navigation [data-view=listening]').tap();
    await ready();
    await page.locator('#paper-year').selectOption('2014');
    await page.locator('button[data-listening-mode=practice]').tap();
    await page.waitForTimeout(650);
    assert.equal(await page.locator('#paper-audio').evaluate((audio) => audio.paused), true);
    assert.equal(await page.locator('#listening-panel').isVisible(), true);
    await page.locator('button[data-listening-mode=papers]').tap();
    await ready();
    assert.match(await page.locator('#paper-notice').textContent(), /2014/);
    assert.equal(await page.locator('#paper-audio').evaluate((audio) => audio.paused), true);
  });
  await check('both listening modes fit tablet portrait and phone widths', async () => {
    for (const width of [810, 390]) {
      await page.setViewportSize({ width, height: 1080 });
      for (const mode of ['papers', 'practice']) {
        await page.locator(`button[data-listening-mode=${mode}]`).tap();
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          ),
        );
      }
    }
  });
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await browser.close();
}
