import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { taskQuestionPages } from '../web/paper-question-pages.mjs';
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const report = [];
try {
  await page.goto(`${process.env.TEST_URL || 'http://127.0.0.1:4175'}/#listening`);
  await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
  const entries = await page.evaluate(async () =>
    (await (await fetch('/papers/practice-catalogue.json')).json()).lessons.filter((e) =>
      ['A', 'B1'].includes(e.part),
    ),
  );
  let confirmedPages = 0;
  for (const entry of entries) {
    await page.evaluate(async (id) => {
      const { listeningBridge } = await import('/app.mjs');
      await listeningBridge.openLesson(id);
    }, entry.id);
    if (!entry.missingAudio)
      await page.waitForFunction(() => !document.querySelector('#play-pause').disabled);
    const state = await page.evaluate(() => ({
      year: document.querySelector('#practice-year').value,
      variant: document.querySelector('#practice-variant').value,
      part: document.querySelector('#practice-part').value,
      task: document.querySelector('#practice-task').value,
      title: document.querySelector('#lesson-title').textContent,
      paused: document.querySelector('#audio').paused,
      time: document.querySelector('#audio').currentTime,
      duration: document.querySelector('#audio').duration,
      playDisabled: document.querySelector('#play-pause').disabled,
      answerNodes: document.querySelectorAll(
        '.reference-answer,.evidence-link,.scoring-point,#transcript .word',
      ).length,
    }));
    assert.equal(state.year, String(entry.year));
    assert.equal(state.variant, entry.variant);
    assert.equal(state.part, entry.part);
    assert.equal(state.task, String(entry.task));
    assert.ok(state.title.includes(`Task ${entry.task}`));
    assert.equal(state.paused, true);
    assert.equal(state.time, 0);
    assert.equal(state.answerNodes, 0);
    assert.equal(state.playDisabled, !!entry.missingAudio);
    if (!entry.missingAudio) assert.ok(state.duration > 0);
    if (entry.missingAudio) {
      assert.equal(await page.locator('#question-pages').isVisible(), false, entry.id);
    } else {
      const lesson = JSON.parse(await fs.readFile(new URL('../web/' + entry.url.slice(2), import.meta.url)));
      const pages = taskQuestionPages(lesson);
      if (entry.part === 'A') {
        assert.ok(pages.length > 0, entry.id);
        for (const [scanPage, firstNumber, lastNumber] of pages) {
          assert.equal(await page.locator('#practice-page').inputValue(), String(scanPage), entry.id);
          const displayedQuestions = await page
            .locator('#questions .question-card:visible')
            .evaluateAll((cards) => cards.map((card) => Number(card.dataset.questionNumber)));
          assert.deepEqual(
            displayedQuestions,
            lesson.questions
              .filter((q) => q.number >= firstNumber && q.number <= lastNumber)
              .map((q) => q.number),
            entry.id,
          );
          confirmedPages++;
          if (scanPage !== pages.at(-1)[0])
            await page.getByRole('button', { name: '下一组题目', exact: true }).click();
        }
      } else {
        assert.equal(await page.locator('#question-pages').isVisible(), false, entry.id);
        const response = page.locator('#questions textarea.question-input');
        await response.fill('test response');
        await page.getByRole('button', { name: 'Data File', exact: true }).click();
        assert.equal(
          await page.locator('#practice-document').inputValue(),
          lesson.paper.dataFile.sourceId,
          entry.id,
        );
        assert.equal(
          await page.locator('#practice-page').inputValue(),
          String(lesson.paper.dataFile.page),
          entry.id,
        );
        assert.equal(await response.inputValue(), 'test response', entry.id);
        await response.fill('');
      }
    }
    report.push({ id: entry.id, ...state });
  }
  assert.equal(report.length, 112);
  assert.deepEqual(errors, []);
  if (process.env.REPORT_FILE)
    await fs.writeFile(
      process.env.REPORT_FILE,
      JSON.stringify({ entries: 112, playable: 105, disabledSample: 7, errors, report }, null, 2),
    );
  console.log(
    'PASS all 112 A+B1 routes: 105 media-ready, 7 disabled Sample, exact identity, paused at zero and concealed first answer',
  );
  console.log(
    `PASS ${confirmedPages} Part A question pages and 45 B1 Data File switches preserve the matching answer area`,
  );
} finally {
  await browser.close();
}
