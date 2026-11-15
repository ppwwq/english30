import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPapers, taskOptions, chooseTask, locateChunk } from '../web/paper-core.mjs';

const sources = [
  {
    id: 'combined',
    year: 2025,
    variant: 'exam',
    paper: 3,
    role: 'question',
    parts: ['A', 'B1'],
    tasks: [
      { number: 1, part: 'A', page: 4 },
      { number: 5, part: 'B1', page: 20 },
    ],
  },
  {
    id: 'split',
    year: 2025,
    variant: 'exam',
    paper: 3,
    role: 'question',
    parts: ['B1'],
    tasks: [
      { number: 5, part: 'B1', page: 11 },
      { number: 6, part: 'B1', page: 12 },
    ],
  },
  { id: 'ms', year: 2025, variant: 'exam', paper: null, role: 'marking', parts: [] },
  {
    id: 'sample',
    year: 2012,
    variant: 'sample',
    paper: 3,
    role: 'question',
    parts: ['A'],
    tasks: [{ number: 1, part: 'A', page: 2 }],
  },
];
test('year, variant, paper and part isolate the correct papers without hiding whole-year references', () => {
  const selected = selectPapers(sources, { year: 2025, variant: 'exam', paper: 3, part: 'B1' });
  assert.deepEqual(
    selected.questions.map((x) => x.id),
    ['split', 'combined'],
  );
  assert.deepEqual(
    selected.references.map((x) => x.id),
    ['ms'],
  );
  assert.deepEqual(selectPapers(sources, { year: 2012, variant: 'exam', paper: 3, part: 'A' }).questions, []);
});
test('tasks deduplicate and reset invalid selection; a task opens a verified source page', () => {
  const selection = { year: 2025, variant: 'exam', paper: 3, part: 'B1' };
  assert.deepEqual(taskOptions(sources, selection), [5, 6]);
  assert.deepEqual(chooseTask(sources, selection, 6), { sourceId: 'split', page: 12 });
  assert.equal(chooseTask(sources, selection, 1), null);
});
test('global seek maps exact boundaries and final end to real audio chunks', () => {
  const chunks = [
    { start: 0, duration: 480 },
    { start: 480, duration: 120 },
  ];
  assert.deepEqual(locateChunk(chunks, -1), { index: 0, offset: 0, time: 0 });
  assert.deepEqual(locateChunk(chunks, 480), { index: 1, offset: 0, time: 480 });
  assert.deepEqual(locateChunk(chunks, 599), { index: 1, offset: 119, time: 599 });
  assert.deepEqual(locateChunk(chunks, 800), { index: 1, offset: 120, time: 600 });
});
