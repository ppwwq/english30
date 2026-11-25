import { allowBeforeUnload, answerConfirmation } from './confirmation-helpers.mjs';
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
const page = await context.newPage(),
  base = (process.env.TEST_URL || 'http://127.0.0.1:4173').replace(/\/#.*$/, '').replace(/\/$/, '');
const report = { cases: [], errors: [], physicalDevice: false };
page.on('pageerror', (e) => report.errors.push(e.message));
allowBeforeUnload(page);
async function check(name, fn) {
  await fn();
  report.cases.push(name);
  console.log('PASS', name);
}
const ready = () =>
  page.waitForFunction(
    () => document.querySelector('#paper-play') && !document.querySelector('#paper-play').disabled,
  );
try {
  await page.goto(base + '/');
  await page.locator('#home-panel').waitFor();
  await page.locator('.main-navigation [data-view=library]').click();
  await page.locator('#paper-year').waitFor();
  await check('library opens from home and plan stays last without writing a study record', async () => {
    assert.equal(await page.locator('body').getAttribute('data-view'), 'library');
    assert.equal(await page.locator('.main-navigation a').last().getAttribute('data-view'), 'today');
    assert.equal(await page.evaluate(() => localStorage.getItem('english30-records-v1')), null);
  });
  await check('year, variant, part and task open their real question page', async () => {
    await page.locator('#paper-year').selectOption('2013');
    await ready();
    await page.locator('#paper-part').selectOption('B1');
    await page.locator('#paper-task').selectOption('6');
    assert.equal(await page.locator('#paper-page').inputValue(), '2');
    assert.match(await page.locator('#paper-source-title').textContent(), /2013 B1/);
    assert.match(await page.locator('#paper-notice').textContent(), /共用同一段/);
    await page.locator('#paper-year').selectOption('2012');
    await page.locator('#paper-variant').selectOption('practice');
    await ready();
    await page.locator('#paper-part').selectOption('A');
    await page.locator('#paper-task').selectOption('2');
    assert.equal(await page.locator('#paper-page').inputValue(), '4');
    assert.match(await page.locator('#paper-source-title').textContent(), /Practice/);
  });
  await check('page change, direct page entry, zoom and rotation keep the image readable', async () => {
    await page.locator('#paper-next').tap();
    assert.equal(await page.locator('#paper-page').inputValue(), '5');
    await page.locator('#paper-page').fill('4');
    await page.locator('#paper-page').press('Tab');
    await page.waitForFunction(
      () =>
        document.querySelector('#paper-image').complete &&
        document.querySelector('#paper-image').naturalWidth > 0,
    );
    await page.locator('#paper-zoom').tap();
    assert.equal(await page.locator('#paper-zoom').getAttribute('aria-pressed'), 'true');
    await page.locator('#paper-rotate').tap();
    assert.match(await page.locator('#paper-image').getAttribute('style'), /rotate\(90deg\)/);
    await page.locator('#paper-zoom').tap();
  });
  await page.locator('#paper-year').selectOption('2013');
  await ready();
  await page.locator('#paper-task').selectOption('1');
  await check('touch progress drag seeks forward and backward without restarting at zero', async () => {
    await page.locator('#paper-seek').scrollIntoViewIfNeeded();
    const box = await page.locator('#paper-seek').boundingBox();
    const cdp = await context.newCDPSession(page);
    for (const ratio of [0.42, 0.18]) {
      const x = box.x + box.width * ratio,
        y = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 1, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(() => document.querySelector('#paper-play').textContent === '播放');
      const value = await page.locator('#paper-seek').inputValue();
      assert.ok(Math.abs(Number(value) / 3406.8718 - ratio) < 0.025, value);
      assert.equal(
        await page.locator('#paper-task').inputValue(),
        ratio > 0.3 ? '2' : '1',
        'dragging into another Task must follow its subtitles and questions',
      );
    }
    await cdp.detach();
  });
  await check('short-word highlights follow the native audio clock between timeupdate events', async () => {
    await page.locator('#paper-review').tap();
    await page.locator('[data-sentence-replay]').nth(1).tap();
    const result = await page.evaluate(async () => {
      const session = await (await fetch('./papers/sessions/2013-exam.json')).json();
      const words = session.sentences.flatMap((s) => s.words).filter((w) => w.start !== null);
      const audio = document.querySelector('#paper-audio');
      const position = Number(document.querySelector('#paper-seek').value);
      const chunk = session.audio.chunks.find((c) => position >= c.start && position < c.start + c.duration);
      return new Promise((resolve) => {
        const start = performance.now();
        let matched = 0,
          checked = 0;
        function sample() {
          const time = chunk.start + audio.currentTime;
          const expected = words.find((w) => time > w.start + 0.04 && time < w.end - 0.04);
          if (expected && !audio.paused) {
            checked++;
            if (document.querySelector('.paper-word.is-playing')?.dataset.word === expected.id) matched++;
          }
          if (performance.now() - start < 3000) requestAnimationFrame(sample);
          else resolve({ matched, checked });
        }
        requestAnimationFrame(sample);
      });
    });
    assert.ok(result.checked > 30 && result.matched / result.checked > 0.95, JSON.stringify(result));
    await page.locator('#paper-review').tap();
  });
  await check('word replay stops at its end and review marks replay with following highlight', async () => {
    await page.locator('#paper-review').tap();
    await page.locator('.paper-word').nth(8).tap();
    await page.waitForFunction(
      () =>
        document.querySelector('#paper-audio').paused &&
        document.querySelector('#paper-play').textContent === '播放',
    );
    const stop = await page.locator('#paper-seek').inputValue();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#paper-seek').inputValue(), stop);
    await page.locator('#paper-word-mark').tap();
    assert.equal(await page.locator('#paper-mark-count').textContent(), '1');
    await page.locator('.paper-marks>summary').tap();
    await page.locator('#paper-follow').tap();
    await page.locator('[data-mark]').tap();
    await page.waitForFunction(() => document.querySelector('.paper-sentence.is-current'));
    assert.equal(await page.locator('#paper-follow').getAttribute('aria-pressed'), 'true');
    await page.locator('#paper-play').tap();
  });
  await check('leaving during review-mark loading cannot restart hidden audio', async () => {
    await page.evaluate(() => {
      document.querySelector('[data-mark]').click();
      document.querySelector('#home-back').click();
    });
    await page.waitForTimeout(350);
    assert.equal(await page.locator('body').getAttribute('data-view'), 'home');
    assert.equal(await page.locator('#paper-audio').evaluate((a) => a.paused), true);
    await page.locator('.main-navigation [data-view=library]').tap();
    await ready();
  });
  await check('question evidence is concealed until review and linked to bounded audio', async () => {
    await page.locator('#paper-task').selectOption('2');
    await page.locator('#paper-play').tap();
    await page.waitForFunction(() => !document.querySelector('#paper-audio').paused);
    assert.ok(
      Number(await page.locator('#paper-seek').inputValue()) >= 980,
      'selecting another Task must clear the previous word replay range',
    );
    await page.locator('#paper-play').tap();
    await page.locator('#paper-task').selectOption('1');
    await ready();
    await page.locator('.paper-evidence>summary').tap();
    const clip = page.locator('[data-evidence]').first();
    assert.ok(await clip.count());
    await clip.tap();
    assert.match(await page.locator('#paper-audio-status').textContent(), /片段|载入/);
    await page.locator('#paper-review').tap();
    assert.equal(await page.locator('#paper-transcript-panel').isVisible(), false);
    await page.locator('#home-back').click();
    await page.locator('.main-navigation [data-view=writing]').tap();
    assert.equal(await page.locator('#paper-audio').evaluate((a) => a.paused), true);
  });
  await check(
    'native audio transport crosses chunks, stops clips and loops across a chunk boundary',
    async () => {
      await page.evaluate(async () => {
        const { PaperPlayer } = await import('./paper-player.mjs');
        const session = await (await fetch('./papers/sessions/2013-exam.json')).json();
        window.paperTestAudio = new Audio();
        window.paperTestPlayer = new PaperPlayer(window.paperTestAudio, (s) => (window.paperTestState = s));
        window.paperTestPlayer.setSource(session.audio);
        await window.paperTestPlayer.seek(480, false);
      });
      assert.ok(Math.abs((await page.evaluate(() => window.paperTestState.time)) - 480) < 0.2);
      await page.evaluate(() => window.paperTestPlayer.playRange(479.4, 480.7));
      await page.waitForFunction(
        () =>
          !window.paperTestState.loading &&
          !window.paperTestState.playing &&
          Math.abs(window.paperTestState.time - 480.7) < 0.12,
        {},
        { timeout: 20000 },
      );
      await page.evaluate(() => {
        window.paperTestLoops = 0;
        window.paperTestLast = 0;
        window.paperTestPlayer.notify = (s) => {
          if (s.time < window.paperTestLast - 0.5) window.paperTestLoops++;
          window.paperTestLast = s.time;
          window.paperTestState = s;
        };
        window.paperTestPlayer.playRange(479.4, 480.7, true);
      });
      await page.waitForFunction(() => window.paperTestLoops >= 2, {}, { timeout: 20000 });
      await page.evaluate(() => window.paperTestPlayer.cancel());
    },
  );
  await check('rapid source changes settle on the last year and stop old playback', async () => {
    await page.locator('#home-back').click();
    await page.locator('.main-navigation [data-view=library]').tap();
    await page.locator('#paper-year').selectOption('2014');
    await page.locator('#paper-year').selectOption('2013');
    await ready();
    await page.locator('#paper-play').tap();
    await page.waitForFunction(() => !document.querySelector('#paper-audio').paused);
    await page.locator('#paper-year').selectOption('2012');
    await ready();
    assert.equal(await page.locator('#paper-audio').evaluate((a) => a.paused), true);
    assert.equal(await page.locator('#paper-year').inputValue(), '2012');
  });
  await check('reading and writing Parts open verified pages and model answers require consent', async () => {
    await page.locator('#paper-year').selectOption('2025');
    await page.locator('#paper-paper').selectOption('1');
    await page.locator('#paper-part').selectOption('B1');
    assert.equal(await page.locator('#paper-page').inputValue(), '9');
    assert.equal(await page.locator('#paper-audio-panel').isVisible(), false);
    await page.locator('[data-source-ref]').first().tap();
    if (await page.getByRole('dialog').isVisible()) await answerConfirmation(page, '打开资料');
    await page.waitForFunction(() => {
      const y = document.querySelector('.paper-reader-heading').getBoundingClientRect().y;
      return y >= 0 && y < innerHeight;
    });
    const heading = await page.locator('.paper-reader-heading').boundingBox();
    assert.ok(heading.y >= 0 && heading.y < 810, 'opening a reference returns to the reader');
    await page.locator('#paper-paper').selectOption('2');
    await page.locator('#paper-part').selectOption('B');
    assert.equal(await page.locator('#paper-page').inputValue(), '6');
    await page.locator('#paper-year').selectOption('2022');
    await page.locator('#paper-variant').selectOption('sample');
    assert.equal(await page.locator('#paper-part').inputValue(), 'A');
    assert.equal(await page.locator('#paper-part').isDisabled(), true);
    assert.equal(await page.locator('#paper-page').inputValue(), '1');
    await page.locator('#paper-next').tap();
    await answerConfirmation(page, '取消');
    assert.equal(await page.locator('#paper-page').inputValue(), '1');
    await page.locator('#paper-next').tap();
    await answerConfirmation(page, '查看参考页');
    assert.equal(await page.locator('#paper-page').inputValue(), '2');
  });
  await check('tablet portrait and phone controls stay within the viewport', async () => {
    for (const width of [810, 390]) {
      await page.setViewportSize({ width, height: 1080 });
      await page.locator('#home-back').click();
      await page.locator('.main-navigation [data-view=library]').tap();
      await page.waitForTimeout(100);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      );
    }
  });
  assert.deepEqual(report.errors, []);
} finally {
  await fs.mkdir('tests/artifacts', { recursive: true });
  await fs.writeFile('tests/artifacts/papers-browser.json', JSON.stringify(report, null, 2));
  await browser.close();
}
