export function createSession(lesson) {
  return { lessonId: lesson.id, phase: 'first', attempts: [], marks: {}, moments: [], timingOffset: 0 };
}

export function shiftedRange(range, offset = 0, duration) {
  if (!Number.isFinite(offset) || Math.abs(offset) > 5) throw new Error('字幕偏移须在 −5 至 5 秒之间。');
  return validateLoop(Math.max(0, range.start + offset), Math.min(duration, range.end + offset), duration);
}

export function materialExposure(entry, entries, seenIds) {
  if (seenIds.includes(entry.id)) return 'practised';
  return entry.contentGroup &&
    entries.some((x) => x.contentGroup === entry.contentGroup && seenIds.includes(x.id))
    ? 'overlap'
    : 'fresh';
}

export function visibleLesson(lesson, session) {
  const reveal = session.phase === 'review';
  return {
    ...lesson,
    sentences: reveal ? lesson.sentences : [],
    questions: lesson.questions.map((q) =>
      reveal
        ? q
        : {
            id: q.id,
            number: q.number,
            label: q.label,
            prompt: q.prompt,
            options: q.options,
            grading: q.grading,
            input: q.input,
          },
    ),
  };
}

export function normaliseAnswer(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[.,!?;:]$/g, '')
    .replace(/\s+/g, ' ');
}

/** Shared answer boundary for single-record and full-backup imports. */
export function validateAnswerResult(result, { allowLegacy = false } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('听力答案格式无效。');
  const manual = result.grading === 'self';
  if (
    !(allowLegacy && !manual && result.answer === undefined) &&
    (typeof result.answer !== 'string' || result.answer.length > (manual ? 20000 : 500))
  )
    throw new Error('听力答案格式无效。');
  if (manual) {
    if (result.correct !== null || result.duplicate !== false)
      throw new Error('自核答案不能包含自动判分结果。');
    const rating = result.selfAssessment;
    if (
      (rating !== undefined && !['correct', 'incorrect', 'pending'].includes(rating)) ||
      result.status !== (rating === 'correct' || rating === 'incorrect' ? 'self-reviewed' : 'pending')
    )
      throw new Error('听力自核结果无效。');
  } else {
    if (
      typeof result.correct !== 'boolean' ||
      (result.grading !== undefined && !['auto', 'verified'].includes(result.grading)) ||
      (result.status !== undefined && result.status !== 'auto') ||
      (result.duplicate != null && typeof result.duplicate !== 'boolean')
    )
      throw new Error('听力答案格式无效。');
    if (result.selfAssessment !== undefined) throw new Error('自动判分题不能导入自核结果。');
  }
  if (result.selfCheck != null && !['', 'correct', 'retry'].includes(result.selfCheck))
    throw new Error('听力自核结果无效。');
  if (result.errorType != null && (typeof result.errorType !== 'string' || result.errorType.length > 100))
    throw new Error('听力错因格式无效。');
  return result;
}

// A stroke is stored in page-relative coordinates, independent of display size.
export function validatePaperInk(ink) {
  if (!ink || typeof ink !== 'object' || Array.isArray(ink)) throw new Error('手写页格式无效。');
  for (const [page, strokes] of Object.entries(ink)) {
    if (
      !/^[\w-]+:[1-9]\d*$/.test(page) ||
      !Array.isArray(strokes) ||
      strokes.some((s) => typeof s !== 'string' || !/^(?:\d{1,4},\d{1,4})(?: \d{1,4},\d{1,4})*$/.test(s))
    ) {
      throw new Error('手写笔迹格式无效。');
    }
  }
  return ink;
}

export function submitAnswers(lesson, session, answers, { ink } = {}) {
  if (session.phase === 'review') throw new Error('本轮已提交，请开始无字幕复测。');
  const pools = new Map();
  const results = Object.fromEntries(
    lesson.questions.map((q) => {
      const answer = String(answers[q.id] ?? '').trim(),
        normal = normaliseAnswer(answer);
      if (ink || q.grading === 'self')
        return [q.id, { answer, correct: null, duplicate: false, status: 'pending', grading: 'self' }];
      let correct = q.answers.some((a) => normaliseAnswer(a) === normal),
        duplicate = false;
      if (q.requiredGroups && !correct) {
        const parts = normal.split(/\s+(?:and|&)\s+|\s*[,;/]\s*/).filter(Boolean);
        const used = new Set();
        correct =
          parts.length === q.requiredGroups.length &&
          q.requiredGroups.every((group) => {
            const i = parts.findIndex(
              (part, index) => !used.has(index) && group.some((alias) => normaliseAnswer(alias) === part),
            );
            if (i < 0) return false;
            used.add(i);
            return true;
          });
      }
      if (q.sharedPool && q.answerCategories) {
        const category = q.answerCategories.find((c) =>
          c.answers.some((alias) => normaliseAnswer(alias) === normal),
        );
        const used = pools.get(q.sharedPool) ?? new Set();
        duplicate = !!category && used.has(category.id);
        correct = !!category && !duplicate;
        if (category) used.add(category.id);
        pools.set(q.sharedPool, used);
      }
      return [q.id, { answer, correct, duplicate }];
    }),
  );
  const attempt = {
    id: crypto.randomUUID(),
    phase: session.phase,
    submittedAt: new Date().toISOString(),
    results,
    ...(ink && { ink: structuredClone(validatePaperInk(ink)) }),
  };
  return { ...session, phase: 'review', attempts: [...session.attempts, attempt] };
}

export function switchPhase(session, phase) {
  if (!['first', 'review', 'retest'].includes(phase)) throw new Error('未知练习阶段');
  if (phase !== 'first' && !session.attempts.length) throw new Error('请先提交首听答案。');
  if (phase === 'first' && session.attempts.length) throw new Error('首听结果已保留，请选择无字幕复测。');
  return { ...session, phase };
}

export function selfAssessAnswer(lesson, session, questionId, rating) {
  if (session.phase !== 'review' || !session.attempts.length)
    throw new Error('请先提交本轮答案，再对照原卷自核。');
  const question = lesson.questions.find((q) => q.id === questionId);
  const attempt = session.attempts.at(-1);
  const result = attempt.results[questionId];
  if (
    !['correct', 'incorrect', 'pending'].includes(rating) ||
    !question ||
    (question.grading !== 'self' && !attempt.ink) ||
    result?.grading !== 'self' ||
    result.correct !== null
  )
    throw new Error('这道题的自核结果无效。');
  return {
    ...session,
    attempts: [
      ...session.attempts.slice(0, -1),
      {
        ...attempt,
        results: {
          ...attempt.results,
          [questionId]: {
            ...result,
            selfAssessment: rating,
            status: rating === 'pending' ? 'pending' : 'self-reviewed',
          },
        },
      },
    ],
  };
}

export function wordAtTime(lesson, time) {
  for (const sentence of lesson.sentences) {
    if (time >= sentence.start && time < sentence.end) {
      return (
        sentence.words.find(
          (w) => Number.isFinite(w.start) && Number.isFinite(w.end) && time >= w.start && time < w.end,
        ) ?? null
      );
    }
  }
  return null;
}

export function validateLoop(start, end, duration) {
  if (![start, end, duration].every(Number.isFinite) || start < 0 || end > duration)
    throw new Error('循环范围必须在录音内。');
  if (end <= start) throw new Error('请把 B 点设在 A 点之后。');
  if (end - start < 0.3) throw new Error('循环至少需要 0.3 秒。');
  return { start, end };
}

export function validateLesson(data) {
  const fail = (message) => {
    throw new Error(message);
  };
  const short = (v, max = 2000) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!data || data.schemaVersion !== 1 || !short(data.id, 120) || !short(data.title, 300))
    fail('练习包格式不正确：需要 schemaVersion 1、id 与 title。');
  if (!Number.isFinite(data.duration) || data.duration <= 0 || data.duration > 7200)
    fail('录音时长必须在 0–7200 秒内。');
  if (
    data.audio != null &&
    (!short(data.audio, 300) ||
      !/^(?:audio\/)?[a-zA-Z0-9_.-]+\.(mp3|m4a|wav|aac|ogg)$/i.test(data.audio) ||
      data.audio.includes('..'))
  )
    fail('音频须为练习包内的文件名，不接受远程音频地址。');
  if (!Array.isArray(data.sentences) || !data.sentences.length || data.sentences.length > 2000)
    fail('练习包需要带时间戳的字幕。');
  if (!Array.isArray(data.questions) || !data.questions.length || data.questions.length > 100)
    fail('练习包需要 1–100 道题。');
  const ids = new Set();
  let lastSentenceStart = -1;
  let count = 0;
  const id = (value) => {
    if (!short(value, 100) || !/^[a-zA-Z0-9_-]+$/.test(value) || value in Object.prototype || ids.has(value))
      fail('题目、句子和词的 id 必须唯一且不能使用保留名称。');
    ids.add(value);
  };
  const range = (item, kind) => {
    if (
      !Number.isFinite(item.start) ||
      !Number.isFinite(item.end) ||
      item.start < 0 ||
      item.end <= item.start ||
      item.end > data.duration + 0.05
    )
      fail(`${kind}时间超出录音或缺失。`);
  };
  for (const sentence of data.sentences) {
    id(sentence.id);
    range(sentence, '字幕');
    if (sentence.start < lastSentenceStart) fail('字幕时间必须按顺序排列。');
    lastSentenceStart = sentence.start;
    if (!Array.isArray(sentence.words) || !sentence.words.length) fail('句子缺少词级时间。');
    let previous = sentence.start;
    for (const word of sentence.words) {
      if (++count > 30000) fail('练习包词数过多，请分成短任务。');
      id(word.id);
      if (!short(word.text, 150)) fail('单词文本无效。');
      if (word.timingStatus === 'segment-only' && word.start === null && word.end === null) continue;
      range(word, '单词');
      if (
        word.start < previous - 0.05 ||
        word.start < sentence.start - 0.05 ||
        word.end > sentence.end + 0.05
      )
        fail('单词时间必须位于所属句子内且按序排列。');
      previous = word.start;
    }
  }
  for (const q of data.questions) {
    id(q.id);
    if (q.grading != null && !['auto', 'verified', 'self'].includes(q.grading)) fail('题目判分方式无效。');
    if (q.input != null && !['text', 'textarea'].includes(q.input)) fail('题目输入方式无效。');
    if (
      !short(q.prompt) ||
      !Array.isArray(q.answers) ||
      (q.grading === 'self' ? q.answers.length !== 0 : !q.answers.length) ||
      !q.answers.every((a) => short(a, 500))
    )
      fail('题目或参考答案缺失。');
    if (
      q.options &&
      (!Array.isArray(q.options) || q.options.length > 20 || !q.options.every((o) => short(o, 500)))
    )
      fail('选项格式不正确。');
    if (
      q.requiredGroups &&
      (!Array.isArray(q.requiredGroups) ||
        q.requiredGroups.length > 10 ||
        !q.requiredGroups.every(
          (g) => Array.isArray(g) && g.length > 0 && g.length < 100 && g.every((a) => short(a, 500)),
        ))
    )
      fail('多要点参考答案格式不正确。');
    if (
      q.sharedPool &&
      (!short(q.sharedPool, 100) ||
        !Array.isArray(q.answerCategories) ||
        !q.answerCategories.length ||
        q.answerCategories.length > 30 ||
        !q.answerCategories.every(
          (c) =>
            short(c.id, 100) &&
            Array.isArray(c.answers) &&
            c.answers.length > 0 &&
            c.answers.length < 100 &&
            c.answers.every((a) => short(a, 500)),
        ))
    )
      fail('共用答案组格式不正确。');
    if (q.evidence != null && !Array.isArray(q.evidence)) fail('题目录音证据格式无效。');
    if (q.grading !== 'self' && !q.evidence?.length) fail('题目缺少录音证据。');
    for (const evidence of q.evidence || []) {
      range(evidence, '证据');
      if (
        evidence.wordIds &&
        (!Array.isArray(evidence.wordIds) ||
          !evidence.wordIds.every((w) => data.sentences.some((s) => s.words.some((x) => x.id === w))))
      )
        fail('证据引用了不存在的词。');
    }
  }
  return data;
}

export function buildRecord(lesson, session) {
  return structuredClone({
    schemaVersion: 1,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    savedAt: new Date().toISOString(),
    attempts: session.attempts,
    marks: session.marks,
    moments: session.moments,
    timingOffset: session.timingOffset || 0,
  });
}
