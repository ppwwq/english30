import { createRequire } from 'node:module';
import { listeningPracticeURL } from './listening-test-url.mjs';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import assert from 'node:assert/strict';

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const reportFile = process.argv.find((x) => x.startsWith('--report='))?.slice(9);
const only = process.argv.find((x) => x.startsWith('--only='))?.slice(7);
const report = { cases: [], errors: [] };
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const context = await browser.newContext({ viewport: { width: 1080, height: 810 } });
const page = await context.newPage();
page.on('pageerror', (e) => report.errors.push(e.message));
page.on('dialog', (d) => d.accept());
const media = () =>
  page.locator('#audio').evaluate((a) => ({
    time: a.currentTime,
    paused: a.paused,
    ended: a.ended,
    rate: a.playbackRate,
    loop: document.getElementById('loop-toggle').getAttribute('aria-pressed'),
  }));
async function ready(review = true) {
  await page.goto('about:blank');
  await page.goto(listeningPracticeURL());
  await page.waitForFunction(() => !document.getElementById('play-pause').disabled);
  if (review) {
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.05);
    await page.locator('#submit-answers').click();
    await page.locator('#loop-more > summary').click();
  }
}
async function pause() {
  if (!(await media()).paused) await page.locator('#play-pause').click();
}
async function seek(time) {
  const slider = page.locator('#seek');
  await slider.scrollIntoViewIfNeeded();
  const box = await slider.boundingBox();
  const state = await page.locator('#audio').evaluate((a) => ({ time: a.currentTime, duration: a.duration }));
  await page.mouse.move(box.x + 8 + ((box.width - 16) * state.time) / state.duration, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 8 + ((box.width - 16) * time) / state.duration, box.y + box.height / 2, {
    steps: 10,
  });
  await page.mouse.up();
  await page.waitForFunction(() => !document.getElementById('audio').seeking);
}
async function evidence(question = 1, index = 0) {
  await page.locator(`[data-question-id="q${question}"] .evidence-link`).nth(index).click();
  await page.waitForFunction(() => !document.getElementById('audio').paused);
}
async function attempt(name, run) {
  if (only && !name.includes(only)) return;
  const item = { name };
  report.cases.push(item);
  try {
    await ready();
    await run(item);
    item.passed = true;
  } catch (e) {
    item.passed = false;
    item.error = e.message;
  }
  item.final = await media().catch(() => null);
  if (reportFile) await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
}
async function sampleLoop(durationMs) {
  const samples = [];
  const until = Date.now() + durationMs;
  while (Date.now() < until) {
    samples.push(await media());
    await page.waitForTimeout(70);
  }
  const wraps = samples.slice(1).filter((x, i) => x.time < samples[i].time - 0.5).length;
  return {
    wraps,
    first: samples[0],
    last: samples.at(-1),
    min: Math.min(...samples.map((x) => x.time)),
    max: Math.max(...samples.map((x) => x.time)),
    allPlaying: samples.every((x) => !x.paused),
  };
}
try {
  await attempt('evidence pause and resume retains its endpoint', async (item) => {
    await evidence();
    await page.waitForTimeout(300);
    await pause();
    item.paused = await media();
    await page.waitForTimeout(150);
    await page.locator('#play-pause').click();
    await page.waitForTimeout(2200);
    const state = await media();
    assert.equal(state.paused, true, 'resuming evidence must still stop at the evidence end');
    assert.ok(Math.abs(state.time - 40.74) < 0.2, `Q1 must stop at 40.74, got ${state.time}`);
  });
  await attempt('repeat after selecting an early word and seeking replays the current sentence', async () => {
    await page.locator('[data-sentence-id="s002"] .word').first().click();
    await page.waitForFunction(() => !document.getElementById('audio').paused);
    await pause();
    await seek(70);
    await page.locator('#repeat-sentence').click();
    await page.waitForTimeout(200);
    const state = await media();
    assert.ok(
      state.time >= 68.6 && state.time < 69.4,
      `current sentence starts 68.74; observed ${state.time}`,
    );
  });
  await attempt(
    'evidence AB repeats at least three times and switching it off continues beyond B',
    async (item) => {
      await evidence();
      await page.locator('#loop-toggle').click();
      item.loop = await sampleLoop(6400);
      assert.ok(item.loop.wraps >= 3, `expected 3 real wraps, got ${item.loop.wraps}`);
      assert.ok(item.loop.min >= 38.69 && item.loop.max <= 40.94);
      assert.equal(item.loop.allPlaying, true);
      await page.locator('#loop-toggle').click();
      await page.waitForTimeout(2200);
      const state = await media();
      assert.equal(state.loop, 'false');
      assert.equal(state.paused, false);
      assert.ok(state.time > 40.74);
    },
  );
  await attempt('AB pause and resume retains bounds and returns to A', async (item) => {
    await evidence();
    await page.locator('#loop-toggle').click();
    await page.waitForTimeout(400);
    await pause();
    const stopped = await media();
    await page.waitForTimeout(400);
    assert.ok(Math.abs((await media()).time - stopped.time) < 0.05);
    assert.equal((await media()).loop, 'true');
    await page.locator('#play-pause').click();
    item.loop = await sampleLoop(2200);
    assert.ok(item.loop.wraps >= 1);
    assert.equal(item.loop.allPlaying, true);
    assert.ok(item.loop.min >= 38.69 && item.loop.max <= 40.94);
  });
  await attempt('manual AB ending at the audio duration loops three times without stopping', async (item) => {
    await seek(85.9);
    await page.locator('#loop-start').click();
    item.a = (await media()).time;
    await page.locator('#seek').focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => !document.getElementById('audio').seeking);
    assert.ok(Math.abs((await media()).time - 87.91) < 0.03);
    await page.locator('#loop-end').click();
    await page.locator('#loop-toggle').click();
    item.loop = await sampleLoop(6900);
    assert.ok(item.loop.wraps >= 3, `expected 3 real ending wraps, got ${item.loop.wraps}`);
    assert.equal(item.loop.allPlaying, true);
    assert.ok(item.loop.min >= item.a - 0.15 && item.loop.max <= 87.91);
  });
  await attempt('manual AB rejects missing A, reverse bounds and zero-length bounds', async () => {
    await page.locator('#loop-end').click();
    assert.match(await page.locator('#status').innerText(), /先设置 A/);
    await seek(30);
    await page.locator('#loop-start').click();
    await seek(20);
    await page.locator('#loop-end').click();
    assert.equal(await page.locator('#status').evaluate((n) => n.classList.contains('is-error')), true);
    assert.equal((await media()).loop, 'false');
    await page.locator('#loop-start').click();
    await page.locator('#loop-end').click();
    assert.equal(await page.locator('#status').evaluate((n) => n.classList.contains('is-error')), true);
    assert.equal((await media()).paused, true);
  });
  await attempt('previous and next sentence choose adjacent sentences', async () => {
    await seek(36);
    await page.locator('#prev-sentence').click();
    await page.waitForTimeout(150);
    assert.ok((await media()).time >= 33.11 && (await media()).time < 33.8);
    await page.locator('#next-sentence').click();
    await page.waitForTimeout(150);
    assert.ok((await media()).time >= 35.13 && (await media()).time < 35.9);
  });
  await attempt('repeat at a sentence endpoint repeats the just-heard sentence', async () => {
    await page.locator('[data-sentence-id="s010"] .sentence-time').click();
    assert.equal((await media()).paused, true, 'time navigation stays paused');
    await page.locator('#repeat-sentence').click();
    await page.waitForFunction(
      () => document.getElementById('audio').paused && document.getElementById('audio').currentTime > 41.8,
    );
    await page.locator('#repeat-sentence').click();
    await page.waitForTimeout(150);
    assert.ok((await media()).time >= 40.89 && (await media()).time < 41.6);
  });
  await attempt('next from a gap does not skip the next sentence', async (item) => {
    await seek(42.23);
    item.before = await media();
    await page.locator('#next-sentence').click();
    await page.waitForTimeout(100);
    const state = await media();
    assert.ok(
      state.time >= 42.29 && state.time < 42.92,
      `next sentence in gap starts42.44, got ${state.time}`,
    );
  });
  await attempt('previous from a gap returns to the just-heard sentence', async () => {
    await seek(42.23);
    await page.locator('#prev-sentence').click();
    await page.waitForTimeout(100);
    const state = await media();
    assert.ok(
      state.time >= 40.89 && state.time < 41.6,
      `previous from gap must start41.04, got ${state.time}`,
    );
  });
  await attempt('repeat from a gap replays the just-heard sentence', async () => {
    await seek(42.23);
    await page.locator('#repeat-sentence').click();
    await page.waitForTimeout(100);
    const state = await media();
    assert.ok(state.time >= 40.89 && state.time < 41.6, `repeat from gap must start41.04, got ${state.time}`);
  });
  await attempt('a new evidence selection replaces the old AB interval', async () => {
    await evidence();
    await page.locator('#loop-toggle').click();
    await evidence(4);
    await page.waitForTimeout(1500);
    const state = await media();
    assert.equal(state.loop, 'false');
    assert.equal(state.paused, true);
    assert.ok(Math.abs(state.time - 80.88) < 0.2);
  });
  await attempt('multiple evidence spans target their own start and stop', async () => {
    await evidence(2, 1);
    await page.waitForTimeout(4000);
    const state = await media();
    assert.equal(state.paused, true);
    assert.ok(Math.abs(state.time - 62.14) < 0.2);
  });
  await attempt('same-turn evidence then retest cannot resume delayed audio or reveal answers', async () => {
    await page.evaluate(() => {
      document.querySelector('[data-question-id="q1"] .evidence-link').click();
      document.getElementById('phase-retest').click();
    });
    await page.waitForTimeout(600);
    const state = await media();
    assert.equal(state.paused, true);
    assert.ok(state.time < 0.05);
    assert.equal(state.loop, 'false');
    assert.equal(await page.locator('.word').count(), 0);
    assert.equal(await page.locator('.evidence-link').count(), 0);
  });
  await attempt('review play at the end restarts the audio', async () => {
    await page.locator('#seek').focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => !document.getElementById('audio').seeking);
    await page.locator('#play-pause').click();
    await page.waitForTimeout(250);
    const state = await media();
    assert.equal(state.paused, false);
    assert.ok(state.time < 1);
  });
  await attempt('first-listen play at the end restarts the audio', async () => {
    await ready(false);
    await page.locator('#seek').focus();
    await page.keyboard.press('End');
    await page.waitForFunction(() => !document.getElementById('audio').seeking);
    await page.locator('#play-pause').click();
    await page.waitForTimeout(250);
    const state = await media();
    assert.equal(state.paused, false);
    assert.ok(state.time < 1);
    assert.equal(await page.locator('.word').count(), 0);
  });
  await attempt('Space types in answer fields but toggles playback outside controls', async () => {
    await ready(false);
    await page.locator('#answer-q1').fill('7000');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#answer-q1').inputValue(), '7000 ');
    assert.equal((await media()).paused, true);
    await page.locator('#lesson-title').click();
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    assert.equal((await media()).paused, false);
    await page.keyboard.press('Space');
    await page.waitForTimeout(100);
    assert.equal((await media()).paused, true);
  });
  await attempt('slow evidence playback stops at the same endpoint', async () => {
    await page.locator('#playback-rate').selectOption('0.75');
    await evidence(4);
    await page.waitForTimeout(1900);
    const state = await media();
    assert.equal(state.rate, 0.75);
    assert.equal(state.paused, true);
    assert.ok(Math.abs(state.time - 80.88) < 0.2);
  });
  if (!report.cases.length) report.failure = `No cases matched --only=${only || ''}`;
  report.passed =
    report.cases.length > 0 && report.cases.every((x) => x.passed) && report.errors.length === 0;
  if (!report.passed) process.exitCode = 1;
} finally {
  await browser.close();
  if (reportFile) await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
