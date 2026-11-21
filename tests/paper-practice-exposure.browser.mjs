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
const base = process.env.TEST_URL || 'http://127.0.0.1:4174';
const report = { cases: [], errors: [], physicalDevice: false };
const ready = (page) => page.waitForFunction(() => !document.getElementById('play-pause').disabled);

async function scenario(name, reveal, wholePaper = false) {
  const context = await browser.newContext({ viewport: { width: 810, height: 1080 }, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  try {
    await page.goto(base + (wholePaper ? '/#listening' : '/#listening/practice'));
    await ready(page);
    await page.locator('.question-input').first().fill('my original draft');
    await page.locator('#home-back').click();
    await page.locator('.main-navigation [data-view="library"]').click();
    await page.locator('#paper-review').waitFor();
    await page.waitForFunction(() => !document.getElementById('paper-play').disabled);
    await reveal(page);
    if (wholePaper) {
      await page.locator('#home-back').click();
      await page.locator('.main-navigation [data-view="listening"]').click();
    } else {
      await page.evaluate(() => {
        location.hash = 'listening/practice';
      });
      await page.waitForFunction(
        () =>
          document.body.dataset.view === 'listening' && document.body.dataset.listeningMode === 'practice',
      );
    }
    await ready(page);
    assert.equal(await page.locator('.question-input').first().inputValue(), 'my original draft');
    if (wholePaper) {
      await page.reload();
      await ready(page);
      assert.equal(await page.locator('.question-input').first().inputValue(), 'my original draft');
      assert.match(await page.locator('.question-panel .quiet-label').innerText(), /辅助作答/);
    }
    await page.locator('#play-pause').click();
    await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.05);
    await page.locator('#submit-answers').click();
    const state = await page.evaluate(async () =>
      (await import('/app.mjs')).listeningBridge.getListeningState(),
    );
    const attempt = state.session.attempts.at(-1);
    assert.equal(
      attempt.assisted,
      true,
      'Viewing original references must mark the open focused attempt as assisted',
    );
    assert.equal(attempt.priorExposure, true);
    if (wholePaper) {
      assert.notEqual(
        state.catalogue.find((entry) => entry.id === 'paper-2025-exam-a-task-2').exposure,
        'fresh',
      );
    }
    assert.equal(await page.evaluate(() => localStorage.getItem('english30-records-v1')), null);
    report.cases.push(name);
    console.log('PASS', name);
  } finally {
    await context.close();
  }
}

try {
  await scenario('original-library subtitles mark a retained focused draft as assisted', async (page) => {
    await page.locator('#paper-review').click();
    await page.locator('#paper-transcript-panel').waitFor({ state: 'visible' });
  });
  await scenario(
    'original-library marking references expose the whole matching paper',
    async (page) => {
      await page
        .locator('#paper-references [data-source-ref]')
        .filter({ hasText: '评分参考' })
        .first()
        .click();
    },
    true,
  );
  assert.deepEqual(report.errors, []);
} finally {
  await fs.mkdir('tests/artifacts', { recursive: true });
  await fs.writeFile('tests/artifacts/paper-practice-exposure-browser.json', JSON.stringify(report, null, 2));
  await browser.close();
}
