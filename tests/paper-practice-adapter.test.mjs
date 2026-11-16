import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateLesson } from '../web/core.mjs';
import {
  buildPaperPractice,
  paperPracticeEntry,
  missingAudioPracticeEntries,
  planPaperAudio,
  paperPracticeRange,
} from '../web/paper-practice-adapter.mjs';

const catalogue = {
  sources: [
    {
      id: 'question-paper',
      year: 2023,
      variant: 'exam',
      paper: 3,
      role: 'question',
      parts: ['A'],
      tasks: [{ number: 1, part: 'A', page: 4 }],
    },
    { id: 'marking', year: 2023, variant: 'exam', paper: null, role: 'marking', parts: [] },
  ],
};
const task = { number: 1, part: 'A', range: { start: 100, end: 110 } };
const session = {
  id: '2023-exam',
  year: 2023,
  variant: 'exam',
  tasks: [task],
  source: { method: 'source OCR', complete: true },
  sentences: [
    {
      id: 's1',
      start: 101,
      end: 104,
      text: 'The blue boat.',
      words: [
        { id: 'w1', text: 'The', start: 101, end: 102 },
        { id: 'w2', text: 'blue', start: null, end: null },
        { id: 'w3', text: 'boat.', start: 103, end: 104 },
      ],
    },
  ],
  questionIndex: [
    { question: 1, label: 'Q1', task: 1, sourceId: 'marking', page: 8, evidenceIds: ['e1'] },
    { question: 2, label: 'Q2', task: 1, sourceId: 'marking', page: 8, evidenceIds: [] },
  ],
  evidence: [
    {
      id: 'e1',
      task: 1,
      questions: [1],
      start: 101,
      end: 104,
      text: 'The blue boat.',
      acceptedPhrase: 'blue',
      status: 'keyword-located',
    },
  ],
};

test('a Task becomes a relative-time lesson with honest self-check cards and the original question page', () => {
  const lesson = buildPaperPractice({ session, task, catalogue, duration: 10.032 });
  assert.equal(lesson.id, 'paper-2023-exam-a-task-1');
  assert.equal(lesson.audio, 'audio/paper-2023-exam-a-task-1.mp3');
  assert.equal(lesson.duration, 10.032);
  assert.equal(lesson.paper.questionSourceId, 'question-paper');
  assert.equal(lesson.paper.questionPage, 4);
  assert.deepEqual(lesson.paper.referencePages, [{ sourceId: 'marking', page: 8 }]);
  assert.equal(lesson.sentences[0].start, 1);
  assert.equal(lesson.sentences[0].words[2].end, 4);
  assert.equal(lesson.sentences[0].words[1].start, null);
  assert.equal(lesson.sentences[0].words[1].timingStatus, 'segment-only');
  assert.equal(lesson.questions[0].grading, 'self');
  assert.deepEqual(lesson.questions[0].answers, []);
  assert.deepEqual(lesson.questions[0].evidence[0].wordIds, ['w1', 'w3']);
  assert.equal(lesson.questions[0].evidence[0].start, 1);
  assert.deepEqual(lesson.questions[1].evidence, []);
});

test('verified 2025 and 2024 questions retain their marking rules and use the full-session overlay clock', async () => {
  const readJSON = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const realCatalogue = await readJSON('../web/papers/catalogue.json');
  const known = await Promise.all(
    ['2025-task1', '2024-task2-intro'].map((id) => readJSON(`../web/lessons/${id}.json`)),
  );
  for (const [year, taskNumber, count] of [
    [2025, 1, 13],
    [2024, 2, 8],
  ]) {
    const paper = await readJSON(`../web/papers/sessions/${year}-exam.json`);
    const selected = paper.tasks.find((item) => item.number === taskNumber);
    const lesson = buildPaperPractice({
      session: paper,
      task: selected,
      catalogue: realCatalogue,
      duration: selected.range.end - selected.range.start,
      verifiedLessons: known,
    });
    assert.equal(lesson.questions.filter((question) => question.grading === 'verified').length, count);
    const original = known.find((item) => item.source.year === year);
    for (const question of original.questions) {
      const adapted = lesson.questions.find((item) => item.number === question.number);
      assert.deepEqual(adapted.answers, question.answers);
      assert.deepEqual(adapted.requiredGroups, question.requiredGroups);
      assert.deepEqual(adapted.sharedPool, question.sharedPool);
      assert.deepEqual(adapted.answerCategories, question.answerCategories);
      assert.ok(
        adapted.evidence
          .flatMap((item) => item.wordIds)
          .every((id) => lesson.sentences.some((sentence) => sentence.words.some((word) => word.id === id))),
      );
    }
    if (year === 2025) {
      assert.equal(lesson.questions[0].evidence[0].start, 105.154);
      assert.equal(lesson.questions[0].evidence[0].end, 107.054);
      assert.equal(lesson.questions[0].evidence[0].wordIds[0], 'v2025t1-w0091');
    }
  }
});

test('Part B tasks share one audio file and exposure group but keep separate original-page response cards', () => {
  const b1 = { number: 5, part: 'B1', range: { start: 100, end: 110 }, sharedAudio: true };
  const b2 = { number: 8, part: 'B2', range: { start: 100, end: 110 }, sharedAudio: true };
  const original = {
    ...catalogue,
    sources: [
      {
        ...catalogue.sources[0],
        parts: ['B1', 'B2'],
        tasks: [
          { number: 5, part: 'B1', page: 10 },
          { number: 8, part: 'B2', page: 20 },
        ],
      },
      catalogue.sources[1],
    ],
  };
  const lessons = [b1, b2].map((selected) =>
    buildPaperPractice({ session, task: selected, catalogue: original, duration: 10.032 }),
  );
  assert.equal(lessons[0].audio, 'audio/paper-2023-exam-part-b.mp3');
  assert.equal(lessons[1].audio, lessons[0].audio);
  assert.notEqual(lessons[0].id, lessons[1].id);
  assert.deepEqual(
    lessons.map((lesson) => lesson.paper.questionPage),
    [10, 20],
  );
  assert.equal(lessons[0].questions.length, 1);
  assert.equal(lessons[0].questions[0].input, 'textarea');
  assert.equal(lessons[0].questions[0].grading, 'self');
  assert.deepEqual(lessons[0].questions[0].answers, []);
  assert.deepEqual(lessons[0].questions[0].evidence, []);
  assert.equal(paperPracticeEntry(lessons[0]).contentGroup, paperPracticeEntry(lessons[1]).contentGroup);
});

test('a source without matching audio remains selectable as an explicit unavailable entry, never a fake lesson', async () => {
  const realCatalogue = JSON.parse(
    await readFile(new URL('../web/papers/catalogue.json', import.meta.url), 'utf8'),
  );
  const entries = missingAudioPracticeEntries(realCatalogue);
  assert.equal(entries.length, 10);
  assert.ok(
    entries.every(
      (entry) =>
        entry.year === 2012 && entry.variant === 'sample' && entry.missingAudio && entry.url === null,
    ),
  );
  assert.deepEqual(
    entries.map((entry) => entry.task),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.match(entries[0].sourceNote, /不匹配/);
});

test('audio cuts span a real chunk boundary and reject a missing span instead of silently shifting words', () => {
  const selected = { number: 2, part: 'A', range: { start: 970, end: 1500 } };
  const audioSession = {
    ...session,
    audio: {
      chunks: [
        { src: '000.mp3', start: 0, duration: 480 },
        { src: '001.mp3', start: 480, duration: 480 },
        { src: '002.mp3', start: 960, duration: 480 },
        { src: '003.mp3', start: 1440, duration: 480 },
      ],
    },
  };
  const cut = planPaperAudio(audioSession, selected);
  assert.deepEqual(
    cut.chunks.map((chunk) => chunk.src),
    ['002.mp3', '003.mp3'],
  );
  assert.equal(cut.startOffset, 10);
  assert.equal(cut.duration, 530);
  assert.throws(
    () =>
      planPaperAudio({ ...audioSession, audio: { chunks: audioSession.audio.chunks.slice(0, 3) } }, selected),
    /完整/,
  );
});

test('an original question document containing answers is explicitly flagged for first-attempt gating', () => {
  const mixed = {
    sources: catalogue.sources.map((source) => ({ ...source, containsAnswers: source.role === 'question' })),
  };
  const lesson = buildPaperPractice({ session, task, catalogue: mixed, duration: 10.032 });
  assert.equal(lesson.paper.questionContainsAnswers, true);
});

test('all 150 original-paper Tasks fit the focused-player contract, with exactly 21 verified questions', async () => {
  const readJSON = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const originals = await readJSON('../web/papers/catalogue.json');
  const known = await Promise.all(
    ['2025-task1', '2024-task2-intro'].map((id) => readJSON(`../web/lessons/${id}.json`)),
  );
  let count = 0;
  let verified = 0;
  const errors = [];
  for (const metadata of originals.sessions) {
    const paper = await readJSON(`../web/${metadata.url.slice(2)}`);
    for (const selected of paper.tasks) {
      const lesson = buildPaperPractice({
        session: paper,
        task: selected,
        catalogue: originals,
        duration:
          paperPracticeRange(paper, selected).range.end - paperPracticeRange(paper, selected).range.start,
        verifiedLessons: known,
      });
      try {
        validateLesson(lesson);
      } catch (error) {
        errors.push(`${lesson.id}: ${error.message}`);
      }
      count += 1;
      verified += lesson.questions.filter((question) => question.grading === 'verified').length;
    }
  }
  assert.deepEqual(errors, []);
  assert.equal(count, 150);
  assert.equal(verified, 21);
});

test('a cut inside a source sentence keeps the complete sentence and records the original Task boundary', () => {
  const selected = { ...task, range: { start: 102, end: 110 } };
  const lesson = buildPaperPractice({ session, task: selected, catalogue, duration: 9.032 });
  assert.deepEqual(lesson.paper.taskAudioRange, { start: 102, end: 110 });
  assert.deepEqual(lesson.paper.originalAudioRange, { start: 101, end: 110 });
  assert.equal(lesson.sentences[0].text, 'The blue boat.');
  assert.equal(lesson.sentences[0].words[0].start, 0);
  assert.ok(lesson.paper.boundaryNote);
});

test('2025 shared Part B begins at the complete dialogue, without the previous page-turn instruction tail', async () => {
  const paper = JSON.parse(
    await readFile(new URL('../web/papers/sessions/2025-exam.json', import.meta.url), 'utf8'),
  );
  const selected = paper.tasks.find((item) => item.number === 5);
  const adjusted = paperPracticeRange(paper, selected);
  assert.deepEqual(adjusted.range, { start: 6302.366, end: 6820.276 });
  const originals = JSON.parse(
    await readFile(new URL('../web/papers/catalogue.json', import.meta.url), 'utf8'),
  );
  const lesson = buildPaperPractice({
    session: paper,
    task: selected,
    catalogue: originals,
    duration: 517.91,
  });
  assert.equal(lesson.sentences[0].text, 'John, Melissa. Good to see you both today.');
  assert.equal(lesson.sentences[0].start, 0);
  assert.equal(planPaperAudio(paper, selected).startOffset, 62.39);
});
