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
page.on('dialog', (dialog) => dialog.accept());
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
  assert.deepEqual(report.errors, []);
} finally {
  await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
  await fs.writeFile(
    new URL('./artifacts/training-journey.json', import.meta.url),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
}
