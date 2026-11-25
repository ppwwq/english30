import { allowBeforeUnload } from './confirmation-helpers.mjs';
import { createRequire } from 'node:module';
import { listeningPracticeURL } from './listening-test-url.mjs';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lesson = JSON.parse(await fs.readFile(path.join(root, 'web/lessons/2025-task1-intro.json'), 'utf8'));
const timedWords = lesson.sentences
  .flatMap((s) => s.words)
  .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
const byId = new Map(timedWords.map((w) => [w.id, w]));
const report = { engine: 'Chromium with actual emulated touch input; not physical iPad', viewports: [] };
const reportFile = process.argv.find((a) => a.startsWith('--report='))?.slice(9);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
try {
  for (const [name, viewport] of [
    ['ipad-landscape', { width: 1080, height: 810 }],
    ['ipad-portrait', { width: 810, height: 1080 }],
  ]) {
    const result = { name, cases: [], errors: [] };
    report.viewports.push(result);
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    page.on('pageerror', (e) => result.errors.push(e.message));
    allowBeforeUnload(page);
    await page.goto(listeningPracticeURL());
    await page.waitForFunction(() => !document.getElementById('play-pause').disabled);
    async function snapshot() {
      return page.locator('#audio').evaluate((a) => ({
        time: a.currentTime,
        paused: a.paused,
        rate: a.playbackRate,
        words: [...document.querySelectorAll('.word.is-playing')].map((n) => n.dataset.wordId),
        sentence: document.querySelector('.sentence.is-current')?.dataset.sentenceId || null,
      }));
    }
    async function attempt(title, action) {
      const item = { title };
      result.cases.push(item);
      try {
        await action(item);
        item.passed = true;
      } catch (e) {
        item.passed = false;
        item.failure = e.message;
      }
      item.after = await snapshot();
    }
    async function touch(from, to, pauseBeforeRelease = 0) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: from.x, y: from.y, id: 1 }],
      });
      for (let i = 1; i <= 14; i++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [
            { x: from.x + ((to.x - from.x) * i) / 14, y: from.y + ((to.y - from.y) * i) / 14, id: 1 },
          ],
        });
        await page.waitForTimeout(15);
      }
      if (pauseBeforeRelease) await page.waitForTimeout(pauseBeforeRelease);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    async function dragTo(fraction, concealed = false) {
      const slider = page.locator('#seek');
      assert.equal(await slider.isDisabled(), false);
      await slider.scrollIntoViewIfNeeded();
      const b = await slider.boundingBox();
      const state = await page
        .locator('#audio')
        .evaluate((a) => ({ duration: a.duration, time: a.currentTime, paused: a.paused }));
      const width = b.width - 16,
        left = b.x + 8,
        y = b.y + b.height / 2;
      await touch({ x: left + (width * state.time) / state.duration, y }, { x: left + width * fraction, y });
      await page.waitForTimeout(250);
      const now = await snapshot();
      assert.ok(
        Math.abs(now.time - state.duration * fraction) < 2,
        `touch target ${state.duration * fraction}, actual ${now.time}`,
      );
      assert.equal(now.paused, state.paused, 'touch drag preserves paused state');
      if (concealed) {
        assert.equal(await page.locator('.word').count(), 0);
        assert.equal(await page.locator('.evidence-link').count(), 0);
      }
    }
    async function sampleSync(ms, requiredGap = null) {
      const samples = await page.evaluate(
        (duration) =>
          new Promise((resolve) => {
            const data = [],
              started = performance.now();
            const timer = setInterval(() => {
              const a = document.getElementById('audio');
              data.push({
                time: a.currentTime,
                words: [...document.querySelectorAll('.word.is-playing')].map((n) => n.dataset.wordId),
              });
              if (performance.now() - started >= duration) {
                clearInterval(timer);
                resolve(data);
              }
            }, 30);
          }),
        ms,
      );
      const mismatches = [];
      let stable = 0,
        gaps = 0;
      for (const s of samples) {
        assert.ok(s.words.length <= 1, 'at most one playing word');
        const word = s.words.length ? byId.get(s.words[0]) : null;
        if (s.words.length && !word) {
          mismatches.push({ reason: 'null-timed or unknown word highlighted', ...s });
          continue;
        }
        const expected = timedWords.find((w) => s.time >= w.start + 0.07 && s.time < w.end - 0.07);
        const stableGap = !timedWords.some((w) => s.time >= w.start - 0.07 && s.time < w.end + 0.07);
        if (expected) {
          stable++;
          if (s.words[0] !== expected.id) mismatches.push({ ...s, expected: expected.id });
        }
        if (stableGap) {
          gaps++;
          if (s.words.length) mismatches.push({ ...s, expected: null });
        }
        if (word && (s.time < word.start - 0.07 || s.time > word.end + 0.07))
          mismatches.push({ ...s, range: [word.start, word.end] });
      }
      assert.deepEqual(mismatches, [], 'highlight must match the lesson timestamp at real media time');
      const targetGapSamples = requiredGap
        ? samples.filter((s) => s.time > requiredGap[0] + 0.07 && s.time < requiredGap[1] - 0.07)
        : [];
      if (requiredGap) {
        assert.ok(targetGapSamples.length >= 3, 'sample the actual unknown-timing interval');
        assert.ok(
          targetGapSamples.every((s) => s.words.length === 0),
          'unknown timing must remain unhighlighted',
        );
      }
      return {
        sampleCount: samples.length,
        stableWordSamples: stable,
        gapSamples: gaps,
        targetGapSamples: targetGapSamples.length,
        distinctWords: [...new Set(samples.flatMap((s) => s.words))].length,
      };
    }
    await attempt('first: paused and playing real touch drags keep answers hidden', async () => {
      await dragTo(0.5, true);
      await page.locator('#play-pause').tap();
      await page.waitForFunction(() => !document.getElementById('audio').paused);
      await dragTo(0.25, true);
    });
    await page.locator('#submit-answers').tap();
    await page.waitForFunction(() => document.querySelectorAll('.word').length > 200);
    await attempt('review: native touch seeks backwards and forwards while paused', async () => {
      await dragTo(0.75);
      await dragTo(0);
    });
    await attempt('normal speed: word highlights follow media and clear in gaps', async (item) => {
      await page.locator('#play-pause').tap();
      item.samples = await sampleSync(6200);
      assert.ok(item.samples.distinctWords >= 7);
      assert.ok(item.samples.gapSamples >= 10);
      await page.locator('#play-pause').tap();
      const a = await snapshot();
      await page.waitForTimeout(250);
      const b = await snapshot();
      assert.equal(b.paused, true);
      assert.ok(Math.abs(a.time - b.time) < 0.01);
      assert.deepEqual(a.words, b.words);
    });
    await attempt('0.75 rate and backward touch seek keep word timing aligned', async (item) => {
      await page.locator('#playback-rate').selectOption('0.75');
      await dragTo(0.035);
      await page.locator('#play-pause').tap();
      item.samples = await sampleSync(3100);
      assert.ok(item.samples.distinctWords >= 5);
      await page.locator('#play-pause').tap();
    });
    await attempt('tap a word: replay, highlight, and vocabulary marking stay reachable', async (item) => {
      const word = page.locator('[data-word-id="w0003"]');
      await word.scrollIntoViewIfNeeded();
      await word.tap();
      await page.waitForFunction(() => !document.getElementById('audio').paused);
      item.samples = await sampleSync(1000);
      await page.locator('#mark-heard').tap();
      assert.equal(await word.evaluate((n) => n.classList.contains('is-heard')), true);
      await page.waitForFunction(() => document.getElementById('audio').paused);
      await page.locator('#clear-mark').tap();
      assert.equal(await word.evaluate((n) => n.classList.contains('is-heard')), false);
    });
    await attempt('sentence-only words are never given fabricated word highlights', async (item) => {
      const fallback = lesson.sentences.flatMap((s) => s.words).find((w) => w.start === null);
      await page.locator('#playback-rate').selectOption('1');
      const word = page.locator(`[data-word-id="${fallback.id}"]`);
      await word.scrollIntoViewIfNeeded();
      await word.tap();
      await page.waitForFunction(() => !document.getElementById('audio').paused);
      item.fallbackWord = fallback.id;
      item.samples = await sampleSync(4000, [12.52, 12.84]);
      if (!(await snapshot()).paused) await page.locator('#play-pause').tap();
    });
    await attempt('manual subtitle touch scroll can return to the current sentence', async (item) => {
      await dragTo(0.42);
      await page.locator('#follow-toggle').tap();
      if ((await page.locator('#follow-toggle').getAttribute('aria-pressed')) !== 'true')
        await page.locator('#follow-toggle').tap();
      await page.waitForTimeout(500);
      const transcript = page.locator('#transcript');
      await transcript.scrollIntoViewIfNeeded();
      const b = await transcript.boundingBox();
      const top = Math.max(b.y + 45, 120),
        bottom = Math.min(b.y + b.height - 45, viewport.height - 200);
      const scrollBefore = await transcript.evaluate((node) => {
        window.subtitleTouchScrollEnded = false;
        node.addEventListener('scrollend', () => (window.subtitleTouchScrollEnded = true), { once: true });
        return node.scrollTop;
      });
      // Hold the finger still before lifting: this case tests a completed drag,
      // not the native tap-to-stop-fling gesture, which intentionally emits no click.
      await touch({ x: b.x + b.width * 0.7, y: bottom }, { x: b.x + b.width * 0.7, y: top }, 150);
      assert.equal(await page.locator('#follow-toggle').getAttribute('aria-pressed'), 'false');
      // A stable scrollTop alone can occur before the native gesture has ended.
      await page.waitForFunction(() => window.subtitleTouchScrollEnded, undefined, { timeout: 3000 });
      item.scrollingSettled = await page.evaluate(() => window.subtitleTouchScrollEnded);
      assert.equal(item.scrollingSettled, true);
      item.scrolledBy = await transcript.evaluate((node, before) => node.scrollTop - before, scrollBefore);
      assert.ok(Math.abs(item.scrolledBy) > 40, 'the native touch must actually scroll the subtitles');
      await page.locator('#follow-toggle').tap();
      await page.waitForTimeout(650);
      assert.equal(await page.locator('#follow-toggle').getAttribute('aria-pressed'), 'true');
      item.geometry = await page.evaluate(() => {
        const a = document.querySelector('.sentence.is-current').getBoundingClientRect(),
          t = document.getElementById('transcript').getBoundingClientRect();
        return {
          sentenceTop: a.top,
          sentenceBottom: a.bottom,
          containerTop: t.top,
          containerBottom: t.bottom,
        };
      });
      assert.ok(
        item.geometry.sentenceTop >= item.geometry.containerTop - 2 &&
          item.geometry.sentenceTop < item.geometry.containerBottom,
        'current sentence is visible after return',
      );
    });
    await page.locator('#phase-retest').tap();
    await attempt('retest: paused and playing real touch drags stay subtitle-free', async () => {
      await dragTo(0.5, true);
      await page.locator('#play-pause').tap();
      await dragTo(0.25, true);
    });
    result.passed = result.cases.every((c) => c.passed) && result.errors.length === 0;
    await context.close();
  }
  report.passed = report.viewports.every((v) => v.passed);
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
