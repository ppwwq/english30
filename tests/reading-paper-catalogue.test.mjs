import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildReadingPaperCatalogue } from '../web/reading-paper-catalogue.mjs';

const { sources } = JSON.parse(readFileSync(new URL('../web/papers/catalogue.json', import.meta.url)));
const sourceById = new Map(sources.map((source) => [source.id, source]));
const catalogue = buildReadingPaperCatalogue(sources);
const edition = (year, variant = 'exam', data = catalogue) =>
  data.find((document) => document.year === year && document.variant === variant);
const pagesOf = (part, kind) => part.pages.filter((page) => page.kind === kind).map((page) => page.page);

test('Paper 1 catalogues both practice parts for each audited edition', () => {
  assert.deepEqual(
    catalogue.map(({ year, variant }) => [year, variant]),
    [
      ...Array.from({ length: 14 }, (_, index) => [2025 - index, 'exam']),
      [2012, 'practice'],
      [2012, 'sample'],
    ],
  );
  assert.equal(new Set(catalogue.map(({ id }) => id)).size, catalogue.length);
  for (const { parts } of catalogue) {
    assert.deepEqual(
      parts.map(({ id }) => id),
      ['A', 'B1'],
    );
    assert.equal(parts[0].questions[0].number, 1);
    assert.equal(parts[1].questions[0].number, parts[0].questions.at(-1).number + 1);
    for (const part of parts) {
      assert.ok(pagesOf(part, 'text').length > 0);
      assert.ok(pagesOf(part, 'question').length > 0);
      assert.ok(part.references[0].pages.length > 0);
    }
  }
});

test('practice images keep stable provenance and exclude scoring pages', () => {
  for (const { year, variant, parts } of catalogue) {
    for (const { id, pages, references } of parts) {
      assert.equal(new Set(pages.map((page) => page.id)).size, pages.length);
      for (const page of pages) {
        const source = sourceById.get(page.sourceId);
        assert.equal(source.year, year);
        assert.equal(source.variant, variant);
        assert.equal(source.paper, 1);
        assert.equal(source.role, 'question');
        assert.ok(source.parts.includes(id));
        assert.equal(page.id, `${source.id}:${page.page}`);
        assert.deepEqual(
          { src: page.src, width: page.width, height: page.height },
          source.pages[page.page - 1],
        );
        assert.ok(!source.containsAnswers || page.page < source.answerStartsPage);
      }
      for (const reference of references) {
        const source = sourceById.get(reference.sourceId);
        assert.equal(source.role, 'marking');
        assert.equal(source.year, year);
        assert.equal(source.variant, variant);
        assert.ok(reference.pages.every((page) => page.sourceId === source.id));
      }
    }
  }
});

test('Paper 1 preserves split and reordered original booklets', () => {
  const split2013 = edition(2013).parts[0];
  assert.equal(split2013.pages[0].sourceId, 'p-5cc25c61965c');
  assert.equal(split2013.pages.at(-1).sourceId, 'p-962b3b805430');
  assert.deepEqual(pagesOf(split2013, 'text'), [1, 2]);
  assert.deepEqual(pagesOf(split2013, 'question'), [1, 2, 3, 4]);

  const reversed2015 = edition(2015).parts[0];
  assert.equal(reversed2015.pages[0].kind, 'text');
  assert.deepEqual(pagesOf(reversed2015, 'text'), [6, 7]);
  assert.deepEqual(pagesOf(reversed2015, 'question'), [1, 2, 3, 4]);

  const reordered2023 = edition(2023).parts[1];
  assert.deepEqual(pagesOf(reordered2023, 'text'), [5, 6]);
  assert.deepEqual(pagesOf(reordered2023, 'question'), [14, 15, 16, 17]);

  const sampleB1 = edition(2012, 'sample').parts[1];
  assert.deepEqual(pagesOf(sampleB1, 'text'), [18, 19]);
  assert.deepEqual(pagesOf(sampleB1, 'question'), [8, 9, 10, 11]);
  assert.equal(sampleB1.questions[0].number, 39);
});

test('Paper 1 selects full scans and identifies shared or rotated scoring pages', () => {
  assert.deepEqual(pagesOf(edition(2019).parts[1], 'question'), [4, 5, 6, 7, 8, 9]);
  assert.deepEqual(pagesOf(edition(2020).parts[1], 'question'), [11, 12, 13, 14]);
  assert.deepEqual(pagesOf(edition(2022).parts[1], 'question'), [10, 12, 13, 14]);
  const reference2018 = edition(2018).parts[1].references[0];
  assert.ok(reference2018.pages.every((page) => page.rotation === 90));
  const reference2025 = edition(2025).parts[0].references[0];
  assert.equal(reference2025.mixed, true);
  assert.deepEqual(
    reference2025.pages.map((page) => page.page),
    [1, 2],
  );
  assert.match(edition(2012, 'practice').parts[0].references[0].label, /暂定/);
});

test('a changed marking boundary or incomplete source cannot leak into practice', () => {
  const changed = sources.map((source) =>
    source.id === 'p-956807ac5e5a' ? { ...source, answerStartsPage: 12 } : source,
  );
  const result = edition(2022, 'exam', buildReadingPaperCatalogue(changed));
  assert.deepEqual(
    result.parts.map(({ id }) => id),
    ['A'],
  );

  const missingPassage = sources.filter((source) => source.id !== 'p-5cc25c61965c');
  assert.equal(edition(2013, 'exam', buildReadingPaperCatalogue(missingPassage)), undefined);
});
