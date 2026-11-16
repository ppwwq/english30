import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession,
  visibleLesson,
  submitAnswers,
  switchPhase,
  wordAtTime,
  validateLesson,
  validateLoop,
  buildRecord,
  shiftedRange,
  materialExposure,
  selfAssessAnswer,
} from '../web/core.mjs';

const lesson = {
  schemaVersion: 1,
  id: 'fixture',
  title: 'Test lesson',
  duration: 20,
  audio: 'audio/test.mp3',
  source: { title: 'Fixture' },
  sentences: [
    {
      id: 's1',
      start: 2,
      end: 7,
      speaker: 'A',
      words: [
        { id: 'w1', text: 'At', start: 2, end: 2.3 },
        { id: 'w2', text: 'nine.', start: 3, end: 3.5 },
      ],
    },
  ],
  questions: [
    {
      id: 'q1',
      number: '1',
      prompt: 'When?',
      answers: ['nine', '9'],
      evidence: [{ start: 2, end: 7, wordIds: ['w2'] }],
      explanation: 'The speaker says nine.',
    },
  ],
};

test('subtitle adjustment keeps source times intact and clips playback to the recording', () => {
  assert.deepEqual(shiftedRange({ start: 2, end: 7 }, 0.4, 20), { start: 2.4, end: 7.4 });
  assert.deepEqual(shiftedRange({ start: 0, end: 7 }, -0.4, 20), { start: 0, end: 6.6 });
  assert.throws(() => shiftedRange({ start: 2, end: 7 }, 12, 20), /偏移/);
  const state = createSession(lesson);
  state.timingOffset = 0.4;
  assert.equal(buildRecord(lesson, state).timingOffset, 0.4);
  assert.equal(lesson.sentences[0].start, 2);
});

test('overlapping extracts are practised content, not a new independent first listen', () => {
  const entries = [
    { id: 'intro', contentGroup: '2025-a1' },
    { id: 'full', contentGroup: '2025-a1' },
    { id: 'new', contentGroup: '2024-a2' },
  ];
  assert.equal(materialExposure(entries[0], entries, ['intro']), 'practised');
  assert.equal(materialExposure(entries[1], entries, ['intro']), 'overlap');
  assert.equal(materialExposure(entries[2], entries, ['intro']), 'fresh');
});

test('a first attempt cannot expose transcript, answers or evidence until it is submitted', () => {
  const session = createSession(lesson);
  let view = visibleLesson(lesson, session);
  assert.deepEqual(view.sentences, []);
  assert.equal(view.questions[0].answers, undefined);
  assert.equal(view.questions[0].evidence, undefined);
  assert.throws(() => switchPhase(session, 'review'), /提交/);
  const reviewed = submitAnswers(lesson, session, { q1: 'nine' });
  view = visibleLesson(lesson, reviewed);
  assert.equal(view.sentences[0].words[1].text, 'nine.');
  assert.deepEqual(view.questions[0].evidence[0].wordIds, ['w2']);
  assert.equal(reviewed.attempts[0].results.q1.correct, true);
});

test('original-paper questions can require self assessment without invented answers or evidence', () => {
  const manual = {
    ...lesson,
    questions: [
      {
        id: 'q1',
        number: '1',
        label: 'Task 5',
        prompt: 'Write your response.',
        answers: [],
        grading: 'self',
        input: 'textarea',
      },
    ],
  };
  assert.equal(validateLesson(manual), manual);
  const question = visibleLesson(manual, createSession(manual)).questions[0];
  assert.equal(question.input, 'textarea');
  assert.equal(question.grading, 'self');
  assert.equal(question.label, 'Task 5');
  assert.equal(question.answers, undefined);
  assert.equal(
    validateLesson({ ...lesson, questions: [{ ...lesson.questions[0], grading: 'verified' }] }).questions[0]
      .grading,
    'verified',
  );
  assert.throws(
    () => validateLesson({ ...manual, questions: [{ ...manual.questions[0], grading: 'pretend' }] }),
    /判分/,
  );
  assert.throws(
    () => validateLesson({ ...manual, questions: [{ ...manual.questions[0], input: 'html' }] }),
    /输入/,
  );
  assert.throws(
    () => validateLesson({ ...manual, questions: [{ ...manual.questions[0], grading: 'auto' }] }),
    /参考答案/,
  );
});

test('a retest hides old answers and evidence while keeping the first attempt unchanged', () => {
  const first = submitAnswers(lesson, createSession(lesson), { q1: 'Nine.' });
  const retest = switchPhase(first, 'retest');
  const hidden = visibleLesson(lesson, retest);
  assert.equal(hidden.questions[0].answers, undefined);
  assert.deepEqual(hidden.sentences, []);
  const second = submitAnswers(lesson, retest, { q1: 'ten' });
  assert.equal(second.attempts.length, 2);
  assert.equal(second.attempts[0].results.q1.answer, 'Nine.');
  assert.equal(second.attempts[0].results.q1.correct, true);
  assert.equal(second.attempts[1].results.q1.correct, false);
});

test('submitting an ungraded original-paper answer keeps it pending beside automatic results', () => {
  const mixed = {
    ...lesson,
    questions: [...lesson.questions, { id: 'written', answers: [], grading: 'self' }],
  };
  const review = submitAnswers(mixed, createSession(mixed), { q1: 'nine', written: '  My response.  ' });
  assert.deepEqual(review.attempts[0].results.written, {
    answer: 'My response.',
    correct: null,
    duplicate: false,
    status: 'pending',
    grading: 'self',
  });
  assert.equal(review.attempts[0].results.q1.correct, true);
  const snapshot = buildRecord(mixed, review);
  review.attempts[0].results.written.answer = 'later edit';
  assert.equal(snapshot.attempts[0].results.written.answer, 'My response.');
  assert.equal(snapshot.attempts[0].results.written.correct, null);
});

test('self assessment annotates only the submitted current attempt and never invents an automatic score', () => {
  const mixed = {
    ...lesson,
    questions: [...lesson.questions, { id: 'written', answers: [], grading: 'self' }],
  };
  const first = submitAnswers(mixed, createSession(mixed), { written: 'First response.' });
  const checked = selfAssessAnswer(mixed, first, 'written', 'correct');
  assert.equal(first.attempts[0].results.written.selfAssessment, undefined);
  assert.equal(checked.attempts[0].id, first.attempts[0].id);
  assert.deepEqual(checked.attempts[0].results.written, {
    answer: 'First response.',
    correct: null,
    duplicate: false,
    status: 'self-reviewed',
    grading: 'self',
    selfAssessment: 'correct',
  });
  const second = submitAnswers(mixed, switchPhase(checked, 'retest'), { written: 'Second response.' });
  const revised = selfAssessAnswer(mixed, second, 'written', 'incorrect');
  assert.equal(revised.attempts[0].results.written.selfAssessment, 'correct');
  assert.equal(revised.attempts[1].results.written.selfAssessment, 'incorrect');
  assert.equal(revised.attempts[1].results.written.answer, 'Second response.');
  const pending = selfAssessAnswer(mixed, revised, 'written', 'pending');
  assert.equal(pending.attempts[1].results.written.status, 'pending');
  assert.equal(pending.attempts[1].results.written.correct, null);
  assert.throws(() => selfAssessAnswer(mixed, switchPhase(first, 'retest'), 'written', 'correct'), /提交/);
  assert.throws(() => selfAssessAnswer(mixed, first, 'q1', 'correct'), /自核/);
  assert.throws(() => selfAssessAnswer(mixed, first, 'missing', 'correct'), /自核/);
  assert.throws(() => selfAssessAnswer(mixed, first, 'written', 'fake'), /自核/);
});

test('word highlighting uses actual timing and clears in gaps, after seeking backwards and at the end', () => {
  assert.equal(wordAtTime(lesson, 3.2)?.id, 'w2');
  assert.equal(wordAtTime(lesson, 2.1)?.id, 'w1');
  assert.equal(wordAtTime(lesson, 2.7), null);
  assert.equal(wordAtTime(lesson, 3.5), null);
  assert.equal(wordAtTime(lesson, 20), null);
});

test('imported lessons reject missing real timestamps, unsafe paths and evidence outside the audio', () => {
  assert.equal(validateLesson(lesson).id, 'fixture');
  const missing = structuredClone(lesson);
  delete missing.sentences[0].words[0].start;
  assert.throws(() => validateLesson(missing), /时间/);
  assert.throws(() => validateLesson({ ...lesson, audio: 'https://other.example/audio.mp3' }), /音频/);
  const badEvidence = structuredClone(lesson);
  badEvidence.questions[0].evidence[0].end = 21;
  assert.throws(() => validateLesson(badEvidence), /证据/);
  const reserved = structuredClone(lesson);
  reserved.sentences[0].words[0].id = 'constructor';
  assert.throws(() => validateLesson(reserved), /id/);
});

test('a word without reliable alignment can be explicitly sentence-only without fake highlighting', () => {
  const fallback = structuredClone(lesson);
  Object.assign(fallback.sentences[0].words[1], { start: null, end: null, timingStatus: 'segment-only' });
  validateLesson(fallback);
  assert.equal(wordAtTime(fallback, 3.2), null);
});

test('AB practice rejects reversed or too short ranges and allows a complete phrase', () => {
  assert.throws(() => validateLoop(8, 4, 20), /B/);
  assert.throws(() => validateLoop(4, 4.1, 20), /0.3/);
  assert.throws(() => validateLoop(2, 25, 20), /录音/);
  assert.deepEqual(validateLoop(2, 7, 20), { start: 2, end: 7 });
});

test('a saved study record is a snapshot and cannot be changed by subsequent practice', () => {
  const session = submitAnswers(lesson, createSession(lesson), { q1: 'nine' });
  session.marks.w2 = 'heard';
  const record = buildRecord(lesson, session);
  session.marks.w2 = 'unknown';
  assert.equal(record.marks.w2, 'heard');
  assert.equal(record.attempts[0].results.q1.answer, 'nine');
  assert.equal(record.lessonId, 'fixture');
});

test('two-point responses need both groups and unordered reasons cannot earn credit twice', () => {
  const questions = [
    {
      id: 'q3',
      answers: ['high school students and their parents'],
      requiredGroups: [['high school students'], ['their parents', 'parents']],
    },
    ...['q11', 'q12', 'q13'].map((id) => ({
      id,
      answers: ["it's free", 'best kind of exercise', 'make friends'],
      sharedPool: 'reasons',
      answerCategories: [
        { id: 'free', answers: ["it's free", "members don't need to pay"] },
        { id: 'exercise', answers: ['best kind of exercise'] },
        { id: 'friends', answers: ['make friends'] },
      ],
    })),
  ];
  const task = { ...lesson, questions };
  const results = submitAnswers(task, createSession(task), {
    q3: 'high school students',
    q11: 'make friends',
    q12: "it's free",
    q13: "members don't need to pay",
  }).attempts[0].results;
  assert.equal(results.q3.correct, false);
  assert.equal(results.q11.correct, true);
  assert.equal(results.q12.correct, true);
  assert.equal(results.q13.correct, false);
  assert.equal(results.q13.duplicate, true);
  const complete = submitAnswers(task, createSession(task), { q3: 'their parents and high school students' })
    .attempts[0].results;
  assert.equal(complete.q3.correct, true);
  const negated = submitAnswers(task, createSession(task), {
    q3: 'high school students but not their parents',
  }).attempts[0].results;
  assert.equal(negated.q3.correct, false);
});
