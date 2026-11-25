import { allowBeforeUnload, answerConfirmation, confirmIncompleteTask } from './confirmation-helpers.mjs';
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
const context = await browser.newContext({ viewport: { width: 820, height: 1180 } });
const page = await context.newPage();
const base = (process.env.TEST_URL || 'http://127.0.0.1:4173').replace(/\/#.*$/, '').replace(/\/$/, '');
const report = { cases: [], errors: [], physicalDevice: false };
page.on('pageerror', (e) => report.errors.push(e.message));
allowBeforeUnload(page);
const check = async (name, fn) => {
  await fn();
  report.cases.push(name);
  console.log('PASS', name);
};
try {
  await page.goto(base + '/#writing');
  await page.locator('#writing-answer').waitFor();
  await check(
    'a correct structure attempt can go directly to a new context without compulsory copying',
    async () => {
      await page
        .locator('#writing-answer')
        .fill('Students have fewer opportunities to study practical skills.');
      await page.locator('#writing-submit').click();
      const transfer = page.getByRole('button', { name: '换情境检验', exact: true });
      await transfer.waitFor({ timeout: 2000 });
      await transfer.click();
      assert.equal(await page.getByLabel('你的新句子', { exact: true }).count(), 1);
      assert.equal(await page.locator('.reference-sentence').count(), 0);
      assert.equal(await page.locator('#writing-answer').inputValue(), '');
      assert.equal(
        await page.locator('body').evaluate(() => localStorage.getItem('english30-study-v1')),
        null,
      );
    },
  );
  await check(
    'saved structure practice is labelled honestly and review starts with a concealed attempt',
    async () => {
      await page
        .locator('#writing-answer')
        .fill('Teenagers have more opportunities to meet people from different backgrounds.');
      for (const checkbox of await page.locator('.training-checklist input').all()) await checkbox.check();
      await page.locator('#writing-submit').click();
      await page.getByRole('button', { name: '结束本次', exact: true }).click();
      assert.equal(await page.evaluate(() => localStorage.getItem('english30-study-v1')), null);
      await page.locator('#session-save').click();
      await answerConfirmation(page, '确认保存');
      await page.locator('.training-review-row').first().waitFor();
      assert.match(await page.locator('.training-statistics').innerText(), /指定结构首答/);
      assert.match(await page.locator('.training-statistics').innerText(), /次数.*不代表.*能力/);
      const card = page.locator('.training-review-row').first();
      assert.equal(await card.getByText('仅手动标记（自评）', { exact: true }).count(), 1);
      assert.equal(await card.getByRole('button', { name: '已能独立回忆', exact: true }).isVisible(), false);
      await card.getByRole('button', { name: '关提示再测', exact: true }).click();
      await page.locator('#writing-answer').waitFor();
      assert.equal(await page.locator('#writing-answer').inputValue(), '');
      assert.equal(await page.locator('.reference-sentence').count(), 0);
      await page
        .locator('#writing-answer')
        .fill('Students have fewer opportunities to study practical skills.');
      await page.locator('#writing-submit').click();
      assert.equal(
        await page.evaluate(
          async () => (await import('/training-core.mjs')).studyStore.getState().records.at(-1).phase,
        ),
        'retest',
      );
    },
  );
  await check('paragraph review offers a blank retest separately from the previous draft', async () => {
    await page.locator('[data-training-mode="paragraph"]').click();
    const draft = 'Our school should offer a gardening club. Students can learn practical skills together.';
    await page.locator('#paragraph-draft').fill(draft);
    await page.locator('#paragraph-submit').click();
    await page.locator('#session-save').click();
    await answerConfirmation(page, '确认保存');
    await page.goto(base + '/#review');
    const card = page
      .locator('.training-review-row')
      .filter({ has: page.getByRole('heading', { name: '给同学一段建议', exact: true }) });
    await card.getByRole('button', { name: '关提示再测', exact: true }).click();
    assert.equal(await page.locator('#paragraph-draft').inputValue(), '');
    assert.equal(await page.locator('#paragraph-revision').count(), 0);
    assert.match(await page.locator('#training-host').innerText(), /同题复测/);
  });
  await check(
    'the shared save interface distinguishes submitted work from later unsubmitted edits',
    async () => {
      await page.evaluate(async () => {
        const { mountTraining } = await import('/training.mjs');
        const host = document.createElement('div');
        host.id = 'save-contract';
        document.body.append(host);
        window.contractSaveRequests = 0;
        window.trainingContract = await mountTraining({
          host,
          bridge: {
            navigate() {},
            requestSave() {
              window.contractSaveRequests++;
              return true;
            },
          },
        });
        window.trainingContract.show('writing');
      });
      const host = page.locator('#save-contract');
      await host
        .locator('#writing-answer')
        .fill('Students have fewer opportunities to study practical skills.');
      let state = await page.evaluate(() => window.trainingContract.getSaveState());
      assert.equal(state.submitted, false);
      assert.equal(state.hasUnsubmittedChanges, true);
      await host.locator('#writing-submit').click();
      state = await page.evaluate(() => window.trainingContract.getSaveState());
      assert.equal(state.submitted, true);
      assert.equal(state.hasUnsubmittedChanges, false);
      await host.locator('#writing-answer').fill('This later edit has not been submitted.');
      assert.equal(
        await page.evaluate(() => window.trainingContract.getSaveState().hasUnsubmittedChanges),
        true,
      );
      await page.evaluate(() => window.trainingContract.saveCurrent());
      assert.equal(await page.evaluate(() => window.contractSaveRequests), 1);
      assert.equal(
        await host.locator('#writing-answer').inputValue(),
        'This later edit has not been submitted.',
      );
      await host.locator('#writing-answer').fill('');
      assert.equal(
        await page.evaluate(() => window.trainingContract.getSaveState().hasUnsubmittedChanges),
        true,
      );
      await page.evaluate(() => document.getElementById('save-contract').remove());
    },
  );
  await check(
    'guest finds saved listening questions the next day, replays evidence and makes a concealed retest',
    async () => {
      const guest = await browser.newContext({
        viewport: { width: 1024, height: 768 },
        timezoneId: 'Asia/Hong_Kong',
      });
      try {
        const evening = await guest.newPage();
        allowBeforeUnload(evening);
        evening.on('pageerror', (e) => report.errors.push(e.message));
        await evening.clock.setFixedTime(new Date('2026-11-21T12:00:00Z'));
        await evening.goto(base + '/#listening');
        await evening.locator('#play-pause').click();
        await evening.locator('#answer-q1').fill('200');
        await evening.locator('#submit-answers').click();
        await confirmIncompleteTask(evening);
        await evening.locator('#session-save').click();
        await answerConfirmation(evening, '确认保存');
        await evening.waitForFunction(() => document.querySelector('#session-save').disabled);
        const q1 = evening.locator('#questions [data-question-id="q1"]');
        await q1.locator('.question-review-tools > summary').click();
        await q1.locator('.self-check').selectOption('retry');
        await q1.locator('.error-reason').selectOption('information');
        const q2 = evening.locator('#questions [data-question-id="q2"]');
        await q2.locator('.question-review-tools > summary').click();
        await q2.locator('.error-reason').selectOption('form');
        await evening.locator('#next-question-page').click();
        const q5 = evening.locator('#questions [data-question-id="q5"]');
        await q5.locator('.question-review-tools > summary').click();
        await q5.locator('.self-check').selectOption('retry');
        await evening.locator('#session-save').click();
        await answerConfirmation(evening, '确认保存');
        await evening.waitForFunction(() => document.querySelector('#session-save').disabled);
        await evening.close();
        const tomorrow = await guest.newPage();
        allowBeforeUnload(tomorrow);
        tomorrow.on('pageerror', (e) => report.errors.push(e.message));
        await tomorrow.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
        await tomorrow.goto(base + '/#review');
        await tomorrow.getByRole('button', { name: '今天到期' }).click();
        const question = tomorrow
          .locator('.training-review-row')
          .filter({ has: tomorrow.getByRole('heading', { name: /2025.*Part A.*Task 1.*Q1$/ }) });
        const history = tomorrow.locator('.training-history');
        await question.waitFor();
        assert.match(await question.innerText(), /漏听／选错信息/);
        assert.match(
          await tomorrow.locator('.training-statistics').innerText(),
          /查看最近已保存纪录（1 条）/,
        );
        assert.doesNotMatch(await tomorrow.locator('.training-statistics').innerText(), /information/);
        await question.getByRole('button', { name: '回原题复盘' }).click();
        await tomorrow.waitForFunction(
          () =>
            document.body.dataset.listeningPhase === 'review' &&
            Number(document.querySelector('#seek').value) > 90,
        );
        assert.equal(await tomorrow.locator('#answer-q1').inputValue(), '200');
        await tomorrow.locator('#session-review').click();
        await question.getByRole('button', { name: '关提示再测' }).click();
        await tomorrow.waitForFunction(() => document.body.dataset.listeningPhase === 'retest');
        assert.equal(await tomorrow.locator('#answer-q1').inputValue(), '');
        assert.equal(await tomorrow.locator('#questions .question-feedback:visible').count(), 0);
        assert.equal(await tomorrow.locator('#transcript [data-word-id]:visible').count(), 0);
        await tomorrow.locator('#play-pause').click();
        await tomorrow.locator('#answer-q1').fill('7000');
        await tomorrow.locator('#submit-answers').click();
        await confirmIncompleteTask(tomorrow);
        await tomorrow.locator('#session-save').click();
        await answerConfirmation(tomorrow, '确认保存');
        await tomorrow.waitForFunction(() => document.querySelector('#session-save').disabled);
        await tomorrow.locator('#session-review').click();
        await history.locator('summary').click();
        assert.match(await history.innerText(), /最近已保存纪录（2 条）/);
        assert.equal(await question.count(), 0);
        assert.match(await tomorrow.locator('.training-review-list').innerText(), /Q2[\s\S]*拼写／词形/);
        const laterQuestion = tomorrow.locator('.training-review-row').filter({
          has: tomorrow.getByRole('heading', { name: /2025.*Part A.*Task 1.*Q5$/ }),
        });
        await laterQuestion.getByRole('button', { name: '关提示再测' }).click();
        await tomorrow.locator('#answer-q5').waitFor();
        assert.equal(await tomorrow.locator('#answer-q1').isVisible(), false);
        assert.equal(await tomorrow.locator('#answer-q5').inputValue(), '');
        await tomorrow.locator('#session-review').click();
        await history.locator('summary').click();
        await history
          .locator('li')
          .filter({ hasText: '独立首答' })
          .getByRole('button', { name: '查看这轮作答' })
          .click();
        await tomorrow.waitForFunction(() => document.querySelector('#answer-q1')?.value === '200');
        assert.equal(await tomorrow.locator('#session-save').isDisabled(), true);
      } finally {
        await guest.close();
      }
    },
  );
  assert.deepEqual(report.errors, []);
} finally {
  await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
  await fs.writeFile(
    new URL('./artifacts/training-journey.json', import.meta.url),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
