import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudyStore, STUDY_KEY, LISTENING_KEY } from '../web/training-core.mjs';
import { createSessionSaver } from '../web/session-save.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function stage(store, id = 'reading-1') {
  store.addAttempt({ id, module: 'reading', taskId: id, answers: { answer: 'a submitted answer' } });
}
test('standalone save keeps later submissions pending while its confirmation is open', () => {
  const storage = memoryStorage();
  const store = createStudyStore({ storage });
  stage(store, 'first');
  const snapshot = store.prepareSave();
  stage(store, 'later');
  store.save(snapshot);
  assert.deepEqual(
    JSON.parse(storage.getItem(STUDY_KEY)).records.map((record) => record.id),
    ['first'],
  );
  assert.equal(store.getState().records.length, 2);
  assert.equal(store.hasUnsaved(), true);
});
function listeningRecord() {
  return {
    schemaVersion: 1,
    lessonId: 'listening-1',
    lessonTitle: 'Listening fixture',
    savedAt: '2026-11-16T10:00:00.000Z',
    attempts: [{ phase: 'first', results: { q1: { answer: '10', correct: true } } }],
    marks: {},
    moments: [],
  };
}

test('preparing a combined save does not persist until confirmed save is invoked', async () => {
  const storage = memoryStorage();
  const studyStore = createStudyStore({ storage });
  stage(studyStore);
  let acknowledged = false;
  const saver = createSessionSaver({
    studyStore,
    storage,
    getListeningSnapshot: () => ({
      record: listeningRecord(),
      acknowledge: () => {
        acknowledged = true;
      },
    }),
  });
  const plan = saver.prepare();
  assert.equal(plan.changed, true);
  assert.equal(createStudyStore({ storage }).getState().records.length, 0);
  assert.equal(acknowledged, false);
  assert.deepEqual(await saver.save(plan), { saved: true, study: true, listening: true });
  const restored = createStudyStore({ storage }).exportBackup();
  assert.equal(restored.study.records[0].id, 'reading-1');
  assert.equal(restored.listening[0].attempts[0].results.q1.answer, '10');
  assert.equal(studyStore.hasUnsaved(), false);
  assert.equal(acknowledged, true);
});

test('a second-key write failure restores the previous records and leaves submissions pending', async () => {
  const storage = memoryStorage();
  const studyStore = createStudyStore({ storage });
  stage(studyStore, 'previous-study');
  studyStore.save();
  const previousListening = listeningRecord();
  previousListening.lessonId = 'previous-listening';
  storage.setItem(LISTENING_KEY, JSON.stringify([previousListening]));
  stage(studyStore, 'pending-study');
  let acknowledged = false;
  const saver = createSessionSaver({
    studyStore,
    storage,
    getListeningSnapshot: () => ({
      record: listeningRecord(),
      acknowledge: () => {
        acknowledged = true;
      },
    }),
  });
  const originalSet = storage.setItem;
  let failOnce = true;
  storage.setItem = (key, value) => {
    originalSet(key, value);
    if (key === LISTENING_KEY && failOnce) {
      failOnce = false;
      throw new Error('simulated quota failure');
    }
  };
  await assert.rejects(saver.save(saver.prepare()), /quota failure/);
  const restored = createStudyStore({ storage }).exportBackup();
  assert.deepEqual(
    restored.study.records.map((record) => record.id),
    ['previous-study'],
  );
  assert.deepEqual(
    restored.listening.map((record) => record.lessonId),
    ['previous-listening'],
  );
  assert.equal(studyStore.hasUnsaved(), true);
  assert.equal(acknowledged, false);
});

test('a readback failure rolls both keys back, including previously absent keys', async () => {
  const storage = memoryStorage();
  const studyStore = createStudyStore({ storage });
  stage(studyStore);
  let acknowledged = false;
  const saver = createSessionSaver({
    studyStore,
    storage,
    getListeningSnapshot: () => ({
      record: listeningRecord(),
      acknowledge: () => {
        acknowledged = true;
      },
    }),
  });
  const originalGet = storage.getItem;
  let failOnce = true;
  storage.getItem = (key) => {
    const stored = originalGet(key);
    if (key === LISTENING_KEY && stored !== null && failOnce) {
      failOnce = false;
      return 'simulated damaged readback';
    }
    return stored;
  };
  await assert.rejects(saver.save(saver.prepare()), /回读不一致/);
  assert.equal(storage.getItem(STUDY_KEY), null);
  assert.equal(storage.getItem(LISTENING_KEY), null);
  assert.equal(studyStore.hasUnsaved(), true);
  assert.equal(acknowledged, false);
});

test('a rollback failure reports that persistence could not be verified and does not acknowledge', async () => {
  const storage = memoryStorage();
  const studyStore = createStudyStore({ storage });
  stage(studyStore);
  let acknowledged = false;
  const saver = createSessionSaver({
    studyStore,
    storage,
    getListeningSnapshot: () => ({
      record: listeningRecord(),
      acknowledge: () => {
        acknowledged = true;
      },
    }),
  });
  const originalSet = storage.setItem;
  storage.setItem = (key, value) => {
    originalSet(key, value);
    if (key === LISTENING_KEY) throw new Error('simulated quota failure');
  };
  storage.removeItem = () => {
    throw new Error('simulated rollback failure');
  };
  await assert.rejects(saver.save(saver.prepare()), /恢复原纪录也未通过核实/);
  assert.equal(studyStore.hasUnsaved(), true);
  assert.equal(acknowledged, false);
});

test('empty and repeated saves do not write duplicate records', async () => {
  const storage = memoryStorage();
  const studyStore = createStudyStore({ storage });
  let pending = null;
  const saver = createSessionSaver({ studyStore, storage, getListeningSnapshot: () => pending });
  const empty = saver.prepare();
  assert.equal(empty.changed, false);
  assert.deepEqual(await saver.save(empty), { saved: false, study: false, listening: false });
  assert.equal(storage.getItem(STUDY_KEY), null);
  assert.equal(storage.getItem(LISTENING_KEY), null);

  stage(studyStore);
  pending = { record: listeningRecord() };
  const first = saver.prepare();
  await saver.save(first);
  assert.deepEqual(await saver.save(first), { saved: false, study: false, listening: false });
  pending = { record: { ...listeningRecord(), savedAt: '2026-11-16T10:10:00.000Z' } };
  assert.deepEqual(await saver.save(saver.prepare()), { saved: false, study: false, listening: false });
  assert.equal(createStudyStore({ storage }).exportBackup().listening.length, 1);
});

test('material preparation failure leaves both records untouched and submissions pending', async () => {
  const storage = memoryStorage();
  const studyStore = createStudyStore({ storage });
  stage(studyStore);
  let acknowledged = false;
  const saver = createSessionSaver({
    studyStore,
    storage,
    getListeningSnapshot: () => ({
      record: listeningRecord(),
      prepare: async () => {
        throw new Error('material preparation failed');
      },
      acknowledge: () => {
        acknowledged = true;
      },
    }),
  });
  await assert.rejects(saver.save(saver.prepare()), /material preparation failed/);
  assert.equal(storage.getItem(STUDY_KEY), null);
  assert.equal(storage.getItem(LISTENING_KEY), null);
  assert.equal(studyStore.hasUnsaved(), true);
  assert.equal(acknowledged, false);
});

test('submissions made while material preparation awaits remain pending after snapshot acknowledgement', async () => {
  const storage = memoryStorage();
  const studyStore = createStudyStore({ storage });
  stage(studyStore, 'before-confirmation');
  let finishPreparation;
  const prepared = new Promise((resolve) => {
    finishPreparation = resolve;
  });
  const saver = createSessionSaver({
    studyStore,
    storage,
    getListeningSnapshot: () => ({ record: listeningRecord(), prepare: () => prepared }),
  });
  const saving = saver.save(saver.prepare());
  stage(studyStore, 'after-confirmation');
  finishPreparation();
  await saving;
  assert.deepEqual(
    createStudyStore({ storage })
      .getState()
      .records.map((record) => record.id),
    ['before-confirmation'],
  );
  assert.deepEqual(
    studyStore.getState().records.map((record) => record.id),
    ['before-confirmation', 'after-confirmation'],
  );
  assert.equal(studyStore.hasUnsaved(), true);
  await saver.save(saver.prepare());
  assert.equal(studyStore.hasUnsaved(), false);
  assert.equal(createStudyStore({ storage }).getState().records.length, 2);
});

test('a full listening archive is rejected before changing either saved dataset', async () => {
  const storage = memoryStorage();
  const previous = Array.from({ length: 10000 }, (_, index) => ({
    ...listeningRecord(),
    lessonId: `previous-${index}`,
  }));
  const raw = JSON.stringify(previous);
  storage.setItem(LISTENING_KEY, raw);
  const studyStore = createStudyStore({ storage });
  stage(studyStore);
  const saver = createSessionSaver({
    studyStore,
    storage,
    getListeningSnapshot: () => ({ record: listeningRecord() }),
  });
  await assert.rejects(saver.save(saver.prepare()), /听力备份格式不正确/);
  assert.equal(storage.getItem(STUDY_KEY), null);
  assert.equal(storage.getItem(LISTENING_KEY), raw);
  assert.equal(studyStore.hasUnsaved(), true);
});
