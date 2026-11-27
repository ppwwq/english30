import { allowBeforeUnload, confirmIncompleteTask } from './confirmation-helpers.mjs';
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
async function check(name, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
  const page = await context.newPage();
  allowBeforeUnload(page);
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
  await confirmIncompleteTask(page);
  await page.locator('.sentence-time').first().waitFor();
}
try {
  await check('timestamp and sentence shortcuts retain pause and continuous play', async (page) => {
    await review(page);
    const timestamp = page.locator('.sentence[data-sentence-id="s00055"] .sentence-time');
    await timestamp.click();
    assert.ok(Math.abs((await state(page)).time - 28.16) < 0.1);
    assert.equal((await state(page)).paused, true, 'timestamp must keep paused');
    await page.locator('#next-sentence').click();
    const next = await state(page);
    assert.ok(next.time > 28.16, 'next moves forward');
    assert.equal((await state(page)).paused, true, 'next must keep paused');
    await page.locator('#prev-sentence').click();
    assert.ok((await state(page)).time < next.time, 'previous moves back');
    assert.equal((await state(page)).paused, true, 'previous must keep paused');
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => !document.querySelector('#audio').paused);
    await timestamp.click();
    await page.waitForFunction(() => document.querySelector('#audio').currentTime > 31.05, null, {
      timeout: 6000,
    });
    assert.equal((await state(page)).paused, false, 'navigation during playback must cross the sentence end');
    const visible = await page.locator('.sentence.is-current').evaluate((n) => {
      const t = document.querySelector('#transcript').getBoundingClientRect(),
        r = n.getBoundingClientRect();
      return r.top >= t.top - 2 && r.top < t.bottom;
    });
    assert.equal(visible, true, 'current subtitle must be visible');
  });
  await check(
    'sentence blank replays to the sentence end after a pause or a word replay',
    async (page) => {
      await review(page);
      const row = page.locator('.sentence[data-sentence-id="s00055"]');
      const word = row.locator('[data-word-id="w000736"]');
      const timestamp = row.locator('.sentence-time');
      const floating = page.locator('.transcript-panel.is-floating');
      const atSentenceEnd = () =>
        page.waitForFunction(
          () => {
            const audio = document.querySelector('#audio');
            return audio.paused && !audio.seeking && Math.abs(audio.currentTime - 30.86) < 0.12;
          },
          null,
          { timeout: 6000 },
        );
      async function replayFromBlank(transcriptMode) {
        const heading = row.locator('.sentence-meta');
        await heading.scrollIntoViewIfNeeded();
        const position = await heading.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const y = Math.floor(box.height / 2);
          for (const fraction of [0.9, 0.8, 0.7, 0.6]) {
            const x = Math.floor(box.width * fraction);
            if (document.elementFromPoint(box.left + x, box.top + y) === element) return { x, y };
          }
          return null;
        });
        assert.ok(position, `${transcriptMode}: tap must hit the sentence blank area`);
        await page.locator('#audio').evaluate((audio) => {
          delete audio.dataset.sentenceSeek;
          delete audio.dataset.sentencePlayed;
          audio.addEventListener('seeked', () => (audio.dataset.sentenceSeek = String(audio.currentTime)), {
            once: true,
          });
          audio.addEventListener('play', () => (audio.dataset.sentencePlayed = 'true'), { once: true });
        });
        await heading.tap({ position });
        await page.waitForFunction(
          () => {
            const { dataset } = document.querySelector('#audio');
            return dataset.sentencePlayed === 'true' && dataset.sentenceSeek !== undefined;
          },
          null,
          { timeout: 2500 },
        );
        assert.ok(
          Math.abs(Number(await page.locator('#audio').getAttribute('data-sentence-seek')) - 28.16) < 0.12,
          `${transcriptMode}: blank playback begins at the sentence start`,
        );
        await atSentenceEnd();
      }
      const finishWord = async () => {
        await page.locator('#audio').evaluate((audio) => {
          delete audio.dataset.wordSeek;
          audio.addEventListener('seeked', () => (audio.dataset.wordSeek = String(audio.currentTime)), {
            once: true,
          });
        });
        await word.tap();
        await page.waitForFunction(() => {
          const audio = document.querySelector('#audio');
          return Number(audio.dataset.wordSeek) > 28.56 && Number(audio.dataset.wordSeek) < 30.86;
        });
        await atSentenceEnd();
      };

      await page.locator('#play-pause').tap();
      await page.waitForFunction(() => !document.querySelector('#audio').paused);
      await page.locator('#play-pause').tap();
      assert.equal((await state(page)).paused, true, 'start with a deliberate pause');
      await floating.locator('.caption-dock').tap();
      assert.equal(await floating.count(), 0, 'test the ordinary docked transcript');
      await replayFromBlank('docked');

      await page.locator('#paper-float-transcript').tap();
      await floating.waitFor();
      await finishWord();
      await replayFromBlank('floating');
      await finishWord();
      await timestamp.tap();
      assert.equal((await state(page)).paused, true, 'the timestamp only positions after a word replay');
      assert.ok(Math.abs((await state(page)).time - 28.16) < 0.1);
    },
    { hasTouch: true },
  );
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
