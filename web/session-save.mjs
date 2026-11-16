import { STUDY_KEY, LISTENING_KEY, validateListeningRecords } from './training-core.mjs';

function browserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function listeningContent(record) {
  const { savedAt, ...content } = record;
  return JSON.stringify(content);
}

// The caller presents one summary and confirms it before invoking save(plan).
export function createSessionSaver({
  studyStore,
  getListeningSnapshot = () => null,
  storage = browserStorage(),
}) {
  const completedPlans = new WeakSet();
  return {
    prepare() {
      const study = studyStore.prepareSave();
      const pending = getListeningSnapshot();
      const listening = pending
        ? { ...pending, record: validateListeningRecords([pending.record])[0] }
        : null;
      return { changed: study.changed || !!listening, study, listening };
    },
    async save(plan) {
      if (!plan.changed || completedPlans.has(plan)) return { saved: false, study: false, listening: false };
      if (!storage) throw new Error('当前浏览器无法保存，请使用导出备份。');
      await plan.listening?.prepare?.();
      const changes = [];
      if (plan.study.changed && storage.getItem(STUDY_KEY) !== plan.study.text)
        changes.push([STUDY_KEY, plan.study.text]);
      if (plan.listening) {
        const previous = validateListeningRecords(JSON.parse(storage.getItem(LISTENING_KEY) || '[]'));
        const latest = [...previous]
          .reverse()
          .find((record) => record.lessonId === plan.listening.record.lessonId);
        if (!latest || listeningContent(latest) !== listeningContent(plan.listening.record))
          changes.push([
            LISTENING_KEY,
            JSON.stringify(validateListeningRecords([...previous, plan.listening.record])),
          ]);
      }
      const previousValues = changes.map(([key]) => [key, storage.getItem(key)]);
      try {
        for (const [key, text] of changes) storage.setItem(key, text);
        for (const [key, text] of changes)
          if (storage.getItem(key) !== text) throw new Error('保存回读不一致。');
      } catch (error) {
        const rollbackErrors = [];
        for (const [key, previous] of previousValues) {
          try {
            if (previous === null) storage.removeItem(key);
            else storage.setItem(key, previous);
            if (storage.getItem(key) !== previous) throw new Error('恢复回读不一致。');
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length) {
          throw new Error('保存失败，恢复原纪录也未通过核实；当前练习仍保留在页面，请勿关闭。', {
            cause: error,
          });
        }
        throw error;
      }
      completedPlans.add(plan);
      if (plan.study.changed) studyStore.ackSave(plan.study);
      plan.listening?.acknowledge?.();
      return {
        saved: !!changes.length,
        study: changes.some(([key]) => key === STUDY_KEY),
        listening: changes.some(([key]) => key === LISTENING_KEY),
      };
    },
  };
}
