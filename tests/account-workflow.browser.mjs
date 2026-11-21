import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const dir = await mkdtemp(path.join(tmpdir(), 'english30-account-test-'));
const external = process.env.ENGLISH30_LOCAL_TEST_URL;
if (external && !['127.0.0.1', 'localhost'].includes(new URL(external).hostname))
  throw Error('本测试仅使用本机服务。');
const child = external
  ? null
  : spawn(process.execPath, ['server.mjs'], {
      env: { ...process.env, PORT: '0', ENGLISH30_ACCOUNT_DIR: dir },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
let browser;
try {
  const base =
    external ||
    (await new Promise((resolve, reject) => {
      child.stdout.once('data', (line) => resolve(line.toString().trim().split(' ').at(-1)));
      child.once('error', reject);
      child.once('exit', () => reject(Error('测试服务提前退出')));
    }));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
  const user = 'student-' + Date.now(),
    password = 'study-practice-123';
  const errors = [];
  async function paperCount(page, count) {
    for (let i = 0; i < 120; i++) {
      const rows = await (await page.request.get(base + '/api/papers')).json();
      if (rows.length === count) return rows;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw Error('答卷数与预期不符。' + (await page.locator('#account-host').innerText()));
  }
  async function device(register) {
    const ctx = await browser.newContext({ viewport: { width: 1194, height: 834 }, hasTouch: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('dialog', (d) => d.accept());
    page.on('response', async (r) => {
      if (r.status() >= 400 && r.url().includes('/api/') && r.request().method() !== 'HEAD')
        console.log(r.status(), new URL(r.url()).pathname, (await r.text()).slice(0, 240));
    });
    await page.goto(base);
    await page.getByRole('link', { name: '登录账号', exact: true }).click();
    assert.equal(
      await page.getByLabel('用户名', { exact: true }).evaluate((el) => el === document.activeElement),
      true,
    );
    if (register) await page.getByRole('button', { name: '注册账号', exact: true }).click();
    await page.getByLabel('用户名', { exact: true }).fill(user);
    await page.getByLabel('密码', { exact: true }).fill(password);
    await page.locator('.account-auth [type=submit]').click();
    await page.getByText('当前账号 · ' + user, { exact: true }).waitFor();
    if (register) await page.getByRole('button', { name: '我已保存恢复码' }).click();
    return { ctx, page };
  }
  const first = await device(true),
    p = first.page;
  await p.locator('#home-back').click();
  await p.locator('[data-view=listening]').click();
  await p.locator('#practice-part').selectOption('B1');
  await p.locator('#practice-task').selectOption('6');
  await p.waitForFunction(
    () =>
      document.querySelector('#lesson-meta').textContent.includes('Task 6') &&
      !document.querySelector('#play-pause').disabled,
  );
  await p.getByRole('button', { name: '手写作答', exact: true }).click();
  assert.equal(await p.locator('#practice-page').inputValue(), '12');
  async function draw(page, points) {
    const svg = page.locator('.paper-ink');
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    for (const [i, [x, y]] of points.entries())
      await svg.dispatchEvent(
        i === 0 ? 'pointerdown' : i === points.length - 1 ? 'pointerup' : 'pointermove',
        {
          pointerId: 4,
          pointerType: 'pen',
          pressure: 0.7,
          button: 0,
          clientX: box.x + x * box.width,
          clientY: box.y + y * box.height,
        },
      );
  }
  await draw(p, [
    [0.13, 0.2],
    [0.22, 0.32],
    [0.58, 0.36],
  ]);
  assert.equal(await p.locator('.ink-stroke').count(), 1);
  await p.locator('#play-pause').click();
  await p.locator('#submit-answers').click();
  const submit = async (page, combined = false) => {
    await page.locator('#session-save').click();
    if (combined) await page.locator('.account-save-dialog input[type=checkbox]:visible').check();
    await page.getByRole('button', { name: '确认保存', exact: true }).click();
    await page
      .waitForFunction(
        () => document.querySelector('#session-save-status').textContent.includes('已存云端'),
        null,
        { timeout: 45000 },
      )
      .catch(async (e) => {
        throw Error((await page.locator('.session-savebar').innerText()) + ' ' + e.message);
      });
  };
  await submit(p);
  const papers = await (await p.request.get(base + '/api/papers?year=2025&part=B1')).json();
  assert.equal(papers.length, 1);
  const url = base + '/api/papers/' + papers[0].id + '/versions/';
  await first.ctx.close();
  const second = await device(false),
    q = second.page;
  await q.locator('.account-paper').waitFor();
  assert.equal(await q.locator('.account-paper').count(), 1);
  await q.locator('.account-paper').click();
  await q.locator('.account-page img').evaluate((i) => i.decode());
  assert.equal(await q.getByLabel('页码', { exact: true }).inputValue(), '12');
  const detail = await (await q.request.get(url + '1')).json();
  assert.equal(detail.pages.length, 14);
  assert.equal(detail.ink[detail.pages[11].key].length, 1);
  const original = await q.request.get(base + '/api/books/master/' + detail.pages[11].master);
  const ink = await q.request.get(url + '1/pages/12/image');
  assert.equal(ink.status(), 200);
  assert.notDeepEqual(await ink.body(), await original.body());
  const pdf = await q.request.get(url + '1/pdf');
  assert.equal(pdf.status(), 200);
  const pdfBytes = await pdf.body();
  assert.match(pdfBytes.toString('latin1'), /\/Type \/Pages \/Count 14 /);
  if (process.env.ACCOUNT_EVIDENCE) {
    await writeFile(path.join(process.env.ACCOUNT_EVIDENCE, 'b1-v1.pdf'), pdfBytes);
    await writeFile(path.join(process.env.ACCOUNT_EVIDENCE, 'b1-page12.jpg'), await ink.body());
    await writeFile(path.join(process.env.ACCOUNT_EVIDENCE, 'b1-page12-base.jpg'), await original.body());
    await q.screenshot({ path: path.join(process.env.ACCOUNT_EVIDENCE, 'account-detail.png') });
  }
  const other = await browser.newContext();
  assert.equal((await other.request.get(url + '1/pdf')).status(), 401);
  await other.request.post(base + '/api/account/register', {
    data: { name: 'other-' + Date.now(), password },
  });
  assert.equal((await other.request.get(url + '1/pages/12/image')).status(), 404);
  const otherMember = await (await other.request.get(base + '/api/account/me')).json();
  assert.ok(otherMember.user);
  assert.equal((await other.request.get(url + '1/pdf')).status(), 404);
  await other.close();
  await q.getByRole('button', { name: '继续作答', exact: true }).click();
  await q.waitForURL('**/#listening');
  await q.locator('.paper-ink .ink-stroke').first().waitFor();
  assert.equal(await q.locator('.paper-ink .ink-stroke').count(), 1);
  await draw(q, [
    [0.14, 0.42],
    [0.38, 0.5],
    [0.63, 0.46],
  ]);
  await q.locator('#submit-answers').click();
  await submit(q);
  const v2 = await (await q.request.get(url + '2')).json();
  assert.equal(v2.pages.length, 14);
  assert.equal(v2.ink[detail.pages[11].key].length, 2);
  assert.equal((await (await q.request.get(url + '1')).json()).ink[detail.pages[11].key].length, 1);
  // The second device opens the first revision after revision 2 was saved.
  const accountPage = async () => {
    await q.locator('#home-back').click();
    await q.getByRole('link', { name: '我的答卷（' + user + '）', exact: true }).click();
  };
  await accountPage();
  await q.getByLabel('保存版本', { exact: true }).waitFor();
  await q.getByLabel('保存版本', { exact: true }).selectOption('1');
  await q.waitForFunction(() => document.querySelector('.account-page img')?.src.includes('/versions/1/'));
  await q.getByRole('button', { name: '继续作答', exact: true }).click();
  await q.waitForURL('**/#listening');
  await q.locator('.paper-ink .ink-stroke').first().waitFor();
  assert.equal(await q.locator('.paper-ink .ink-stroke').count(), 1);
  await draw(q, [
    [0.18, 0.62],
    [0.4, 0.58],
    [0.55, 0.67],
  ]);
  await q.locator('#submit-answers').click();
  await q.locator('#session-save').click();
  await q.getByRole('button', { name: '确认保存', exact: true }).click();
  await q.locator('#session-save-status').filter({ hasText: '已存本机，云端待完成' }).waitFor();
  await accountPage();
  await q.getByRole('button', { name: '另存为独立答卷' }).click();
  await paperCount(q, 2);
  await q.waitForFunction(
    () =>
      !document.querySelector('#account-host [aria-busy=true]') &&
      document.querySelector('#account-host').getAttribute('aria-busy') !== 'true',
  );
  const rows = await (await q.request.get(base + '/api/papers')).json();
  assert.equal(rows.find((r) => r.id === papers[0].id).version, 2);
  const copy = rows.find((r) => r.id !== papers[0].id);
  assert.equal(copy.version, 1);
  const copyDetail = await (await q.request.get(base + '/api/papers/' + copy.id + '/versions/1')).json();
  assert.equal(copyDetail.ink[detail.pages[11].key].length, 2);
  // Open a clean retest, save while the API is unavailable, reload, retry.
  await q.locator('#home-back').click();
  await q.locator('[data-view=listening]').click();
  await q.locator('#phase-retest').click();
  assert.equal(await q.locator('.paper-ink .ink-stroke').count(), 0);
  await q.getByRole('button', { name: '打字作答', exact: true }).click();
  const essay =
    '  A first line.\n' + 'Second line with text to wrap. '.repeat(125) + '\nThe very last line.  ';
  await q.locator('.question-input:visible').first().fill(essay);
  await q.locator('#play-pause').click();
  await q.locator('#submit-answers').click();
  await q.route('**/api/**', (r) => r.abort('internetdisconnected'));
  await q.locator('#session-save').click();
  await q.locator('.account-save-dialog input[type=checkbox]:visible').check();
  await q.getByRole('button', { name: '确认保存', exact: true }).click();
  await q.locator('#session-save-status').filter({ hasText: '已存本机，云端待完成' }).waitFor();
  await q.unroute('**/api/**');
  await q.reload();
  await accountPage();
  await q.getByRole('button', { name: '重试上传', exact: true }).click();
  await paperCount(q, 3);
  const last = (await (await q.request.get(base + '/api/papers')).json()).find((r) => r.part === 'A+B1');
  assert.ok(last);
  assert.equal(last.phase, 'retest');
  const result = await (await q.request.get(base + '/api/papers/' + last.id + '/versions/1')).json();
  assert.equal(result.originals.length, 26);
  assert.ok(result.pages.length >= 28);
  assert.ok(result.pages.find((p) => p.kind === 'typed').after.endsWith(':12'));
  assert.equal(
    result.records['paper-2025-exam-b1-task-6'].attempts.at(-1).rawAnswers['task-6-response'],
    essay,
  );
  assert.deepEqual(result.ink, {});
  // A different Task of the same booklet edits the same page, including an explicit erase.
  const third = await device(false),
    t = third.page;
  await t.locator('[data-paper-id="' + copy.id + '"]').click();
  await t.getByLabel('继续作答的 Task').selectOption('7');
  await t.getByRole('button', { name: '继续作答', exact: true }).click();
  await t.waitForURL('**/#listening');
  const number = t.locator('#practice-page');
  await number.fill('12');
  await number.dispatchEvent('change');
  assert.equal(await t.locator('.paper-ink .ink-stroke').count(), 2);
  await t.getByRole('button', { name: '其他工具', exact: true }).click();
  await t.getByRole('button', { name: '套索', exact: true }).click();
  await draw(t, [
    [0.01, 0.01],
    [0.99, 0.01],
    [0.99, 0.99],
    [0.01, 0.99],
    [0.01, 0.01],
  ]);
  await t.getByRole('button', { name: '删除选中', exact: true }).click();
  assert.equal(await t.locator('.paper-ink .ink-stroke').count(), 0);
  await t.locator('#play-pause').click();
  await t.locator('#submit-answers').click();
  await submit(t);
  const cleared = await (await t.request.get(base + '/api/papers/' + copy.id + '/versions/2')).json();
  assert.deepEqual(cleared.tasks, [6, 7]);
  assert.equal(cleared.pages[11].hash, null);
  assert.equal(cleared.ink[cleared.pages[11].key], undefined);
  assert.deepEqual(
    await (await t.request.get(base + '/api/papers/' + copy.id + '/versions/2/pages/12/image')).body(),
    await original.body(),
  );
  await third.ctx.close();
  // Confirm ownership of legacy guest data before its first upload.
  const guest = await browser.newContext(),
    g = await guest.newPage();
  g.on('dialog', (d) => d.accept());
  await g.goto(base + '/#account');
  const legacy = structuredClone(detail.records['paper-2025-exam-b1-task-6']);
  delete legacy.attempts.at(-1).sourceVersions;
  await g.evaluate(
    (record) => localStorage.setItem('english30-records-v1', JSON.stringify([record])),
    legacy,
  );
  const guestUser = 'guest-' + Date.now();
  await g.getByRole('button', { name: '注册账号', exact: true }).click();
  await g.getByLabel('用户名', { exact: true }).fill(guestUser);
  await g.getByLabel('密码', { exact: true }).fill(password);
  await g.locator('.account-auth [type=submit]').click();
  const recovery = g.locator('.account-recovery-code');
  await recovery.waitFor();
  const code = await recovery.textContent();
  await g.getByRole('button', { name: '我已保存恢复码' }).click();
  assert.deepEqual(await (await g.request.get(base + '/api/papers')).json(), []);
  await g.locator('.account-settings > summary').click();
  await g.getByRole('button', { name: '导入到我的账号' }).click();
  await g.locator('.account-paper').waitFor();
  const imported = (await (await g.request.get(base + '/api/papers')).json())[0];
  assert.equal(imported.legacyInk, true);
  const restored = (await (await g.request.get(base + '/api/learning')).json()).backup;
  assert.deepEqual(restored.listening[0], legacy);
  const recoverContext = await browser.newContext();
  const res = await recoverContext.request.post(base + '/api/account/recover', {
    data: { name: guestUser, code, password: password + '2' },
  });
  assert.equal(res.status(), 200);
  const recovered = await res.json();
  assert.notEqual(recovered.recoveryCode, code);
  assert.equal((await (await g.request.get(base + '/api/account/me')).json()).user, null);
  assert.equal((await (await recoverContext.request.get(base + '/api/papers')).json()).length, 1);
  const remove = await recoverContext.request.delete(base + '/api/papers/' + imported.id, {
    headers: { 'X-English30-Owner': recovered.user.id },
  });
  assert.equal(remove.status(), 200);
  assert.equal(
    (await (await recoverContext.request.get(base + '/api/learning')).json()).backup.listening.length,
    0,
  );
  assert.equal(
    (await recoverContext.request.get(base + '/api/papers/' + imported.id + '/versions/1/pdf')).status(),
    404,
  );
  assert.equal(
    (
      await recoverContext.request.post(base + '/api/account/delete', {
        headers: { 'X-English30-Owner': recovered.user.id },
        data: { password: password + '2' },
      })
    ).status(),
    200,
  );
  await guest.close();
  await recoverContext.close();
  assert.deepEqual(errors, []);
  console.log(
    'Two independent browser profiles: full 14-page B1 PDF, page 12 ink, account isolation, editable restore, immutable versions verified.',
  );
} finally {
  await browser?.close();
  child?.kill();
}
