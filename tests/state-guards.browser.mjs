import { allowBeforeUnload, answerConfirmation } from './confirmation-helpers.mjs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const testUrl = new URL(process.env.TEST_URL || 'http://127.0.0.1:4173/');
testUrl.hash = 'listening/practice';
const reportPath =
  process.argv.find((arg) => arg.startsWith('--report='))?.slice(9) ||
  fileURLToPath(new URL('./artifacts/state-guards-final.json', import.meta.url));
const report = { cases: [], errors: [], passed: false };
let browser;

async function ready(page) {
  await page.goto(testUrl.href);
  await page.waitForFunction(() => !document.getElementById('play-pause').disabled);
}

async function submitFirstAttempt(page) {
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.05);
  await page.locator('#submit-answers').click();
  await page.waitForFunction(
    () => document.getElementById('phase-review').getAttribute('aria-pressed') === 'true',
  );
}

async function openRecordDrawer(page) {
  const summary = page.locator('summary').filter({ hasText: '本次复习标记' });
  if (!(await summary.evaluate((node) => node.parentElement.open))) await summary.click();
}

async function scenario(name, run) {
  const context = await browser.newContext({ viewport: { width: 1080, height: 810 }, hasTouch: true });
  const page = await context.newPage();
  const item = { name, passed: false };
  report.cases.push(item);
  page.on('pageerror', (error) => report.errors.push({ scenario: name, message: error.message }));
  try {
    await run(page, item);
    item.passed = true;
  } catch (error) {
    item.failure = error.message;
  } finally {
    await context.close();
  }
}

try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
  });

  await scenario(
    'navigation cancels a pending evidence seek before the hidden player can start',
    async (page, item) => {
      await ready(page);
      await submitFirstAttempt(page);
      // Both actions occur before the native seeked event: this consistently covers
      // the race where navigation pauses audio that has not started playing yet.
      await page.evaluate(() => {
        document.querySelector('.evidence-link').click();
        document.querySelector('[data-view="reading"]').click();
      });
      await page.waitForTimeout(700);
      item.state = await page.evaluate(() => ({
        view: document.body.dataset.view,
        paused: document.getElementById('audio').paused,
        currentTime: document.getElementById('audio').currentTime,
        playerHidden: document.querySelector('.player').hidden,
      }));
      assert.equal(item.state.view, 'reading');
      assert.equal(item.state.playerHidden, true);
      assert.equal(item.state.paused, true, 'a delayed seek must not resume playback after navigation');
    },
  );

  await scenario(
    'cancelling same-material review preserves the unfinished retest answers',
    async (page, item) => {
      allowBeforeUnload(page);
      await ready(page);
      await submitFirstAttempt(page);
      await page.locator('[data-word-id="w0001"]').click();
      await page.locator('#mark-heard').click();
      await openRecordDrawer(page);
      await page.locator('#session-save').click();
      await answerConfirmation(page, '确认保存');
      await page.waitForFunction(
        () => JSON.parse(localStorage.getItem('english30-records-v1') || '[]').length === 1,
      );
      await page.locator('#phase-retest').click();
      await page.locator('#answer-q1').fill('my unsaved retest answer');
      await page.evaluate(() => {
        location.hash = 'review';
      });
      await page.locator('button').filter({ hasText: '回原音复习' }).first().click();
      const restorePrompt = (await answerConfirmation(page, '取消')).includes('回听会结束');
      item.state = await page.evaluate(async () => {
        const { listeningBridge } = await import('./app.mjs');
        return {
          phase: listeningBridge.getListeningState().session.phase,
          draft: document.getElementById('answer-q1').value,
        };
      });
      item.restorePrompt = restorePrompt;
      assert.equal(
        restorePrompt,
        true,
        'restoring a saved review must warn before replacing the current retest',
      );
      assert.equal(item.state.phase, 'retest');
      assert.equal(item.state.draft, 'my unsaved retest answer');
    },
  );

  await scenario('edits made during save confirmation remain visibly unsaved', async (page, item) => {
    allowBeforeUnload(page);
    await ready(page);
    await submitFirstAttempt(page);
    await page.locator('[data-word-id="w0001"]').click();
    await page.locator('#mark-heard').click();
    await openRecordDrawer(page);
    await page.locator('#session-save').click();
    await page.getByRole('dialog').waitFor();
    // Simulate a change arriving while the confirmation summary is already open.
    await page.evaluate(() => document.querySelector('#mark-unknown').click());
    await answerConfirmation(page, '确认保存');
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem('english30-records-v1') || '[]').length === 1,
    );
    item.state = await page.evaluate(async () => {
      const { listeningBridge } = await import('./app.mjs');
      const state = listeningBridge.getListeningState();
      return {
        current: state.session.marks.w0001,
        saved: state.savedRecords.at(-1).marks.w0001,
        status: document.getElementById('status').textContent,
      };
    });
    await page.locator('#lesson-select').selectOption('2025-task1');
    const warning = await answerConfirmation(page, '取消');
    assert.match(warning, /清空未保存/);
    assert.equal(item.state.current, 'unknown');
    assert.equal(item.state.saved, 'heard', 'saving must retain the snapshot the user confirmed');
    assert.match(item.state.status, /新修改尚未保存/);
    assert.equal(await page.getByRole('dialog').count(), 0);
  });

  assert.deepEqual(report.errors, []);
  report.passed = report.cases.length === 3 && report.cases.every((item) => item.passed);
} catch (error) {
  report.failure = error.message;
} finally {
  await browser?.close();
  if (!report.passed) process.exitCode = 1;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
