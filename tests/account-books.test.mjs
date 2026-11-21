import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAccountApi } from '../cloudflare/account-api.mjs';

const read = (name) => readFileSync(new URL('../' + name, import.meta.url));
const books = JSON.parse(read('web/papers/answer-books.json'));
const catalogue = JSON.parse(read('web/papers/catalogue.json'));
const sources = new Map(catalogue.sources.map((s) => [s.id, s]));
const approved = new Map(JSON.parse(read('assets-manifest.json')).files.map((f) => [f.path, f.sha256]));

test('all 30 A/B1 books keep safe distinct original pages, full Task coverage and separate Data Files', () => {
  assert.equal(Object.keys(books).length, 30);
  let pages = 0,
    data = 0;
  for (const b of Object.values(books)) {
    assert.deepEqual(b.taskChoices.map((c) => c.task).sort(), b.part === 'A' ? [1, 2, 3, 4] : [5, 6, 7]);
    const seen = new Set();
    for (const p of [...b.pages, ...b.data]) {
      assert.ok(!seen.has(p.key));
      seen.add(p.key);
      const source = sources.get(p.source);
      assert.ok(source && !source.containsAnswers && ['question', 'data'].includes(source.role));
      assert.equal(source.year, b.year);
      assert.equal(source.variant, b.variant);
      assert.equal(approved.get(p.src), p.originalHash);
      assert.equal(p.src, source.pages[p.number - 1].src.slice(2));
    }
    for (const task of b.taskChoices) assert.ok(b.pages.some((p) => p.number === task.page));
    pages += b.pages.length;
    data += b.data.length;
  }
  assert.equal(pages, 221);
  assert.equal(data, 131);
  assert.equal(books['2025-exam-B1'].data.length, 0);
  assert.equal(books['2025-exam-B1'].pages[11].source, 'p-0f9d7f187a64');
  assert.deepEqual(
    books['2020-exam-B1'].pages.map((p) => p.number),
    [12, 13, 14, 15],
  );
});

test('a confirmed save survives a verified missing original, preserves ordered Data File and retries just once', async () => {
  const raw = new DatabaseSync(':memory:');
  const db = {
    one: (q, ...v) => raw.prepare(q).get(...v),
    all: (q, ...v) => raw.prepare(q).all(...v),
    run: (q, ...v) => raw.prepare(q).run(...v),
    transaction(fn) {
      raw.exec('BEGIN');
      try {
        const r = fn();
        raw.exec('COMMIT');
        return r;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const files = new Map();
  const bucket = {
    async put(k, v) {
      files.set(k, new Uint8Array(v));
    },
    async get(k) {
      const bytes = files.get(k);
      return bytes ? { body: bytes, arrayBuffer: async () => bytes.slice().buffer } : null;
    },
    async delete(keys) {
      for (const k of [keys].flat()) files.delete(k);
    },
  };
  const book = structuredClone(books['2014-exam-B1']);
  // A one-pixel RGB JPEG. A distinct JPEG comment identifies each simulated original.
  const pixel = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z',
    'base64',
  );
  const originals = new Map();
  for (const page of [...book.pages, ...book.data]) {
    const label = Buffer.from(page.key);
    const comment = Buffer.from([0xff, 0xfe, 0, label.length + 2]);
    const bytes = Buffer.concat([pixel.subarray(0, 2), comment, label, pixel.subarray(2)]);
    page.width = page.height = 1;
    page.master = createHash('sha256').update(bytes).digest('hex');
    originals.set('/papers/print/' + page.master + '.jpg', bytes);
  }
  originals.delete('/papers/print/' + book.pages[0].master + '.jpg');
  const api = createAccountApi(db, bucket, async (url) => {
    if (url === '/papers/answer-books.json') return Response.json({ '2014-exam-B1': book });
    return originals.has(url) ? new Response(originals.get(url)) : new Response(null, { status: 404 });
  });
  const origin = 'https://english30.test';
  let headers = { 'Content-Type': 'application/json' };
  const call = (route, method = 'GET', value) =>
    api.fetch(
      new Request(origin + route, {
        method,
        headers,
        body: value === undefined ? undefined : JSON.stringify(value),
      }),
    );
  const signup = await call('/api/account/register', 'POST', {
    name: 'reader',
    password: 'paper-test-password',
  });
  const { user } = await signup.json();
  headers = {
    ...headers,
    Cookie: signup.headers.get('Set-Cookie').split(';')[0],
    'X-English30-Owner': user.id,
  };
  const pages = [...book.pages, ...book.data];
  for (let i = 0; i < pages.length; i += 8) {
    const r = await call('/api/books/freeze', 'POST', {
      book: '2014-exam-B1',
      hashes: pages.slice(i, i + 8).map((p) => p.master),
    });
    assert.equal(r.status, 200);
  }
  const choice = book.taskChoices[0],
    record = {
      schemaVersion: 1,
      lessonId: choice.lessonId,
      savedAt: new Date().toISOString(),
      marks: {},
      moments: [],
      attempts: [{ id: crypto.randomUUID(), phase: 'first', results: {} }],
    };
  const paper = {
    id: crypto.randomUUID(),
    saveId: crypto.randomUUID(),
    base: 0,
    book: '2014-exam-B1',
    task: choice.task,
    lessonId: choice.lessonId,
    record,
    touched: [],
    appendices: [],
    includeData: true,
  };
  const first = await (await call('/api/papers', 'POST', paper)).json(),
    retry = await (await call('/api/papers', 'POST', paper)).json();
  assert.deepEqual(first, retry);
  assert.equal(first.version, 1);
  const route = '/api/papers/' + paper.id + '/versions/1';
  const detail = await (await call(route)).json();
  assert.equal(detail.missing, true);
  assert.equal(detail.pages.length, 14);
  assert.equal(detail.pages[0].missing, true);
  assert.equal(detail.pages[4].kind, 'data');
  assert.equal((await call(route + '/pages/1/image')).status, 404);
  const pdf = await call(route + '/pdf');
  assert.equal(pdf.status, 200);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.match(bytes.toString('latin1'), /Original page unavailable/);
  assert.match(bytes.toString('latin1'), /\/Count 14 /);
  const page = await call(route + '/pages/2/image');
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await page.arrayBuffer()))
      .digest('hex'),
    book.pages[1].master,
  );
  raw.close();
});
