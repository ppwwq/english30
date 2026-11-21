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
const context = await browser.newContext({
  viewport: { width: 1080, height: 810 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
const base = (process.env.TEST_URL || 'http://127.0.0.1:4173').replace(/\/#.*$/, '').replace(/\/$/, '');
const report = { cases: [], errors: [], physicalDevice: false };
page.on('pageerror', (e) => report.errors.push(e.message));
page.on('dialog', (d) => d.accept());
const check = async (name, fn) => {
  await fn();
  report.cases.push({ name, passed: true });
};
const nav = async (view) => {
  await page.locator('#home-back').click();
  await page.locator(`.main-navigation [data-view="${view}"]`).tap();
  await page.waitForFunction((v) => document.body.dataset.view === v, view);
  if (view === 'listening') {
    await page.evaluate(() => {
      location.hash = 'listening/practice';
    });
    await page.waitForFunction(() => document.body.dataset.listeningMode === 'practice');
  }
};
const ready = () => page.waitForFunction(() => !document.getElementById('play-pause').disabled);
try {
  await page.goto(base + '/#today');
  await page.locator('#training-save').waitFor();
  await check(
    'home opens all five modules and each module has a return link at tablet and phone widths',
    async () => {
      for (const width of [1080, 810, 390]) {
        await page.setViewportSize({ width, height: width === 810 ? 1080 : 810 });
        for (const view of ['library', 'listening', 'reading', 'writing', 'today']) {
          await nav(view);
          await page.waitForTimeout(1250);
          assert.equal(await page.locator('.main-navigation').isVisible(), false);
          assert.equal(await page.locator('#home-back').isVisible(), true);
          assert.ok(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
            ),
          );
        }
      }
      await page.setViewportSize({ width: 1080, height: 810 });
    },
  );
  let record;
  await check(
    'bookmark ranges and subtitle offset save, reload, restore and follow the active sentence',
    async () => {
      await nav('listening');
      await ready();
      await page.locator('#play-pause').tap();
      await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.1);
      await page.locator('#mark-moment').tap();
      await page.locator('#submit-answers').tap();
      await page.locator('.review-drawer>summary').tap();
      await page.locator('.moment-adjustment>summary').tap();
      await page.getByLabel('标记1起点（秒）').fill('8');
      await page.getByLabel('标记1终点（秒）').fill('10');
      await page.getByRole('button', { name: '应用并预听', exact: true }).tap();
      await page.waitForFunction(() => document.getElementById('audio').currentTime >= 8);
      await page.locator('#audio').evaluate((a) => a.pause());
      await page.locator('#subtitle-adjustment>summary').tap();
      await page.locator('#subtitle-offset').fill('0.4');
      await page.locator('#apply-subtitle-offset').tap();
      await page.locator('#audio').evaluate((a) => a.pause());
      await page.locator('#save-record').tap();
      record = await page.evaluate(() => JSON.parse(localStorage.getItem('english30-records-v1')).at(-1));
      assert.equal(record.timingOffset, 0.4);
      assert.equal(record.moments[0].start, 8);
      assert.equal(record.moments[0].end, 10);
      await page.reload();
      await ready();
      await page.locator('.review-drawer>summary').tap();
      await page.getByRole('button', { name: '恢复这份纪录，继续复盘' }).tap();
      assert.equal(await page.locator('#subtitle-offset').inputValue(), '0.4');
      await page.locator('#follow-toggle').tap();
      await page.locator('#marks-list button').filter({ hasText: '没听清' }).tap();
      await page.waitForFunction(
        () =>
          document.getElementById('audio').currentTime >= 8 && document.querySelector('.sentence.is-current'),
      );
      assert.equal(await page.locator('#follow-toggle').getAttribute('aria-pressed'), 'true');
      await page.waitForTimeout(2300);
      assert.ok(await page.locator('#audio').evaluate((a) => a.paused && a.currentTime < 10.5));
    },
  );
  await check('listening offers only DSE excerpts and no file picker', async () => {
    assert.equal(await page.locator('input[type=file]').count(), 0);
    assert.equal(await page.locator('#lesson-select option').count(), 3);
  });
  await check(
    'leaving listening stops playback and Space on Reading never starts a hidden player',
    async () => {
      await nav('reading');
      await page.locator('[data-rd-answer]').first().waitFor();
      await page.locator('body').click({ position: { x: 8, y: 300 } });
      await page.keyboard.press('Space');
      await page.waitForTimeout(350);
      assert.ok(await page.locator('#audio').evaluate((a) => a.paused));
      await nav('writing');
      await page.locator('[data-training-mode=sentence]').tap();
      await page.locator('#writing-answer').fill('My draft stays here.');
      await nav('today');
      await nav('writing');
      assert.equal(await page.locator('#writing-answer').inputValue(), 'My draft stays here.');
    },
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await browser.close();
  const output = process.argv.find((x) => x.startsWith('--report='))?.slice(9);
  if (output) await fs.writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
