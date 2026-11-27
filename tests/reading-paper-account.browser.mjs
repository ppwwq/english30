import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allowBeforeUnload, answerConfirmation } from './confirmation-helpers.mjs';
import { learningDelta } from '../web/account-learning.mjs';

const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require('playwright');
const directory = await mkdtemp(path.join(tmpdir(), 'english30-reading-account-'));
const server = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: '0', ENGLISH30_ACCOUNT_DIR: directory },
  stdio: ['ignore', 'pipe', 'inherit'],
});
let browser;

try {
  const base = await new Promise((resolve, reject) => {
    server.stdout.once('data', (line) => resolve(line.toString().trim().split(' ').at(-1)));
    server.once('error', reject);
    server.once('exit', () => reject(Error('测试服务提前退出')));
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
  const credentials = { name: 'paper-one-reader', password: 'paper-one-study-123' };
  const errors = [];
  const account = '#account-host';
  const reading = '#reading-paper-host';

  async function device(route, hash = 'reading-paper', data = credentials) {
    const context = await browser.newContext({ viewport: { width: 1194, height: 834 }, hasTouch: true });
    const login = await context.request.post(`${base}/api/account/${route}`, { data });
    assert.equal(login.status(), 200, await login.text());
    const { user } = await login.json();
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    allowBeforeUnload(page);
    await page.goto(`${base}/#${hash}`);
    return { context, page, user };
  }

  const localRecords = (device) =>
    device.page.evaluate((id) => {
      const data = localStorage.getItem(`english30-user:${id}:english30-study-v1`);
      return data ? JSON.parse(data).records : [];
    }, device.user.id);
  const get = async (device, suffix) => {
    const result = await device.context.request.get(`${base}${suffix}`);
    assert.ok(result.ok(), `${suffix}: ${result.status()} ${await result.text()}`);
    return result.json();
  };
  const papers = (device) => get(device, '/api/papers?paper=1');
  const head = (device) => get(device, '/api/learning');
  const save = async (page) => {
    await page.locator('#session-save').click();
    await answerConfirmation(page, '确认保存');
  };
  async function until(action, check, detail) {
    for (let i = 0; i < 100; i++) {
      const result = await action();
      if (check(result)) return result;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
    throw Error(detail);
  }

  const first = await device('register');
  const p = first.page;
  const sheet = p.locator(`${reading} .reading-paper-document[data-kind="question"]`);
  await sheet.getByRole('button', { name: '打字', exact: true }).click();
  await sheet.locator('textarea').fill('The first answer travels between devices.');
  await sheet.getByRole('button', { name: '手写', exact: true }).click();
  const svg = sheet.locator('.paper-ink');
  const box = await svg.boundingBox();
  const wrap = await sheet.locator('.reading-paper-page').boundingBox();
  await p.mouse.move(box.x + 80, wrap.y + 36);
  await p.mouse.down();
  await p.mouse.move(box.x + 135, wrap.y + 58, { steps: 5 });
  await p.mouse.up();
  await svg.locator('.ink-stroke').waitFor();
  await p.locator(reading).getByRole('button', { name: '交卷', exact: true }).click();
  await p.locator(`${reading} [data-check-result]`).selectOption('retry');
  await p.locator(`${reading} [data-check-error]`).selectOption('答案不完整');
  assert.deepEqual(await localRecords(first), []);
  await save(p);
  const initial = await until(
    () => head(first),
    (r) => r.backup?.study.records.length === 1,
    '首次保存未同步。',
  );
  const [record] = initial.backup.study.records;
  const [book] = await papers(first);
  assert.match(book.title, /Paper 1/);
  assert.equal(book.version, 1);
  assert.equal((await get(first, '/api/papers?paper=3')).length, 0);
  const version = `/api/papers/${book.id}/versions/1`;
  const detail = await get(first, version);
  assert.deepEqual(detail.records[record.taskId], record);
  assert.equal(record.details.readingPaper.ink, undefined);
  const [key, hash] = Object.entries(record.details.readingPaper.inkFiles)[0];
  const n = detail.pages.findIndex((page) => page.key === key) + 1;
  assert.ok(n > 0);
  assert.ok(detail.pages[n - 1].hash);
  assert.equal(detail.pages.at(-1).kind, 'typed');
  assert.equal((await get(first, `${version}/pages/${n}/ink`)).strokes.length, 1);
  assert.equal((await get(first, `/api/ink/${hash}`))[key].length, 1);
  assert.equal(
    (await first.context.request.get(base + `${version}/pages/${n}/image`)).headers()['content-type'],
    'image/jpeg',
  );
  const pdf = await first.context.request.get(base + `${version}/pdf`);
  assert.equal(pdf.headers()['content-type'], 'application/pdf');
  assert.equal((await pdf.body()).subarray(0, 4).toString(), '%PDF');

  const second = await device('login', 'account');
  let q = second.page;
  await q
    .locator(account)
    .getByRole('button', { name: /Paper 1/ })
    .click();
  await q.locator(account).getByRole('button', { name: '继续作答' }).click();
  const secondSheet = q.locator(`${reading} .reading-paper-document[data-kind="question"]`);
  await secondSheet.locator('.submitted-ink .ink-stroke').waitFor();
  await secondSheet.getByRole('button', { name: '打字答案', exact: true }).click();
  assert.equal(await secondSheet.locator('textarea').inputValue(), record.answers[1]);
  assert.equal(await q.locator(`${reading} [data-check-error]`).inputValue(), '答案不完整');
  await until(
    () => localRecords(second),
    (r) => r.length === 1,
    '设备 B 的本地学习记录仍为空。',
  );

  // Open the ordinary reading entry in a new tab, without a pinned account version.
  const freshTab = await second.context.newPage();
  freshTab.on('pageerror', (error) => errors.push(error.message));
  allowBeforeUnload(freshTab);
  await q.close();
  second.page = q = freshTab;
  await q.goto(`${base}/#reading-paper`);
  await q.locator(`${reading} [data-check-error]`).selectOption('定位不到依据');
  await p.locator(`${reading} [data-check-result]`).selectOption('correct');
  await save(p);
  const newHead = await until(
    () => head(first),
    (r) => r.backup?.study.records[0]?.details.readingPaper.checks[1]?.status === 'correct',
    '设备 A 的新版未同步。',
  );
  const changed = structuredClone(newHead.backup);
  changed.study.settings.startDate = '2024-10-01';
  const sent = await first.context.request.post(`${base}/api/learning`, {
    headers: { 'X-English30-Owner': first.user.id },
    data: { saveId: crypto.randomUUID(), delta: learningDelta(newHead.backup, changed) },
  });
  assert.ok(sent.ok(), await sent.text());
  const synced = q.waitForResponse(
    (r) => r.url().endsWith('/api/learning') && r.request().method() === 'GET',
  );
  await q.evaluate(() => window.dispatchEvent(new Event('focus')));
  await synced;
  await q.waitForFunction(
    (id) =>
      JSON.parse(localStorage.getItem(`english30-user:${id}:english30-study-v1`)).settings.startDate ===
      '2024-10-01',
    second.user.id,
  );
  assert.equal(await q.locator(`${reading} [data-check-error]`).inputValue(), '定位不到依据');
  assert.equal((await localRecords(second))[0].details.readingPaper.checks[1].error, '答案不完整');
  await save(q);
  await q.waitForFunction(
    () => document.querySelector('#session-save-status').textContent === '已存本机，云端待完成',
  );
  await q.evaluate(() => {
    location.hash = '#account';
  });
  await q.locator(account).getByText('这份答卷已有新版').waitFor();
  await q.locator(account).getByRole('button', { name: '另存为独立答卷' }).click();
  const [copy] = (
    await until(
      () => papers(first),
      (r) => r.length === 2,
      '未创建独立答卷。',
    )
  ).filter((r) => r.id !== book.id);
  const last = await until(
    () => head(first),
    (r) => r.backup?.study.records.length === 2,
    '另存副本未同步。',
  );
  assert.equal(
    last.backup.study.records.find((r) => r.id === record.id).details.readingPaper.checks[1].status,
    'correct',
  );
  const copied = last.backup.study.records.find((r) => r.id === `a-${copy.id}`).details.readingPaper;
  assert.equal(copied.checks[1].error, '定位不到依据');
  assert.equal(copied.copyOf, record.id);

  // The pull also runs while a device already has an acknowledged local save.
  const pulled = p.waitForResponse(
    (r) => r.url().endsWith('/api/learning') && r.request().method() === 'GET',
  );
  await p.evaluate(() => window.dispatchEvent(new Event('focus')));
  await pulled;
  await until(
    () => localRecords(first),
    (r) => r.length === 2,
    '非空设备未取回另一台设备的记录。',
  );

  const outsider = await device('register', 'account', { ...credentials, name: 'paper-one-other' });
  assert.equal((await outsider.context.request.get(`${base}/api/ink/${hash}`)).status(), 404);
  assert.equal((await outsider.context.request.get(base + version)).status(), 404);
  const portable = await p.evaluate(async () => {
    const { portableReadingBackup } = await import('/reading-paper-storage.mjs');
    const current = await (await fetch('/api/learning')).json();
    return portableReadingBackup(current.backup);
  });
  assert.equal(portable.study.records[0].details.readingPaper.ink[key].length, 1);
  const other = outsider.page.locator(account);
  await other.locator('.account-settings > summary').click();
  const picking = outsider.page.waitForEvent('filechooser');
  await other.getByRole('button', { name: '从完整备份导入' }).click();
  const picker = await picking;
  await picker.setFiles({
    name: 'paper1-test-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(portable)),
  });
  await answerConfirmation(outsider.page, '确认导入');
  await other.getByText('已导入完整学习备份。').waitFor();
  assert.equal((await papers(outsider)).length, 2);
  const imported = await head(outsider);
  assert.equal(imported.backup.study.records[0].details.readingPaper.inkFiles[key], hash);
  assert.equal((await get(outsider, `/api/ink/${hash}`))[key].length, 1);

  await second.context.clearCookies();
  await q.evaluate(() => window.dispatchEvent(new Event('focus')));
  await q.locator(account).getByRole('heading', { name: '重新登录' }).waitFor();
  await q.locator(account).getByLabel('密码', { exact: true }).fill(credentials.password);
  const relogged = q.waitForResponse(
    (r) => r.url().endsWith('/api/account/login') && r.request().method() === 'POST',
  );
  await q.locator(`${account} .account-auth [type=submit]`).click();
  const loginResult = await relogged;
  assert.ok(loginResult.ok(), await loginResult.text());
  await q
    .locator(`${account} .account-settings`)
    .waitFor({ timeout: 7000 })
    .catch(async (error) => {
      throw Error(`${error.message}\n${await q.locator(account).innerText()}\n${errors.join('\n')}`);
    });
  assert.equal((await papers(second)).length, 2);
  assert.deepEqual(errors, []);
  console.log(
    'Paper 1 saved to two local browser profiles: page images, PDF, ink, conflict copies, automatic sync and re-login verified.',
  );
} finally {
  await browser?.close();
  server.kill();
}
