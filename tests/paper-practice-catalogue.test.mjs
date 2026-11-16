import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateLesson } from '../web/core.mjs';
import { chooseTask } from '../web/paper-core.mjs';

const readJSON = async (path) =>
  JSON.parse(await readFile(new URL(`../web/${path}`, import.meta.url), 'utf8'));
const catalogue = await readJSON('papers/practice-catalogue.json');
const originals = await readJSON('papers/catalogue.json');
const ready = catalogue.lessons.filter((entry) => !entry.missingAudio);

test('the catalogue covers every playable source Task and explicitly excludes mismatched Sample audio', async () => {
  assert.equal(ready.length, 150);
  assert.equal(new Set(catalogue.lessons.map((entry) => entry.id)).size, 160);
  for (const metadata of originals.sessions) {
    const session = await readJSON(metadata.url.slice(2));
    const entries = ready.filter((entry) => entry.year === session.year && entry.variant === session.variant);
    assert.equal(entries.length, 10, session.id);
    for (const task of session.tasks) {
      assert.equal(
        entries.filter((entry) => entry.part === task.part && entry.task === task.number).length,
        1,
      );
    }
  }
  const missing = catalogue.lessons.filter((entry) => entry.missingAudio);
  assert.equal(missing.length, 10);
  assert.ok(
    missing.every((entry) => entry.year === 2012 && entry.variant === 'sample' && entry.url === null),
  );
  assert.ok(missing.every((entry) => entry.sourceNote === originals.sessionIssues['2012-sample']));
});

test('all generated lessons satisfy the player schema and retain original-page and word-timing provenance', async () => {
  let verified = 0;
  let partAQuestions = 0;
  let longResponses = 0;
  const flagged = [];
  const sessions = new Map();
  const trusted = new Map();
  const verifiedKeys = new Set();
  for (const entry of ready) {
    const lesson = await readJSON(entry.url.slice(2));
    assert.doesNotThrow(() => validateLesson(lesson), entry.id);
    assert.equal(lesson.id, entry.id);
    const paper = lesson.paper;
    if (!sessions.has(paper.sessionId))
      sessions.set(paper.sessionId, await readJSON(`papers/sessions/${paper.sessionId}.json`));
    const session = sessions.get(paper.sessionId);
    assert.equal(entry.year, session.year);
    assert.equal(entry.variant, session.variant);
    const sourcePage = chooseTask(
      originals.sources,
      { year: entry.year, variant: entry.variant, paper: 3, part: entry.part },
      entry.task,
    );
    assert.deepEqual({ sourceId: paper.questionSourceId, page: paper.questionPage }, sourcePage);
    const source = originals.sources.find((item) => item.id === sourcePage.sourceId);
    assert.equal(source.role, 'question');
    assert.equal(paper.questionContainsAnswers, !!source.containsAnswers);
    if (paper.questionContainsAnswers) flagged.push(entry.id);
    const sourceWords = new Map(
      session.sentences.flatMap((sentence) => sentence.words).map((word) => [word.id, word]),
    );
    for (const word of lesson.sentences.flatMap((sentence) => sentence.words)) {
      const original = sourceWords.get(word.id);
      assert.ok(original, `${entry.id}: ${word.id} has no source`);
      assert.equal(word.text, original.text);
      if (original.start === null) {
        assert.equal(word.start, null);
        assert.equal(word.end, null);
        assert.equal(word.timingStatus, 'segment-only');
      } else {
        assert.ok(
          Math.abs(word.start + paper.originalAudioRange.start - original.start) <= 0.0011,
          `${entry.id}: ${word.id} clock mismatch`,
        );
        assert.ok(Math.abs(word.end + paper.originalAudioRange.start - original.end) <= 0.0011);
      }
    }
    if (entry.part === 'A') partAQuestions += lesson.questions.length;
    else {
      assert.equal(lesson.questions.length, 1);
      assert.equal(lesson.questions[0].input, 'textarea');
      longResponses += 1;
    }
    for (const question of lesson.questions) {
      if (question.grading === 'verified') {
        verified += 1;
        verifiedKeys.add(`${paper.sessionId}:${entry.task}:${question.number}`);
        if (!trusted.has(question.verifiedLessonId))
          trusted.set(question.verifiedLessonId, await readJSON(`lessons/${question.verifiedLessonId}.json`));
        const reference = trusted
          .get(question.verifiedLessonId)
          .questions.find((item) => item.number === question.number);
        assert.deepEqual(question.answers, reference.answers);
        assert.deepEqual(question.requiredGroups, reference.requiredGroups);
        assert.deepEqual(question.sharedPool, reference.sharedPool);
        assert.deepEqual(question.answerCategories, reference.answerCategories);
      } else {
        assert.equal(question.grading, 'self');
        assert.deepEqual(question.answers, []);
      }
      for (const evidence of question.evidence) {
        assert.ok(
          evidence.start >= 0 && evidence.end > evidence.start && evidence.end <= lesson.duration + 0.05,
        );
      }
    }
  }
  assert.equal(partAQuestions, 814);
  assert.equal(longResponses, 90);
  assert.equal(verified, 21);
  assert.equal(verifiedKeys.size, 21);
  assert.deepEqual(flagged.sort(), [
    'paper-2023-exam-b2-task-10',
    'paper-2023-exam-b2-task-8',
    'paper-2023-exam-b2-task-9',
  ]);
  assert.equal(ready.find((entry) => entry.id === 'paper-2025-exam-a-task-1').contentGroup, '2025-a1');
  assert.equal(ready.find((entry) => entry.id === 'paper-2024-exam-a-task-2').contentGroup, '2024-a2');
});

test('all 75 MP3 files match their measured duration report and every Part B task uses its shared recording', async () => {
  const report = await readJSON('papers/practice-audio.json');
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.audio.length, 75);
  const measured = new Map(report.audio.map((item) => [item.src, item]));
  const used = new Set();
  const shared = new Map();
  for (const entry of ready) {
    const lesson = await readJSON(entry.url.slice(2));
    used.add(lesson.audio);
    const audio = measured.get(lesson.audio);
    assert.ok(audio, entry.id);
    assert.equal(lesson.duration, audio.duration);
    assert.deepEqual(lesson.paper.originalAudioRange, audio.sourceRange);
    assert.ok(Math.abs(audio.duration - (audio.sourceRange.end - audio.sourceRange.start)) <= 0.15);
    if (entry.part !== 'A') {
      const previous = shared.get(lesson.paper.sessionId);
      if (previous) assert.deepEqual({ audio: lesson.audio, contentGroup: entry.contentGroup }, previous);
      else shared.set(lesson.paper.sessionId, { audio: lesson.audio, contentGroup: entry.contentGroup });
    }
  }
  assert.equal(used.size, 75);
  assert.equal(shared.size, 15);
  for (const entry of report.audio) {
    assert.ok(used.has(entry.src));
    const bytes = await readFile(new URL(`../web/${entry.src}`, import.meta.url));
    assert.equal(bytes.length, entry.bytes);
    assert.ok(bytes.length > 1000);
    assert.ok(
      bytes.subarray(0, 3).toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0),
      entry.src,
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.src);
    assert.ok(Number.isFinite(entry.duration) && entry.duration > 0);
    assert.ok(entry.sampleRate > 0 && entry.channels > 0 && entry.bitRate > 0);
  }
});
