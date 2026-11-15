import { createRequire } from 'node:module';
import { listeningPracticeURL } from './listening-test-url.mjs';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Run against a local server. --no-range emulates a host returning a full 200 MP3
// response even when the browser asks for bytes. Media playback remains real.
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE ||
    new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const noRange = process.argv.includes('--no-range');
const reportFile = process.argv.find((arg) => arg.startsWith('--report='))?.slice(9);
const baseURL = listeningPracticeURL();
const report = { mode: noRange ? 'full-200-no-range' : 'normal-server', cases: [], errors: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_EXECUTABLE || undefined,
});
try {
  const context = await browser.newContext({ viewport: { width: 1080, height: 810 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  if (noRange) {
    const mp3 = await fs.readFile(path.join(root, 'web/audio/task1-intro.mp3'));
    await page.route('**/audio/task1-intro.mp3', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'audio/mpeg', 'content-length': String(mp3.length) },
        body: mp3,
      }),
    );
  }
  await page.goto(baseURL);
  await page.waitForFunction(() => !document.getElementById('play-pause').disabled);
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.1);
  await page.locator('#submit-answers').click();
  await page.waitForFunction(() => document.querySelectorAll('.evidence-link').length === 5);

  async function verifyEvidence(question, start, end, beforeClick) {
    const item = { question, expected: { start, end } };
    report.cases.push(item);
    await page.locator('#audio').evaluate((audio) => {
      window.evidenceEvents = [];
      window.evidenceProbe?.abort();
      window.evidenceProbe = new AbortController();
      for (const type of ['seeking', 'seeked', 'play', 'playing', 'pause', 'timeupdate']) {
        audio.addEventListener(
          type,
          () => window.evidenceEvents.push({ type, time: audio.currentTime, paused: audio.paused }),
          { signal: window.evidenceProbe.signal },
        );
      }
    });
    if (beforeClick) await beforeClick();
    await page.locator(`[data-question-id="q${question}"] .evidence-link`).first().click();
    await page.waitForTimeout(300);
    item.afterStart = await page.locator('#audio').evaluate((audio) => ({
      time: audio.currentTime,
      paused: audio.paused,
      seeking: audio.seeking,
    }));
    assert.ok(
      item.afterStart.time >= start - 0.15 && item.afterStart.time <= end + 0.15,
      `Q${question} must start inside its evidence; observed ${item.afterStart.time.toFixed(3)}s`,
    );
    await page.waitForFunction(() => document.getElementById('audio').paused, null, {
      timeout: (end - start) * 1000 + 2500,
    });
    item.stopped = await page.locator('#audio').evaluate((audio) => audio.currentTime);
    assert.ok(Math.abs(item.stopped - end) <= 0.2, `Q${question} must stop at ${end}s, got ${item.stopped}s`);
    await page.waitForTimeout(1000);
    item.afterOneSecond = await page.locator('#audio').evaluate((audio) => ({
      time: audio.currentTime,
      paused: audio.paused,
    }));
    assert.equal(item.afterOneSecond.paused, true);
    assert.ok(Math.abs(item.afterOneSecond.time - item.stopped) < 0.05, 'audio must stay stopped');
    item.events = await page.evaluate(() => window.evidenceEvents);
    item.passed = true;
  }

  await verifyEvidence(1, 38.84, 40.74);
  if (process.argv.includes('--extended')) {
    await verifyEvidence(4, 79.78, 80.88);
    await verifyEvidence(1, 38.84, 40.74); // backwards after a later segment
    await verifyEvidence(4, 79.78, 80.88, async () => {
      await page.locator('[data-question-id="q1"] .evidence-link').click();
      await page.waitForTimeout(120);
    }); // latest evidence wins while an earlier one is playing
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error.message;
  const page = browser.contexts()[0]?.pages()[0];
  if (page) {
    report.finalMedia = await page
      .locator('#audio')
      .evaluate((audio) => ({
        time: audio.currentTime,
        paused: audio.paused,
        duration: audio.duration,
        readyState: audio.readyState,
        seekable: Array.from({ length: audio.seekable.length }, (_, i) => [
          audio.seekable.start(i),
          audio.seekable.end(i),
        ]),
        events: window.evidenceEvents,
      }))
      .catch(() => null);
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  if (reportFile) await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
