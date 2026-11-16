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
base.hash = 'listening';
const report = { cases: [], errors: [], physicalDevice: false };
const reportPath =
  process.argv.find((arg) => arg.startsWith('--report='))?.slice(9) ||
  fileURLToPath(new URL('./artifacts/paper-practice-player-browser.json', import.meta.url));
const source = JSON.parse(
  await fs.readFile(new URL('../web/papers/practice/paper-2025-exam-a-task-1.json', import.meta.url), 'utf8'),
);
const evidence = source.questions.find((q) => q.id === 'q1').evidence[0];
const ready = (page, title = '') =>
  page.waitForFunction(
    (expected) =>
      !document.querySelector('#play-pause').disabled &&
      document.querySelector('#lesson-title').textContent.includes(expected),
    title,
  );
const media = (page) =>
  page.locator('#audio').evaluate((audio) => ({
    time: audio.currentTime,
    duration: audio.duration,
    paused: audio.paused,
    seek: Number(document.querySelector('#seek').value),
    loop: document.querySelector('#loop-toggle').getAttribute('aria-pressed'),
  }));
async function drag(page, fraction, playing, touch = false) {
  const slider = page.locator('#seek');
  assert.equal(await slider.isDisabled(), false);
  await slider.scrollIntoViewIfNeeded();
  const bounds = await slider.boundingBox();
  const before = await media(page);
  const from = bounds.x + 8 + ((bounds.width - 16) * before.seek) / before.duration;
  const target = bounds.x + 8 + (bounds.width - 16) * fraction;
  const y = bounds.y + bounds.height / 2;
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from, y }] });
    for (let step = 1; step <= 16; step++)
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: from + ((target - from) * step) / 16, y }],
      });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(from, y);
    await page.mouse.down();
    await page.mouse.move(target, y, { steps: 16 });
    await page.mouse.up();
  }
  await page.waitForTimeout(250);
  const after = await media(page);
  assert.ok(
    Math.abs(after.time - before.duration * fraction) < 2.5,
    `real ${touch ? 'touch' : 'pointer'} drag to ${fraction}: ${JSON.stringify(after)}`,
  );
  assert.equal(after.paused, !playing, 'drag preserves playback state');
  return after;
}
async function review(page) {
  if ((await media(page)).paused) await page.locator('#play-pause').tap();
  await page.waitForFunction(() => !document.querySelector('#audio').paused);
  await page.locator('#submit-answers').tap();
  await page.locator('.word').first().waitFor({ state: 'visible' });
}
async function check(name, run) {
  const result = { name, passed: false };
  report.cases.push(result);
  const context = await browser.newContext({
    viewport: { width: 810, height: 1080 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push({ name, message: error.message }));
  page.on('dialog', (dialog) => dialog.accept());
  try {
    await page.goto(base.href);
    await ready(page, '2025');
    await run(page, result);
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
    'native pointer and touch dragging works while paused and playing without revealing first-answer or retest hints',
    async (page, result) => {
      result.drags = [];
      if (process.argv.includes('--screenshots')) {
        await page.screenshot({
          path: fileURLToPath(new URL('./artifacts/paper-practice-ipad-first.png', import.meta.url)),
          fullPage: true,
        });
      }
      result.drags.push(await drag(page, 0.45, false));
      assert.equal(await page.locator('.word, .evidence-link, .reference-answer').count(), 0);
      await page.locator('#play-pause').tap();
      await page.waitForFunction(() => !document.querySelector('#audio').paused);
      result.drags.push(await drag(page, 0.2, true, true));
      assert.equal(await page.locator('.word, .evidence-link, .reference-answer').count(), 0);
      await review(page);
      if (process.argv.includes('--screenshots')) {
        await page.screenshot({
          path: fileURLToPath(new URL('./artifacts/paper-practice-ipad-review.png', import.meta.url)),
          fullPage: true,
        });
      }
      result.drags.push(await drag(page, 0.6, false));
      await page.locator('#phase-retest').tap();
      await page.waitForFunction(() => document.querySelector('#mode-label').textContent === '无字幕复测');
      result.drags.push(await drag(page, 0.3, false, true));
      assert.equal(await page.locator('.word, .evidence-link, .reference-answer').count(), 0);
      assert.equal(await page.locator('#practice-document option[data-reference]').count(), 0);
    },
  );
  await check(
    'original word highlighting follows real audio and question evidence stops at its precise endpoint',
    async (page, result) => {
      await review(page);
      await page.locator('.sentence-time').first().tap();
      await page.waitForFunction(() => document.querySelector('.word.is-playing'));
      const followed = new Set();
      for (let sample = 0; sample < 15; sample++) {
        const id = await page
          .locator('.word.is-playing')
          .first()
          .getAttribute('data-word-id')
          .catch(() => null);
        if (id) followed.add(id);
        await page.waitForTimeout(100);
      }
      result.followedWords = [...followed];
      assert.ok(followed.size >= 3, 'real playback should advance across at least three words');
      assert.ok((await page.locator('.sentence.is-current').count()) > 0);
      await page.locator('[data-question-id=q1] .evidence-link').first().tap();
      await page.waitForTimeout(150);
      result.start = await media(page);
      assert.ok(result.start.time >= evidence.start - 0.15 && result.start.time < evidence.end);
      await page.waitForFunction(() => document.querySelector('#audio').paused, null, { timeout: 6000 });
      result.stop = await media(page);
      assert.ok(
        Math.abs(result.stop.time - evidence.end) <= 0.2,
        `evidence end ${evidence.end}, observed ${result.stop.time}`,
      );
      await page.waitForTimeout(500);
      assert.ok(Math.abs((await media(page)).time - result.stop.time) < 0.05);
      assert.equal((await media(page)).paused, true);
    },
  );
  await check(
    'original evidence AB loops repeatedly and real dragging exits its bounds while retaining playback',
    async (page, result) => {
      await review(page);
      await page.locator('[data-question-id=q1] .evidence-link').first().tap();
      await page.locator('#loop-toggle').tap();
      await page.waitForFunction(
        () => document.querySelector('#loop-toggle').getAttribute('aria-pressed') === 'true',
      );
      const samples = [];
      for (let sample = 0; sample < 70; sample++) {
        samples.push(await media(page));
        await page.waitForTimeout(100);
      }
      const wraps = samples.slice(1).filter((state, index) => samples[index].time - state.time > 0.5).length;
      result.loop = {
        wraps,
        min: Math.min(...samples.map((s) => s.time)),
        max: Math.max(...samples.map((s) => s.time)),
        allPlaying: samples.every((s) => !s.paused),
      };
      assert.ok(wraps >= 2, JSON.stringify(result.loop));
      assert.ok(result.loop.min >= evidence.start - 0.15 && result.loop.max <= evidence.end + 0.2);
      assert.equal(result.loop.allPlaying, true);
      result.afterDrag = await drag(page, 0.7, true, true);
      assert.equal(result.afterDrag.loop, 'false');
      await page.waitForTimeout(350);
      assert.ok((await media(page)).time > result.afterDrag.time);
    },
  );
  await check(
    'unverified original answers remain pending instead of wrong, and explicit save restores answers, self-check and marks',
    async (page, result) => {
      await page.locator('#practice-year').selectOption('2013');
      await ready(page, '2013');
      await page.locator('.question-input').first().fill('my original paper answer');
      await review(page);
      assert.match(await page.locator('.result-summary').textContent(), /待自核.*不计入自动正确率/);
      assert.equal(await page.locator('.question-card.is-incorrect').count(), 0);
      assert.equal(await page.locator('.reference-answer').count(), 0);
      assert.equal(await page.evaluate(() => localStorage.getItem('english30-records-v1')), null);
      await page.locator('.self-check').first().selectOption('correct');
      await page.locator('.word').first().tap();
      await page.locator('#mark-unknown').tap();
      await page.locator('.review-drawer > summary').tap();
      await page.locator('#save-record').tap();
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('回读验证'));
      const records = await page.evaluate(() => JSON.parse(localStorage.getItem('english30-records-v1')));
      const saved = records.at(-1);
      result.savedLesson = saved.lessonId;
      const results = Object.values(saved.attempts.at(-1).results);
      assert.ok(results.every((r) => r.correct === null && r.grading === 'self'));
      assert.equal(results[0].status, 'self-reviewed');
      assert.ok(results.slice(1).every((r) => r.status === 'pending'));
      assert.equal(Object.keys(saved.marks).length, 1);
      await page.reload();
      await ready(page, '2025');
      await page.locator('#practice-year').selectOption('2013');
      await ready(page, '2013');
      await page.locator('.review-drawer > summary').tap();
      await page.getByRole('button', { name: '恢复这份纪录，继续复盘', exact: true }).tap();
      assert.equal(await page.locator('.question-input').first().inputValue(), 'my original paper answer');
      assert.equal(await page.locator('.self-check').first().inputValue(), 'correct');
      assert.equal(await page.locator('.word.is-unknown').count(), 1);
      assert.match(await page.locator('.result-summary').textContent(), /1 题已自核/);
    },
  );
  await check(
    'switching mode immediately after starting evidence cannot resume hidden original audio',
    async (page) => {
      await review(page);
      await page.evaluate(() => {
        document.querySelector('[data-question-id=q1] .evidence-link').click();
        document.querySelector('button[data-listening-mode=practice]').click();
      });
      await ready(page);
      await page.waitForTimeout(600);
      assert.equal(await page.locator('body').getAttribute('data-listening-mode'), 'practice');
      assert.equal(await page.locator('#practice-sources').isVisible(), false);
      assert.equal(await page.locator('#audio').evaluate((audio) => audio.paused), true);
      assert.equal(await page.locator('.word, .evidence-link').count(), 0);
      assert.equal((await media(page)).loop, 'false');
    },
  );
  assert.deepEqual(report.errors, []);
  report.passed = report.cases.every((result) => result.passed);
} finally {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await browser.close();
}
