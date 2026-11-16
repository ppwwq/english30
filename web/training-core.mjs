import { validateAnswerResult } from './core.mjs';

export const STUDY_KEY = 'english30-study-v1';
export const LISTENING_KEY = 'english30-records-v1';
const modules = new Set(['writing', 'reading', 'integrated', 'dictation']);
const phases = new Set(['first', 'review', 'retest']);
const clone = (value) => JSON.parse(JSON.stringify(value));
const isDate = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
  new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const safeId = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length < 250 &&
  /^[a-zA-Z0-9_:.@-]+$/.test(value) &&
  !(value in Object.prototype);
const validPaperReference = (p) =>
  p &&
  safeId(p.sentenceId) &&
  Number.isInteger(p.year) &&
  p.year >= 2012 &&
  p.year <= 2100 &&
  ['exam', 'practice', 'sample'].includes(p.variant) &&
  p.sessionId === `${p.year}-${p.variant}` &&
  ['A', 'B1', 'B2'].includes(p.part) &&
  Number.isInteger(p.task) &&
  p.task >= 1 &&
  p.task <= 10 &&
  Number.isFinite(p.start) &&
  p.start >= 0 &&
  Number.isFinite(p.end) &&
  p.end > p.start &&
  p.end <= 14400;
function inspect(value, depth = 0) {
  if (depth > 12) throw new Error('备份层级过深。');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('备份含无效数字。');
  if (typeof value === 'string' && value.length > 100000) throw new Error('单项文本过长。');
  if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('备份含保留字段。');
      inspect(child, depth + 1);
    }
}
export function dateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (name) => parts.find((p) => p.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function plusDays(date, days) {
  return new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
}
export function emptyStudyState(today = dateKey()) {
  return {
    schemaVersion: 1,
    records: [],
    personalExercises: [],
    paperMarks: [],
    reviews: {},
    settings: { startDate: today, minutes: 60 },
  };
}
export function validateStudyState(value) {
  inspect(value);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.records) ||
    value.records.length > 10000 ||
    !Array.isArray(value.personalExercises) ||
    value.personalExercises.length > 1000 ||
    !value.reviews ||
    Array.isArray(value.reviews) ||
    !value.settings ||
    !isDate(value.settings.startDate) ||
    ![30, 60].includes(value.settings.minutes)
  )
    throw new Error('学习备份格式不正确。');
  const ids = new Set();
  const markIds = new Set();
  if (value.paperMarks !== undefined && (!Array.isArray(value.paperMarks) || value.paperMarks.length > 10000))
    throw new Error('原卷复习标记格式不正确。');
  for (const m of value.paperMarks || []) {
    if (
      !validPaperReference(m) ||
      !safeId(m.key) ||
      markIds.has(m.key) ||
      !m.key.startsWith(`${m.sessionId}:`) ||
      typeof m.word !== 'string' ||
      m.word.length > 200 ||
      typeof m.text !== 'string' ||
      m.text.length > 4000 ||
      !Number.isFinite(Date.parse(m.createdAt))
    )
      throw new Error('原卷标记缺少有效的来源、原句或时间。');
    markIds.add(m.key);
  }
  for (const r of value.records) {
    if (
      !safeId(r.id) ||
      ids.has(r.id) ||
      !modules.has(r.module) ||
      !safeId(r.taskId) ||
      !phases.has(r.phase) ||
      !Number.isFinite(Date.parse(r.createdAt))
    )
      throw new Error('学习记录缺少有效的项目、时间或阶段。');
    ids.add(r.id);
    if (
      r.details?.paper &&
      (!validPaperReference(r.details.paper) ||
        r.module !== 'dictation' ||
        r.taskId !== `paper:${r.details.paper.sessionId}:${r.details.paper.sentenceId}`)
    )
      throw new Error('原卷练习缺少匹配的材料或时间。');
    if (
      r.correct != null &&
      (!Number.isFinite(r.correct) || r.correct < 0 || !Number.isFinite(r.total) || r.correct > r.total)
    )
      throw new Error('正确数与总数不一致。');
    if (r.total != null && (!Number.isFinite(r.total) || r.total < 0 || r.total > 10000))
      throw new Error('题目总数无效。');
    if (
      r.elapsedSeconds != null &&
      (!Number.isFinite(r.elapsedSeconds) || r.elapsedSeconds < 0 || r.elapsedSeconds > 604800)
    )
      throw new Error('练习用时无效。');
    if (
      r.errorTypes &&
      (!Array.isArray(r.errorTypes) ||
        r.errorTypes.length > 30 ||
        r.errorTypes.some((x) => typeof x !== 'string' || x.length > 100))
    )
      throw new Error('错因格式无效。');
  }
  for (const e of value.personalExercises)
    if (
      !safeId(e.id) ||
      typeof e.original !== 'string' ||
      typeof e.target !== 'string' ||
      !e.target.trim() ||
      e.target.length > 2000 ||
      typeof e.meaning !== 'string'
    )
      throw new Error('个人错句缺少原句、参考改句或意思。');
  for (const [id, r] of Object.entries(value.reviews))
    if (
      !safeId(id) ||
      !r ||
      !isDate(r.dueDate) ||
      !Number.isInteger(r.level) ||
      r.level < 0 ||
      r.level > 3 ||
      !['again', 'remembered'].includes(r.rating)
    )
      throw new Error('复习安排格式无效。');
  return clone({ ...value, paperMarks: value.paperMarks || [] });
}
export function validateListeningRecords(records) {
  inspect(records);
  if (!Array.isArray(records) || records.length > 10000) throw new Error('听力备份格式不正确。');
  for (const r of records) {
    if (
      !r ||
      r.schemaVersion !== 1 ||
      !safeId(r.lessonId) ||
      !Number.isFinite(Date.parse(r.savedAt)) ||
      !Array.isArray(r.attempts) ||
      !r.attempts.length ||
      !r.marks ||
      !Array.isArray(r.moments)
    )
      throw new Error('听力记录缺少材料、作答或时间信息。');
    for (const a of r.attempts) {
      if (!a || !a.results || typeof a.results !== 'object' || Array.isArray(a.results))
        throw new Error('听力作答格式不正确。');
      for (const [id, result] of Object.entries(a.results)) {
        if (!safeId(id)) throw new Error('听力答案编号无效。');
        validateAnswerResult(result, { allowLegacy: true });
      }
    }
  }
  return clone(records);
}
export function validateBackup(value) {
  if (!value || value.kind !== 'english30-backup' || value.schemaVersion !== 1)
    throw new Error('请选择 English30 完整学习备份。');
  return {
    schemaVersion: 1,
    kind: 'english30-backup',
    exportedAt: value.exportedAt,
    study: validateStudyState(value.study),
    listening: validateListeningRecords(value.listening),
  };
}
export function compareSentence(target, answer) {
  if (
    typeof target !== 'string' ||
    typeof answer !== 'string' ||
    target.length > 4000 ||
    answer.length > 4000
  )
    throw new Error('单句练习请限制在 4000 字符内。');
  const words = (text) =>
    String(text)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .match(/[a-z]+(?:'[a-z]+)?|\d+(?:[.,]\d+)*/g) || [];
  const expected = words(target),
    actual = words(answer);
  if (expected.length > 400 || actual.length > 400)
    throw new Error('请把长段落拆成不超过 400 词的单句练习。');
  const dp = Array.from({ length: expected.length + 1 }, () => Array(actual.length + 1).fill(0));
  for (let i = 0; i <= expected.length; i++) dp[i][0] = i;
  for (let j = 0; j <= actual.length; j++) dp[0][j] = j;
  for (let i = 1; i <= expected.length; i++)
    for (let j = 1; j <= actual.length; j++)
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (expected[i - 1] === actual[j - 1] ? 0 : 1),
      );
  const differences = [];
  let i = expected.length,
    j = actual.length;
  while (i || j) {
    if (i && j && expected[i - 1] === actual[j - 1]) {
      i--;
      j--;
    } else if (i && j && dp[i][j] === dp[i - 1][j - 1] + 1) {
      differences.unshift({ kind: 'replace', expected: expected[--i], actual: actual[--j] });
    } else if (i && dp[i][j] === dp[i - 1][j] + 1) {
      differences.unshift({ kind: 'missing', expected: expected[--i] });
    } else {
      differences.unshift({ kind: 'extra', actual: actual[--j] });
    }
  }
  return {
    correct: expected.length > 0 && dp[expected.length][actual.length] === 0,
    differences,
    expectedWords: expected.length,
    actualWords: actual.length,
  };
}
export function planForDay(startDate, today = dateKey(), budget = 60) {
  if (!isDate(startDate) || !isDate(today) || ![30, 60].includes(budget))
    throw new Error('训练日期或时长不正确。');
  const elapsed = Math.floor(
    (Date.parse(today + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86400000,
  );
  const day = Math.min(30, Math.max(1, elapsed + 1));
  const writingDay = [3, 6].includes(day % 7);
  const minutes =
    budget === 30
      ? { listening: 15, reading: day % 2 ? 10 : 0, writing: day % 2 ? 0 : 10, review: 5 }
      : writingDay
        ? { listening: 20, reading: 10, writing: 25, review: 5 }
        : { listening: 35, reading: 10, writing: 10, review: 5 };
  const focus =
    day <= 2
      ? '校准当前水平'
      : day <= 7
        ? '短段精听与准确写句'
        : day <= 14
          ? '隔天回忆与同义识别'
          : day <= 21
            ? '听读写信息整合'
            : day <= 28
              ? '减少提示，换新材料'
              : '用新材料比较独立表现';
  return {
    day,
    finished: elapsed >= 30,
    notStarted: elapsed < 0,
    focus,
    minutes,
    writingDay,
    b1: day >= 15 && day <= 21,
    startDate,
    endDate: plusDays(startDate, 29),
  };
}
export function nextReview(previous, rating, today = dateKey()) {
  if (!['again', 'remembered'].includes(rating) || !isDate(today)) throw new Error('复习结果无效。');
  const level = rating === 'again' ? 0 : Math.min(3, (previous?.level ?? -1) + 1);
  return { rating, level, lastDate: today, dueDate: plusDays(today, [1, 3, 7, 14][level]) };
}
export function listeningAttempts(records) {
  const attempts = new Map();
  for (const record of records || [])
    for (const [i, attempt] of (record.attempts || []).entries()) {
      const results = Object.values(attempt.results || {}).filter(Boolean);
      const scored = results.filter(
        (result) => result.grading !== 'self' && typeof result.correct === 'boolean',
      );
      const identity = attempt.id || attempt.submittedAt || attempt.createdAt || `legacy-${i}`;
      attempts.set(`${record.lessonId}:${identity}`, {
        module: 'listening',
        taskId: record.lessonId,
        phase: attempt.phase || (i === 0 ? 'first' : 'retest'),
        assisted: !!(
          attempt.assisted ||
          attempt.navigationUsed ||
          attempt.priorExposure ||
          attempt.phase === 'review'
        ),
        correct: scored.length ? scored.filter((result) => result.correct).length : null,
        total: scored.length,
        selfAssessments: Object.fromEntries(
          Object.entries(attempt.results || {})
            .filter(([, result]) => result?.grading === 'self')
            .map(([id, result]) => [id, result.selfAssessment ?? 'pending']),
        ),
        elapsedSeconds: attempt.elapsedSeconds || 0,
        errorTypes: results.flatMap((result) =>
          typeof result.errorType === 'string' && result.errorType ? [result.errorType] : [],
        ),
      });
    }
  return [...attempts.values()];
}
export function isTargetedStructureAttempt(record) {
  return (
    record.details?.practiceKind === 'targeted-structure' ||
    (!record.details?.practiceKind &&
      record.module === 'writing' &&
      record.details?.stage === 0 &&
      typeof record.answers?.sentence === 'string')
  );
}

export function summariseRecords(records) {
  const group = () => ({ attempts: 0, correct: 0, total: 0, seconds: 0 });
  const out = {
    first: group(),
    targeted: group(),
    assisted: group(),
    retest: group(),
    errors: {},
    writing: 0,
    reading: 0,
  };
  const firstSeen = new Set();
  for (const r of records) {
    let key =
      r.assisted || r.phase === 'review'
        ? 'assisted'
        : r.phase === 'retest'
          ? 'retest'
          : isTargetedStructureAttempt(r)
            ? 'targeted'
            : 'first';
    const task = `${r.module}:${r.taskId}`;
    if (['first', 'targeted'].includes(key) && firstSeen.has(task)) key = 'retest';
    firstSeen.add(task);
    const g = out[key];
    g.attempts++;
    if (Number.isFinite(r.correct) && Number.isFinite(r.total)) {
      g.correct += r.correct;
      g.total += r.total;
    }
    g.seconds += r.elapsedSeconds || 0;
    for (const e of r.errorTypes || []) out.errors[e] = (out.errors[e] || 0) + 1;
    if (r.module === 'writing') out.writing++;
    if (r.module === 'reading') out.reading++;
  }
  return out;
}
function storageDefault() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
export function createStudyStore({ storage = storageDefault(), now = () => new Date() } = {}) {
  let state = emptyStudyState(dateKey(now())),
    saved = clone(state),
    loadError = null;
  try {
    const raw = storage?.getItem(STUDY_KEY);
    if (raw) {
      state = validateStudyState(JSON.parse(raw));
      saved = clone(state);
    }
  } catch (e) {
    loadError = e.message;
  }
  const listeners = new Set();
  const emit = () => {
    for (const fn of listeners) fn();
  };
  const set = (value) => {
    state = validateStudyState(value);
    emit();
  };
  const api = {
    get loadError() {
      return loadError;
    },
    getState: () => clone(state),
    getSavedState: () => clone(saved),
    hasUnsaved: () => JSON.stringify(state) !== JSON.stringify(saved),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    addAttempt(input) {
      const record = clone({
        ...input,
        id: input.id || `a-${now().getTime()}-${Math.random().toString(36).slice(2, 9)}`,
        createdAt: input.createdAt || now().toISOString(),
        phase: input.phase || 'first',
        assisted: !!input.assisted,
      });
      set({ ...state, records: [...state.records, record] });
      return record.id;
    },
    addExercise(input) {
      const exercise = clone({
        ...input,
        id: input.id || `personal-${now().getTime()}-${Math.random().toString(36).slice(2, 7)}`,
        source: '个人添加的错句',
      });
      set({
        ...state,
        personalExercises: [...state.personalExercises.filter((e) => e.id !== exercise.id), exercise],
      });
      return exercise.id;
    },
    setPaperMarks(paperMarks) {
      set({ ...state, paperMarks });
    },
    setSettings(settings) {
      set({ ...state, settings: { ...state.settings, ...settings } });
    },
    markReviewed(id, rating) {
      if (!safeId(id)) throw new Error('复习项目无效。');
      set({
        ...state,
        reviews: { ...state.reviews, [id]: nextReview(state.reviews[id], rating, dateKey(now())) },
      });
    },
    replaceState(value) {
      set(value);
    },
    prepareSave() {
      const snapshot = validateStudyState(state);
      const text = JSON.stringify(snapshot);
      return { state: snapshot, text, changed: text !== JSON.stringify(saved) };
    },
    ackSave(snapshot) {
      // Acknowledge only the captured submission; newer edits remain in state.
      saved = validateStudyState(snapshot.state);
      loadError = null;
      emit();
      return clone(saved);
    },
    save() {
      if (!storage) throw new Error('当前浏览器无法保存，请使用导出备份。');
      const snapshot = api.prepareSave();
      storage.setItem(STUDY_KEY, snapshot.text);
      if (storage.getItem(STUDY_KEY) !== snapshot.text) throw new Error('保存回读不一致。');
      return api.ackSave(snapshot);
    },
    exportBackup() {
      let listening = [];
      const raw = storage?.getItem(LISTENING_KEY);
      if (raw) listening = validateListeningRecords(JSON.parse(raw));
      return {
        schemaVersion: 1,
        kind: 'english30-backup',
        exportedAt: now().toISOString(),
        study: clone(saved),
        listening,
      };
    },
    importBackup(input) {
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
          oldListening == null
            ? storage.removeItem(LISTENING_KEY)
            : storage.setItem(LISTENING_KEY, oldListening);
        } catch {}
        throw e;
      }
      state = merged;
      saved = clone(merged);
      loadError = null;
      emit();
      return { records: merged.records.length, listening: listening.length };
    },
  };
  return api;
}
export const studyStore = createStudyStore();
