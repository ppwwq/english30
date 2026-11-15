export function selectPapers(sources, selection) {
  const selected = sources.filter(
    (s) =>
      s.year === Number(selection.year) &&
      s.variant === selection.variant &&
      (s.paper === null || s.paper === Number(selection.paper)) &&
      (!selection.part || !s.parts.length || s.parts.includes(selection.part)),
  );
  return {
    questions: selected
      .filter((s) => s.role === 'question' && s.paper === Number(selection.paper))
      .sort(
        (a, b) =>
          (a.parts.length || 99) - (b.parts.length || 99) ||
          Number(a.containsAnswers || false) - Number(b.containsAnswers || false),
      ),
    references: selected.filter((s) => s.role !== 'question' || s.paper === null),
  };
}
export function taskOptions(sources, selection) {
  return [
    ...new Set(
      selectPapers(sources, selection).questions.flatMap((s) =>
        (s.tasks || []).filter((t) => !selection.part || t.part === selection.part).map((t) => t.number),
      ),
    ),
  ].sort((a, b) => a - b);
}
export function chooseTask(sources, selection, number) {
  for (const source of selectPapers(sources, selection).questions) {
    const task = source.tasks?.find(
      (t) => t.number === Number(number) && (!selection.part || t.part === selection.part),
    );
    if (task) return { sourceId: source.id, page: task.page };
  }
  return null;
}
export function locateChunk(chunks, requested) {
  if (!chunks.length) throw new Error('没有录音片段');
  const last = chunks.at(-1),
    time = Math.min(last.start + last.duration, Math.max(0, Number(requested) || 0));
  let index = chunks.findIndex(
    (chunk, i) => time >= chunk.start && (i === chunks.length - 1 || time < chunks[i + 1].start),
  );
  if (index < 0) index = 0;
  return { index, offset: time - chunks[index].start, time };
}
