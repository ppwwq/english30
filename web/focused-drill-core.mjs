import { paperDrillSentences } from './paper-study-core.mjs';

// Keep full-paper timestamps in saved links; the focused player subtracts offset.
export function practiceDrillContext(lesson) {
  if (!lesson?.paper) return null;
  const p = lesson.paper;
  const offset = p.originalAudioRange.start;
  const shifted = (value) => (Number.isFinite(value) ? value + offset : value);
  return {
    offset,
    selection: { part: p.part, task: p.task },
    session: {
      id: p.sessionId,
      year: p.year,
      variant: p.variant,
      audio: { duration: p.originalAudioRange.end },
      tasks: [{ part: p.part, number: p.task, range: p.taskAudioRange || p.originalAudioRange }],
      sentences: lesson.sentences.map((s) => ({
        ...s,
        start: shifted(s.start),
        end: shifted(s.end),
        words: s.words.map((w) => ({ ...w, start: shifted(w.start), end: shifted(w.end) })),
      })),
    },
  };
}

export function questionDrillSentence(lesson, question) {
  const context = practiceDrillContext(lesson);
  if (!context) return null;
  const candidates = paperDrillSentences(context.session, context.selection);
  for (const evidence of question.evidence || []) {
    const start = evidence.start + context.offset,
      end = evidence.end + context.offset;
    const matched = candidates
      .map((s) => ({ s, overlap: Math.min(s.end, end) - Math.max(s.start, start) }))
      .filter((x) => x.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap);
    if (matched[0]) return matched[0].s.id;
  }
  return null;
}
