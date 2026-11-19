import { createRequire } from 'node:module';
import { listeningPracticeURL } from './listening-test-url.mjs';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import assert from 'node:assert/strict';

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const reportFile = process.argv.find((arg) => arg.startsWith('--report='))?.slice(9);
const report = { cases: [], errors: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
try {
  const context = await browser.newContext({ viewport: { width: 1080, height: 810 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(listeningPracticeURL());
  await page.waitForFunction(() => !document.getElementById('play-pause').disabled);

  async function media() {
    return page.locator('#audio').evaluate((audio) => ({
      time: audio.currentTime,
      paused: audio.paused,
      duration: audio.duration,
      sliderValue: Number(document.getElementById('seek').value),
      sliderDisabled: document.getElementById('seek').disabled,
      words: document.querySelectorAll('.word').length,
      evidence: document.querySelectorAll('.evidence-link').length,
    }));
  }
  async function attempt(name, run) {
    const item = { name };
    report.cases.push(item);
    try {
      await run(item);
      item.passed = true;
    } catch (error) {
      item.passed = false;
      item.failure = error.message;
    }
    item.after = await media();
  }
  async function drag(fraction, expectPlaying, item, concealed = false) {
    const slider = page.locator('#seek');
    assert.equal(await slider.isDisabled(), false, 'audio-ready progress must be draggable in this phase');
    await slider.scrollIntoViewIfNeeded();
    const bounds = await slider.boundingBox();
    const before = await media();
    item.before = before;
    const left = bounds.x + 8;
    const travel = bounds.width - 16;
    const from = left + travel * (before.sliderValue / before.duration);
    const target = left + travel * fraction;
    const y = bounds.y + bounds.height / 2;
    // Use actual pointer interaction with the native range, never set its value
    // or audio.currentTime from the test.
    await page.mouse.move(from, y);
    await page.mouse.down();
    await page.mouse.move(target, y, { steps: 18 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const after = await media();
    item.target = before.duration * fraction;
    assert.ok(
      Math.abs(after.time - item.target) < 2,
      `drag must seek near ${item.target.toFixed(2)}s, got ${after.time.toFixed(2)}s`,
    );
    assert.equal(after.paused, !expectPlaying, 'drag must preserve whether playback was paused or playing');
    if (concealed) {
      assert.equal(after.words, 0, 'seeking must not expose subtitles before submission');
      assert.equal(after.evidence, 0, 'seeking must not expose answer evidence before submission');
    }
  }

  await attempt('first: paused drag', (item) => drag(0.5, false, item, true));
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => !document.getElementById('audio').paused);
  await attempt('first: playing drag', (item) => drag(0.25, true, item, true));
  await page.locator('#submit-answers').click();
  await page.waitForFunction(() => document.querySelectorAll('.evidence-link').length === 5);

  await attempt('review: paused drag', (item) => drag(0.6, false, item));
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => !document.getElementById('audio').paused);
  await attempt('review: playing drag', (item) => drag(0.3, true, item));
  await page.locator('[data-question-id="q1"] .evidence-link').click();
  await page.waitForFunction(
    () => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 38.8,
  );
  await attempt('review: drag escapes evidence end', async (item) => {
    await drag(0.75, true, item);
    await page.waitForTimeout(500);
    assert.equal((await media()).paused, false);
  });
  await page.locator('[data-question-id="q1"] .evidence-link').click();
  await page.waitForFunction(
    () => !document.getElementById('audio').paused && document.getElementById('audio').currentTime < 40.7,
  );
  await page.locator('#loop-more > summary').click();
  await page.locator('#loop-toggle').click();
  await attempt('review: drag escapes AB loop', async (item) => {
    await drag(0.75, true, item);
    assert.equal(await page.locator('#loop-toggle').getAttribute('aria-pressed'), 'false');
    await page.waitForTimeout(500);
    assert.ok((await media()).time > 60, 'AB must not pull the new position back into its old range');
  });

  await page.locator('#phase-retest').click();
  await attempt('retest: paused drag', (item) => drag(0.5, false, item, true));
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => !document.getElementById('audio').paused);
  await attempt('retest: playing drag', (item) => drag(0.25, true, item, true));
  report.passed = report.cases.every((item) => item.passed) && report.errors.length === 0;
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.failure = error.message;
  report.passed = false;
  process.exitCode = 1;
} finally {
  await browser.close();
  if (reportFile) await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
