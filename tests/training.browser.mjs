import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import assert from 'node:assert/strict';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const context = await browser.newContext({
  viewport: { width: 1080, height: 810 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const report = { checks: [], errors: [], physicalDevice: false };
const reportFile =
  process.argv.find((x) => x.startsWith('--report='))?.slice(9) ||
  new URL('./artifacts/training-ui-report.json', import.meta.url);
const artifactDirectory = new URL('./artifacts/', import.meta.url);
await fs.mkdir(artifactDirectory, { recursive: true });
page.on('pageerror', (e) => report.errors.push(e.message));
page.on('dialog', (d) => d.accept());
const check = async (name, fn) => {
  await fn();
  report.checks.push(name);
};
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('english30-study-v1')));
const state = () => page.evaluate(async () => (await import('/training-core.mjs')).studyStore.getState());
const nav = async (view) => {
  await page.locator(`.main-navigation [data-view="${view}"]`).click();
  await page.waitForFunction((v) => document.body.dataset.view === v, view);
  if (view === 'listening')
    await page.evaluate(() => {
      location.hash = 'listening/practice';
    });
};
try {
  await page.goto(
    (process.env.TEST_URL || 'http://127.0.0.1:4173').replace(/\/#.*$/, '').replace(/\/$/, '') + '/#today',
  );
  await page.locator('.training-day').first().waitFor();
  await check('30-day calendar and 30-minute budget remain staged until explicit save', async () => {
    assert.equal(await page.locator('.training-day').count(), 30);
    await page.getByText('调整训练安排', { exact: true }).click();
    await page.locator('#training-budget').selectOption('30');
    await page.getByRole('button', { name: '应用安排', exact: true }).click();
    assert.equal((await state()).settings.minutes, 30);
    assert.equal(await saved(), null);
  });
  await nav('writing');
  const target = 'Students have fewer opportunities to study practical skills.';
  await check(
    'four writing stages preserve first-answer/review/retest separation and hide recall target',
    async () => {
      await page.locator('#writing-answer').fill(target);
      await page.locator('#writing-submit').click();
      await page.locator('#writing-next').click();
      assert.equal(await page.locator('.reference-sentence').textContent(), target);
      await page.locator('#writing-answer').fill(target);
      await page.locator('#writing-submit').click();
      await page.locator('#writing-next').click();
      assert.equal(await page.locator('.reference-sentence').count(), 0);
      await page.locator('#writing-answer').fill(target);
      await page.locator('#writing-submit').click();
      await page.locator('#writing-next').click();
      await page
        .locator('#writing-answer')
        .fill('Teenagers have more opportunities to meet people from different backgrounds.');
      for (const el of await page.locator('.training-checklist input').all()) await el.check();
      await page.locator('#writing-submit').click();
      assert.equal(await saved(), null);
      assert.deepEqual(
        (await state()).records.map((r) => [r.phase, r.assisted]),
        [
          ['first', false],
          ['review', true],
          ['retest', false],
          ['retest', false],
        ],
      );
      await page.locator('#session-save').click();
      assert.equal((await saved()).records.length, 4);
    },
  );
  await check('personal error can be added, selected and remains unpersisted before save', async () => {
    await page.getByText('加入自己的错句', { exact: true }).click();
    const f = page.locator('.training-personal-form');
    await f.getByLabel('原句', { exact: true }).fill('She can helps children.');
    await f.getByLabel('已核对的参考改句').fill('She can help children.');
    await f.getByLabel('意思或情境').fill('她可以帮助孩子。');
    await f.getByRole('button').click();
    assert.equal((await state()).personalExercises.length, 1);
    assert.equal((await saved()).personalExercises.length, 0);
  });
  await check(
    'paragraph drafts and Paper 2 drafts are independent and preserve input when changing modes',
    async () => {
      await page.locator('[data-training-mode=paragraph]').click();
      const draft =
        'Our school should offer a practical skills club. Students can learn how to cook simple meals and manage their time. These lessons will help teenagers take care of themselves when their parents are busy. Teachers can organise small group activities every Friday. Students should work together and share their ideas. The club does not need expensive equipment because we can use the school kitchen. I hope the school will listen to our suggestions and give us more opportunities to practise these useful skills.';
      await page.locator('#paragraph-draft').fill(draft);
      await page.locator('#paragraph-submit').click();
      assert.equal((await state()).records.at(-1).details.kind, 'paragraph');
      await page.locator('#paragraph-revision').fill(draft + ' We can start next month.');
      for (const el of await page.locator('.training-checklist input').all()) await el.check();
      await page.getByRole('button', { name: '提交修改稿与自核', exact: true }).click();
      await page.locator('[data-training-mode=paper2]').click();
      assert.equal(await page.locator('#paragraph-draft').inputValue(), '');
      assert.equal(await page.locator('#paper2-task').inputValue(), '2025-p2-a-q1');
      assert.ok((await page.locator('.paper2-prompt-text').textContent()).includes('852 Teen Art Club'));
      await page.waitForFunction(() => {
        const img = document.querySelector('.paper2-source-image img');
        return img?.complete && img.naturalWidth > 0;
      });
      assert.equal(
        await page
          .locator('.paper2-source-image img')
          .evaluate((img) => img.complete && img.naturalWidth > 0),
        true,
      );
      await page.locator('#paper2-task').selectOption('custom');
      await page.locator('#paper2-source').fill('Personal past paper task');
      await page
        .locator('#paper2-prompt')
        .fill('Write a letter to your principal suggesting a new school activity.');
      await page
        .locator('#paragraph-draft')
        .fill('Dear Principal, I would like to suggest a gardening club.');
      await page.locator('[data-training-mode=paragraph]').click();
      assert.equal(await page.locator('#paragraph-draft').inputValue(), draft);
    },
  );
  await check(
    'dictation uses completed listening sentences, plays concealed audio and does not reveal text before answer',
    async () => {
      await nav('listening');
      await page.waitForFunction(() => !document.getElementById('play-pause').disabled);
      await page.locator('#play-pause').click();
      await page.waitForFunction(() => document.getElementById('audio').currentTime > 0.03);
      await page.locator('#submit-answers').click();
      await page.locator('.review-drawer > summary').click();
      await page.locator('#session-save').click();
      await nav('writing');
      await page.locator('[data-training-mode=dictation]').click();
      await page.locator('#dictation-sentence').waitFor();
      const text = await page.evaluate(async () => {
        const { listeningBridge } = await import('/app.mjs');
        return listeningBridge
          .getListeningState()
          .lesson.sentences.find((s) => s.id === document.getElementById('dictation-sentence').value)?.text;
      });
      assert.ok(text);
      assert.equal((await page.locator('#training-host').textContent()).includes(text), false);
      await page.getByRole('button', { name: '听原音', exact: true }).click();
      await page.waitForFunction(() => !document.getElementById('audio').paused);
      assert.equal(await page.locator('body').getAttribute('data-view'), 'writing');
      await page.getByRole('button', { name: '暂停', exact: true }).click();
      await page.locator('#dictation-answer').fill(text);
      await page.locator('#dictation-submit').click();
      assert.equal((await state()).records.at(-1).correct, 1);
      await page.getByRole('button', { name: '显示原句', exact: true }).click();
      assert.ok((await page.locator('.training-feedback').textContent()).includes(text));
    },
  );
  await check('backup export uses the real saved record store', async () => {
    await page.getByRole('button', { name: '待复习与备份', exact: true }).click();
    await page.locator('#session-save').click();
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#training-export').click();
    const download = await downloadEvent;
    const data = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.equal(data.kind, 'english30-backup');
    assert.ok(data.study.records.length >= 6);
    assert.equal(await page.locator('input[type=file]').count(), 0);
    assert.equal((await saved()).records.length, data.study.records.length);
    await page.getByText('仅手动标记（自评）', { exact: true }).first().click();
    await page.getByRole('button', { name: '仍需重练', exact: true }).first().click();
    assert.equal(Object.keys((await saved()).reviews).length, 0);
    assert.equal(Object.keys((await state()).reviews).length, 1);
  });
  await check(
    'review reopens the original paragraph draft and revision, and returns to the exact dictation sentence with answers hidden',
    async () => {
      await page.getByLabel('复习类型', { exact: true }).selectOption('writing');
      const row = page
        .locator('.training-review-row')
        .filter({ has: page.getByRole('heading', { name: '给同学一段建议', exact: true }) });
      await row.getByRole('button', { name: '查看上次作答', exact: true }).click();
      assert.ok((await page.locator('#paragraph-draft').inputValue()).startsWith('Our school'));
      assert.ok(
        (await page.locator('#paragraph-revision').inputValue()).endsWith('We can start next month.'),
      );
      await nav('listening');
      await page.locator('#lesson-select').selectOption('2024-task2-intro');
      await page.waitForFunction(() => !document.getElementById('play-pause').disabled);
      await nav('writing');
      await page.getByRole('button', { name: '待复习与备份', exact: true }).click();
      await page.getByLabel('复习类型', { exact: true }).selectOption('dictation');
      await page
        .locator('.training-review-row')
        .first()
        .getByRole('button', { name: '关提示再测', exact: true })
        .click();
      await page.locator('#dictation-answer').waitFor();
      assert.equal(await page.locator('#dictation-answer').inputValue(), '');
      assert.equal(await page.locator('.training-feedback').count(), 0);
      assert.equal(
        await page.evaluate(
          async () => (await import('/app.mjs')).listeningBridge.getListeningState().lesson.id,
        ),
        '2025-task1-intro',
      );
      const sentence = await page.evaluate(
        async () =>
          (await import('/app.mjs')).listeningBridge
            .getListeningState()
            .lesson.sentences.find((s) => s.id === document.getElementById('dictation-sentence').value).text,
      );
      await page.locator('#dictation-answer').fill(sentence);
      await page.locator('#dictation-submit').click();
      assert.equal((await state()).records.at(-1).phase, 'retest');
    },
  );
  await check('iPad landscape/portrait and narrow screens have no document overflow', async () => {
    for (const [name, width, height] of [
      ['ipad-landscape', 1080, 810],
      ['ipad-portrait', 810, 1080],
      ['phone', 390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      for (const view of ['today', 'writing']) {
        await nav(view);
        if (view === 'writing') await page.locator('[data-training-mode=sentence]').click();
        const widths = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        assert.ok(widths.scroll <= widths.client + 1, JSON.stringify({ name, view, ...widths }));
        await page.waitForTimeout(1200);
        await page.screenshot({
          path: new URL(`training-${name}-${view}.png`, artifactDirectory).pathname.replace(/^\//, ''),
          fullPage: true,
        });
      }
    }
  });
  assert.deepEqual(report.errors, []);
} catch (e) {
  report.failure = e.stack;
  process.exitCode = 1;
} finally {
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}
