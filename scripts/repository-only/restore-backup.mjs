import {
  validateBackup,
  validateStudyState,
  validateListeningRecords,
  STUDY_KEY,
  LISTENING_KEY,
} from '../../web/training-core.mjs';

export function restoreBackup(store, storage, input) {
  const state = store.getState();
  const payload = validateBackup(input);
  if (!storage) throw new Error('当前浏览器无法导入保存。');
  const oldStudy = storage.getItem(STUDY_KEY),
    oldListening = storage.getItem(LISTENING_KEY);
  const existing = oldListening ? validateListeningRecords(JSON.parse(oldListening)) : [];
  const merge = (a, b, key) => [...new Map([...a, ...b].map((x) => [key(x), x])).values()];
  const merged = validateStudyState({
    ...state,
    records: merge(state.records, payload.study.records, (x) => x.id),
    personalExercises: merge(state.personalExercises, payload.study.personalExercises, (x) => x.id),
    paperMarks: merge(state.paperMarks, payload.study.paperMarks, (x) => x.key),
    reviews: { ...state.reviews, ...payload.study.reviews },
    settings: payload.study.settings,
  });
  const listening = merge(existing, payload.listening, (x) => `${x.lessonId}:${x.savedAt}`);
  const a = JSON.stringify(merged),
    b = JSON.stringify(listening);
  try {
    storage.setItem(STUDY_KEY, a);
    storage.setItem(LISTENING_KEY, b);
    if (storage.getItem(STUDY_KEY) !== a || storage.getItem(LISTENING_KEY) !== b)
      throw new Error('导入回读不一致。');
  } catch (e) {
    try {
      oldStudy == null ? storage.removeItem(STUDY_KEY) : storage.setItem(STUDY_KEY, oldStudy);
      oldListening == null ? storage.removeItem(LISTENING_KEY) : storage.setItem(LISTENING_KEY, oldListening);
    } catch {}
    throw e;
  }
  store.replaceState(merged);
  store.ackSave({ state: merged });
  return { records: merged.records.length, listening: listening.length };
}
