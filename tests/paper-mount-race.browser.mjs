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
const page = await browser.newPage();
page.on('dialog', (d) => d.accept());
const held = [],
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const body = await fs.readFile(new URL('../web/papers/sessions/2025-exam.json', import.meta.url), 'utf8');
try {
  await page.route('**/papers/sessions/2025-exam.json', (r) => held.push(r));
  await page.goto(`${process.env.TEST_URL || 'http://127.0.0.1:4175'}/#papers`, {
    waitUntil: 'domcontentloaded',
  });
  await page.locator('#paper-task option[value="2"]').waitFor({ state: 'attached' });
  await page.locator('#paper-task').selectOption('2');
  await page.locator('[data-source-ref="p-9f8236cfe333"]').click();
  await page.waitForFunction(() => document.querySelector('#paper-source-title').textContent.includes('MS'));
  assert.equal(held.length, 2);
  await held[0].fulfill({ status: 200, contentType: 'application/json', body });
  await page.waitForTimeout(400);
  assert.equal(held.length, 2, 'mount completion must not restart the newer in-flight selection');
  assert.match(await page.locator('#paper-source-title').textContent(), /MS/);
  await held[1].fulfill({ status: 200, contentType: 'application/json', body });
  await page.waitForFunction(() => !document.querySelector('#paper-play').disabled);
  assert.equal(await page.locator('#paper-task').inputValue(), '2');
  assert.equal(await page.locator('#paper-page').inputValue(), '6');
  assert.match(await page.locator('#paper-source-title').textContent(), /MS/);
  assert.deepEqual(errors, []);
  console.log('PASS delayed initial mount cannot replace newer Task selection or its marking page');
} finally {
  await browser.close();
}
