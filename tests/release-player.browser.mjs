import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const report = { cases: [], errors: [], physicalDevice: false };
const base = process.env.TEST_URL || 'http://127.0.0.1:4174';
const ready = (page) => page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
const state = (page) =>
  page.locator('#audio').evaluate((a) => ({ time: a.currentTime, paused: a.paused, duration: a.duration }));
async function check(name, run) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => report.errors.push(e.message));
  try {
    await page.goto(`${base}/#listening`);
    await ready(page);
    await run(page);
    report.cases.push({ name, passed: true });
    console.log('PASS', name);
  } catch (e) {
    report.cases.push({ name, passed: false, error: e.message });
    console.log('FAIL', name, e.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}
async function review(page) {
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => !document.querySelector('#audio').paused);
  await page.locator('#submit-answers').click();
  await page.locator('.sentence-time').first().waitFor();
}
try {
  await check('subtitle navigation retains pause and play, never acquires a sentence stop', async (page) => {
    await review(page);
    await page.locator('.sentence-time').nth(5).click();
    await page.waitForTimeout(150);
    assert.equal((await state(page)).paused, true, 'time click must keep paused');
    await page.locator('#next-sentence').click();
    await page.waitForTimeout(150);
    assert.equal((await state(page)).paused, true, 'next must keep paused');
    await page.locator('#play-pause').click();
    await page.locator('.sentence-time').nth(4).click();
    await page.waitForTimeout(5000);
    assert.equal((await state(page)).paused, false, 'navigation during playback must cross the sentence end');
    const visible = await page.locator('.sentence.is-current').evaluate((n) => {
      const t = document.querySelector('#transcript').getBoundingClientRect(),
        r = n.getBoundingClientRect();
      return r.top >= t.top - 2 && r.top < t.bottom;
    });
    assert.equal(visible, true, 'current subtitle must be visible');
  });
  await check('native drag previews without media seeks until release', async (page) => {
    const seek = page.locator('#seek');
    const box = await seek.boundingBox();
    const before = await state(page);
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 12 });
    assert.ok(Math.abs((await state(page)).time - before.time) < 0.1, 'drag must only preview');
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await state(page);
    assert.ok(Math.abs(after.time - before.duration * 0.6) < 3, 'release commits destination');
    assert.equal(after.paused, true);
  });
  await check('fresh task blocks premature submit and missed-audio marks', async (page) => {
    assert.equal(await page.locator('#submit-answers').isDisabled(), true);
    assert.equal(await page.locator('#mark-moment').isDisabled(), true);
    await page.locator('#play-pause').click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#submit-answers').isDisabled(), false);
    assert.equal(await page.locator('#mark-moment').isDisabled(), false);
    await page.locator('#practice-task').selectOption('2');
    await ready(page);
    assert.equal((await state(page)).paused, true);
    assert.equal(await page.locator('#play-pause').getAttribute('aria-label'), '播放');
  });
} finally {
  await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
  await fs.writeFile(
    new URL('./artifacts/release-player.json', import.meta.url),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
