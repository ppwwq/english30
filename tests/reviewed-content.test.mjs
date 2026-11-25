import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createSession, submitAnswers, visibleLesson } from '../web/core.mjs';
const lesson = async (id) =>
  JSON.parse(await fs.readFile(new URL(`../web/papers/practice/${id}.json`, import.meta.url)));
test('2025 Task 1 opening instructions keep the reviewed words and replay positions in both players', async () => {
  const task = await lesson('paper-2025-exam-a-task-1');
  const full = JSON.parse(
    await fs.readFile(new URL('../web/papers/sessions/2025-exam.json', import.meta.url)),
  );
  for (const [id, expected] of [
    [
      's00051',
      'Task 1. Stella Poon and Adrian Timpson host a podcast about health and fitness in Hong Kong.',
    ],
    ['s00056', 'At the end of the task, you will have one minute to tidy up your answers.'],
  ]) {
    const clipped = task.sentences.find((s) => s.id === id);
    const original = full.sentences.find((s) => s.id === id);
    assert.equal(clipped.text, expected);
    assert.equal(original.text, expected);
    assert.equal(clipped.words.map((w) => w.text).join(' '), expected);
    assert.deepEqual(
      original.words.map((w) => w.id),
      clipped.words.map((w) => w.id),
    );
    for (const [i, w] of clipped.words.entries()) {
      assert.ok(Math.abs(original.words[i].start - task.paper.originalAudioRange.start - w.start) < 0.001);
    }
  }
});
test('2025 Task 2 shows marking-scheme alternatives without converting reference text to automatic grades', async () => {
  const l = await lesson('paper-2025-exam-a-task-2');
  assert.equal(l.questions.length, 13);
  for (const q of l.questions) {
    assert.doesNotMatch(q.prompt, /请按原题页/);
    assert.ok(q.referenceAnswer);
    assert.equal(q.reference.sourceId, 'p-9f8236cfe333');
    assert.equal(q.reference.page, 6);
  }
  assert.match(l.questions.find((q) => q.number === 15).referenceAnswer, /large.*heavy.*carry/s);
  assert.equal(l.questions.find((q) => q.number === 21).referenceAnswer, 'sports shoes');
  assert.match(l.questions.find((q) => q.number === 23).referenceAnswer, /still dark.*before sunrise/s);
  const first = createSession(l);
  assert.ok(visibleLesson(l, first).questions.every((q) => !q.referenceAnswer && !q.evidence));
  assert.ok(Object.values(submitAnswers(l, first, {}).attempts[0].results).every((r) => r.correct === null));
});
test('2025 Task 1 evidence retains the question and correction instead of isolated answer words', async () => {
  const l = await lesson('paper-2025-exam-a-task-1');
  const evidence = (n) => l.questions.find((q) => q.number === n).evidence[0];
  assert.equal(evidence(1).contextStart, 101.594);
  assert.equal(evidence(2).contextStart, 110.174);
  assert.equal(evidence(2).contextEnd, 128.454);
  assert.equal(evidence(4).contextStart, 143.034);
});
test('2016 Task 1 gives every question a reference and relevant evidence, retaining both mentions of 1972', async () => {
  const l = await lesson('paper-2016-exam-a-task-1');
  assert.equal(l.questions.length, 15);
  assert.ok(l.questions.every((q) => q.referenceAnswer && q.evidence.length));
  const q = l.questions.find((q) => q.number === 2);
  assert.equal(q.referenceAnswer, '1972');
  assert.equal(q.evidence.length, 2);
  assert.ok(q.evidence[0].start < 132 && q.evidence[1].start > 136);
});
test('2025 Task 2 subtitle gap restores official sentences without invented word timing', async () => {
  const l = await lesson('paper-2025-exam-a-task-2');
  const gap = l.sentences.filter((s) => s.start >= 328.24 && s.start < 342);
  assert.ok(gap.some((s) => s.text === 'That really helps.'));
  assert.ok(gap.some((s) => s.text.includes('why is marathon running so popular in Thailand')));
  assert.ok(gap.some((s) => s.text.includes('courses there are so beautiful')));
  const courses = gap.flatMap((s) => s.words).find((w) => w.text === 'courses');
  assert.equal(courses.start, null);
  assert.equal(courses.timingStatus, 'segment-only');
});
