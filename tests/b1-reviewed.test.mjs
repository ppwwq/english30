import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { applyReviewedContent } from '../web/paper-reviewed-content.mjs';
test('B1 content points preserve sources, alternatives and manual grading', async () => {
  const lesson = JSON.parse(
    await fs.readFile(new URL('../web/papers/practice/paper-2025-exam-b1-task-5.json', import.meta.url)),
  );
  const review = JSON.parse(
    await fs.readFile(new URL('../web/papers/reviewed/2025-exam.json', import.meta.url)),
  );
  applyReviewedContent(lesson, review);
  assert.equal(lesson.questions[0].grading, 'self');
  assert.equal(lesson.questions[0].scoringPoints.length, 13);
  assert.equal(lesson.questions[0].scoringPoints[0].id, '5.1');
  assert.match(lesson.questions[0].scoringPoints[0].sourceLabel, /原音/);
  assert.match(lesson.questions[0].scoringPoints[3].sourceLabel, /Data File/);
  assert.equal(lesson.paper.referencePages[0].page, 8);
});
