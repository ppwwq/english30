import { validateLesson, validateAnswerResult, validatePaperInk } from '../../web/core.mjs';

export const LISTENING_RECORDS_KEY = 'english30-records-v1';
const safeId = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value) && !(value in Object.prototype);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const phases = new Set(['first', 'review', 'retest']);
function inspect(value, depth = 0) {
  if (depth > 14) throw new Error('文件层级过深。');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('文件含无效数字。');
  if (typeof value === 'string' && value.length > 100000) throw new Error('单项文本过长。');
  if (value && typeof value === 'object')
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('文件含保留字段。');
      inspect(child, depth + 1);
    }
}
function jsonCopy(input, max = 6_000_000) {
  if (typeof input === 'string' && input.length > max) throw new Error('文件太大，请分成较小的练习。');
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  inspect(value);
  const text = JSON.stringify(value);
  if (!text || text.length > max) throw new Error('文件太大或格式无效。');
  return JSON.parse(text);
}

/** Validate the single-record JSON produced by the listening page's Export button. */
export function parseListeningRecord(input) {
  const r = jsonCopy(input);
  if (
    !object(r) ||
    r.schemaVersion !== 1 ||
    !safeId(r.lessonId) ||
    !date(r.savedAt) ||
    !Array.isArray(r.attempts) ||
    !r.attempts.length ||
    r.attempts.length > 1000 ||
    !object(r.marks) ||
    !Array.isArray(r.moments) ||
    r.moments.length > 30000
  )
    throw new Error('请选择有效的单条听力学习纪录。');
  if (r.lessonTitle != null && (typeof r.lessonTitle !== 'string' || r.lessonTitle.length > 300))
    throw new Error('听力材料名称无效。');
  if (r.timingOffset != null && (!Number.isFinite(r.timingOffset) || Math.abs(r.timingOffset) > 5))
    throw new Error('字幕偏移必须在正负 5 秒内。');
  for (const a of r.attempts) {
    if (a?.ink !== undefined) validatePaperInk(a.ink);
    if (
      !object(a) ||
      !phases.has(a.phase) ||
      !date(a.submittedAt) ||
      !object(a.results) ||
      !Object.keys(a.results).length ||
      Object.keys(a.results).length > 100
    )
      throw new Error('听力作答缺少有效的阶段、时间或题目。');
    if (a.id != null && !safeId(a.id)) throw new Error('作答编号无效。');
    for (const key of ['assisted', 'navigationUsed', 'priorExposure'])
      if (a[key] != null && typeof a[key] !== 'boolean') throw new Error('作答辅助状态无效。');
    if (
      a.elapsedSeconds != null &&
      (!Number.isFinite(a.elapsedSeconds) || a.elapsedSeconds < 0 || a.elapsedSeconds > 604800)
    )
      throw new Error('作答用时无效。');
    for (const [id, result] of Object.entries(a.results)) {
      if (!safeId(id)) throw new Error('听力答案编号无效。');
      validateAnswerResult(result);
    }
  }
  for (const [id, type] of Object.entries(r.marks))
    if (!safeId(id) || !['heard', 'unknown'].includes(type)) throw new Error('卡词标记格式无效。');
  for (const m of r.moments) {
    if (
      !object(m) ||
      !Number.isFinite(m.time) ||
      m.time < 0 ||
      m.time > 7200 ||
      (m.phase != null && !phases.has(m.phase))
    )
      throw new Error('时间标记格式无效。');
    if (
      (m.start != null || m.end != null) &&
      (!Number.isFinite(m.start) ||
        !Number.isFinite(m.end) ||
        m.start < 0 ||
        m.end > 7200 ||
        m.end - m.start < 0.3)
    )
      throw new Error('复习片段范围无效。');
  }
  return r;
}

/** Call only after the user confirms the prepared import summary. */
export function importListeningRecord(input, { storage } = {}) {
  const record = parseListeningRecord(input);
  try {
    storage ??= globalThis.localStorage;
  } catch {
    throw new Error('当前浏览器无法保存学习纪录。');
  }
  if (!storage) throw new Error('当前浏览器无法保存学习纪录。');
  const before = storage.getItem(LISTENING_RECORDS_KEY);
  const previous = before == null ? [] : JSON.parse(before);
  if (!Array.isArray(previous) || previous.length > 10000) throw new Error('已有听力纪录格式异常，未覆盖。');
  const records = previous.map(parseListeningRecord);
  const index = records.findIndex((r) => r.lessonId === record.lessonId && r.savedAt === record.savedAt);
  if (index < 0) records.push(record);
  else records[index] = record;
  const serialized = JSON.stringify(records);
  try {
    storage.setItem(LISTENING_RECORDS_KEY, serialized);
    if (storage.getItem(LISTENING_RECORDS_KEY) !== serialized) throw new Error('导入回读不一致。');
  } catch (error) {
    try {
      before == null
        ? storage.removeItem(LISTENING_RECORDS_KEY)
        : storage.setItem(LISTENING_RECORDS_KEY, before);
    } catch {}
    throw new Error(`听力纪录未能保存：${error.message}`);
  }
  return { record, total: records.length, added: index < 0 };
}

/** Local private source library. Construction/read operations never save a lesson. */
export function createListeningLibrary({
  indexedDB = globalThis.indexedDB,
  databaseName = 'english30-listening-library-v1',
} = {}) {
  function open() {
    return new Promise((resolve, reject) => {
      if (!indexedDB) return reject(new Error('当前浏览器无法使用本地材料库，请保留原文件。'));
      let request;
      try {
        request = indexedDB.open(databaseName, 1);
      } catch (error) {
        reject(new Error(`本地材料库无法打开：${error.message}`));
        return;
      }
      request.onupgradeneeded = () => request.result.createObjectStore('lessons', { keyPath: 'id' });
      request.onerror = () =>
        reject(new Error(`本地材料库无法打开：${request.error?.message || '浏览器拒绝储存'}`));
      let blocked = false;
      request.onblocked = () => {
        blocked = true;
        reject(new Error('本地材料库被其他页面占用，请关闭旧页面后重试。'));
      };
      request.onsuccess = () => {
        if (blocked) {
          request.result.close();
          return;
        }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  }
  async function transaction(mode, operation) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('lessons', mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () =>
          reject(new Error(`本地材料操作失败：${tx.error?.message || '空间不足或储存被拒绝'}`));
        const request = operation(tx.objectStore('lessons'));
        request.onsuccess = () => {
          result = request.result;
        };
      });
    } finally {
      db.close();
    }
  }
  async function load(id) {
    if (!safeId(id)) throw new Error('材料编号无效。');
    const entry = await transaction('readonly', (store) => store.get(id));
    if (!entry) return null;
    validateLesson(entry.lesson);
    if (!(entry.audio instanceof Blob) || !entry.audio.size)
      throw new Error('已保存的原音不完整，请重新载入原文件。');
    return entry;
  }
  return {
    async save({ lesson, audio }) {
      const copy = jsonCopy(lesson);
      validateLesson(copy);
      if (!safeId(copy.id)) throw new Error('材料编号只接受字母、数字和常用分隔符。');
      if (!(audio instanceof Blob) || audio.size <= 0 || audio.size > 300_000_000)
        throw new Error('请先载入不超过 300 MB 的匹配原音。');
      const entry = {
        id: copy.id,
        lesson: copy,
        audio: audio.slice(0, audio.size, audio.type),
        savedAt: new Date().toISOString(),
      };
      await transaction('readwrite', (store) => store.put(entry));
      const back = await load(copy.id);
      if (
        !back ||
        JSON.stringify(back.lesson) !== JSON.stringify(copy) ||
        back.audio.size !== audio.size ||
        back.audio.type !== audio.type
      )
        throw new Error('材料回读验证失败，请保留原文件并重新保存。');
      return back;
    },
    load,
    async list() {
      const entries = await transaction('readonly', (store) => store.getAll());
      return entries.map(({ id, lesson, savedAt }) => ({
        id,
        title: lesson.title,
        year: lesson.source?.year || null,
        part: lesson.source?.paper?.match(/Part\s+([AB]\d?)/i)?.[1] || '',
        task: lesson.source?.task || '',
        minutes: Math.round(lesson.duration / 6) / 10,
        imported: true,
        savedAt,
      }));
    },
    async remove(id) {
      if (!safeId(id)) throw new Error('材料编号无效。');
      await transaction('readwrite', (store) => store.delete(id));
    },
  };
}

export const listeningLibrary = createListeningLibrary();
