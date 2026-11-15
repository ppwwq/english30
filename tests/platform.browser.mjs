import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
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
page.on('pageerror', (e) => report.errors.push(e.message));
page.on('dialog', (d) => d.accept());
const check = async (name, fn) => {
  await fn();
  report.cases.push({ name, passed: true });
};
const nav = async (view) => {
  await page.locator(`.main-navigation [data-view="${view}"]`).tap();
  await page.waitForFunction((v) => document.body.dataset.view === v, view);
  if (view === 'listening') await page.locator('button[data-listening-mode=practice]').tap();
};
const ready = () => page.waitForFunction(() => !document.getElementById('play-pause').disabled);
try {
  await page.goto(base + '/#today');
  await page.locator('#training-save').waitFor();
  await check(
    'five-view navigation settles its highlight on the actual active item at tablet and phone widths',
    async () => {
      for (const width of [1080, 810, 390]) {
        await page.setViewportSize({ width, height: width === 810 ? 1080 : 810 });
        for (const view of ['library', 'listening', 'reading', 'writing', 'today']) {
          await nav(view);
          await page.waitForTimeout(1250);
          const geometry = await page.locator('.main-navigation').evaluate((track) => {
            const b = track.querySelector('button[aria-pressed=true]'),
              t = track.querySelector('.rubber-thumb');
            const values = getComputedStyle(t)
              .clipPath.match(/inset\((.+?) round/)[1]
              .split(' ')
              .map(parseFloat);
            return {
              left: b.offsetLeft - 5,
              clipLeft: values[3] ?? values[1] ?? values[0],
              right: b.offsetLeft - 5 + b.offsetWidth,
              clipRight: track.clientWidth - 10 - values[1],
              scroll: document.documentElement.scrollWidth,
              client: document.documentElement.clientWidth,
            };
          });
          assert.ok(
            Math.abs(geometry.left - geometry.clipLeft) < 2 &&
              Math.abs(geometry.right - geometry.clipRight) < 2,
            JSON.stringify({ view, width, ...geometry }),
          );
          assert.ok(geometry.scroll <= geometry.client + 1);
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
  await check(
    'single listening exports restore safely and invalid imports leave saved data intact',
    async () => {
      await page.locator('.import-menu>summary').tap();
      const before = await page.evaluate(() => localStorage.getItem('english30-records-v1'));
      await page.locator('#import-record').setInputFiles({
        name: 'invalid.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{"schemaVersion":1}'),
      });
      await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('未导入'));
      assert.equal(await page.evaluate(() => localStorage.getItem('english30-records-v1')), before);
      await page.evaluate(() => localStorage.removeItem('english30-records-v1'));
      await page.locator('#import-record').setInputFiles({
        name: 'record.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(record)),
      });
      await page.waitForFunction(() =>
        document.getElementById('status').textContent.startsWith('听力纪录已合并'),
      );
      assert.equal(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem('english30-records-v1')).at(-1).timingOffset,
        ),
        0.4,
      );
    },
  );
  await check(
    'imported source package and original audio survive explicit save and page reload',
    async () => {
      const lesson = JSON.parse(
        await fs.readFile(new URL('../web/lessons/2025-task1-intro.json', import.meta.url), 'utf8'),
      );
      lesson.id = 'local-browser-regression';
      lesson.title = '本机回归材料';
      await page.locator('#import-package').setInputFiles({
        name: 'source.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(lesson)),
      });
      await page.waitForFunction(
        () => document.getElementById('lesson-title').textContent === '本机回归材料',
      );
      await page
        .locator('#import-audio')
        .setInputFiles(new URL('../web/audio/task1-intro.mp3', import.meta.url).pathname.replace(/^\//, ''));
      await ready();
      await page.locator('#save-material').tap();
      await page.waitForFunction(() =>
        document.getElementById('status').textContent.startsWith('练习包与原音已在本机保存'),
      );
      await page.reload();
      await ready();
      await page.locator('#lesson-select').selectOption('local-browser-regression');
      await ready();
      assert.equal(await page.locator('#lesson-title').textContent(), '本机回归材料');
      assert.ok(await page.locator('#audio').evaluate((a) => a.src.startsWith('blob:') && a.duration > 87));
      await page.locator('#seek').fill('20');
      await page.locator('#play-pause').tap();
      await page.waitForFunction(() => document.getElementById('audio').currentTime > 20.1);
      await nav('writing');
    },
  );
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
