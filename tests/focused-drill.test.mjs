import test from 'node:test';
import assert from 'node:assert/strict';
import {
  practiceDrillContext,
  questionDrillSentence,
  sentenceQuestionLabels,
} from '../web/focused-drill-core.mjs';

const lesson = {
  paper: {
    sessionId: '2025-exam',
    year: 2025,
    variant: 'exam',
    part: 'A',
    task: 1,
    originalAudioRange: { start: 100, end: 180 },
    taskAudioRange: { start: 100, end: 180 },
  },
  sentences: [
    {
      id: 'unreliable',
      start: 5,
      end: 7,
      text: 'A doubtful transcript.',
      words: [
        { text: 'A', start: 5, end: 5.2 },
        { text: 'doubtful', start: null, end: null },
        { text: 'transcript.', start: 6, end: 7 },
      ],
    },
    {
      id: 'answer',
      start: 20,
      end: 22,
      text: 'About seven thousand.',
      words: [
        { text: 'About', start: 20, end: 20.5 },
        { text: 'seven', start: 20.5, end: 21 },
        { text: 'thousand.', start: 21, end: 22 },
      ],
    },
    {
      id: 'other',
      start: 40,
      end: 43,
      text: 'We meet on Sundays.',
      words: [
        { text: 'We', start: 40, end: 40.3 },
        { text: 'meet', start: 40.3, end: 41 },
        { text: 'on', start: 41, end: 41.5 },
        { text: 'Sundays.', start: 41.5, end: 43 },
      ],
    },
  ],
};
test('focused drill keeps original paper identity and full-audio times for saved review links', () => {
  const { session, selection, offset } = practiceDrillContext(lesson);
  assert.equal(session.id, '2025-exam');
  assert.deepEqual(selection, { part: 'A', task: 1 });
  assert.equal(offset, 100);
  assert.equal(session.sentences[1].start, 120);
  assert.equal(session.sentences[1].words[0].start, 120);
  assert.equal(session.sentences[0].words[1].start, null);
  assert.equal(lesson.sentences[1].start, 20);
});
test('a question selects its reliable evidence sentence, never an unrelated or uncertain answer', () => {
  assert.equal(questionDrillSentence(lesson, { evidence: [{ start: 20.2, end: 21.8 }] }), 'answer');
  assert.equal(questionDrillSentence(lesson, { evidence: [{ start: 5, end: 7 }] }), null);
  assert.equal(questionDrillSentence(lesson, { evidence: [] }), null);
});
test('changing sentence keeps all matching question and scoring-point labels, excluding lead-in only', () => {
  const questions = [
    { label: 'Q11', evidence: [{ start: 20, end: 22, contextStart: 18 }] },
    { label: 'Q12', evidence: [{ start: 20, end: 23 }] },
    { label: 'Task 5', scoringPoints: [{ id: '5.2', evidence: [{ start: 40, end: 42 }] }] },
  ];
  assert.deepEqual(sentenceQuestionLabels(questions, 20, 21), ['Q11', 'Q12']);
  assert.deepEqual(sentenceQuestionLabels(questions, 18, 20), []);
  assert.deepEqual(sentenceQuestionLabels(questions, 40, 41), ['5.2']);
});
