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
const url = new URL(process.env.TEST_URL || 'http://127.0.0.1:4174');
url.hash = 'listening';
const reportPath =
  process.argv.find((arg) => arg.startsWith('--report='))?.slice(9) ||
  fileURLToPath(new URL('./artifacts/background-color-browser.json', import.meta.url));
const report = { passed: false, viewports: [] };
try {
  for (const [width, height] of [
    [1280, 900],
    [810, 1080],
    [390, 844],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url.href);
    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        background: getComputedStyle(document.body).backgroundColor,
        text: getComputedStyle(document.body).color,
        surface: root.getPropertyValue('--surface').trim(),
        mutedSurface: root.getPropertyValue('--surface-muted').trim(),
        border: root.getPropertyValue('--line').trim(),
        primary: root.getPropertyValue('--pine').trim(),
        lilac: root.getPropertyValue('--lilac').trim(),
        lime: root.getPropertyValue('--lime').trim(),
        adjustmentInput: getComputedStyle(document.querySelector('.subtitle-adjustment input'))
          .backgroundColor,
        theme: document.querySelector('meta[name="theme-color"]').content,
      };
    });
    report.viewports.push({ width, height, colors });
    assert.deepEqual(colors, {
      background: 'rgb(232, 239, 246)',
      text: 'rgb(36, 36, 31)',
      surface: '#fffefa',
      mutedSurface: '#eee9df',
      border: '#dcd6cb',
      primary: '#24241f',
      lilac: '#c4bbfe',
      lime: '#d4e73e',
      adjustmentInput: 'rgb(247, 242, 232)',
      theme: '#E8EFF6',
    });
    await page.close();
  }
  report.passed = true;
} catch (error) {
  report.failure = error.stack;
  process.exitCode = 1;
} finally {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify(report));
