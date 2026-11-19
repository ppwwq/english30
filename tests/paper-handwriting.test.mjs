import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, submitAnswers, selfAssessAnswer, buildRecord } from '../web/core.mjs';
import { parseListeningRecord } from '../scripts/repository-only/listening-library.mjs';

test('handwriting submits the marked pages and lets verified questions be checked manually', () => {
  const lesson = { id: 'paper-test', questions: [{ id: 'q1', grading: 'verified', answers: ['7000'] }] };
  const ink = { 'paper:3': ['250,400 270,415'] };
  const review = submitAnswers(lesson, createSession(lesson), {}, { ink });
  ink['paper:3'].length = 0;
  const assessed = selfAssessAnswer(lesson, review, 'q1', 'correct');
  const attempt = parseListeningRecord(buildRecord(lesson, assessed)).attempts[0];
  assert.deepEqual(attempt.ink, { 'paper:3': ['250,400 270,415'] });
  assert.equal(attempt.results.q1.selfAssessment, 'correct');
  assert.equal(attempt.results.q1.correct, null);
});
