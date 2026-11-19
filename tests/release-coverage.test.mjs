import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const root = new URL('../web/papers/', import.meta.url);
const catalogue = JSON.parse(await fs.readFile(new URL('practice-catalogue.json', root)));
const sources = JSON.parse(await fs.readFile(new URL('catalogue.json', root)));
const pageExists = (ref) => !!sources.sources.find((s) => s.id === ref?.sourceId)?.pages[ref.page - 1];
test('every playable A+B1 task has reviewed display references, contextual evidence and valid source pages', async () => {
  let aQuestions = 0,
    bTasks = 0,
    audioPoints = 0;
  const entries = catalogue.lessons.filter((e) => ['A', 'B1'].includes(e.part) && !e.missingAudio);
  assert.equal(entries.length, 105);
  for (const entry of entries) {
    const lesson = JSON.parse(await fs.readFile(new URL(`practice/${entry.id}.json`, root)));
    const checkEvidence = (e, label) =>
      assert.ok(
        e.contextStart >= 0 &&
          e.contextStart <= e.start &&
          e.start < e.end &&
          e.end <= e.contextEnd &&
          e.contextEnd <= lesson.duration,
        `${label} evidence bounds`,
      );
    assert.ok(lesson.paper.referencePages.every(pageExists), `${entry.id} marking pages`);
    for (const q of lesson.questions) {
      assert.ok(q.referenceAnswer, `${entry.id} ${q.id} reference`);
      assert.ok(pageExists(q.reference), `${entry.id} ${q.id} marking source`);
      if (entry.part === 'A') {
        aQuestions++;
        assert.ok(q.evidence.length, `${entry.id} ${q.id} evidence missing`);
        q.evidence.forEach((e) => checkEvidence(e, `${entry.id} ${q.id}`));
      } else {
        bTasks++;
        assert.equal(q.grading, 'self');
        assert.ok(q.scoringPoints.length > 0);
        for (const p of q.scoringPoints) {
          assert.ok(pageExists(p.reference), `${entry.id} ${p.id} marking source`);
          assert.ok(p.dataReferences.every(pageExists), `${entry.id} ${p.id} Data File source`);
          if (p.sourceLabel.includes('原音')) {
            audioPoints++;
            assert.ok(p.evidence?.length, `${entry.id} ${p.id} audio evidence missing`);
            p.evidence.forEach((e) => checkEvidence(e, `${entry.id} ${p.id}`));
          }
        }
      }
    }
  }
  assert.equal(aQuestions, 814);
  assert.equal(bTasks, 45);
  assert.equal(audioPoints, 144);
});
