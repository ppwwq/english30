import { allowBeforeUnload } from './confirmation-helpers.mjs';
import { createRequire } from 'node:module';
import { listeningPracticeURL } from './listening-test-url.mjs';
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
const report = { cases: [], errors: [] };
const base = listeningPracticeURL();
async function scenario(name, fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  allowBeforeUnload(page);
  page.on('pageerror', (e) => report.errors.push(e.message));
  const item = { name };
  report.cases.push(item);
  try {
    await fn(page, item);
    item.passed = true;
  } catch (e) {
    item.passed = false;
    item.failure = e.message;
  } finally {
    await context.close();
  }
}
const ready = (page) => page.waitForFunction(() => !document.getElementById('play-pause').disabled);
try {
  await scenario(
    'initial controls stay disabled while the catalogue and lesson are still loading',
    async (page, item) => {
      let release;
      const requested = new Promise((resolve) => {
        release = resolve;
      });
      await page.route('**/lesson-catalogue.json', (route) => release(route));
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      const route = await requested;
      item.disabled = await page.locator('#play-pause').isDisabled();
      assert.equal(item.disabled, true, 'play must not become clickable before a lesson exists');
      assert.equal(await page.locator('#seek').isDisabled(), true);
      assert.equal(await page.locator('#follow-toggle').isDisabled(), true);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: await fs.readFile(new URL('../web/lesson-catalogue.json', import.meta.url)),
      });
      await ready(page);
      assert.ok(await page.locator('#audio').evaluate((a) => Number.isFinite(a.duration)));
    },
  );
  await scenario('switching lesson stops old playback even when the new lesson fails', async (page, item) => {
    await page.goto(base);
    await ready(page);
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.1);
    await page.route('**/lessons/2025-task1.json', (r) => r.fulfill({ status: 503, body: 'Unavailable' }));
    await page.locator('#lesson-select').selectOption('2025-task1');
    await page.waitForFunction(() => document.getElementById('status').classList.contains('is-error'));
    item.media = await page.locator('#audio').evaluate((a) => ({
      paused: a.paused,
      time: a.currentTime,
      playDisabled: document.getElementById('play-pause').disabled,
      seekDisabled: document.getElementById('seek').disabled,
    }));
    assert.equal(item.media.paused, true, 'the old recording must stop when switching lessons');
    assert.equal(item.media.seekDisabled, true, 'failed load must not leave an enabled stale slider');
    await page.locator('#lesson-select').selectOption('2025-task1-intro');
    await ready(page);
    assert.equal(await page.locator('#audio').evaluate((a) => a.paused), true);
  });
  await scenario('late old audio download cannot replace the newly selected lesson', async (page, item) => {
    let held;
    await page.route('**/audio/task1-intro.mp3', (route) => {
      held = route;
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('.question-input').length === 4);
    await page.locator('#lesson-select').selectOption('2025-task1');
    await ready(page);
    if (held)
      await held
        .fulfill({
          status: 200,
          contentType: 'audio/mpeg',
          body: await fs.readFile(new URL('../web/audio/task1-intro.mp3', import.meta.url)),
        })
        .catch(() => {});
    await page.waitForTimeout(150);
    item.duration = await page.locator('#audio').evaluate((a) => a.duration);
    assert.ok(Math.abs(item.duration - 228) < 0.1);
    assert.equal(await page.locator('.question-input').count(), 13);
  });
  await scenario(
    'mismatched DSE audio disables playback and a matching replacement recovers',
    async (page, item) => {
      await page.route('**/audio/task1-intro.mp3', (route) =>
        route.fulfill({
          contentType: 'audio/mpeg',
          path: new URL('../web/audio/task1.mp3', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'),
        }),
      );
      await page.goto(base);
      await page.waitForFunction(() => document.getElementById('status').textContent.includes('不一致'));
      assert.equal(await page.locator('#play-pause').isDisabled(), true);
      assert.equal(await page.locator('#seek').isDisabled(), true);
      await page.unroute('**/audio/task1-intro.mp3');
      await page.reload();
      await ready(page);
      await page.locator('#play-pause').click();
      await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.1);
      item.recovered = true;
    },
  );
  report.passed = report.cases.every((x) => x.passed) && report.errors.length === 0;
  if (!report.passed) process.exitCode = 1;
} finally {
  await browser.close();
  const file = process.argv.find((x) => x.startsWith('--report='))?.slice(9);
  if (file) await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
