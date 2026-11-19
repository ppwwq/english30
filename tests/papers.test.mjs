import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
await fs.mkdir(new URL('./artifacts/', import.meta.url), { recursive: true });
const root = new URL('../web/', import.meta.url);
const catalogue = JSON.parse(await fs.readFile(new URL('papers/catalogue.json', root), 'utf8'));
test('provided PDFs and reviewed supplements retain source identity and readable page assets', async () => {
  assert.equal(catalogue.sources.filter((s) => s.role !== 'supplement' && !s.externalSupplement).length, 126);
  const added = catalogue.sources.filter((s) => s.externalSupplement);
  assert.equal(added.length, 1);
  assert.equal(added[0].sourceUrl, 'https://src.dselib.com/eng/eng/2022/ans.pdf');
  assert.deepEqual(added[0].originalPdfPages, [17, 24]);
  assert.equal(catalogue.sources.filter((s) => s.role === 'supplement').length, 3);
  assert.equal(new Set(catalogue.sources.map((s) => s.id)).size, catalogue.sources.length);
  for (const source of catalogue.sources) {
    assert.ok(source.sourcePath);
    assert.equal(source.pages.length, source.pageCount);
    for (const page of source.pages) assert.ok((await fs.stat(new URL(page.src, root))).size > 0);
  }
});
test('wrongfoldermetadataiscorrectedandmissingSampleaudioisexplicit', () => {
  const misplaced = catalogue.sources.find((s) => s.sourcePath === 'Paper 2\\2015.pdf');
  assert.equal(misplaced.paper, 1);
  assert.deepEqual(misplaced.parts, ['B2']);
  assert.ok(catalogue.sessionIssues['2012-sample']);
  assert.equal(
    catalogue.sessions.some((s) => s.id === '2012-sample'),
    false,
  );
});
test('everyexamyearhas10linkedTasksandallclipswordsandreferencesstaywithintheirrealassets', async () => {
  for (let year = 2012; year <= 2025; year++)
    assert.ok(catalogue.sessions.some((s) => s.id === `${year}-exam`));
  assert.equal(catalogue.sessions.length, 15);
  for (const entry of catalogue.sessions) {
    const s = JSON.parse(await fs.readFile(new URL(entry.url, root), 'utf8'));
    assert.equal(s.tasks.length, 10, s.id);
    const ids = new Set();
    let end = 0;
    for (const c of s.audio.chunks) {
      assert.ok(Math.abs(c.start - end) < 0.01);
      end = c.start + c.duration;
      assert.ok((await fs.stat(new URL(c.src, root))).size > 0);
    }
    assert.ok(Math.abs(end - s.audio.duration) < 0.01);
    for (const t of s.tasks) assert.ok(t.range.end > t.range.start && t.range.end <= end + 0.1);
    for (const sentence of s.sentences)
      for (const w of sentence.words) {
        assert.equal(ids.has(w.id), false);
        ids.add(w.id);
        if (w.start !== null) assert.ok(w.end > w.start && w.start >= 0 && w.end <= end + 0.1);
      }
    for (const e of s.evidence)
      assert.ok(e.start >= 0 && e.end > e.start && e.end <= end + 0.1 && e.end - e.start <= 20);
    for (const q of s.questionIndex) {
      const source = catalogue.sources.find((x) => x.id === q.sourceId);
      assert.ok(source, `${s.id}/${q.sourceId}`);
      assert.ok(q.page >= 1 && q.page <= source.pageCount);
    }
  }
});
