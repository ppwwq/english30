import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import { fileURLToPath } from 'node:url';

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE ||
    new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_EXECUTABLE || undefined,
});
const base = new URL(process.env.TEST_URL || 'http://127.0.0.1:4174');
base.hash = 'listening';
const report = { cases: [], errors: [], physicalDevice: false };
const reportPath =
  process.argv.find((arg) => arg.startsWith('--report='))?.slice(9) ||
  fileURLToPath(new URL('./artifacts/paper-layout-browser.json', import.meta.url));
async function check(name, run) {
  const result = { name, passed: false };
  report.cases.push(result);
  try {
    await run(result);
    result.passed = true;
  } catch (error) {
    result.failure = error.stack;
    process.exitCode = 1;
  }
}
try {
  await check(
    'both mode labels stay inside their actual buttons at desktop, iPad and phone widths',
    async (result) => {
      result.viewports = [];
      for (const [width, height] of [
        [1280, 900],
        [810, 1080],
        [390, 844],
      ]) {
        const context = await browser.newContext({
          viewport: { width, height },
          reducedMotion: 'reduce',
          hasTouch: width < 1000,
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => report.errors.push(error.message));
        await page.goto(base.href);
        await page.waitForFunction(
          () =>
            document.querySelector('#paper-drill-play') &&
            !document.querySelector('#paper-drill-play').disabled,
        );
        await page.evaluate(async () => {
          await document.fonts.ready;
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const labels = await page.locator('#listening-modes .phase-switch').evaluate((track) => {
          const buttons = [...track.querySelectorAll(':scope > button')];
          return [...track.querySelectorAll('.rubber-copy')].map((copy, index) => {
            const range = document.createRange();
            range.selectNodeContents(copy);
            const text = range.getBoundingClientRect(),
              button = buttons[index].getBoundingClientRect();
            return {
              label: copy.textContent,
              text: { left: text.left, right: text.right },
              button: { left: button.left, right: button.right },
            };
          });
        });
        result.viewports.push({ width, labels });
        await context.close();
        assert.equal(labels.length, 2);
        for (const label of labels)
          assert.ok(
            label.text.left >= label.button.left - 1 && label.text.right <= label.button.right + 1,
            JSON.stringify({ width, ...label }),
          );
      }
    },
  );
  await check(
    'Tab focus stays below the visible sticky audio controls after a dictation submission',
    async (result) => {
      result.viewports = [];
      for (const [width, height] of [
        [1280, 900],
        [810, 1080],
        [390, 844],
      ]) {
        const context = await browser.newContext({
          viewport: { width, height },
          reducedMotion: 'reduce',
          hasTouch: width < 1000,
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => report.errors.push(error.message));
        await page.goto(base.href);
        await page.waitForFunction(
          () =>
            document.querySelector('#paper-drill-play') &&
            !document.querySelector('#paper-drill-play').disabled,
        );
        await page.locator('#paper-drill summary').click();
        await page.locator('#paper-drill-play').click();
        await page.waitForFunction(() => !document.querySelector('#paper-audio').paused);
        await page.locator('#paper-drill-answer').fill("I don't know.");
        await page.locator('#paper-drill-submit').click();
        await page.locator('#paper-drill-feedback').waitFor({ state: 'visible' });
        await page.locator('#paper-drill-sentence').focus();
        await page.keyboard.press('Tab');
        await page.evaluate(
          () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const geometry = await page.evaluate(() => {
          const active = document.activeElement,
            target = active.getBoundingClientRect();
          const panel = document.querySelector('#paper-audio-panel').getBoundingClientRect();
          const hit = document.elementFromPoint(
            target.left + target.width / 2,
            target.top + target.height / 2,
          );
          return {
            id: active.id,
            top: target.top,
            bottom: target.bottom,
            panelBottom: panel.bottom,
            viewportHeight: innerHeight,
            centerVisible: active.contains(hit),
            focusVisible: active.matches(':focus-visible'),
          };
        });
        result.viewports.push({ width, geometry });
        await context.close();
        assert.equal(geometry.id, 'paper-drill-play');
        assert.ok(
          geometry.focusVisible &&
            geometry.centerVisible &&
            geometry.top >= geometry.panelBottom &&
            geometry.bottom <= geometry.viewportHeight,
          JSON.stringify({ width, geometry }),
        );
      }
    },
  );
  assert.deepEqual(report.errors, []);
} finally {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report));
