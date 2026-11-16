import { chooseTask } from './paper-core.mjs';

const rounded = (value) => Math.round(value * 1000) / 1000;
const variantLabel = (variant) =>
  ({ exam: '正式卷', practice: 'Practice', sample: 'Sample' })[variant] || variant;

export function paperPracticeId(session, task) {
  return `paper-${session.id}-${task.part.toLowerCase()}-task-${task.number}`;
}

export function paperPracticeAudio(session, task) {
  if (task.part !== 'A') return `audio/paper-${session.id}-part-b.mp3`;
  return `audio/${paperPracticeId(session, task)}.mp3`;
}

export function paperPracticeRange(session, task) {
  const range = { ...task.range };
  const overlapping = (session.sentences || []).filter(
    (sentence) => sentence.end > range.start && sentence.start < range.end,
  );
  const first = overlapping[0],
    last = overlapping.at(-1);
  const notes = [];
  if (first && first.start < range.start) {
    if (
      /^Turn to Page \d+ of the Data File\.$/i.test(first.text) &&
      first.end - range.start <= 0.3 &&
      overlapping[1]
    ) {
      range.start = overlapping[1].start;
      notes.push('略过上一个翻页指令的残尾，从完整对话开始。');
    } else {
      range.start = first.start;
      notes.push('起点保留原稿的完整语句。');
    }
  }
  if (last && last.end > range.end) {
    range.end = last.end;
    notes.push('终点保留原稿的完整语句。');
  }
  return { range, boundaryNote: notes.join(' ') };
}

export function planPaperAudio(session, task) {
  const { range, boundaryNote } = paperPracticeRange(session, task);
  const { start, end } = range;
  const chunks = (session.audio?.chunks || []).filter(
    (chunk) => chunk.start < end && chunk.start + chunk.duration > start,
  );
  if (
    !chunks.length ||
    chunks[0].start > start ||
    chunks.at(-1).start + chunks.at(-1).duration < end - 0.001 ||
    chunks.some(
      (chunk, i) => i > 0 && Math.abs(chunk.start - chunks[i - 1].start - chunks[i - 1].duration) > 0.01,
    )
  ) {
    throw new Error(`${session.id} Task ${task.number} 的原音范围不完整。`);
  }
  return {
    audio: paperPracticeAudio(session, task),
    range,
    boundaryNote,
    chunks,
    startOffset: rounded(start - chunks[0].start),
    duration: rounded(end - start),
  };
}

export function paperPracticeEntry(lesson) {
  const { year, variant, part, task, sessionId, sourceNote } = lesson.paper;
  let contentGroup = `paper-${sessionId}-${part.toLowerCase()}-${task}`;
  if (part !== 'A') contentGroup = `paper-${sessionId}-part-b`;
  if (
    variant === 'exam' &&
    part === 'A' &&
    ((year === 2025 && task === 1) || (year === 2024 && task === 2))
  ) {
    contentGroup = `${year}-a${task}`;
  }
  return {
    id: lesson.id,
    title: lesson.title,
    url: `./papers/practice/${lesson.id}.json`,
    year,
    variant,
    part,
    task,
    contentGroup,
    sourceNote,
    minutes: rounded(lesson.duration / 60),
    missingAudio: false,
  };
}

export function missingAudioPracticeEntries(catalogue) {
  const entries = [];
  for (const [sessionId, sourceNote] of Object.entries(catalogue.sessionIssues || {})) {
    const [yearValue, variant] = sessionId.split('-');
    const year = Number(yearValue);
    if (catalogue.sessions?.some((session) => session.id === sessionId)) continue;
    const tasks = new Map(
      catalogue.sources
        .filter(
          (source) =>
            source.year === year &&
            source.variant === variant &&
            source.paper === 3 &&
            source.role === 'question',
        )
        .flatMap((source) => (source.tasks || []).map((task) => [task.number, task])),
    );
    for (const task of [...tasks.values()].sort((a, b) => a.number - b.number)) {
      const id = paperPracticeId({ id: sessionId }, task);
      entries.push({
        id,
        title: `${year} ${variantLabel(variant)} · Part ${task.part} · Task ${task.number}`,
        url: null,
        year,
        variant,
        part: task.part,
        task: task.number,
        contentGroup: `paper-${sessionId}`,
        sourceNote,
        minutes: 0,
        missingAudio: true,
      });
    }
  }
  return entries;
}

function relativeRange(item, range) {
  return {
    start: rounded(Math.max(item.start, range.start) - range.start),
    end: rounded(Math.min(item.end, range.end) - range.start),
  };
}

function taskSentences(session, range) {
  return session.sentences
    .filter((sentence) => sentence.end > range.start && sentence.start < range.end)
    .map((sentence) => {
      const words = sentence.words
        .filter((word) => word.start === null || (word.end > range.start && word.start < range.end))
        .map((word) => ({
          ...word,
          ...(word.start === null ? { timingStatus: 'segment-only' } : relativeRange(word, range)),
        }));
      return {
        ...sentence,
        ...relativeRange(sentence, range),
        text: words.map((word) => word.text).join(' '),
        words,
      };
    })
    .filter((sentence) => sentence.words.length);
}

export function buildPaperPractice({ session, task, catalogue, duration, verifiedLessons = [] }) {
  const { range, boundaryNote } = paperPracticeRange(session, task);
  if (!range || !(range.end > range.start)) throw new Error('Task 缺少有效的原音范围。');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Task 缺少已核实的音频时长。');
  const selection = { year: session.year, variant: session.variant, paper: 3, part: task.part };
  const original = chooseTask(catalogue.sources, selection, task.number);
  if (!original) throw new Error(`${session.id} Task ${task.number} 缺少原题页。`);
  const sentences = taskSentences(session, range);
  const indexed = (session.questionIndex || []).filter((question) => question.task === task.number);
  const referencePages = [
    ...new Map(
      indexed
        .filter((q) => q.sourceId && q.page)
        .map((q) => [`${q.sourceId}:${q.page}`, { sourceId: q.sourceId, page: q.page }]),
    ).values(),
  ];
  const words = sentences.flatMap((sentence) => sentence.words);
  const questions = indexed.map((question) => ({
    id: `q${question.question}`,
    number: question.question,
    label: question.label || `Q${question.question}`,
    prompt: `请按原题页的第 ${question.question} 题作答。`,
    grading: 'self',
    input: 'text',
    answers: [],
    explanation: '提交后请对照评分参考自行核对；录音定位仅辅助回听，不作自动判分依据。',
    reference: { sourceId: question.sourceId, page: question.page },
    evidence: (session.evidence || [])
      .filter(
        (evidence) =>
          question.evidenceIds?.includes(evidence.id) &&
          evidence.end > range.start &&
          evidence.start < range.end,
      )
      .map((evidence) => {
        const relative = relativeRange(evidence, range);
        return {
          ...relative,
          wordIds: words
            .filter(
              (word) => Number.isFinite(word.start) && word.end > relative.start && word.start < relative.end,
            )
            .map((word) => word.id),
          source: evidence.source,
          status: evidence.status,
        };
      }),
  }));
  if (task.part !== 'A') {
    questions.push({
      id: `task-${task.number}-response`,
      number: task.number,
      label: `Task ${task.number}`,
      prompt: `请按原题页完成 Task ${task.number}，结合录音和 Data File 写下答案或草稿。`,
      grading: 'self',
      input: 'textarea',
      answers: [],
      evidence: [],
      explanation: '本任务需结合录音、Data File 与评分参考自行核对；不提供自动写作判分。',
    });
  }
  for (const overlay of session.verifiedLessonOverlays || []) {
    if (overlay.originalAudioRange.end <= range.start || overlay.originalAudioRange.start >= range.end)
      continue;
    const verified = verifiedLessons.find((lesson) => lesson.id === overlay.lessonId);
    if (!verified) throw new Error(`缺少已核实练习包 ${overlay.lessonId}。`);
    const offset = overlay.originalAudioRange.start - range.start;
    const originalWords = new Map(
      verified.sentences.flatMap((sentence) => sentence.words).map((word) => [word.id, word]),
    );
    const wordMap = new Map();
    for (const [id, originalWord] of originalWords) {
      const mapped = words.find(
        (word) =>
          (word.id === id || word.id.endsWith(`-${id}`)) &&
          word.text === originalWord.text &&
          (originalWord.start === null
            ? word.start === null
            : Math.abs(word.start - originalWord.start - offset) < 0.06),
      );
      if (mapped) wordMap.set(id, mapped.id);
    }
    for (const question of verified.questions) {
      const index = questions.findIndex((item) => item.number === question.number);
      if (index < 0) throw new Error(`${overlay.lessonId} Q${question.number} 未对应原卷题号。`);
      const evidence = question.evidence.map((item) => {
        const wordIds = (item.wordIds || []).map((id) => {
          if (!wordMap.has(id)) throw new Error(`${overlay.lessonId} 的证据单词 ${id} 未对应原卷字幕。`);
          return wordMap.get(id);
        });
        const shifted = {
          ...structuredClone(item),
          start: rounded(item.start + offset),
          end: rounded(item.end + offset),
          wordIds,
        };
        if (shifted.start < 0 || shifted.end > duration + 0.05)
          throw new Error(`${overlay.lessonId} 的证据超出 Task 录音。`);
        return shifted;
      });
      questions[index] = {
        ...questions[index],
        ...structuredClone(question),
        grading: 'verified',
        input: 'text',
        evidence,
        verifiedLessonId: verified.id,
      };
    }
  }
  const sourceNote = [session.source?.note, task.note, boundaryNote].filter(Boolean).join(' ');
  return {
    schemaVersion: 1,
    id: paperPracticeId(session, task),
    title: `${session.year} ${variantLabel(session.variant)} · Part ${task.part} · Task ${task.number}`,
    audio: paperPracticeAudio(session, task),
    duration,
    source: {
      title: `${session.year} HKDSE Paper 3`,
      year: session.year,
      paper: 3,
      task: task.number,
      notes: sourceNote,
      audioOriginalRangeSeconds: { ...range },
      timingMethod: session.source?.method || 'existing word-level paper transcript',
    },
    instructions: '先阅读原题页，听录音完成本轮作答，再打开字幕与证据核对。',
    paper: {
      ...selection,
      task: task.number,
      sessionId: session.id,
      questionSourceId: original.sourceId,
      questionPage: original.page,
      questionContainsAnswers: !!catalogue.sources.find((source) => source.id === original.sourceId)
        ?.containsAnswers,
      referencePages,
      originalAudioRange: { ...range },
      taskAudioRange: { ...task.range },
      boundaryNote,
      sharedAudio: !!task.sharedAudio,
      sourceNote,
    },
    sentences,
    questions,
  };
}
