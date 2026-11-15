import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import { validateLesson, createSession, submitAnswers } from '../web/core.mjs';

for (const [name, count, duration] of [
  ['2025-task1-intro', 4, 87.91],
  ['2025-task1', 13, 228],
]) {
  test(`${name}: verified question count, truthful timings, and reference responses`, async () => {
    const lesson = validateLesson(
      JSON.parse(await fs.readFile(new URL(`../web/lessons/${name}.json`, import.meta.url), 'utf8')),
    );
    assert.equal(lesson.questions.length, count);
    assert.equal(lesson.duration, duration);
    const answers = Object.fromEntries(lesson.questions.map((q) => [q.id, q.answers[0]]));
    if (count === 13) {
      answers.q11 = "it's free";
      answers.q12 = 'swimming is the best kind of exercise';
      answers.q13 = 'you make friends';
    }
    const results = submitAnswers(lesson, createSession(lesson), answers).attempts[0].results;
    assert.equal(Object.values(results).filter((r) => r.correct).length, count);
    for (const sentence of lesson.sentences)
      for (const word of sentence.words) {
        if (word.start === null) assert.equal(word.timingStatus, 'segment-only');
        else assert.ok(word.end > word.start);
      }
    assert.ok((await fs.stat(new URL(`../web/${lesson.audio}`, import.meta.url))).size > 1000);
  });
}
