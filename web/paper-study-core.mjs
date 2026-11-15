import { compareSentence } from './training-core.mjs';

export function paperDrillSentences(session, selection) {
  if (!session?.audio || !['A', 'B1'].includes(selection.part)) return [];
  const range = session.tasks.find(
    (t) => t.part === selection.part && t.number === Number(selection.task),
  )?.range;
  if (!range) return [];
  return session.sentences
    .filter(
      (s) =>
        s.start >= range.start &&
        s.end <= range.end &&
        s.end <= session.audio.duration &&
        s.end - s.start >= 1 &&
        s.end - s.start <= 18 &&
        s.text.length <= 2000 &&
        s.words.length >= 3 &&
        s.words.length <= 40 &&
        s.words.every(
          (w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.sourceMatched !== false,
        ) &&
        !/\b(?:study the task|tidy up your answers|spaces (?:below|provided)|provided as an example|barcode|end of (?:part|task)|go on to part)\b/i.test(
          s.text,
        ),
    )
    .sort((a, b) => a.start - b.start);
}

export function createPaperDrill({
  session,
  selection,
  sentenceId,
  previous = [],
  exposed = false,
  retest = false,
}) {
  const sentence = paperDrillSentences(session, selection).find((s) => s.id === sentenceId);
  if (!sentence) throw new Error('此句暂不适合短句听写，请换一句或使用原句复盘。');
  const taskId = `paper:${session.id}:${sentence.id}`;
  const phase = retest || previous.some((r) => r.taskId === taskId) ? 'retest' : exposed ? 'review' : 'first';
  let plays = 0,
    assisted = exposed,
    submitted = false;
  return {
    sentence,
    played(rate = 1) {
      plays++;
      if (plays > 1 || rate !== 1) assisted = true;
    },
    reveal() {
      assisted = true;
    },
    submit(answer) {
      if (submitted) throw new Error('这一轮已经提交，请开始关提示复测。');
      if (!plays) throw new Error('先听一次原音，再提交你听到的内容。');
      const result = compareSentence(sentence.text, answer);
      submitted = true;
      return {
        result,
        record: {
          module: 'dictation',
          taskId,
          phase,
          assisted,
          correct: result.correct ? 1 : 0,
          total: 1,
          answers: { sentence: answer },
          errorTypes: [],
          source: `${session.year} Paper 3 · Part ${selection.part} · Task ${selection.task}`,
          details: {
            title: `${session.year} 原卷短句 · Task ${selection.task} · ${Math.floor(sentence.start / 60)}:${String(Math.floor(sentence.start % 60)).padStart(2, '0')}`,
            comparison: 'transcript-word-match',
            plays,
            reference: sentence.text,
            paper: {
              sessionId: session.id,
              year: session.year,
              variant: session.variant,
              part: selection.part,
              task: Number(selection.task),
              sentenceId,
              start: sentence.start,
              end: sentence.end,
            },
          },
        },
      };
    },
  };
}
