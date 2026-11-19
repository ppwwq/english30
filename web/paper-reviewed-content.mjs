// Reviewed reference text is independent of machine grading. Applying an overlay
// never promotes a self-check question to an automatically scored question.
export function applyReviewedContent(lesson, review) {
  const task = review?.tasks?.[`${lesson.paper.part}-${lesson.paper.task}`];
  if (!task) return lesson;
  for (const sentence of task.sentences || []) {
    lesson.sentences = lesson.sentences.filter((s) => s.id !== sentence.id);
    lesson.sentences.push(structuredClone(sentence));
  }
  lesson.sentences.sort((a, b) => a.start - b.start);
  for (const [number, patch] of Object.entries(task.questions || {})) {
    const question = lesson.questions.find((q) => q.number === Number(number));
    if (!question) throw new Error(`${lesson.id}: reviewed Q${number} is absent`);
    if (patch.prompt) question.prompt = patch.prompt;
    if (patch.referenceImage) question.referenceImage = structuredClone(patch.referenceImage);
    if (patch.scoringPoints) question.scoringPoints = structuredClone(patch.scoringPoints);
    if (patch.rubricReferences) question.rubricReferences = structuredClone(patch.rubricReferences);
    if (patch.referenceAnswer) {
      question.referenceAnswer = patch.referenceAnswer;
      question.reference = { ...task.reference, ...patch.reference };
      question.referenceStatus = 'source-reviewed';
      question.explanation = patch.note || '按评分参考自核；其他合理表述不由字幕逐词比对判错。';
    }
    if (patch.evidence) {
      question.evidence = patch.evidence.map(([contextStart, contextEnd, start, end]) => {
        if (!(
          contextStart >= 0 &&
          contextStart <= start &&
          start < end &&
          end <= contextEnd &&
          contextEnd <= lesson.duration
        ))
          throw new Error(`${lesson.id} Q${number}: invalid reviewed evidence bounds`);
        return {
          start,
          end,
          contextStart,
          contextEnd,
          wordIds: lesson.sentences
            .flatMap((s) => s.words)
            .filter((w) => Number.isFinite(w.start) && w.end > start && w.start < end)
            .map((w) => w.id),
          source: { ...task.script, ...patch.script },
          status: 'reviewed-reference-and-transcript-existing-alignment',
        };
      });
    }
  }
  if (task.reference) lesson.paper.referencePages = task.referencePages || [task.reference];
  if (task.dataFile) lesson.paper.dataFile = task.dataFile;
  if (task.reviewRules) lesson.paper.reviewRules = task.reviewRules;
  return lesson;
}
