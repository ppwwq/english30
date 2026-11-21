import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, submitAnswers, selfAssessAnswer, buildRecord } from '../web/core.mjs';
import { parseListeningRecord } from '../scripts/repository-only/listening-library.mjs';
import { eraseStroke, moveSelection, isPaperStroke } from '../web/paper-ink-geometry.mjs';

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

test('old lines can be cut, moved and submitted alongside pressure-sensitive strokes', () => {
  const original = '10,100 900,100';
  const fragments = eraseStroke(original, [320, 40], [320, 160], 10, 1.4, false);
  assert.equal(fragments.length, 2);
  assert.ok(fragments.every(isPaperStroke));
  assert.ok(fragments[0].points.at(-1)[0] < 320 && fragments[1].points[0][0] > 320);
  assert.deepEqual(eraseStroke(original, [320, 40], [320, 160], 10, 1.4, true), []);
  assert.deepEqual(eraseStroke(original, [20, 680], [70, 610], 10, 1.4, false), [original]);
  const pen = {
    tool: 'pen',
    color: '#254c8b',
    width: 3.2,
    points: [
      [25, 40, 10],
      [75, 60, 83],
    ],
  };
  const pages = { 'paper:3': [original, pen, ...moveSelection(fragments, 900, -200)] };
  const lesson = { id: 'paper-test', questions: [{ id: 'q1', grading: 'self' }] };
  const submitted = submitAnswers(lesson, createSession(lesson), {}, { ink: pages });
  assert.deepEqual(parseListeningRecord(buildRecord(lesson, submitted)).attempts[0].ink, pages);
  assert.equal(isPaperStroke({ ...pen, color: 'url(#pattern)' }), false);
  assert.equal(isPaperStroke({ ...pen, points: [[25, 40, 110]] }), false);
});
