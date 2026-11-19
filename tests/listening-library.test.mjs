import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createListeningLibrary,
  parseListeningRecord,
  importListeningRecord,
} from '../scripts/repository-only/listening-library.mjs';

const record = () => ({
  schemaVersion: 1,
  lessonId: 'personal-one',
  lessonTitle: 'My paper',
  savedAt: '2026-11-15T10:00:00.000Z',
  attempts: [
    {
      phase: 'first',
      submittedAt: '2026-11-15T09:59:00.000Z',
      results: { q1: { answer: 'five', correct: true, duplicate: false } },
    },
  ],
  marks: { w1: 'heard' },
  moments: [{ time: 4, phase: 'first' }],
});
const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
};

test('single listening exports import once and preserve an existing saved lesson', () => {
  const storage = memoryStorage();
  const old = { ...record(), lessonId: 'existing' };
  storage.setItem('english30-records-v1', JSON.stringify([old]));
  const incoming = record();
  assert.deepEqual(parseListeningRecord(JSON.stringify(incoming)), incoming);
  assert.equal(importListeningRecord(incoming, { storage }).total, 2);
  assert.equal(importListeningRecord(incoming, { storage }).added, false);
  assert.equal(JSON.parse(storage.getItem('english30-records-v1')).length, 2);
  assert.equal(JSON.parse(storage.getItem('english30-records-v1'))[0].lessonId, 'existing');
});

test('invalid and prototype-bearing imports cannot change saved records', () => {
  const storage = memoryStorage();
  importListeningRecord(record(), { storage });
  const before = storage.getItem('english30-records-v1');
  const bad = record();
  bad.attempts[0].results.q1.answer = { html: 'bad' };
  assert.throws(() => importListeningRecord(bad, { storage }), /答案/);
  assert.throws(() => parseListeningRecord('{"__proto__":{"polluted":true}}'), /保留/);
  assert.equal(storage.getItem('english30-records-v1'), before);
  assert.equal({}.polluted, undefined);
});

test('manual original-paper exports round-trip long answers and reject forged self assessments', () => {
  const incoming = record();
  incoming.attempts[0].results.written = {
    answer: 'My written response. '.repeat(60),
    correct: null,
    duplicate: false,
    grading: 'self',
    status: 'pending',
  };
  assert.deepEqual(parseListeningRecord(incoming), incoming);
  const assessed = structuredClone(incoming);
  Object.assign(assessed.attempts[0].results.written, { selfAssessment: 'correct', status: 'self-reviewed' });
  const storage = memoryStorage();
  assert.deepEqual(importListeningRecord(assessed, { storage }).record, assessed);
  for (const badResult of [
    { correct: true },
    { selfAssessment: 'hacked' },
    { selfAssessment: {} },
    { selfAssessment: 'correct' },
    { status: 'self-reviewed' },
    { grading: 'auto' },
    { duplicate: true },
    { answer: 'x'.repeat(20001) },
  ]) {
    const bad = structuredClone(incoming);
    Object.assign(bad.attempts[0].results.written, badResult);
    assert.throws(() => parseListeningRecord(bad), /答案|自核/);
  }
  const automatic = record();
  automatic.attempts[0].results.q1.selfAssessment = 'correct';
  assert.throws(() => parseListeningRecord(automatic), /自核/);
});

test('a failed verification restores the pre-import record instead of reporting success', () => {
  const storage = memoryStorage();
  const prior = JSON.stringify([record()]);
  storage.setItem('english30-records-v1', prior);
  const write = storage.setItem;
  let first = true;
  storage.setItem = (key, value) => {
    write(key, first ? '[]' : value);
    first = false;
  };
  assert.throws(() => importListeningRecord({ ...record(), lessonId: 'second' }, { storage }), /回读/);
  assert.equal(storage.getItem('english30-records-v1'), prior);
});

test('an unavailable material store reports a useful error and never pretends to save', async () => {
  await assert.rejects(createListeningLibrary({ indexedDB: null }).list(), /本地材料/);
});

test('imports preserve calibrated ranges and attempt metadata while rejecting invalid bounds', () => {
  const value = record();
  value.timingOffset = -1.2;
  value.moments[0] = { time: 4, phase: 'first', start: 1.1, end: 5.8 };
  Object.assign(value.attempts[0], {
    id: 'attempt-1',
    assisted: true,
    navigationUsed: true,
    priorExposure: true,
    elapsedSeconds: 70,
  });
  assert.deepEqual(parseListeningRecord(value), value);
  value.timingOffset = 6;
  assert.throws(() => parseListeningRecord(value), /字幕/);
  value.timingOffset = 0;
  value.moments[0].end = 0.3;
  assert.throws(() => parseListeningRecord(value), /片段/);
  value.moments[0].end = 5.8;
  value.attempts[0].assisted = 'false';
  assert.throws(() => parseListeningRecord(value), /辅助/);
});

test(
  'real IndexedDB keeps the lesson and original audio after page reload, only following explicit save',
  { skip: !process.env.TEST_BROWSER },
  async () => {
    const { createServer } = await import('node:http');
    const { readFile } = await import('node:fs/promises');
    const { createRequire } = await import('node:module');
    const require = createRequire(
      process.env.PLAYWRIGHT_PACKAGE || new URL('../package.json', import.meta.url).href,
    );
    const { chromium } = require('playwright');
    const routes = new Map([
      ['/listening-library.mjs', ['../scripts/repository-only/listening-library.mjs', 'text/javascript']],
      ['/web/core.mjs', ['core.mjs', 'text/javascript']],
      ['/lesson.json', ['lessons/2024-task2-intro.json', 'application/json']],
      ['/audio.mp3', ['audio/2024-task2-intro.mp3', 'audio/mpeg']],
    ]);
    const server = createServer(async (req, res) => {
      try {
        if (req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<!doctype html><title>Library test</title>');
          return;
        }
        const route = routes.get(req.url);
        if (!route) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': route[1] });
        res.end(await readFile(new URL(`../web/${route[0]}`, import.meta.url)));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_EXECUTABLE || undefined,
      });
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const before = await page.evaluate(async () => {
        const { createListeningLibrary } = await import('/listening-library.mjs');
        const library = createListeningLibrary({ databaseName: 'test-persistence' });
        const lesson = await fetch('/lesson.json').then((r) => r.json());
        lesson.id = 'personal-persistence';
        const audio = await fetch('/audio.mp3').then((r) => r.blob());
        const stagedCount = (await library.list()).length;
        await library.save({ lesson, audio });
        lesson.title = 'Unsaved change';
        const saved = await library.load('personal-persistence');
        const hash = [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', await saved.audio.arrayBuffer())),
        ].join(',');
        return { stagedCount, title: saved.lesson.title, hash, size: saved.audio.size };
      });
      assert.equal(before.stagedCount, 0);
      assert.notEqual(before.title, 'Unsaved change');
      await page.reload();
      const after = await page.evaluate(async () => {
        const { createListeningLibrary } = await import('/listening-library.mjs');
        const library = createListeningLibrary({ databaseName: 'test-persistence' });
        const catalogue = await library.list();
        const saved = await library.load(catalogue[0].id);
        const hash = [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', await saved.audio.arrayBuffer())),
        ].join(',');
        const result = {
          title: saved.lesson.title,
          hash,
          size: saved.audio.size,
          count: catalogue.length,
          questionCount: saved.lesson.questions.length,
          imported: catalogue[0].imported,
        };
        await library.remove(saved.id);
        result.remaining = (await library.list()).length;
        return result;
      });
      assert.equal(after.count, 1);
      assert.equal(after.title, before.title);
      assert.equal(after.hash, before.hash);
      assert.equal(after.size, before.size);
      assert.equal(after.questionCount, 8);
      assert.equal(after.imported, true);
      assert.equal(after.remaining, 0);
    } finally {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
