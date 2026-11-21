import { validateBackup, emptyStudyState } from './training-core.mjs';

export function emptyBackup() {
  return {
    kind: 'english30-backup',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    study: emptyStudyState(),
    listening: [],
  };
}

const identity = {
  records: (r) => r.id,
  personalExercises: (e) => e.id,
  paperMarks: (m) => m.key,
  listening: (r) => r.lessonId + ':' + r.savedAt,
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Send only changes from the acknowledged local snapshot. Deletions carry
// their previous value so a stale device cannot remove a newer cloud edit.
export function learningDelta(previous, next) {
  const delta = { sets: {}, removed: {}, reviews: {}, settings: {} };
  for (const [group, key] of Object.entries(identity)) {
    const before = new Map((previous.study[group] || previous[group]).map((v) => [key(v), v]));
    const after = new Map((next.study[group] || next[group]).map((v) => [key(v), v]));
    delta.sets[group] = [...after].filter(([id, v]) => !same(before.get(id), v)).map(([, v]) => v);
    delta.removed[group] = [...before].filter(([id]) => !after.has(id)).map(([, v]) => v);
  }
  for (const group of ['reviews', 'settings']) {
    for (const key of new Set([...Object.keys(previous.study[group]), ...Object.keys(next.study[group])])) {
      const before = previous.study[group][key],
        after = next.study[group][key];
      if (!same(before, after)) delta[group][key] = { before, after };
    }
  }
  return delta;
}
export function applyLearningDelta(backup, delta) {
  const next = structuredClone(backup);
  for (const [group, key] of Object.entries(identity)) {
    const rows = new Map((next.study[group] || next[group]).map((v) => [key(v), v]));
    for (const prev of delta.removed[group]) if (same(rows.get(key(prev)), prev)) rows.delete(key(prev));
    for (const row of delta.sets[group]) rows.set(key(row), row);
    (group === 'listening' ? next : next.study)[group] = [...rows.values()];
  }
  for (const group of ['reviews', 'settings']) {
    for (const [key, change] of Object.entries(delta[group])) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw Error('记录字段无效。');
      if (change.after !== undefined) next.study[group][key] = change.after;
      else if (same(next.study[group][key], change.before)) delete next.study[group][key];
    }
  }
  next.exportedAt = new Date().toISOString();
  return validateBackup(next);
}
