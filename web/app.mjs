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
} from './core.mjs';
import { mountPaperPractice } from './paper-practice.mjs';
import { taskQuestionPages } from './paper-question-pages.mjs';
import { mountTranscriptWindow } from './transcript-window.mjs';
import { mountFocusedDrill } from './focused-drill.mjs';
import { questionDrillSentence } from './focused-drill-core.mjs';
import { checkpointPaper, readPaperDraft, seenMaterials, markSeen } from './paper-recovery.mjs';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const transcriptWindow = mountTranscriptWindow();
let catalogue = [
  { id: '2025-task1-intro', title: '入门选段 · 第 1–4 题', url: './lessons/2025-task1-intro.json' },
  { id: '2025-task1', title: '完整访谈 · 第 1–13 题', url: './lessons/2025-task1.json' },
];
const storageKey = 'english30-records-v1';
const listeningEvents = new EventTarget();
let paperPractice,
  paperCatalogueError = null;
let unavailableControls = [];
let requestedLessonId = null;
let activeLessonLoad = null;
let navigateTo = () => {},
  glossary = [];
let requestSave = () => status('保存入口正在准备，请稍候。');
let focusedDrill;
let answerMode = 'type',
  inkPages = {},
  paperPage = null;
const exposedLessons = seenMaterials();
let recoveringPaper = readPaperDraft(),
  checkpointTimer;
let priorExposure = false;
let playbackRequest = 0;
let lesson = null,
  session = null,
  drafts = {},
  selectedWord = null;
let wordElements = new Map(),
  sentenceElements = new Map(),
  wordsById = new Map();
let activeWord = null,
  activeSentence = null,
  follow = true,
  raf = null,
  objectURL = null;
let loop = { start: null, end: null, enabled: false },
  stopAt = null,
  audioReady = false,
  loadGeneration = 0;
let audioLoadController = null,
  pendingSeek = null;
let seekPreview = null;
let seekGesturePaused = null;
let savedRecord = null,
  saveRevision = null,
  revision = 0,
  hasStarted = false,
  attemptStart = null,
  navigationUsed = false;
const phaseNames = { first: '首听作答', review: '逐句精听', retest: '无字幕复测' };
const formatTime = (n) => {
  n = Math.max(0, Number.isFinite(n) ? n : 0);
  return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('is-error', error);
}
function touch() {
  revision++;
  queueCheckpoint();
  listeningEvents.dispatchEvent(new Event('change'));
}
function checkpoint() {
  clearTimeout(checkpointTimer);
  if (!lesson?.paper || !session) return;
  const elapsedMs = attemptStart == null ? 0 : Math.max(0, Date.now() - attemptStart);
  const ok = checkpointPaper({
    session,
    drafts,
    inkPages,
    answerMode,
    paperPage,
    hasStarted,
    elapsedMs,
    navigationUsed,
    revision,
    priorExposure,
    savedAt: savedRecord?.savedAt,
  });
  if (!ok) status('浏览器暂时无法保留刷新草稿，请保持此页打开。', true);
}
function queueCheckpoint() {
  if (!lesson?.paper) return;
  clearTimeout(checkpointTimer);
  checkpointTimer = setTimeout(checkpoint, 100);
}
function review() {
  return session?.phase === 'review';
}
function hasAnswerDraft() {
  return (
    !!session &&
    !review() &&
    (Object.keys(inkPages).length > 0 || Object.values(drafts).some((answer) => String(answer).trim()))
  );
}
function hasUnsavedListening() {
  return hasAnswerDraft() || (revision > 0 && revision !== saveRevision);
}
function guardReview() {
  if (!review()) {
    status('先提交本轮答案，再使用字幕、证据和循环练习。');
    return false;
  }
  return true;
}
function button(label, action, className = 'button-quiet') {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', action);
  return b;
}
function empty(target, title, text) {
  target.replaceChildren();
  const box = el('div', 'empty-state');
  box.append(el('h3', '', title), el('p', '', text));
  target.append(box);
}
function resetPlayer() {
  cancelPendingSeek();
  audio.pause();
  loop = { start: null, end: null, enabled: false };
  stopAt = null;
  seekPreview = null;
  seekGesturePaused = null;
  $('loop-more').open = false;
  $('player-feedback').hidden = true;
  selectedWord = null;
  audio.playbackRate = 1;
  $('playback-rate').value = '1';
  updateLoop();
  syncPlaybackButton();
}
function clearHighlights() {
  if (activeWord) wordElements.get(activeWord)?.classList.remove('is-playing');
  if (activeSentence) sentenceElements.get(activeSentence)?.classList.remove('is-current');
  activeWord = null;
  activeSentence = null;
}

async function loadLesson(data) {
  validateLesson(data);
  for (const [node, disabled] of unavailableControls) node.disabled = disabled;
  unavailableControls = [];
  audioLoadController?.abort();
  audioLoadController = null;
  resetPlayer();
  clearHighlights();
  if (objectURL) {
    URL.revokeObjectURL(objectURL);
    objectURL = null;
  }
  lesson = data;
  priorExposure = exposureFor(data.id) !== 'fresh';
  session = createSession(lesson);
  drafts = {};
  answerMode = 'type';
  inkPages = {};
  paperPage = null;
  selectedWord = null;
  hasStarted = false;
  attemptStart = null;
  navigationUsed = false;
  follow = true;
  revision = 0;
  saveRevision = null;
  savedRecord = null;
  if (data.paper && recoveringPaper?.session.lessonId === data.id) {
    const draft = recoveringPaper;
    session = draft.session;
    drafts = draft.drafts || {};
    inkPages = draft.inkPages;
    answerMode = draft.answerMode === 'ink' ? 'ink' : 'type';
    paperPage = draft.paperPage;
    hasStarted = !!draft.hasStarted;
    if (hasStarted && !review()) attemptStart = Date.now() - (draft.elapsedMs || 0);
    navigationUsed = !!draft.navigationUsed;
    priorExposure ||= !!draft.priorExposure;
    revision = draft.revision || 0;
    savedRecord = draft.savedAt
      ? readSavedRecords().findLast((r) => r.lessonId === data.id && r.savedAt === draft.savedAt)
      : null;
    if (savedRecord && !hasAnswerDraft() && !listeningBridge.getSaveSnapshot()) saveRevision = revision;
  }
  if (data.paper) recoveringPaper = null;
  audioReady = false;
  wordsById = new Map();
  for (const s of lesson.sentences) for (const w of s.words) wordsById.set(w.id, { word: w, sentence: s });
  $('lesson-title').textContent = lesson.title;
  $('lesson-meta').textContent = lesson.paper
    ? `${lesson.paper.year} · Part ${lesson.paper.part} · Task ${lesson.paper.task} · ${formatTime(lesson.duration)}${lesson.paper.sharedAudio ? ' · Part B 共用原音' : ' · Task 原音分段'}`
    : `第 ${lesson.questions[0].number}–${lesson.questions.at(-1).number} 题 · ${formatTime(lesson.duration)} · 原卷对话节选`;
  paperPractice?.setEntry(data.id);
  $('time-total').textContent = formatTime(lesson.duration);
  $('seek').max = lesson.duration;
  audio.removeAttribute('src');
  audio.load();
  render();
  status('正在载入原音。');
  if (lesson.audio) {
    const controller = new AbortController();
    audioLoadController = controller;
    try {
      // The private host can return the whole MP3 for a Range request. A fully
      // loaded Blob is seekable without depending on that server capability.
      const response = await fetch(new URL(data.audio, document.baseURI), { signal: controller.signal });
      if (!response.ok) throw new Error('原音载入失败，请联网后重新选择练习。');
      const blob = await response.blob();
      if (controller.signal.aborted || audioLoadController !== controller) return;
      objectURL = URL.createObjectURL(blob);
      audio.src = objectURL;
      audio.load();
      status(
        review()
          ? '已恢复本轮复盘，可继续核对答案与原音。'
          : hasAnswerDraft()
            ? '已恢复本页草稿，可以继续作答。'
            : '原音已载入。准备好后播放；提交前隐藏字幕与答案线索。',
      );
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (audioLoadController === controller) audioLoadController = null;
    }
  }
}

function chooseLesson(entry) {
  activeLessonLoad = performLessonChoice(entry);
  return activeLessonLoad;
}
async function performLessonChoice(entry) {
  transcriptWindow.enable(false);
  const generation = ++loadGeneration;
  requestedLessonId = entry.id;
  audioLoadController?.abort();
  audioLoadController = null;
  resetPlayer();
  audioReady = false;
  audio.removeAttribute('src');
  audio.load();
  if (session) renderControls();
  for (const id of ['play-pause', 'seek', 'mark-moment', 'submit-answers']) $(id).disabled = true;
  if (entry.missingAudio) {
    $('question-pages').hidden = true;
    $('transcript').before($('practice-sources'), $('original-responses'));
    $('review-paper-panel').hidden = true;
    clearTimeout(checkpointTimer);
    checkpointPaper(null);
    recoveringPaper = null;
    delete document.body.dataset.paperAnswer;
    lesson = null;
    session = null;
    drafts = {};
    revision = 0;
    saveRevision = null;
    clearHighlights();
    paperPractice?.setEntry(entry.id);
    $('lesson-title').textContent = entry.title;
    $('lesson-meta').textContent =
      `${entry.year} · ${entry.variant} · Part ${entry.part} · Task ${entry.task} · 无匹配原音`;
    $('time-current').textContent = '0:00';
    $('time-total').textContent = '—';
    $('seek').value = 0;
    $('seek').max = 1;
    $('mode-label').textContent = '只读原卷';
    $('original-responses').replaceChildren();
    $('original-responses').hidden = true;
    $('review-navigation').hidden = true;
    $('listening-next-actions').hidden = true;
    $('marks-list').replaceChildren();
    $('saved-records')?.replaceChildren();
    if (!unavailableControls.length)
      unavailableControls = [
        ...document.querySelectorAll(
          '#listening-panel button, .player button, .player input, .player select',
        ),
      ].map((node) => [node, node.disabled]);
    for (const [node] of unavailableControls) node.disabled = true;
    $('questions').replaceChildren();
    paperPractice?.renderUnavailable(entry);
    $('word-inspector').hidden = true;
    empty($('transcript'), '这份 Sample 的音频尚未匹配', '请选择正式试卷或 Practice 继续精练。');
    status('Sample 音频缺失或与原稿不匹配，尚不能开始听力精练。');
    requestedLessonId = null;
    listeningEvents.dispatchEvent(new Event('change'));
    return;
  }
  status('正在载入练习与原音，请稍候。');
  try {
    const response = await fetch(entry.url);
    if (!response.ok) throw new Error('练习材料载入失败，请联网后重试。');
    const data = await response.json();
    if (generation !== loadGeneration) return;
    await loadLesson(data);
  } catch (error) {
    if (generation !== loadGeneration) return;
    status(error.message, true);
    empty($('transcript'), '材料暂未载入', '请检查网络后重新选择原卷。');
  } finally {
    if (generation === loadGeneration) requestedLessonId = null;
  }
}

function render() {
  if (!lesson) return;
  transcriptWindow.enable(review() && !!lesson.paper && !!lesson.sentences.length);
  const submittedInk = session.attempts.at(-1)?.ink;
  const mode = review() ? (submittedInk ? 'ink' : 'type') : answerMode;
  document.body.dataset.paperAnswer = lesson.paper ? mode : '';
  paperPractice?.renderSources(lesson, session.phase, {
    mode,
    ink: review() ? submittedInk : inkPages,
    readOnly: review(),
    page: paperPage,
    setMode(next) {
      if (next === answerMode) return;
      answerMode = next;
      touch();
      render();
    },
    setPage(sourceId, page) {
      const previous = paperPage?.questionPage;
      const questionPage =
        sourceId === lesson.paper.questionSourceId ? page : (previous ?? lesson.paper.questionPage);
      paperPage = { sourceId, page, questionPage };
      syncQuestionPage();
      if (previous !== questionPage) $('questions').scrollTop = 0;
      queueCheckpoint();
    },
    changed: touch,
  });
  renderTranscript();
  renderQuestions();
  renderMarks();
  renderControls();
  renderInspector();
  renderSaved();
  renderCatalogue();
  queueCheckpoint();
  listeningEvents.dispatchEvent(new Event('change'));
}
function renderTranscript() {
  clearHighlights();
  wordElements = new Map();
  sentenceElements = new Map();
  const target = $('transcript');
  target.replaceChildren();
  $('review-help').hidden = !review();
  if (!review()) {
    empty(
      target,
      session.phase === 'first' ? '先让耳朵走一遍' : '关上字幕，再听一次',
      session.phase === 'first'
        ? '读题、听原音，按你听到的内容作答。没听清时，留下时间标记；提交后再逐词回听。'
        : '本轮重新作答，旧答案和卡词暂时收起。首听结果会保留，复测结果单独记录。',
    );
    const context = el('div', 'task-context');
    if (lesson.introduction || lesson.instructions)
      context.append(el('p', '', lesson.introduction || lesson.instructions));
    if (lesson.example) context.append(el('p', '', `例题：${lesson.example}`));
    context.append(
      el(
        'p',
        'fine-print',
        lesson.paper
          ? '按 Task 分段练习，可暂停和反复听。提交后开放字幕与评分参考。'
          : '这是原卷对话节选练习；可暂停，不等同于完整考试模拟。',
      ),
    );
    target.append(context);
    return;
  }
  for (const sentence of lesson.sentences) {
    const row = el('div', 'sentence');
    row.dataset.sentenceId = sentence.id;
    const heading = el('div', 'sentence-meta');
    heading.append(
      button(
        formatTime(sentence.start),
        () => seekPosition(sentence.start + (session.timingOffset || 0)),
        'sentence-time',
      ),
      el('span', 'speaker', sentence.speaker || ''),
    );
    row.append(heading);
    const text = el('p', 'sentence-text');
    text.lang = 'en';
    for (const word of sentence.words) {
      const b = button(word.text, () => selectWord(word.id), 'word');
      b.dataset.wordId = word.id;
      if (session.marks[word.id]) b.classList.add(`is-${session.marks[word.id]}`);
      if (word.timingStatus === 'segment-only') b.title = '此词时间待核；点词可回听整句';
      b.setAttribute('aria-label', `${word.text}，选择并回听`);
      text.append(b, document.createTextNode(' '));
      wordElements.set(word.id, b);
    }
    row.append(text);
    target.append(row);
    sentenceElements.set(sentence.id, row);
  }
  updatePlayback();
}

function renderQuestions() {
  const target = $('questions');
  target.replaceChildren();
  const responses = $('original-responses');
  responses.replaceChildren();
  const splitReview = review() && !!lesson.paper;
  const paperPanel = $('review-paper-panel');
  paperPanel.hidden = !splitReview;
  const sources = $('practice-sources');
  if (splitReview && sources.parentElement !== paperPanel) paperPanel.append(sources, responses);
  if (!splitReview && sources.parentElement === paperPanel) $('transcript').before(sources, responses);
  $('review-navigation').hidden = !splitReview;
  responses.hidden = !splitReview;
  if (splitReview) responses.append(el('h2', '', '原题与本轮作答'));
  $('question-heading').textContent = splitReview ? '答案与证据' : '题目与作答';
  const last = session.attempts.at(-1);
  if (review() && last) {
    const results = Object.values(last.results);
    const automatic = results.filter((r) => typeof r.correct === 'boolean' && r.grading !== 'self');
    const matched = automatic.filter((r) => r.correct).length;
    const manual = results.filter((r) => r.grading === 'self');
    const pending = manual.filter((r) => r.status === 'pending').length;
    const summary = el(
      'p',
      'result-summary',
      `${automatic.length ? `本轮 ${matched}/${automatic.length} 题与参考表达匹配。` : ''}${manual.length ? ` ${pending} 题待自核，${manual.length - pending} 题已自核；不计入自动正确率。` : '其余请自核。'}`,
    );
    if (automatic.length) summary.append(el('small', 'fine-print', '不同的正确写法可对照评分参考自核。'));
    target.append(summary);
    if (lesson.paper?.reviewRules?.length) {
      const rules = el('details', 'task-scoring-rules');
      rules.append(el('summary', '', '计分规则与可互换答案'));
      for (const rule of lesson.paper.reviewRules) rules.append(el('p', 'task-scoring-rule', rule));
      target.append(rules);
    }
  }
  for (const q of visibleLesson(lesson, session).questions) {
    const card = el('article', 'question-card');
    card.dataset.questionId = q.id;
    card.dataset.questionNumber = q.number;
    const label = el('label', 'question-label', `${q.label || q.number}. ${q.prompt}`);
    label.htmlFor = `answer-${q.id}`;
    label.lang = 'en';
    card.append(label);
    const input = q.options
      ? el('select', 'question-input')
      : el(q.input === 'textarea' ? 'textarea' : 'input', 'question-input');
    input.id = `answer-${q.id}`;
    input.name = q.id;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('autocapitalize', 'none');
    if (q.options) {
      input.append(new Option('请选择', ''));
      for (const option of q.options) input.append(new Option(option, option));
    } else {
      if (q.input !== 'textarea') input.type = 'text';
      input.maxLength = q.input === 'textarea' ? 20000 : 500;
      input.placeholder =
        q.input === 'textarea' ? '按原题要求写下完整作答；提交后对照评分参考自核。' : '写下听到的答案';
    }
    input.value = review() ? last?.results[q.id]?.answer || '' : drafts[q.id] || '';
    if (q.options) input.disabled = review();
    else input.readOnly = review();
    input.addEventListener('input', () => {
      drafts[q.id] = input.value;
      touch();
    });
    card.append(input);
    if (splitReview) {
      const original = el('article', 'original-response');
      original.dataset.questionNumber = q.number;
      original.append(label, input);
      responses.append(original);
      card.append(el('h3', 'question-label', q.label || `第 ${q.number} 题`));
    }
    if (review()) {
      const result = last.results[q.id];
      card.classList.toggle('is-correct', result.correct);
      const feedback = el('div', 'question-feedback');
      const tools = el('details', 'question-review-tools');
      tools.append(el('summary', '', '自核与详情'));
      tools.append(
        el(
          'strong',
          '',
          result.grading === 'self'
            ? result.status === 'self-reviewed'
              ? '已自核 · 保留原作答'
              : '待自核 · 对照原卷评分参考'
            : result.correct
              ? '已匹配参考表达'
              : result.duplicate
                ? '与前面理由重复，不能重复计分'
                : '待自核：对照参考表达与录音',
        ),
      );
      if (q.referenceAnswer || q.grading !== 'self')
        feedback.append(
          el(
            'p',
            'reference-answer',
            q.referenceAnswer ||
              (q.answerCategories
                ? q.answerCategories.map((c) => c.answers.join(' / ')).join('；\n')
                : q.answers.join(' / ')),
          ),
        );
      if (q.referenceImage) {
        const img = el('img', 'reference-diagram');
        img.src = q.referenceImage.src;
        img.alt = q.referenceImage.alt;
        feedback.append(img);
      }
      const sourcePage = paperPractice?.sourcePage(q.reference);
      if (sourcePage) {
        const link = el('a', 'reference-source', `${sourcePage.name} · PDF 第 ${q.reference.page} 页`);
        link.href = sourcePage.src;
        link.target = '_blank';
        link.rel = 'noopener';
        tools.append(link);
      }
      if (q.scoringPoints?.length) {
        const points = el('ol', 'scoring-points');
        for (const point of q.scoringPoints) {
          const item = el('li', 'scoring-point');
          item.dataset.pointId = point.id;
          item.append(el('strong', '', point.id), el('p', 'reference-answer', point.referenceAnswer));
          if (point.section) item.append(el('p', 'fine-print', point.section));
          item.append(el('p', 'point-source', point.sourceLabel));
          for (const ref of point.dataReferences || []) {
            const page = paperPractice?.sourcePage(ref);
            if (!page) continue;
            const link = el('a', 'reference-source', `查看 Data File 第 ${ref.printedPage} 页`);
            link.href = page.src;
            link.target = '_blank';
            link.rel = 'noopener';
            item.append(link);
          }
          for (const evidence of point.evidence || []) {
            item.append(
              button(
                '听原音 · ' + formatTime(evidence.contextStart ?? evidence.start),
                () => showEvidence(q, evidence),
                'evidence-link',
              ),
            );
            tools.append(
              button(
                point.id + ' · 只听答案句',
                () => showEvidence(q, evidence, true),
                'button-text answer-replay',
              ),
            );
          }
          points.append(item);
        }
        feedback.append(points);
      }
      if (q.rubricReferences?.length) {
        const rubric = el('details', 'scoring-rubric');
        rubric.append(el('summary', '', '语言、组织与语气评分表'));
        for (const ref of q.rubricReferences) {
          const page = paperPractice?.sourcePage(ref);
          if (!page) continue;
          const link = el('a', 'reference-source', `评分参考 · PDF 第 ${ref.page} 页`);
          link.href = page.src;
          link.target = '_blank';
          link.rel = 'noopener';
          rubric.append(link);
          for (const [index, src] of (page.displayImages || [page.src]).entries()) {
            const img = el('img');
            img.src = src;
            img.alt = `${q.label || q.number} 评分参考 PDF 第 ${ref.page} 页${page.displayImages ? `，第 ${index + 1} 栏` : ''}`;
            img.loading = 'lazy';
            rubric.append(img);
          }
        }
        feedback.append(rubric);
      }
      if (q.explanation) tools.append(el('p', '', q.explanation));
      const evidence = q.evidence || [];
      const evidenceIds = new Set(evidence.flatMap((e) => e.wordIds || []));
      const spoken = lesson.sentences
        .flatMap((s) => s.words)
        .filter((w) => evidenceIds.has(w.id))
        .map((w) => w.text)
        .join(' ');
      if (spoken) {
        const pair = el('details', 'paraphrase-pair');
        pair.append(
          el('summary', '', '题目说法 ↔ 原音说法'),
          el('p', '', `题目：${q.prompt}`),
          el('p', '', `原音关键词：${spoken}`),
        );
        tools.append(pair);
      }
      evidence.forEach((e, i) => {
        feedback.append(
          button(
            evidence.length > 1
              ? `听证据 ${i + 1} · ${formatTime(e.contextStart ?? e.start)}`
              : `听原音 · ${formatTime(e.contextStart ?? e.start)}`,
            () => showEvidence(q, e),
            'evidence-link',
          ),
        );
        if (Number.isFinite(e.contextStart)) {
          const answerOnly = button('只重听答案句', () => showEvidence(q, e, true), 'button-text');
          answerOnly.dataset.answerOnly = 'true';
          tools.append(answerOnly);
        }
      });
      const selfCheck = el('select', 'self-check');
      selfCheck.setAttribute('aria-label', `第${q.number}题自核结果`);
      selfCheck.append(
        new Option('自核：暂未确认', ''),
        new Option('自核：我的表达正确', 'correct'),
        new Option('自核：需要重练', 'retry'),
      );
      selfCheck.value =
        result.grading === 'self'
          ? { correct: 'correct', incorrect: 'retry' }[result.selfAssessment] || ''
          : result.selfCheck || '';
      selfCheck.addEventListener('change', () => {
        if (result.grading === 'self') {
          session = selfAssessAnswer(
            lesson,
            session,
            q.id,
            { correct: 'correct', retry: 'incorrect' }[selfCheck.value] || 'pending',
          );
          renderQuestions();
        } else result.selfCheck = selfCheck.value;
        touch();
      });
      tools.append(selfCheck);
      const errorReason = el('select', 'error-reason');
      errorReason.setAttribute('aria-label', `第${q.number}题主要错因`);
      for (const [value, label] of [
        ['', '选择主要错因'],
        ['sound', '认识但听不出'],
        ['meaning', '不懂词义'],
        ['information', '漏听／选错信息'],
        ['form', '拼写／词形'],
        ['sentence', '听到词但跟不上句意'],
      ])
        errorReason.append(new Option(label, value));
      errorReason.value = result.errorType || '';
      errorReason.addEventListener('change', () => {
        result.errorType = errorReason.value;
        touch();
      });
      tools.append(errorReason);
      if (questionDrillSentence(lesson, q)) {
        const practise = button(
          '练这一处',
          () => {
            focusedDrill ||= mountFocusedDrill({
              cancel: () => {
                resetPlayer();
                audio.playbackRate = 1;
                $('playback-rate').value = '1';
              },
              play: async (start, end) => {
                await playSubtitle(start, end);
                return { ok: !audio.paused, rate: audio.playbackRate };
              },
              onChange: () => listeningEvents.dispatchEvent(new Event('change')),
            });
            focusedDrill.open(lesson, q, practise);
          },
          'button-secondary',
        );
        practise.dataset.practiceDrill = q.id;
        tools.append(practise);
      } else if (lesson.paper) {
        tools.append(
          el(
            'p',
            'fine-print',
            evidence.length
              ? '可听原音证据；此处逐词时间尚未全部核实，暂不提供单句听写。'
              : '原音证据定位待核实；本题暂不提供单句听写。',
          ),
        );
      }
      feedback.append(tools);
      card.append(feedback);
    }
    target.append(card);
  }
  syncQuestionPage();
}

function syncQuestionPage() {
  const pages = taskQuestionPages(lesson);
  const pager = $('question-pages');
  pager.hidden = !pages.length;
  if (!pages.length) return;
  const page = paperPage?.questionPage ?? lesson.paper.questionPage;
  const index = pages.findIndex(([number]) => number === page);
  const range = pages[index];
  for (const card of document.querySelectorAll(
    '#questions [data-question-number], #original-responses [data-question-number]',
  )) {
    const number = Number(card.dataset.questionNumber);
    card.hidden = !range || number < range[1] || number > range[2];
  }
  const label = range && (range[1] === range[2] ? 'Q' + range[1] : 'Q' + range[1] + '–Q' + range[2]);
  $('question-page-range').textContent = range ? '第 ' + page + ' 页 · ' + label : '此页没有本 Task 的题目';
  const previous = $('previous-question-page'),
    next = $('next-question-page'),
    back = $('return-question-page');
  previous.hidden = next.hidden = !range || pages.length === 1;
  previous.disabled = index <= 0;
  next.disabled = index < 0 || index === pages.length - 1;
  back.hidden = !!range;
  previous.onclick = () => paperPractice.showQuestionPage(pages[index - 1][0]);
  next.onclick = () => paperPractice.showQuestionPage(pages[index + 1][0]);
  back.onclick = () => paperPractice.showQuestionPage(pages[0][0]);
}

function renderControls() {
  const isReview = review();
  document.body.dataset.listeningPhase = session.phase;
  $('mode-label').textContent = phaseNames[session.phase];
  for (const phase of ['first', 'review', 'retest']) {
    const b = $(`phase-${phase}`);
    b.setAttribute('aria-pressed', String(session.phase === phase));
    b.disabled =
      (phase === 'first' && !!session.attempts.length) || (phase !== 'first' && !session.attempts.length);
  }
  $('submit-answers').hidden = isReview;
  $('submission-note').hidden = isReview;
  $('submit-answers').disabled = !audioReady || !hasStarted;
  $('submit-answers').title = hasStarted ? '' : '先播放原音；播放后可留空交卷。';
  $('submit-answers').textContent = session.phase === 'retest' ? '提交复测答案' : '提交作答';
  $('listening-next-actions').hidden = !isReview;
  const fresh = catalogueWithStatus().some(
    (entry) =>
      entry.paperPractice &&
      !entry.missingAudio &&
      entry.exposure === 'fresh' &&
      ['A', 'B1'].includes(entry.part) &&
      entry.id !== lesson.id,
  );
  $('listening-fresh').disabled = !fresh;
  $('listening-fresh').textContent = fresh ? '换未练过的 Task' : '暂无未练过的验证材料';
  for (const id of [
    'prev-sentence',
    'next-sentence',
    'repeat-sentence',
    'loop-start',
    'loop-end',
    'loop-toggle',
    'playback-rate',
    'follow-toggle',
  ])
    $(id).disabled = !isReview || !audioReady;
  $('play-pause').disabled = !audioReady;
  $('seek').disabled = !audioReady;
  $('mark-moment').disabled = !audioReady || !hasStarted || audio.currentTime <= 0;
  syncPlaybackButton();
  $('save-record').disabled = !session.attempts.length;
  $('export-record').disabled = !savedRecord;
  $('follow-toggle').setAttribute('aria-pressed', String(follow));
  $('follow-toggle').textContent = follow ? '正在跟随' : '回到播放位置';
  $('subtitle-adjustment').hidden = !isReview;
  $('follow-toggle').hidden = !isReview;
  $('prev-sentence').hidden = !isReview;
  $('next-sentence').hidden = !isReview;
  document.querySelector('.rate-control').hidden = !isReview;
  document.querySelector('.player-bottom').hidden = !isReview;
  $('subtitle-offset').value = String(session.timingOffset || 0);
  const quiet = document.querySelector('.quiet-label');
  if (quiet)
    quiet.textContent = isReview
      ? '按题对照 · 未核实不判错'
      : session.phase === 'retest'
        ? '原速 · 无提示复测'
        : priorExposure || navigationUsed
          ? '原速 · 辅助作答'
          : '原速 · 独立作答';
}

function renderSaved() {
  let target = $('saved-records');
  if (!target) {
    target = el('div', 'saved-records');
    target.id = 'saved-records';
    document.querySelector('.review-drawer-content').append(target);
  }
  target.replaceChildren();
  try {
    const records = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (!Array.isArray(records)) return;
    const record = records.findLast(
      (r) =>
        r.schemaVersion === 1 &&
        r.lessonId === lesson.id &&
        Array.isArray(r.attempts) &&
        r.attempts.length &&
        r.attempts.every(
          (a) => a.results && lesson.questions.every((q) => typeof a.results[q.id]?.answer === 'string'),
        ),
    );
    if (!record) return;
    target.append(
      el(
        'p',
        'fine-print',
        `此设备有已保存的练习：${new Date(record.savedAt).toLocaleString('zh-HK')} · ${record.attempts.length} 轮`,
      ),
    );
    target.append(
      button(
        '恢复这份纪录，继续复盘',
        () => {
          if (hasUnsavedListening() && !confirm('恢复会替换当前尚未保存的练习，继续吗？')) return;
          resetPlayer();
          const restored = structuredClone(record);
          session = {
            lessonId: lesson.id,
            phase: 'review',
            attempts: restored.attempts,
            marks: restored.marks || {},
            moments: restored.moments || [],
            timingOffset: restored.timingOffset || 0,
          };
          drafts = {};
          savedRecord = restored;
          revision = 0;
          saveRevision = 0;
          render();
          status('已从当前浏览器恢复学习纪录，可以继续复盘或开始新一轮无字幕复测。');
        },
        'button-secondary',
      ),
    );
  } catch {
    target.append(el('p', 'fine-print', '此浏览器暂时无法读取已存纪录。'));
  }
}

function selectWord(id) {
  if (!guardReview()) return;
  wordElements.get(selectedWord)?.classList.remove('is-selected');
  selectedWord = id;
  wordElements.get(id)?.classList.add('is-selected');
  renderInspector();
  const s = wordsById.get(id).sentence;
  const w = wordsById.get(id).word;
  return playSubtitle(
    Math.max(s.start, Number.isFinite(w.start) ? w.start - 0.55 : s.start),
    Math.min(s.end, Number.isFinite(w.end) ? w.end + 0.7 : s.end),
  );
}
function renderInspector() {
  const inspector = $('word-inspector');
  inspector.hidden = !review() || !selectedWord;
  if (inspector.hidden) return;
  const { word, sentence } = wordsById.get(selectedWord);
  $('word-text').textContent = word.text;
  $('word-context').textContent = sentence.words.map((w) => w.text).join(' ');
  const plain = word.text.toLowerCase().replace(/^[^a-z]+|[^a-z'-]+$/gi, '');
  const meaning = glossary.find(
    (g) =>
      (!g.lessonIds?.length || g.lessonIds.includes(lesson.id)) &&
      (g.wordIds?.includes(word.id) || g.lemma?.toLowerCase() === plain),
  );
  $('word-meaning').textContent = meaning
    ? `${meaning.meaning}${meaning.collocation ? ` · 搭配：${meaning.collocation}` : ''}`
    : '';
  let lookup = $('dictionary-link');
  if (!lookup) {
    lookup = el('a', 'button-text', '查英英词典 ↗');
    lookup.id = 'dictionary-link';
    lookup.target = '_blank';
    lookup.rel = 'noopener noreferrer';
    inspector.append(lookup);
  }
  lookup.href =
    'https://dictionary.cambridge.org/dictionary/english/' +
    encodeURIComponent(word.text.toLowerCase().replace(/^[^a-z]+|[^a-z'-]+$/gi, ''));
  $('mark-heard').setAttribute('aria-pressed', String(session.marks[selectedWord] === 'heard'));
  $('mark-unknown').setAttribute('aria-pressed', String(session.marks[selectedWord] === 'unknown'));
}
function setMark(type) {
  if (!guardReview() || !selectedWord) return;
  if (type) session.marks[selectedWord] = type;
  else delete session.marks[selectedWord];
  touch();
  const node = wordElements.get(selectedWord);
  node.classList.remove('is-heard', 'is-unknown');
  if (type) node.classList.add(`is-${type}`);
  renderInspector();
  renderMarks();
  status(
    type === 'heard'
      ? '已标记：认识，但在原音里听不出。'
      : type === 'unknown'
        ? '已标记：不认识这个词。'
        : '已清除这个词的标记。',
  );
}
function renderMarks() {
  const target = $('marks-list');
  target.replaceChildren();
  if (!review()) {
    target.append(
      el(
        'p',
        'empty-copy',
        `本轮记下 ${session.moments.length} 个时间点；提交后可逐个回听。卡词将在复盘时显示。`,
      ),
    );
    return;
  }
  for (const [id, type] of Object.entries(session.marks)) {
    const found = wordsById.get(id);
    if (!found) continue;
    const item = el('div', 'mark-item');
    item.append(
      button(found.word.text, () => selectWord(id), 'marked-word'),
      el('span', '', type === 'heard' ? '认识，但听不出' : '不认识'),
      button(
        '清除',
        () => {
          delete session.marks[id];
          touch();
          renderTranscript();
          renderMarks();
          renderInspector();
        },
        'button-text',
      ),
    );
    target.append(item);
  }
  session.moments.forEach((moment, i) => {
    const item = el('div', 'mark-item');
    const start = Number.isFinite(moment.start) ? moment.start : Math.max(0, moment.time - 4);
    const end = Number.isFinite(moment.end) ? moment.end : Math.min(lesson.duration, moment.time + 2);
    item.append(
      button(`${formatTime(moment.time)} · 没听清`, () => playRange(start, end)),
      button(
        '清除',
        () => {
          session.moments.splice(i, 1);
          touch();
          renderMarks();
        },
        'button-text',
      ),
    );
    const adjust = el('details', 'moment-adjustment');
    adjust.append(el('summary', '', '调整回听片段'));
    const fields = [];
    for (const [label, value] of [
      ['起点（秒）', start],
      ['终点（秒）', end],
    ]) {
      const field = el('label', '', label);
      const input = el('input');
      input.type = 'number';
      input.min = '0';
      input.max = String(lesson.duration);
      input.step = '0.1';
      input.value = String(Math.round(value * 10) / 10);
      input.setAttribute('aria-label', `标记${i + 1}${label}`);
      fields.push(input);
      field.append(input);
      adjust.append(field);
    }
    adjust.append(
      button(
        '应用并预听',
        () => {
          try {
            const range = validateLoop(Number(fields[0].value), Number(fields[1].value), lesson.duration);
            Object.assign(moment, range);
            touch();
            renderMarks();
            playRange(range.start, range.end);
            status('片段已调整；保存本次学习纪录后，隔天仍可回听此范围。');
          } catch (error) {
            status(error.message, true);
          }
        },
        'button-quiet',
      ),
    );
    item.append(adjust);
    target.append(item);
  });
  if (!target.children.length)
    target.append(el('p', 'empty-copy', '还没有标记。点字幕中的词，或播放时按「刚才没听清」。'));
}

function playSubtitle(start, end) {
  try {
    const range = shiftedRange({ start, end }, session.timingOffset || 0, lesson.duration);
    return playRange(range.start, range.end);
  } catch (error) {
    status(error.message, true);
    return Promise.resolve();
  }
}

// Navigation changes position only. A bounded replay is an explicit, separate action.
function seekPosition(time) {
  if (!audioReady || !lesson) return;
  cancelPendingSeek();
  stopAt = null;
  loop.enabled = false;
  follow = true;
  clearHighlights();
  if (!review()) navigationUsed = true;
  audio.currentTime = Math.max(0, Math.min(time, lesson.duration, audio.duration));
  updateLoop();
  renderControls();
  updatePlayback();
}

function showEvidence(q, e, answerOnly = false) {
  if (!guardReview()) return;
  transcriptWindow.showForPlayback();
  for (const node of wordElements.values()) node.classList.remove('is-evidence');
  for (const s of lesson.sentences)
    for (const w of s.words) {
      if (
        e.wordIds?.length
          ? e.wordIds.includes(w.id)
          : Number.isFinite(w.start) && w.start >= e.start && w.start < e.end
      )
        wordElements.get(w.id)?.classList.add('is-evidence');
    }
  follow = true;
  renderControls();
  playSubtitle(
    answerOnly ? e.start : (e.contextStart ?? e.start),
    answerOnly ? e.end : (e.contextEnd ?? e.end),
  );
  status(`第 ${q.number} 题：已标出本题证据，当前播放词会随原音移动。`);
}
async function play() {
  cancelPendingSeek();
  if (!audioReady) {
    status('音频还没准备好，请稍候或重新载入。', true);
    return;
  }
  try {
    await audio.play();
    hasStarted = true;
    if (!review() && attemptStart == null) attemptStart = Date.now();
  } catch {
    status('浏览器暂停了播放。请再按一次播放；若仍失败，重新载入匹配音频。', true);
  }
}
function cancelPendingSeek() {
  pendingSeek?.abort();
  pendingSeek = null;
}
function seekForPlayback(time, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error, ready = false) => {
      clearTimeout(timer);
      audio.removeEventListener('seeked', onSeeked);
      audio.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      error ? reject(error) : resolve(ready);
    };
    const onSeeked = () =>
      finish(
        Math.abs(audio.currentTime - time) > 0.15
          ? new Error('未能定位到片段起点，已暂停。请重新载入原音后再试。')
          : null,
        true,
      );
    const onError = () => finish(new Error('原音定位失败，请重新载入后再试。'));
    const onAbort = () => finish(null, false);
    const timer = setTimeout(() => finish(new Error('片段定位超时，已暂停。请重试。')), 5000);
    audio.addEventListener('seeked', onSeeked);
    audio.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      audio.currentTime = time;
    } catch (error) {
      finish(error);
    }
  });
}
async function playRange(start, end, repeat = false) {
  if (!guardReview() || !audioReady) return;
  cancelPendingSeek();
  const controller = new AbortController();
  pendingSeek = controller;
  try {
    const range = validateLoop(start, end, Math.min(lesson.duration, audio.duration));
    audio.pause();
    follow = true;
    clearHighlights();
    renderControls();
    stopAt = null;
    loop = { ...range, enabled: false };
    updateLoop();
    if (!(await seekForPlayback(range.start, controller.signal)) || controller.signal.aborted) return;
    pendingSeek = null;
    const transcriptBounds = $('transcript').getBoundingClientRect();
    const visibleBottom =
      window.innerHeight - document.querySelector('.player').getBoundingClientRect().height;
    if (!lesson.paper && (transcriptBounds.bottom < 0 || transcriptBounds.top > visibleBottom)) {
      $('transcript').scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    loop.enabled = repeat;
    stopAt = repeat ? null : range.end;
    updateLoop();
    await play();
  } catch (e) {
    if (!controller.signal.aborted) {
      audio.pause();
      status(e.message, true);
    }
  } finally {
    if (pendingSeek === controller) pendingSeek = null;
  }
}
function currentSentence() {
  const time = audio.currentTime - (session?.timingOffset || 0);
  return (
    lesson?.sentences.find((s) => time + 0.001 >= s.start && time < s.end) ||
    lesson?.sentences.findLast((s) => s.start <= time) ||
    lesson?.sentences[0]
  );
}
function updateLoop() {
  $('loop-toggle').setAttribute('aria-pressed', String(loop.enabled));
  $('loop-label').textContent =
    Number.isFinite(loop.start) && Number.isFinite(loop.end)
      ? `${formatTime(loop.start)} – ${formatTime(loop.end)}${loop.enabled ? ' · 循环中' : ''}`
      : Number.isFinite(loop.start)
        ? `A ${formatTime(loop.start)} · 请设置 B`
        : '未设置循环';
}
function updatePlayback() {
  if (!lesson) return;
  let time = audio.currentTime || 0;
  if (review() && loop.enabled && Number.isFinite(loop.end) && time >= loop.end - 0.025) {
    audio.currentTime = loop.start;
    time = loop.start;
  } else if (Number.isFinite(stopAt) && time >= stopAt - 0.025) {
    audio.pause();
    stopAt = null;
  }
  $('time-current').textContent = formatTime(seekPreview ?? time);
  if (seekPreview === null) $('seek').value = time;
  $('mark-moment').disabled = !audioReady || !hasStarted || time <= 0;
  if (!review()) return;
  const subtitleTime = time - (session.timingOffset || 0);
  const word = wordAtTime(lesson, subtitleTime);
  const wordChanged = activeWord !== word?.id;
  if (wordChanged) {
    wordElements.get(activeWord)?.classList.remove('is-playing');
    activeWord = word?.id || null;
    wordElements.get(activeWord)?.classList.add('is-playing');
  }
  const sentence = lesson.sentences.find((s) => subtitleTime >= s.start && subtitleTime < s.end);
  if (activeSentence !== sentence?.id) {
    sentenceElements.get(activeSentence)?.classList.remove('is-current');
    activeSentence = sentence?.id || null;
    const node = sentenceElements.get(activeSentence);
    node?.classList.add('is-current');
    if (follow && node) {
      const target = $('transcript');
      const top = node.getBoundingClientRect().top - target.getBoundingClientRect().top + target.scrollTop;
      target.scrollTo({
        top: Math.max(0, top - 50),
        behavior: 'instant',
      });
    }
  }
  if (follow && wordChanged && word && transcriptWindow.open) {
    const target = $('transcript');
    const bounds = target.getBoundingClientRect();
    const current = wordElements.get(word.id)?.getBoundingClientRect();
    if (current && (current.top < bounds.top || current.bottom > bounds.bottom))
      target.scrollTop += current.top - bounds.top - target.clientHeight / 3;
  }
}
document.querySelector('.transcript-panel').addEventListener('transcript-layout', () => {
  if (follow && review()) {
    clearHighlights();
    updatePlayback();
  }
});
function tick() {
  updatePlayback();
  if (!audio.paused) raf = requestAnimationFrame(tick);
}

audio.addEventListener('loadedmetadata', () => {
  if (!lesson) return;
  const mismatch = Math.abs(audio.duration - lesson.duration) > Math.max(2, lesson.duration * 0.01);
  audioReady = Number.isFinite(audio.duration) && !mismatch;
  if (!audioReady) status('音频时长与练习包不一致，字幕会错位。请载入这份练习包对应的剪辑音频。', true);
  renderControls();
});
audio.addEventListener('error', () => {
  if (audio.getAttribute('src')) {
    audioReady = false;
    renderControls();
    status('音频载入失败。请检查网络并重新载入这份原卷。', true);
  }
});
function syncPlaybackButton() {
  $('play-pause').setAttribute('aria-label', audio.paused ? '播放' : '暂停');
  $('play-pause').innerHTML = audio.paused
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
}
audio.addEventListener('play', () => {
  hasStarted = true;
  renderControls();
  cancelAnimationFrame(raf);
  tick();
});
audio.addEventListener('pause', () => {
  cancelAnimationFrame(raf);
  syncPlaybackButton();
  updatePlayback();
});
audio.addEventListener('timeupdate', updatePlayback);
audio.addEventListener('seeked', updatePlayback);
audio.addEventListener('ended', () => {
  if (review() && loop.enabled) {
    audio.currentTime = loop.start;
    play();
  } else {
    status(review() ? '播放结束。可以选择卡词重听，或开始无字幕复测。' : '播放结束。请完成本轮答案后提交。');
  }
});

$('play-pause').addEventListener('click', () => {
  if (!lesson || !audioReady) return;
  cancelPendingSeek();
  if (audio.paused) {
    if (review()) transcriptWindow.showForPlayback();
    if (audio.ended || audio.currentTime >= Math.min(lesson.duration, audio.duration) - 0.1) {
      stopAt = null;
      audio.currentTime = loop.enabled ? loop.start : 0;
    }
    play();
  } else audio.pause();
});
$('seek').addEventListener('input', () => {
  if (audioReady) {
    seekPreview = Number($('seek').value);
    $('time-current').textContent = formatTime(seekPreview);
  }
});
$('seek').addEventListener('pointerdown', () => {
  if (audioReady) seekGesturePaused = audio.paused;
});
function commitSeek() {
  if (seekPreview === null) {
    seekGesturePaused = null;
    return;
  }
  const destination = seekPreview;
  const wasPaused = seekGesturePaused ?? audio.paused;
  seekPreview = null;
  seekGesturePaused = null;
  seekPosition(destination);
  if (!wasPaused && audio.paused) play();
  else if (wasPaused && !audio.paused) audio.pause();
}
$('seek').addEventListener('change', commitSeek);
$('seek').addEventListener('pointerup', commitSeek);
$('seek').addEventListener('pointercancel', () => {
  seekPreview = null;
  seekGesturePaused = null;
  updatePlayback();
});
$('review-navigation').addEventListener('click', (event) => {
  const link = event.target.closest('[data-review-target]');
  if (!link) return;
  event.preventDefault();
  if (link.dataset.reviewTarget === 'transcript' && $('paper-float-transcript')) {
    if (!transcriptWindow.open) transcriptWindow.toggle();
    $('transcript').focus({ preventScroll: true });
    return;
  }
  $(link.dataset.reviewTarget).scrollIntoView({ block: 'start', behavior: 'instant' });
});
$('playback-rate').addEventListener('change', () => {
  audio.playbackRate = review() ? Number($('playback-rate').value) : 1;
});
for (const [id, step] of [
  ['prev-sentence', -1],
  ['next-sentence', 1],
])
  $(id).addEventListener('click', () => {
    if (!guardReview()) return;
    const current = currentSentence();
    const index = lesson.sentences.indexOf(current);
    const target =
      step < 0 && audio.currentTime - (session.timingOffset || 0) >= current.end ? index : index + step;
    const s = lesson.sentences[Math.max(0, Math.min(lesson.sentences.length - 1, target))];
    seekPosition(s.start + (session.timingOffset || 0));
  });
$('repeat-sentence').addEventListener('click', () => {
  const s = currentSentence();
  if (s) playSubtitle(s.start, s.end);
});
$('play-word').addEventListener('click', () => {
  if (selectedWord) {
    const s = wordsById.get(selectedWord).sentence;
    playSubtitle(s.start, s.end);
  }
});
$('loop-start').addEventListener('click', () => {
  if (!guardReview()) return;
  cancelPendingSeek();
  loop = { start: audio.currentTime, end: null, enabled: false };
  stopAt = null;
  updateLoop();
  status('A 点已设置。播放到结束位置后设 B 点。');
});
$('loop-end').addEventListener('click', () => {
  if (!guardReview()) return;
  cancelPendingSeek();
  try {
    if (!Number.isFinite(loop.start)) throw new Error('请先设置 A 点。');
    const range = validateLoop(loop.start, audio.currentTime, lesson.duration);
    loop = { ...range, enabled: false };
    stopAt = null;
    updateLoop();
    status('B 点已设置，按 AB 循环开始反复听。');
  } catch (e) {
    status(e.message, true);
  }
});
$('loop-toggle').addEventListener('click', () => {
  if (!guardReview()) return;
  cancelPendingSeek();
  try {
    validateLoop(loop.start, loop.end, lesson.duration);
    loop.enabled = !loop.enabled;
    stopAt = null;
    updateLoop();
    if (loop.enabled) {
      audio.currentTime = loop.start;
      play();
    }
  } catch (e) {
    status('先设置 A、B 两点，或点「听原音证据」选好片段。', true);
  }
});
$('mark-moment').addEventListener('click', () => {
  if (!audioReady || !hasStarted || audio.currentTime <= 0) return;
  const time = audio.currentTime;
  if (session.moments.some((m) => Math.abs(m.time - time) < 2)) {
    status('这个位置刚刚记下了，继续听就好。');
    return;
  }
  session.moments.push({ time, phase: session.phase });
  $('player-feedback').hidden = false;
  $('player-feedback').textContent = `已记下 ${formatTime(time)} · 交卷后可回听`;
  touch();
  renderMarks();
  status(`已记下 ${formatTime(time)}，提交后从前几秒回听。`);
});
$('follow-toggle').addEventListener('click', () => {
  follow = !follow;
  clearHighlights();
  renderControls();
  updatePlayback();
});
for (const event of ['wheel', 'touchmove'])
  $('transcript').addEventListener(
    event,
    () => {
      if (follow && review()) {
        follow = false;
        renderControls();
      }
    },
    { passive: true },
  );
$('mark-heard').addEventListener('click', () => setMark('heard'));
$('mark-unknown').addEventListener('click', () => setMark('unknown'));
$('dismiss-word').addEventListener('click', () => {
  const previous = wordElements.get(selectedWord);
  previous?.classList.remove('is-selected');
  selectedWord = null;
  renderInspector();
  previous?.focus({ preventScroll: true });
});
$('clear-mark').addEventListener('click', () => setMark(null));
$('apply-subtitle-offset').addEventListener('click', () => {
  if (!guardReview()) return;
  const sentence = currentSentence(),
    offset = Number($('subtitle-offset').value);
  try {
    shiftedRange(sentence, offset, lesson.duration);
    session.timingOffset = offset;
    touch();
    clearHighlights();
    playSubtitle(sentence.start, sentence.end);
    status('字幕同步已调整，保存本次学习纪录后会保留。');
  } catch (error) {
    status(error.message, true);
  }
});
$('reset-subtitle-offset').addEventListener('click', () => {
  if (!guardReview()) return;
  session.timingOffset = 0;
  touch();
  clearHighlights();
  renderControls();
  updatePlayback();
  status('已还原原始字幕时间。');
});

$('submit-answers').addEventListener('click', () => {
  if (!lesson || review()) return;
  if (!hasStarted) {
    status('先播放原音再作答。如果听不出来，也可以保留空白后提交。');
    return;
  }
  audio.pause();
  const handwritten = lesson.paper && answerMode === 'ink';
  session = submitAnswers(lesson, session, handwritten ? {} : drafts, handwritten ? { ink: inkPages } : {});
  Object.assign(session.attempts.at(-1), {
    elapsedSeconds: attemptStart == null ? 0 : Math.round((Date.now() - attemptStart) / 1000),
    navigationUsed,
    assisted: navigationUsed || (session.attempts.at(-1).phase === 'first' && priorExposure),
    priorExposure: session.attempts.at(-1).phase === 'first' && priorExposure,
  });
  markSeen(exposedLessons, lesson.id);
  touch();
  render();
  status('已提交。现在可点题目证据、点词回听，或设置 AB 循环。未匹配的表达请按参考自行核对。');
});
for (const phase of ['first', 'review', 'retest'])
  $(`phase-${phase}`).addEventListener('click', () => {
    if (!session || session.phase === phase) return;
    if (phase === 'review' && session.phase === 'retest') {
      status('请先提交这轮复测，才能重新显示提示。');
      return;
    }
    try {
      session = switchPhase(session, phase);
      if (phase === 'retest') answerMode = session.attempts.at(-1)?.ink ? 'ink' : 'type';
      resetPlayer();
      audio.currentTime = 0;
      drafts = {};
      inkPages = {};
      paperPage = null;
      hasStarted = false;
      attemptStart = null;
      navigationUsed = false;
      follow = true;
      render();
      status(
        phase === 'retest' ? '字幕和旧答案已收起。准备好后，原速听一遍再作答。' : '现在可看字幕、回听证据。',
      );
    } catch (e) {
      status(e.message, true);
    }
  });

$('lesson-select').replaceChildren(...catalogue.map((x) => new Option(x.title, x.id)));
$('lesson-select').addEventListener('change', (event) => {
  const entry = catalogue.find((x) => x.id === event.target.value);
  if (!entry) return;
  if (hasUnsavedListening() && !confirm('切换练习会清空未保存的本次作答与标记。继续吗？')) {
    event.target.value = lesson?.id || '';
    return;
  }
  chooseLesson(entry);
});

$('save-record').addEventListener('click', () => requestSave());
$('listening-retest').addEventListener('click', () => $('phase-retest').click());
$('listening-finish').addEventListener('click', () => navigateTo('review'));
$('listening-fresh').addEventListener('click', () => {
  const fresh = catalogueWithStatus().filter(
    (entry) =>
      entry.paperPractice &&
      !entry.missingAudio &&
      entry.exposure === 'fresh' &&
      ['A', 'B1'].includes(entry.part) &&
      entry.id !== lesson.id,
  );
  const next = fresh.find((entry) => entry.part === lesson.paper?.part) || fresh[0];
  if (next) navigateTo('listening', { lessonId: next.id });
});
$('export-record').addEventListener('click', () => {
  if (!savedRecord) return;
  const blob = new Blob([JSON.stringify(savedRecord, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a');
  a.href = url;
  a.download = `english30-${lesson.id}-${savedRecord.savedAt.slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  status(
    !hasUnsavedListening() ? '已导出刚才回读验证的学习纪录。' : '已导出上次保存的纪录；后续修改还未保存。',
  );
});
document.addEventListener('keydown', (event) => {
  if (
    document.body.dataset.view !== 'listening' ||
    event.code !== 'Space' ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY', 'A'].includes(event.target.tagName) ||
    event.target.isContentEditable
  )
    return;
  event.preventDefault();
  $('play-pause').click();
});
window.addEventListener('pagehide', () => {
  checkpoint();
  cancelPendingSeek();
  audio.pause();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) checkpoint();
});
window.addEventListener('storage', () => {
  for (const id of seenMaterials()) exposedLessons.add(id);
  if (lesson && !review() && exposureFor(lesson.id) !== 'fresh') {
    priorExposure = true;
    renderControls();
  }
});

function readSavedRecords() {
  try {
    const records = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(records) ? records : [];
  } catch {
    return [];
  }
}
function exposureFor(id) {
  const entry = catalogue.find((x) => x.id === id) || { id };
  return materialExposure(entry, catalogue, [
    ...exposedLessons,
    ...readSavedRecords().map((r) => r.lessonId),
  ]);
}
function catalogueWithStatus() {
  const seen = [...exposedLessons, ...readSavedRecords().map((r) => r.lessonId)];
  return catalogue.map((x) => ({ ...x, exposure: materialExposure(x, catalogue, seen) }));
}
function renderCatalogue() {
  const selected = lesson?.id || $('lesson-select').value;
  $('lesson-select').replaceChildren(
    ...catalogueWithStatus()
      .filter((x) => !x.paperPractice)
      .map(
        (x) =>
          new Option(
            `${x.title} · ${{ fresh: '未练', practised: '已练', overlap: '含已练选段' }[x.exposure]}`,
            x.id,
          ),
      ),
  );
  $('lesson-select').value = selected;
}
function waitForAudio() {
  if (audioReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      audio.removeEventListener('loadedmetadata', ready);
      audio.removeEventListener('error', failed);
      error ? reject(error) : resolve();
    };
    const ready = () => (audioReady ? done() : done(new Error('原音与练习包不匹配。')));
    const failed = () => done(new Error('原音载入失败。'));
    const timer = setTimeout(() => done(new Error('原音尚未准备好，请稍候再试。')), 15000);
    audio.addEventListener('loadedmetadata', ready);
    audio.addEventListener('error', failed);
  });
}
export const listeningBridge = {
  setSaveHandler(fn) {
    requestSave = fn;
  },
  getSaveState() {
    return {
      submitted: !!session?.attempts.length,
      hasDraft: hasAnswerDraft() || !!focusedDrill?.getSaveState().hasDraft,
      label: '听力',
      saved: !!savedRecord && !!session?.attempts.length,
      lessonTitle: lesson?.title || '',
    };
  },
  getSaveSnapshot() {
    if (!session?.attempts.length) return null;
    const record = buildRecord(lesson, session);
    const fingerprint = ({ savedAt, ...content }) => JSON.stringify(content);
    if (savedRecord && fingerprint(savedRecord) === fingerprint(record)) return null;
    const savingSession = session,
      savingRevision = revision;
    return {
      record,
      label: lesson.title,
      acknowledge() {
        if (session === savingSession) {
          savedRecord = record;
          saveRevision = savingRevision;
          queueCheckpoint();
          renderControls();
          renderSaved();
          status(
            revision !== savingRevision
              ? '确认时的纪录已保存并完成回读；保存期间的新修改尚未保存。'
              : '已保存到当前浏览器，并完成回读验证。未提交输入不包含在内。',
          );
        }
        listeningEvents.dispatchEvent(new Event('change'));
      },
    };
  },
  exposePaper({ year, variant, part, task } = {}) {
    const affected = catalogue.filter(
      (e) =>
        e.paperPractice &&
        e.year === Number(year) &&
        e.variant === variant &&
        (!part || e.part === part) &&
        (!task || e.task === Number(task)),
    );
    for (const entry of affected) markSeen(exposedLessons, entry.id);
    if (lesson && exposureFor(lesson.id) !== 'fresh') {
      priorExposure = true;
      if (session?.phase !== 'review') navigationUsed = true;
      renderControls();
      queueCheckpoint();
    }
    listeningEvents.dispatchEvent(new Event('change'));
  },
  setNavigator(fn) {
    navigateTo = fn;
  },
  getListeningState() {
    return {
      lesson: lesson && session ? structuredClone(visibleLesson(lesson, session)) : null,
      session: session ? structuredClone(session) : null,
      savedRecords: readSavedRecords(),
      catalogue: catalogueWithStatus(),
    };
  },
  onChange(fn) {
    listeningEvents.addEventListener('change', fn);
    return () => listeningEvents.removeEventListener('change', fn);
  },
  pauseListening() {
    focusedDrill?.suspend();
    ++playbackRequest;
    cancelPendingSeek();
    audio.pause();
  },
  refreshSaved() {
    if (lesson) {
      renderSaved();
      renderCatalogue();
    }
  },
  async openLesson(lessonId) {
    await listeningReady;
    if (!lessonId) return;
    if (requestedLessonId === lessonId) return activeLessonLoad;
    if (lesson?.id === lessonId) {
      if (requestedLessonId && requestedLessonId !== lessonId) {
        ++loadGeneration;
        audioLoadController?.abort();
        audioLoadController = null;
        requestedLessonId = null;
        if (objectURL) {
          audio.src = objectURL;
          audio.load();
        }
        paperPractice?.setEntry(lessonId);
        status('已回到原材料，当前作答草稿保留。');
      }
      return;
    }
    const entry = catalogue.find((x) => x.id === lessonId);
    if (!entry) throw new Error('这份材料不在 DSE 目录中。');
    if (hasUnsavedListening() && !confirm('切换材料会替换当前未保存的听力草稿，继续吗？')) return false;
    await chooseLesson(entry);
  },
  async showMode(mode) {
    await listeningReady;
    if (mode === 'papers') {
      if (paperCatalogueError) throw paperCatalogueError;
      return await this.openLesson(paperPractice.selected.id);
    } else {
      return await this.openLesson(
        lesson && !lesson.paper ? lesson.id : catalogue.find((x) => !x.paperPractice).id,
      );
    }
  },
  async playListening({ lessonId, start, end, wordId, concealed = false } = {}) {
    await listeningReady;
    const request = ++playbackRequest;
    if (lessonId && lesson?.id !== lessonId) {
      const entry = catalogue.find((x) => x.id === lessonId);
      if (!entry) throw new Error('这条旧纪录对应的材料不在当前 DSE 目录中。');
      if (hasUnsavedListening() && !confirm('切换材料会替换当前未保存的听力草稿。继续回听？'))
        throw new Error('已取消切换，当前草稿仍保留。');
      await chooseLesson(entry);
      if (request !== playbackRequest) return;
      if (lesson?.id !== lessonId) throw new Error('未能载入对应原音。');
    }
    await waitForAudio();
    if (request !== playbackRequest) return;
    if (!review()) {
      if (hasUnsavedListening() && !confirm('回听会结束当前未提交的听力作答，并恢复上次保存的复盘。继续吗？'))
        throw new Error('已取消回听，当前作答仍保留。');
      const record = readSavedRecords().findLast(
        (r) => r.lessonId === lesson?.id && Array.isArray(r.attempts) && r.attempts.length,
      );
      if (
        !record ||
        !record.attempts.every(
          (a) => a.results && lesson.questions.every((q) => typeof a.results[q.id]?.answer === 'string'),
        )
      )
        throw new Error('先完成这份材料的首听并提交，再进入原句复习。');
      resetPlayer();
      session = {
        lessonId: lesson.id,
        phase: 'review',
        attempts: structuredClone(record.attempts),
        marks: structuredClone(record.marks || {}),
        moments: structuredClone(record.moments || []),
        timingOffset: record.timingOffset || 0,
      };
      savedRecord = structuredClone(record);
      saveRevision = revision = 0;
      drafts = {};
      render();
    }
    if (!concealed) await navigateTo('listening', { mode: lesson?.paper ? 'papers' : 'practice' });
    if (wordId && wordsById.has(wordId)) await selectWord(wordId);
    else {
      const sentence = currentSentence();
      const from = Number.isFinite(start) ? start : sentence.start,
        to = Number.isFinite(end) ? end : sentence.end;
      if (concealed) await playSubtitle(from, to);
      else await playRange(from, to);
    }
  },
};

async function initialiseListening() {
  try {
    const response = await fetch('./lesson-catalogue.json');
    if (response.ok) {
      const data = await response.json();
      const entries = Array.isArray(data) ? data : data.lessons;
      if (
        Array.isArray(entries) &&
        entries.length &&
        entries.every(
          (x) =>
            typeof x.id === 'string' &&
            typeof x.title === 'string' &&
            /^\.\/lessons\/[a-zA-Z0-9_-]+\.json$/.test(x.url),
        )
      )
        catalogue = entries;
    }
  } catch {
    /* Keep the known bundled starter if the catalogue is unavailable. */
  }
  try {
    const responses = await Promise.all([
      fetch('./papers/practice-catalogue.json'),
      fetch('./papers/catalogue.json'),
    ]);
    if (responses.some((r) => !r.ok)) throw new Error('原卷精练目录载入失败，请刷新后重试。');
    const [practice, originals] = await Promise.all(responses.map((r) => r.json()));
    const entries = practice.lessons
      .filter((e) => ['A', 'B1'].includes(e.part))
      .map((e) => ({ ...e, paperPractice: true }));
    catalogue.push(...entries.filter((e) => !e.missingAudio));
    // Missing-audio entries remain selectable to explain the source gap without playing another paper.
    catalogue.push(...entries.filter((e) => e.missingAudio));
    paperPractice = mountPaperPractice({
      transcriptWindow,
      entries,
      sources: originals.sources,
      onSelect: (entry) => listeningBridge.openLesson(entry.id),
      onReference: (paper) => listeningBridge.exposePaper({ year: paper.year, variant: paper.variant }),
      onIntegrated: () => navigateTo('integrated', { taskId: 'integrated-2025-b1-t6' }),
      onLibrary: (paper) =>
        navigateTo('library', {
          paper: { year: paper.year, variant: paper.variant, paper: 3, part: paper.part, task: paper.task },
        }),
    });
    if (recoveringPaper) paperPractice.setEntry(recoveringPaper.session.lessonId);
  } catch (error) {
    paperCatalogueError = error;
  }
  $('lesson-select').replaceChildren(
    ...catalogue.filter((x) => !x.paperPractice).map((x) => new Option(x.title, x.id)),
  );
  // Catalogue readiness must not wait for the initial audio download. Otherwise
  // a later user selection can be overwritten when the shell finishes starting.
  chooseLesson(location.hash === '#listening' && paperPractice ? paperPractice.selected : catalogue[0]);
  listeningEvents.dispatchEvent(new Event('change'));
}
fetch('./content/listening-glossary.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((data) => {
    glossary = Array.isArray(data?.entries) ? data.entries : [];
    if (selectedWord) renderInspector();
  })
  .catch(() => {});
const listeningReady = initialiseListening();
