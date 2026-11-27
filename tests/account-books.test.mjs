import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createAccountApi } from '../cloudflare/account-api.mjs';
import { createPrivateFiles } from '../cloudflare/private-files.mjs';
import { buildReadingPaperCatalogue } from '../web/reading-paper-catalogue.mjs';
import { emptyBackup, learningDelta } from '../web/account-learning.mjs';

const read = (name) => readFileSync(new URL('../' + name, import.meta.url));
const books = JSON.parse(read('web/papers/answer-books.json'));
const catalogue = JSON.parse(read('web/papers/catalogue.json'));
const sources = new Map(catalogue.sources.map((s) => [s.id, s]));
const approved = new Map(JSON.parse(read('assets-manifest.json')).files.map((f) => [f.path, f.sha256]));

test('all 30 A/B1 books keep safe distinct original pages, full Task coverage and separate Data Files', () => {
  const listening = Object.values(books).filter((book) => book.paper !== 1);
  assert.equal(listening.length, 30);
  let pages = 0,
    data = 0;
  for (const b of listening) {
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

test('all 32 Paper 1 books preserve only the verified reading and answer pages in order', () => {
  let count = 0;
  for (const paper of buildReadingPaperCatalogue(catalogue.sources)) {
    for (const part of paper.parts) {
      count++;
      const book = books[`reading-${paper.year}-${paper.variant}-${part.id}`];
      assert.equal(book.paper, 1);
      assert.equal(book.taskChoices[0].lessonId, `reading-paper:${paper.year}-${paper.variant}:${part.id}`);
      assert.deepEqual(
        book.questions,
        part.questions.map((q) => q.number),
      );
      assert.equal(book.pages.length, part.pages.length);
      for (const [i, page] of book.pages.entries()) {
        const original = part.pages[i];
        assert.equal(page.key, original.id);
        assert.equal(page.originalHash, approved.get(page.src));
        assert.equal(page.writable, original.kind !== 'text');
        assert.notEqual(original.kind, 'reference');
      }
    }
  }
  assert.equal(count, 32);
});

function database(raw) {
  return {
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
}

test('a learning snapshot can replace the current one at quota and immediately releases the old object', async (t) => {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  const db = database(raw);
  const files = createPrivateFiles(db);
  const api = createAccountApi(db, files, async () => new Response(null, { status: 404 }));
  const origin = 'https://english30.test';
  const register = await api.fetch(
    new Request(origin + '/api/account/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'quota-reader', password: 'quota-test-password' }),
    }),
  );
  assert.equal(register.status, 200);
  const { user } = await register.json();
  const cookie = register.headers.get('Set-Cookie').split(';')[0];
  const post = async (previous, next) => {
    const response = await api.fetch(
      new Request(origin + '/api/learning', {
        method: 'POST',
        headers: { cookie, 'Content-Type': 'application/json', 'X-English30-Owner': user.id },
        body: JSON.stringify({ saveId: crypto.randomUUID(), delta: learningDelta(previous, next) }),
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const previous = emptyBackup();
  const first = structuredClone(previous);
  first.study.settings.startDate = '2026-11-26';
  const old = await post(previous, first);
  const oldPath = `users/${user.id}/${old.hash}`;
  const oldBytes = db.one('SELECT bytes FROM objects WHERE path=?', oldPath).bytes;
  db.run(
    'INSERT INTO objects VALUES (?,?,?,?,?,?)',
    `users/${user.id}/quota-fixture`,
    user.id,
    256 * 1024 * 1024 - oldBytes,
    Date.now(),
    0,
    0,
  );
  const second = structuredClone(first);
  second.study.settings.startDate = '2026-11-27';
  const current = await post(first, second);
  assert.notEqual(current.hash, old.hash);
  assert.equal(files.get(oldPath), null);
  assert.equal(db.one('SELECT hash FROM learning WHERE owner=?', user.id).hash, current.hash);
});

test('private SQLite files round-trip over 2 MiB and an interrupted replacement preserves every old part', async (t) => {
  const raw = new DatabaseSync(':memory:');
  t.after(() => raw.close());
  const db = database(raw);
  const files = createPrivateFiles(db);
  const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, i) => (i * 31 + (i >>> 16)) % 251);
  files.put('users/a/page', bytes);
  files.put('users/b/page', Uint8Array.of(42));
  assert.deepEqual(new Uint8Array(await files.get('users/a/page').arrayBuffer()), bytes);
  assert.ok(db.one('SELECT max(length(data)) AS n FROM file_parts').n < 2 * 1024 * 1024);
  raw.exec(
    "CREATE TRIGGER simulate_full BEFORE INSERT ON file_parts WHEN NEW.part=1 BEGIN SELECT RAISE(ABORT,'full'); END",
  );
  assert.throws(() => files.put('users/a/page', new Uint8Array(bytes.length)), /full/);
  assert.deepEqual(new Uint8Array(await files.get('users/a/page').arrayBuffer()), bytes);
  raw.exec('DROP TRIGGER simulate_full');
  files.put('users/a/page', new Uint8Array());
  assert.equal((await files.get('users/a/page').arrayBuffer()).byteLength, 0);
  assert.deepEqual(new Uint8Array(await files.get('users/b/page').arrayBuffer()), Uint8Array.of(42));
  files.delete(['users/a/page', 'users/b/page']);
  assert.equal(files.get('users/a/page'), null);
  assert.equal(files.get('users/b/page'), null);
});

test('a confirmed save survives a verified missing original, preserves ordered Data File and retries just once', async () => {
  const raw = new DatabaseSync(':memory:');
  const db = database(raw);
  const bucket = createPrivateFiles(db);
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
  const deleted = await call('/api/papers/' + paper.id, 'DELETE');
  assert.equal(deleted.status, 200);
  assert.deepEqual(await (await call('/api/papers')).json(), []);
  assert.equal((await (await call(route)).json()).code, 'PAPER_DELETED');
  assert.deepEqual(Object.keys(db.one('SELECT * FROM deleted_papers')), ['owner', 'paper']);
  assert.deepEqual(Object.keys(db.one('SELECT * FROM deleted_members')), ['owner', 'lesson', 'stamp']);
  assert.equal(db.one('SELECT count(*) AS n FROM versions').n, 0);
  raw.close();
});
