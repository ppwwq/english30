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
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const ready = () => page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
const audioState = () =>
  page
    .locator('#audio')
    .evaluate((a) => ({ paused: a.paused, time: a.currentTime, seeks: window.actualSeeks }));
try {
  await page.goto(`${process.env.TEST_URL || 'http://127.0.0.1:4175'}/#listening`);
  await ready();
  await page.evaluate(() => {
    const a = document.querySelector('#audio'),
      p = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    window.actualSeeks = 0;
    Object.defineProperty(a, 'currentTime', {
      get() {
        return p.get.call(a);
      },
      set(v) {
        window.actualSeeks++;
        return p.set.call(a, v);
      },
    });
  });
  for (const playing of [false, true]) {
    if (playing) await page.locator('#play-pause').click();
    const b = await page.locator('#seek').boundingBox(),
      before = await audioState();
    await page.mouse.move(b.x + 8, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.6, b.y + b.height / 2, { steps: 10 });
    assert.equal((await audioState()).seeks, before.seeks, 'drag is preview only');
    await page.mouse.up();
    await page.waitForTimeout(150);
    const after = await audioState();
    assert.equal(after.seeks, before.seeks + 1, 'one seek on release');
    assert.equal(after.paused, !playing);
  }
  await page.locator('#play-pause').click();
  const beforeKeyboard = await audioState();
  await page.locator('#seek').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal((await audioState()).seeks, beforeKeyboard.seeks + 1, 'keyboard commits once');
  const beforeCancel = await audioState();
  await page.locator('#seek').evaluate((s) => {
    s.value = 200;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('pointercancel', { bubbles: true }));
  });
  assert.equal((await audioState()).seeks, beforeCancel.seeks, 'cancel does not commit');
  await page.locator('#submit-answers').click();
  await page.evaluate(() => document.querySelectorAll('.sentence-time')[40].click());
  await page.waitForTimeout(200);
  const visible = () =>
    page.locator('.sentence.is-current').evaluate((n) => {
      const r = n.getBoundingClientRect(),
        t = document.querySelector('#transcript').getBoundingClientRect();
      return r.bottom > t.top && r.top < t.bottom;
    });
  assert.equal(await visible(), true, 'jump follows within 250 ms');
  await page.locator('#play-pause').click();
  await page.waitForTimeout(200);
  assert.equal(await visible(), true, 'normal playback follows');
  await page
    .locator('#transcript')
    .evaluate((n) => n.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true })));
  assert.equal(await page.locator('#follow-toggle').getAttribute('aria-pressed'), 'false');
  await page.locator('#follow-toggle').click();
  assert.equal(await visible(), true);
  await page.locator('.evidence-link').first().click();
  await page.waitForTimeout(200);
  assert.equal(await visible(), true, 'evidence playback follows');
  const evidenceEnd = await page.evaluate(async () => {
    const { listeningBridge } = await import('/app.mjs');
    const e = listeningBridge.getListeningState().lesson.questions.find((q) => q.evidence?.length)
      .evidence[0];
    return e.contextEnd ?? e.end;
  });
  await page.locator('#audio').evaluate((a, end) => {
    a.currentTime = end - 0.25;
  }, evidenceEnd);
  const dragBox = await page.locator('#seek').boundingBox();
  await page.mouse.move(dragBox.x + dragBox.width * 0.35, dragBox.y + dragBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(dragBox.x + dragBox.width * 0.7, dragBox.y + dragBox.height / 2, { steps: 3 });
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.waitForTimeout(200);
  assert.equal(
    (await audioState()).paused,
    false,
    'drag retains gesture-start playback even if evidence ends while held',
  );
  await page.locator('#audio').evaluate((a) => a.pause());
  await page.locator('#change-paper').click();
  await page.locator('#practice-task').selectOption('3');
  await ready();
  await page.locator('.question-input').first().fill('my Task 3 answer');
  await page.locator('#play-pause').click();
  await page.locator('#submit-answers').click();
  assert.equal(await page.locator('#questions .reference-answer').count(), 14);
  assert.equal(
    await page.locator('#original-responses .question-input').first().inputValue(),
    'my Task 3 answer',
  );
  await page.goto(`${process.env.TEST_URL || 'http://127.0.0.1:4175'}/#papers`);
  await page.waitForSelector('#paper-task');
  await page.locator('#paper-task').selectOption('2');
  await page.locator('[data-source-ref="p-9f8236cfe333"]').click();
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('#paper-page').value === '6' &&
        document.querySelector('#paper-source-title').textContent.includes('MS'),
    );
  } catch (error) {
    console.log(
      'Library diagnostic',
      await page.evaluate(() =>
        Object.fromEntries(
          [
            'paper-year',
            'paper-variant',
            'paper-part',
            'paper-task',
            'paper-page',
            'paper-source-title',
            'paper-notice',
          ].map((id) => {
            const n = document.getElementById(id);
            return [id, n?.value ?? n?.textContent];
          }),
        ),
      ),
    );
    throw error;
  }
  assert.match(
    await page.locator('#paper-source-title').textContent(),
    /MS/,
    'library opens current Task marking page',
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS one-commit pointer/keyboard/cancel, 200 ms follow/manual recovery and 2025 A3 submission',
  );
} finally {
  await browser.close();
}
