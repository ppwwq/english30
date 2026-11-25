import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import https from 'node:https';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium, webkit } = require('playwright');
const isWebKit = process.env.TEST_ENGINE === 'webkit';
const browser = await (isWebKit ? webkit : chromium).launch({
  executablePath: isWebKit ? process.env.WEBKIT_EXECUTABLE : process.env.CHROMIUM_EXECUTABLE,
});
const original = new URL(process.env.TEST_URL || 'http://127.0.0.1:4173');
const upstream = original.protocol === 'https:' ? https : http;
let release,
  mediaRequest,
  failing = true;
const pending = new Promise((resolve) => {
  mediaRequest = resolve;
});
const hold = new Promise((resolve) => {
  release = resolve;
});
// WebKit can load native media outside the browser automation request router.
const gateway = http.createServer(async (req, res) => {
  if (failing && req.url === '/audio/paper-2025-exam-a-task-1.mp3') {
    mediaRequest();
    await hold;
    res.writeHead(503);
    return res.end();
  }
  const forwarded = upstream.request(
    {
      hostname: original.hostname,
      port: original.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: original.host },
    },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  forwarded.on('error', () => res.destroy());
  res.on('close', () => forwarded.destroy());
  req.pipe(forwarded);
});
await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + gateway.address().port;
let page;
try {
  page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/#listening', { waitUntil: 'domcontentloaded' });
  await Promise.race([
    pending,
    page.waitForTimeout(10000).then(() => {
      throw Error('未收到所选 Task 的音频请求');
    }),
  ]);
  await page.locator('#answer-q1').fill('7000');
  assert.equal(await page.locator('#play-pause').isDisabled(), true);
  await page.locator('#continue-question-group').click();
  assert.equal(await page.locator('#answer-q5').isVisible(), true);
  await page.locator('#previous-question-page').click();
  release();
  await page.locator('#audio-retry').waitFor();
  failing = false;
  await page.locator('#audio-retry').click();
  await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  assert.equal(await page.locator('#answer-q1').inputValue(), '7000');
  assert.match(
    await page.locator('#audio').evaluate((a) => a.currentSrc),
    /\/audio\/paper-2025-exam-a-task-1\.mp3$/,
  );
  await page.locator('#play-pause').click();
  await page.waitForFunction(() => document.querySelector('#audio').currentTime > 0.1);
  await page.locator('#submit-answers').click();
  const dialog = page.getByRole('dialog', { name: '交整份 Task？' });
  const prompt = await dialog.innerText();
  assert.equal(
    await dialog.getByRole('button', { name: '取消' }).evaluate((n) => n === document.activeElement),
    true,
  );
  await page.keyboard.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  assert.match(prompt, /13 题.*12 题未答/);
  assert.equal(await page.locator('#transcript .word').count(), 0);
  await page.locator('#submit-answers').click();
  await page.keyboard.press('Tab');
  assert.equal(
    await dialog.getByRole('button', { name: '确认交卷' }).evaluate((n) => n === document.activeElement),
    true,
  );
  await page.keyboard.press('Enter');
  const summary = page.locator('.result-summary');
  assert.match(await summary.innerText(), /已答 1 题 · 未答 12 题/);
  assert.match(await summary.innerText(), /1\/1 题与参考表达匹配/);
  assert.equal(
    await summary.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return (
        document.activeElement === node &&
        bounds.top >= 0 &&
        bounds.bottom <= document.querySelector('.player').getBoundingClientRect().top
      );
    }),
    true,
  );
  await page.waitForFunction(
    () => document.querySelector('#transcript').getAttribute('aria-busy') !== 'true',
  );
  const lesson = await (
    await page.request.get(base + '/papers/practice/paper-2025-exam-a-task-1.json')
  ).json();
  assert.deepEqual(
    await page.locator('#transcript .word').allTextContents(),
    lesson.sentences.flatMap((s) => s.words.map((w) => w.text)),
  );
  await page.locator('#phase-retest').click();
  assert.equal(await page.locator('#transcript .word').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS editable questions before audio, native streaming and retry, navigation, explicit whole-Task submit, visible feedback and concealed retest',
  );
} catch (error) {
  if (page)
    console.error(
      await page
        .evaluate(() => {
          const a = document.querySelector('#audio');
          return {
            status: document.querySelector('#status')?.textContent,
            source: a?.currentSrc,
            paused: a?.paused,
            time: a?.currentTime,
            duration: a?.duration,
            network: a?.networkState,
            ready: a?.readyState,
            error: a?.error?.code,
          };
        })
        .catch(() => null),
    );
  throw error;
} finally {
  release();
  gateway.closeAllConnections();
  gateway.close();
  await browser.close();
}
