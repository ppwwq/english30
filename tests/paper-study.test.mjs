import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudyStore, validateStudyState } from '../web/training-core.mjs';
import { paperDrillSentences, createPaperDrill } from '../web/paper-study-core.mjs';

const mark = {
  key: '2025-exam:w1',
  sessionId: '2025-exam',
  year: 2025,
  variant: 'exam',
  part: 'A',
  task: 1,
  sentenceId: 's1',
  word: 'tickets',
  text: 'We need two tickets.',
  start: 103.2,
  end: 106.8,
  createdAt: '2026-11-15T09:00:00Z',
};
function memoryStorage() {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
}
const sentence = {
  id: 's1',
  text: 'We need two tickets.',
  start: 103.2,
  end: 106.8,
  words: ['We', 'need', 'two', 'tickets.'].map((text, i) => ({
    id: `w${i}`,
    text,
    start: 103.2 + i * 0.8,
    end: 104 + i * 0.8,
    sourceMatched: true,
  })),
};
const selection = { year: 2025, variant: 'exam', part: 'A', task: 1 };
const session = {
  id: '2025-exam',
  year: 2025,
  variant: 'exam',
  audio: { duration: 400 },
  tasks: [{ part: 'A', number: 1, range: { start: 100, end: 200 } }],
  sentences: [sentence],
};

test('short dictation offers only bounded, aligned sentences from the selected A/B1 task', () => {
  const data = {
    ...session,
    sentences: [
      sentence,
      { ...sentence, id: 'long', end: 150 },
      { ...sentence, id: 'outside', start: 50, end: 54 },
      { ...sentence, id: 'uncertain', words: [{ start: null, sourceMatched: false }] },
      { ...sentence, id: 'instructions', text: 'You now have 30 seconds to study the task.' },
    ],
  };
  assert.deepEqual(
    paperDrillSentences(data, selection).map((s) => s.id),
    ['s1'],
  );
  assert.deepEqual(paperDrillSentences(data, { ...selection, part: 'B2' }), []);
});

test('dictation freezes the submitted answer and separates first, assisted and retest results', () => {
  const drill = createPaperDrill({ session, selection, sentenceId: 's1' });
  assert.throws(() => drill.submit('We need tickets.'), /先听/);
  drill.played(1);
  const first = drill.submit('We need tickets.');
  assert.equal(first.record.phase, 'first');
  assert.equal(first.record.assisted, false);
  assert.equal(first.record.correct, 0);
  assert.deepEqual(first.result.differences, [{ kind: 'missing', expected: 'two' }]);
  assert.throws(() => drill.submit('We need two tickets.'), /已经提交/);
  const retest = createPaperDrill({ session, selection, sentenceId: 's1', previous: [first.record] });
  retest.played(1);
  assert.equal(retest.submit('We need two tickets.').record.phase, 'retest');
  const assisted = createPaperDrill({ session, selection, sentenceId: 's1' });
  assisted.played(0.75);
  assert.equal(assisted.submit('We need two tickets.').record.assisted, true);
  const repeated = createPaperDrill({ session, selection, sentenceId: 's1' });
  repeated.played(1);
  repeated.played(1);
  assert.equal(repeated.submit('').record.assisted, true);
});

test('original-paper marks stay drafts until explicit save, then survive reload and full backup import', () => {
  const storage = memoryStorage(),
    store = createStudyStore({ storage });
  store.setPaperMarks([mark]);
  assert.equal(storage.getItem('english30-study-v1'), null);
  assert.deepEqual(store.exportBackup().study.paperMarks, []);
  store.save();
  assert.deepEqual(createStudyStore({ storage }).getState().paperMarks, [mark]);
  const restored = createStudyStore({ storage: memoryStorage() });
  restored.importBackup(store.exportBackup());
  assert.deepEqual(restored.getSavedState().paperMarks, [mark]);
  restored.importBackup(store.exportBackup());
  assert.equal(restored.getState().paperMarks.length, 1);
});

test('old backups remain compatible, while malformed marks cannot corrupt saved state', () => {
  const store = createStudyStore({ storage: memoryStorage() });
  const old = store.getState();
  delete old.paperMarks;
  assert.deepEqual(validateStudyState(old).paperMarks, []);
  for (const bad of [
    { ...mark, end: mark.start },
    { ...mark, sessionId: '../wrong' },
    { ...mark, part: 'Z' },
    { ...mark, year: 100 },
    { ...mark, task: -1 },
    { ...mark, text: 'x'.repeat(4001) },
    { ...mark, createdAt: 'bad' },
  ])
    assert.throws(() => store.setPaperMarks([bad]));
  assert.throws(() => store.setPaperMarks([mark, mark]));
  assert.deepEqual(store.getState().paperMarks, []);
});

test('imported original-paper attempts must retain a valid matching source before any write', () => {
  const storage = memoryStorage(),
    store = createStudyStore({ storage });
  const drill = createPaperDrill({ session, selection, sentenceId: 's1' });
  drill.played();
  const { record } = drill.submit('We need two tickets.');
  for (const paper of [
    { ...record.details.paper, sessionId: '2012-practice' },
    { ...record.details.paper, end: 0 },
    { ...record.details.paper, sentenceId: 'different' },
  ])
    assert.throws(() => store.addAttempt({ ...record, details: { ...record.details, paper } }));
  assert.deepEqual(store.getState().records, []);
  assert.equal(storage.getItem('english30-study-v1'), null);
});
