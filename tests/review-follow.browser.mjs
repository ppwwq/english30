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
try {
  const context = await browser.newContext({ viewport: { width: 1080, height: 810 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.goto(listeningPracticeURL());
  await page.waitForFunction(() => !document.getElementById('play-pause').disabled);
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.1);
  await page.locator('#seek').fill('20');
  await page.waitForFunction(() => document.getElementById('audio').currentTime >= 20);
  await page.locator('#mark-moment').click();
  await page.locator('#submit-answers').click();
  await page.locator('[data-word-id="w0005"]').click();
  await page.locator('#mark-heard').click();
  await page.locator('#audio').evaluate((a) => a.pause());
  for (const label of ['word bookmark', 'time bookmark']) {
    if ((await page.locator('#follow-toggle').getAttribute('aria-pressed')) === 'true')
      await page.locator('#follow-toggle').click();
    await page.locator('#loop-more > summary').click();
    await page.locator('#open-review-marks').click();
    const row =
      label === 'word bookmark'
        ? page.locator('#marks-list .marked-word').first()
        : page.locator('#marks-list button').filter({ hasText: '没听清' }).first();
    await row.click();
    await page.waitForTimeout(350);
    const item = {
      name: label,
      follow: await page.locator('#follow-toggle').getAttribute('aria-pressed'),
      current: await page.locator('.sentence.is-current').count(),
    };
    report.cases.push(item);
    assert.equal(item.follow, 'true', 'review bookmark playback must restore subtitle follow');
    assert.equal(item.current, 1);
    const geometry = await page.locator('.sentence.is-current').evaluate((n) => {
      const r = n.getBoundingClientRect(),
        t = document.getElementById('transcript').getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, containerTop: t.top, containerBottom: t.bottom };
    });
    assert.ok(geometry.bottom > geometry.containerTop && geometry.top < geometry.containerBottom);
    await page.locator('#audio').evaluate((a) => a.pause());
    item.passed = true;
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.failure = e.message;
  process.exitCode = 1;
} finally {
  await browser.close();
  const p = process.argv.find((x) => x.startsWith('--report='))?.slice(9);
  if (p) await fs.writeFile(p, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
