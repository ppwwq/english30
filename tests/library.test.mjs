import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSession, submitAnswers, validateLesson } from '../web/core.mjs';

const read = (file) => readFile(new URL(`../web/${file}`, import.meta.url), 'utf8').then(JSON.parse);

test('2024 extract accepts source answers for Q13–20, in either order for paired blanks', async () => {
  const lesson = validateLesson(await read('lessons/2024-task2-intro.json'));
  assert.deepEqual(
    lesson.questions.map((q) => q.number),
    [13, 14, 15, 16, 17, 18, 19, 20],
  );
  const reviewed = submitAnswers(lesson, createSession(lesson), {
    q13: 'Paqua Monna',
    q14: 'customs',
    q15: 'languages',
    q16: 'C',
    q17: 'strong',
    q18: 'light',
    q19: '5',
    q20: '14',
  });
  assert.equal(Object.values(reviewed.attempts[0].results).filter((r) => r.correct).length, 8);
  const repeated = submitAnswers(lesson, createSession(lesson), {
    q14: 'languages',
    q15: 'languages',
    q17: 'light',
    q18: 'light',
  }).attempts[0].results;
  assert.equal(repeated.q15.correct, false);
  assert.equal(repeated.q15.duplicate, true);
  assert.equal(repeated.q18.correct, false);
  assert.equal(repeated.q18.duplicate, true);
  const selectedOption = submitAnswers(lesson, createSession(lesson), {
    q16: lesson.questions.find((q) => q.number === 16).options[2],
  }).attempts[0].results;
  assert.equal(selectedOption.q16.correct, true);
});

test('spelling evidence does not truncate the name when its last word only has sentence timing', async () => {
  const lesson = await read('lessons/2024-task2-intro.json');
  const spelling = lesson.sentences.find((s) => s.text.includes('M-o-double-n-a'));
  const clip = lesson.questions.find((q) => q.number === 13).evidence[0];
  assert.ok(clip.start <= spelling.start);
  assert.ok(clip.end >= spelling.end);
  // The last letter ends at 18.73 s in the independently transcribed source audio.
  assert.ok(clip.end >= 18.73);
});

test('the library offers playable lessons from both 2024 and 2025', async () => {
  const { lessons } = await read('lesson-catalogue.json');
  assert.deepEqual([...new Set(lessons.map((item) => item.year))].sort(), [2024, 2025]);
  for (const item of lessons) {
    const lesson = validateLesson(await read(item.url.replace(/^\.\//, '')));
    assert.equal(item.id, lesson.id);
    assert.equal(item.part, 'A');
    assert.ok((await readFile(new URL(`../web/${lesson.audio}`, import.meta.url))).length > 1000);
  }
});

test('context meanings point to words actually present in each linked lesson', async () => {
  const { entries } = await read('content/listening-glossary.json');
  assert.ok(entries.length >= 10);
  for (const entry of entries) {
    assert.match(entry.sourceNote, /非官方译文/);
    for (const lessonId of entry.lessonIds) {
      const lesson = await read(`lessons/${lessonId}.json`);
      const words = new Set(lesson.sentences.flatMap((s) => s.words.map((w) => w.id)));
      assert.ok(entry.wordIds.length > 0);
      assert.ok(
        entry.wordIds.every((id) => words.has(id)),
        `${entry.lemma} / ${lessonId}`,
      );
      assert.ok(
        lesson.sentences.some((s) => s.text.includes(entry.collocation)),
        entry.collocation,
      );
    }
  }
});
