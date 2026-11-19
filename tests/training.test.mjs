import { restoreBackup } from '../scripts/repository-only/restore-backup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createStudyStore,
  compareSentence,
  planForDay,
  nextReview,
  validateStudyState,
  summariseRecords,
  validateBackup,
  listeningAttempts,
} from '../web/training-core.mjs';

test('dictation treats standard thousands separators as the same number without discarding decimals', () => {
  assert.equal(compareSentence('About 7,000 people.', 'About 7000 people').correct, true);
  assert.equal(compareSentence('It costs 1,250.50 dollars.', 'It costs 1250.50 dollars').correct, true);
  assert.equal(compareSentence('It costs 7.5 dollars.', 'It costs 75 dollars').correct, false);
  assert.equal(compareSentence('There are 7,000 people.', '7000').correct, false);
});

test('legacy named-structure answers stay separate from independent paragraphs without rewriting records', () => {
  const records = [
    {
      module: 'writing',
      taskId: 'old-sentence',
      phase: 'first',
      answers: { sentence: 'My sentence.' },
      details: { stage: 0 },
    },
    {
      module: 'writing',
      taskId: 'paragraph',
      phase: 'first',
      answers: { draft: 'My draft.' },
      details: { kind: 'paragraph' },
    },
    {
      module: 'writing',
      taskId: 'assisted',
      phase: 'first',
      assisted: true,
      answers: { sentence: 'Helped.' },
      details: { stage: 0 },
    },
  ];
  const before = structuredClone(records);
  const stats = summariseRecords(records);
  assert.equal(stats.targeted.attempts, 1);
  assert.equal(stats.first.attempts, 1);
  assert.equal(stats.assisted.attempts, 1);
  assert.deepEqual(records, before);
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
}
test('staging learning never writes storage, explicit save persists a snapshot and reads it back', () => {
  const storage = memoryStorage();
  const store = createStudyStore({ storage, now: () => new Date('2026-11-15T10:00:00Z') });
  store.addAttempt({
    module: 'writing',
    taskId: 'opportunities',
    phase: 'first',
    answers: { sentence: 'We have fewer opportunities to study.' },
    correct: 1,
    total: 1,
  });
  assert.equal(storage.getItem('english30-study-v1'), null);
  assert.equal(store.getSavedState().records.length, 0);
  assert.equal(store.hasUnsaved(), true);
  store.save();
  assert.equal(store.getSavedState().records.length, 1);
  assert.equal(store.hasUnsaved(), false);
  const record = store.getState().records[0];
  record.answers.sentence = 'changed';
  assert.equal(store.getSavedState().records[0].answers.sentence, 'We have fewer opportunities to study.');
  assert.equal(createStudyStore({ storage }).getState().records.length, 1);
});
test('a failed save does not claim a new saved state', () => {
  const store = createStudyStore({
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
    },
  });
  store.addAttempt({ module: 'reading', taskId: 'r1', phase: 'first' });
  assert.throws(() => store.save(), /full/);
  assert.equal(store.getSavedState().records.length, 0);
  assert.equal(store.hasUnsaved(), true);
});
test('sentence checking reports missing and extra words, accepts punctuation and curly apostrophe differences', () => {
  assert.equal(
    compareSentence('Parents can help their children to study.', 'parents can help their children to study')
      .correct,
    true,
  );
  assert.equal(compareSentence('We don’t pay.', "We don't pay").correct, true);
  const result = compareSentence('They have opportunities to study.', 'They have opportunities study.');
  assert.equal(result.correct, false);
  assert.ok(result.differences.some((x) => x.kind === 'missing' && x.expected === 'to'));
  assert.equal(compareSentence('We can organise classes.', 'We can orange classes.').correct, false);
});
test('30-day plan follows the selected budget and keeps month boundaries stable', () => {
  const early = planForDay('2026-11-15', '2026-11-15', 60);
  assert.equal(early.day, 1);
  assert.equal(early.minutes.listening, 35);
  const late = planForDay('2026-11-15', '2026-12-14', 30);
  assert.equal(late.day, 30);
  assert.equal(
    Object.values(late.minutes).reduce((a, b) => a + b, 0),
    30,
  );
  assert.equal(planForDay('2026-11-15', '2026-12-30', 60).finished, true);
  assert.throws(() => planForDay('2026-02-31', '2026-03-04', 60));
});
test('single-sentence checking rejects oversized input before allocating an edit-distance table', () => {
  assert.throws(() => compareSentence('hello', 'word '.repeat(1000)), /单句|400/);
});
test('review dates lengthen only after remembered retrieval and reset on another miss', () => {
  const first = nextReview(null, 'again', '2026-11-15');
  assert.equal(first.dueDate, '2026-11-16');
  const success = nextReview(first, 'remembered', '2026-11-16');
  assert.equal(success.dueDate, '2026-11-19');
  const miss = nextReview(success, 'again', '2026-11-19');
  assert.equal(miss.dueDate, '2026-11-20');
  assert.equal(miss.level, 0);
});
test('statistics keep independent first attempts separate from assisted practice and retests', () => {
  const stats = summariseRecords([
    { module: 'reading', phase: 'first', assisted: false, correct: 2, total: 4 },
    { module: 'reading', phase: 'review', assisted: true, correct: 4, total: 4 },
    { module: 'reading', phase: 'retest', assisted: false, correct: 3, total: 4 },
  ]);
  assert.equal(stats.first.correct, 2);
  assert.equal(stats.first.total, 4);
  assert.equal(stats.assisted.correct, 4);
  assert.equal(stats.retest.correct, 3);
  const exposed = summariseRecords([
    { module: 'reading', taskId: 'r1', phase: 'first', assisted: true, correct: 2, total: 2 },
    { module: 'reading', taskId: 'r1', phase: 'first', assisted: false, correct: 2, total: 2 },
  ]);
  assert.equal(exposed.first.attempts, 0);
  assert.equal(exposed.retest.attempts, 1);
});

test('a named structure exercise is counted separately from independent first attempts', () => {
  const stats = summariseRecords([
    {
      module: 'writing',
      taskId: 'opportunities',
      phase: 'first',
      assisted: false,
      correct: 1,
      total: 1,
      details: { practiceKind: 'targeted-structure', stage: 0 },
    },
    { module: 'writing', taskId: 'opportunities', phase: 'review', assisted: true, correct: 1, total: 1 },
    { module: 'writing', taskId: 'opportunities', phase: 'retest', assisted: false, selfCheck: 'correct' },
    { module: 'reading', taskId: 'new-passage', phase: 'first', assisted: false, correct: 2, total: 3 },
  ]);
  assert.equal(stats.first.attempts, 1);
  assert.equal(stats.first.total, 3);
  assert.equal(stats.targeted.attempts, 1);
  assert.equal(stats.assisted.attempts, 1);
  assert.equal(stats.retest.attempts, 1);
});
test('backup validators reject malformed or dangerous state before any write', () => {
  assert.throws(() => validateStudyState({ schemaVersion: 1, records: 'bad' }));
  const store = createStudyStore({ storage: memoryStorage() });
  const state = store.getState();
  state.reviews = JSON.parse('{"__proto__":{"level":0,"dueDate":"2026-11-15"}}');
  assert.throws(() => validateStudyState(state));
  assert.throws(() =>
    validateBackup({
      schemaVersion: 1,
      kind: 'english30-backup',
      study: store.getState(),
      listening: [{ id: 'missing-data' }],
    }),
  );
});

test('full backup merges saved listening, existing drafts and imported learning with a verified round-trip', () => {
  const storage = memoryStorage();
  const store = createStudyStore({ storage, now: () => new Date('2026-11-15T10:00:00Z') });
  store.addAttempt({ id: 'existing', module: 'reading', taskId: 'r1', phase: 'first' });
  const incoming = createStudyStore({
    storage: memoryStorage(),
    now: () => new Date('2026-11-14T10:00:00Z'),
  });
  incoming.addAttempt({ id: 'imported', module: 'writing', taskId: 'w1', phase: 'retest' });
  incoming.save();
  const backup = incoming.exportBackup();
  backup.listening = [
    {
      schemaVersion: 1,
      lessonId: '2025-task1',
      savedAt: '2026-11-14T10:00:00Z',
      attempts: [{ results: { q1: { correct: true } } }],
      marks: { w1: 'heard' },
      moments: [],
    },
  ];
  assert.deepEqual(restoreBackup(store, storage, backup), { records: 2, listening: 1 });
  assert.deepEqual(
    store.exportBackup().study.records.map((r) => r.id),
    ['existing', 'imported'],
  );
  assert.equal(store.exportBackup().listening[0].marks.w1, 'heard');
  assert.equal(store.hasUnsaved(), false);
  assert.equal(createStudyStore({ storage }).getSavedState().records.length, 2);
  assert.deepEqual(restoreBackup(store, storage, backup), { records: 2, listening: 1 });
});

test('failed two-store import rolls back the successful first write and preserves memory state', () => {
  const storage = memoryStorage();
  const originalSet = storage.setItem;
  storage.setItem = (key, value) => {
    if (key === 'english30-records-v1') throw new Error('quota');
    originalSet(key, value);
  };
  const store = createStudyStore({ storage });
  const backup = store.exportBackup();
  store.addAttempt({ id: 'draft', module: 'reading', taskId: 'r1', phase: 'first' });
  assert.throws(() => restoreBackup(store, storage, backup), /quota/);
  assert.equal(storage.getItem('english30-study-v1'), null);
  assert.equal(store.getState().records.length, 1);
  assert.equal(store.getSavedState().records.length, 0);
});

test('full backups preserve pending and self-reviewed answers without accepting forged grades', () => {
  const backup = createStudyStore({ storage: memoryStorage() }).exportBackup();
  const manual = {
    answer: 'My response.',
    correct: null,
    duplicate: false,
    grading: 'self',
    status: 'pending',
  };
  backup.listening = [
    {
      schemaVersion: 1,
      lessonId: 'paper-task',
      savedAt: '2026-11-15T10:00:00Z',
      marks: {},
      moments: [],
      attempts: [{ results: { written: manual, legacy: { correct: true } } }],
    },
  ];
  assert.deepEqual(validateBackup(backup).listening, backup.listening);
  manual.status = 'self-reviewed';
  manual.selfAssessment = 'incorrect';
  assert.deepEqual(validateBackup(backup).listening, backup.listening);
  for (const badResult of [
    { ...manual, correct: false },
    { ...manual, selfAssessment: 'wrong' },
    { ...manual, status: 'pending' },
    { ...manual, answer: [] },
    null,
  ]) {
    const bad = structuredClone(backup);
    bad.listening[0].attempts[0].results.written = badResult;
    assert.throws(() => validateBackup(bad), /答案|自核/);
  }
});

test('listening snapshots update one stable attempt and keep navigation-assisted work out of first-attempt results', () => {
  const attempt = {
    phase: 'first',
    submittedAt: '2026-11-15T10:00:00Z',
    navigationUsed: true,
    results: { q1: { correct: false, errorType: '拼写' } },
  };
  const newer = { ...attempt, results: { q1: { correct: true, errorType: '语境义' } } };
  const records = [
    { lessonId: 'intro', attempts: [attempt] },
    {
      lessonId: 'intro',
      attempts: [
        newer,
        { phase: 'retest', submittedAt: '2026-11-16T10:00:00Z', results: { q1: { correct: true } } },
      ],
    },
  ];
  const flat = listeningAttempts(records);
  assert.equal(flat.length, 2);
  assert.deepEqual(flat[0].errorTypes, ['语境义']);
  const stats = summariseRecords(flat);
  assert.equal(stats.first.attempts, 0);
  assert.equal(stats.assisted.correct, 1);
  assert.equal(stats.retest.correct, 1);
});

test('manual listening attempts remain in history but do not lower automatic accuracy', () => {
  const manual = {
    answer: 'My response.',
    correct: null,
    duplicate: false,
    grading: 'self',
    status: 'self-reviewed',
    selfAssessment: 'correct',
  };
  const flat = listeningAttempts([
    {
      lessonId: 'paper-task',
      attempts: [
        { id: 'first', phase: 'first', results: { q1: { correct: true }, q2: manual } },
        { id: 'second', phase: 'retest', results: { q2: manual } },
      ],
    },
  ]);
  assert.equal(flat.length, 2);
  assert.equal(flat[0].correct, 1);
  assert.equal(flat[0].total, 1);
  assert.equal(flat[1].correct, null);
  assert.equal(flat[1].total, 0);
  assert.deepEqual(flat[1].selfAssessments, { q2: 'correct' });
  const stats = summariseRecords(flat);
  assert.equal(stats.first.correct, 1);
  assert.equal(stats.first.total, 1);
  assert.equal(stats.retest.attempts, 1);
  assert.equal(stats.retest.total, 0);
});
