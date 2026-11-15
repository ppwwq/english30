import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
import { evaluateReading, countWords, evidenceFeedback, readingElapsed } from '../web/reading.mjs';

const set = {
  paragraphs: [
    {
      segments: [
        { id: 's1', text: 'one' },
        { id: 's2', text: 'two' },
        { id: 's3', text: 'three' },
      ],
    },
  ],
  questions: [
    { id: 'q1', type: 'choice', answers: ['A'], evidenceSets: [['s1']] },
    { id: 'q2', type: 'text', answers: ['ordinary people'], evidenceSets: [['s2']] },
    {
      id: 'q3',
      type: 'multi',
      answerGroups: [['split up'], ['divorce', 'filed for divorce'], ['called it quits', 'quits']],
      required: 2,
      evidenceSets: [
        ['s1', 's2'],
        ['s1', 's3'],
        ['s2', 's3'],
      ],
    },
  ],
};
test('Reading answers and evidence stay unavailable until submission', () => {
  assert.equal(evaluateReading(set, { q1: 'A' }, { q1: ['s1'] }, false), null);
});
test('free wording is pending self-check rather than automatically wrong', () => {
  const result = evaluateReading(
    set,
    { q1: 'B', q2: 'the lives of normal people', q3: ['split up', 'split up'] },
    {},
    true,
  );
  assert.equal(result.q1.answer, 'mismatch');
  assert.equal(result.q2.answer, 'review');
  assert.equal(result.q3.answer, 'review');
  assert.equal(result.q3.matchedPoints, 1);
});
test('two different official answer groups meet a two-point response', () => {
  const result = evaluateReading(
    set,
    { q1: 'a', q2: 'Ordinary people.', q3: ['split up', 'filed for divorce'] },
    { q3: ['s1', 's2'] },
    true,
  );
  assert.equal(result.q1.answer, 'matched');
  assert.equal(result.q2.answer, 'matched');
  assert.equal(result.q3.answer, 'matched');
  assert.equal(result.q3.evidence.status, 'sufficient');
});
test('evidence distinguishes missing points and overly wide selection', () => {
  assert.equal(evidenceFeedback(['s1'], [['s1', 's2']]).status, 'incomplete');
  assert.equal(evidenceFeedback(['s1', 's2', 's3'], [['s1', 's2']]).status, 'wide');
  assert.equal(evidenceFeedback(['s2'], [['s1']]).status, 'different');
  assert.equal(evidenceFeedback([], [['s1']]).status, 'missing');
});
test('unknown evidence ids never count as selected source evidence', () => {
  assert.equal(evaluateReading(set, { q1: 'A' }, { q1: ['forged'] }, true).q1.evidence.status, 'missing');
});
test('timer counts active time and word counter respects contractions', () => {
  assert.equal(readingElapsed({ elapsed: 12, runningSince: 1000 }, 6000), 17);
  assert.equal(readingElapsed({ elapsed: 12, runningSince: null }, 6000), 12);
  assert.equal(countWords("I'd like to invite you — 13 October."), 7);
});
test('bundled A/B1 questions refer only to real source sentences and every media asset exists', async () => {
  const reading = JSON.parse(
    await fs.readFile(new URL('../web/content/reading.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(
    reading.sets.map((s) => s.part),
    ['A', 'B1'],
  );
  for (const set of reading.sets) {
    const ids = new Set(set.paragraphs.flatMap((p) => p.segments.map((s) => s.id)));
    for (const question of set.questions) {
      assert.ok(question.number && question.explanation && question.bridge.length);
      for (const group of question.evidenceSets) {
        assert.ok(group.length);
        for (const id of group) assert.ok(ids.has(id), `${question.id}: missing ${id}`);
      }
    }
  }
  const integrated = JSON.parse(
    await fs.readFile(new URL('../web/content/integrated.json', import.meta.url), 'utf8'),
  );
  assert.equal(integrated.tasks[0].part, 'B1');
  assert.equal(integrated.tasks[0].taskNumber, 6);
  for (const task of integrated.tasks) {
    await fs.access(new URL('../web/' + task.audio.src, import.meta.url));
    for (const source of task.sources)
      if (source.image) await fs.access(new URL('../web/' + source.image, import.meta.url));
    const valid = new Set(['audio', ...task.sources.map((s) => s.id)]);
    for (const field of task.sourceFields) for (const source of field.sources) assert.ok(valid.has(source));
  }
});
