import { confirmAction } from './confirmation.mjs';
import {
  createSession,
  visibleLesson,
  submitAnswers,
  switchPhase,
  wordAtTime,
  validateLesson,
  validateLoop,
  validatePlaybackRange,
  buildRecord,
  shiftedRange,
  materialExposure,
  selfAssessAnswer,
  listeningAttemptKey,
  listeningRecordThrough,
  listeningErrorLabels,
} from './core.mjs';
import { bookFor, loadBooks } from './answer-books.mjs';
import { paperSaveInfo } from './account-render.mjs';
import { activeAccount, scopedKey } from './account-scope.mjs';
import { mountPaperPractice } from './paper-practice.mjs';
import { loadPaperCatalogue } from './paper-catalogue.mjs';
import { inkIcon } from './ink-icons.mjs';
import { taskQuestionPages } from './paper-question-pages.mjs';
import { mountTranscriptWindow } from './transcript-window.mjs';
import { mountFocusedDrill } from './focused-drill.mjs';
import { questionDrillSentence } from './focused-drill-core.mjs';
import { checkpointPaper, readPaperDraft, seenMaterials, markSeen } from './paper-recovery.mjs';
import { RecordingSource, matchesPackagedRecording } from './recording-source.mjs';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const playerMenu = $('loop-more');
const playerMenuSummary = playerMenu.querySelector('summary');
const reviewMarksDialog = $('review-marks-dialog');
const recording = new RecordingSource(audio);
const transcriptWindow = mountTranscriptWindow();
let catalogue = [
  { id: '2025-task1-intro', title: '入门选段 · 第 1–4 题', url: './lessons/2025-task1-intro.json' },
  { id: '2025-task1', title: '完整访谈 · 第 1–13 题', url: './lessons/2025-task1.json' },
];
const storageKey = scopedKey('english30-records-v1');
const listeningEvents = new EventTarget();
let paperPractice,
  paperCatalogueError = null;
let unavailableControls = [];
let requestedLessonId = null;
let activeLessonLoad = null;
let navigateTo = () => {},
  glossary = [];
let focusedDrill;
let cloudBook = null,
  getWorkspace = () => null,
  cloudContinuing = false,
  touchedInk = new Set();
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
  raf = null;
let loop = { start: null, end: null, enabled: false },
  stopAt = null,
  audioReady = false,
  loadGeneration = 0;
let pendingSeek = null,
  failedEntry = null;
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
  if (reviewMarksDialog.open) {
    const feedback = $('review-marks-status');
    feedback.textContent = message;
    feedback.classList.toggle('is-error', error);
  }
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
    touchedInk: [...touchedInk],
    cloudContinuing,
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
  playerMenu.open = false;
  reviewMarksDialog.close();
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

function loadLesson(data) {
  validateLesson(data);
  for (const [node, disabled] of unavailableControls) node.disabled = disabled;
  unavailableControls = [];
  resetPlayer();
  clearHighlights();
  lesson = data;
  cloudBook = data.paper ? getWorkspace(data.paper) : null;
  cloudContinuing = false;
  touchedInk = new Set();
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
  if (cloudBook && !recoveringPaper) {
    const own = cloudBook.originals.filter((p) => p.part === data.paper.part);
    inkPages = Object.fromEntries(
      own.filter((p) => cloudBook.ink[p.key]).map((p) => [p.key, structuredClone(cloudBook.ink[p.key])]),
    );
    if (Object.keys(inkPages).length) {
      answerMode = 'ink';
      priorExposure = true;
    }
  }
  if (data.paper && recoveringPaper?.session.lessonId === data.id) {
    const draft = recoveringPaper;
    session = draft.session;
    drafts = draft.drafts || {};
    inkPages = draft.inkPages;
    touchedInk = new Set(draft.touchedInk || []);
    cloudContinuing = !!draft.cloudContinuing;
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
    if (savedRecord && session.attempts.length) {
      const last = session.attempts.length - 1;
      savedRecord =
        listeningRecordThrough(savedRecord, listeningAttemptKey(session.attempts[last], last)) || savedRecord;
    }
    if (savedRecord && !hasAnswerDraft() && !listeningBridge.getSaveSnapshot()) saveRevision = revision;
  }
  if (data.paper) recoveringPaper = null;
  audioReady = false;
  wordsById = new Map();
  for (const s of lesson.sentences) for (const w of s.words) wordsById.set(w.id, { word: w, sentence: s });
  renderLessonTitle(lesson.title);
  $('lesson-meta').textContent = lesson.paper
    ? `Task ${lesson.paper.task}${lesson.paper.sharedAudio ? ' 使用 Part B 共用原音' : ' 原音分段'}　${formatTime(lesson.duration)}`
    : `第 ${lesson.questions[0].number}–${lesson.questions.at(-1).number} 题 · ${formatTime(lesson.duration)} · 原卷对话节选`;
  paperPractice?.setEntry(data.id);
  $('time-total').textContent = formatTime(lesson.duration);
  $('seek').max = lesson.duration;
  render();
  status('题目已就绪，可以先读题和作答。正在载入原音…');
  if (data.audio) recording.load(data.audio);
}

function chooseLesson(entry) {
  const area = document.querySelector('.study-grid');
  area.inert = true;
  const guarded = performLessonChoice(entry).finally(() => {
    if (activeLessonLoad === guarded) area.inert = !!failedEntry;
  });
  activeLessonLoad = guarded;
  return activeLessonLoad;
}
async function performLessonChoice(entry) {
  cancelAnimationFrame(transcriptFrame);
  finishTranscript = null;
  transcriptWindow.enable(false);
  const generation = ++loadGeneration;
  requestedLessonId = entry.id;
  failedEntry = null;
  $('audio-retry').hidden = true;
  resetPlayer();
  audioReady = false;
  recording.clear();
  if (session) renderControls();
  for (const id of ['play-pause', 'seek', 'mark-moment', 'submit-answers']) $(id).disabled = true;
  if (entry.missingAudio) {
    document.body.dataset.listeningPhase = 'first';
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
    renderLessonTitle(entry.title);
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
    if (data.id !== entry.id) throw new Error('题包与所选 Task 不符，请重试。');
    loadLesson(data);
  } catch (error) {
    if (generation !== loadGeneration) return;
    failedEntry = entry;
    $('audio-retry').textContent = '重试载入题包';
    $('audio-retry').hidden = false;
    status(error.message, true);
    empty($('transcript'), '材料暂未载入', '请检查网络后重新选择原卷。');
  } finally {
    if (generation === loadGeneration) requestedLessonId = null;
  }
}

function render() {
  if (!lesson) return;
  transcriptWindow.enable(review() && !!lesson.paper && !!lesson.sentences.length);
  const submitted = session.attempts.at(-1);
  const submittedInk = submitted?.ink;
  const mode = review() ? (submittedInk ? 'ink' : 'type') : answerMode;
  document.body.dataset.paperAnswer = lesson.paper ? mode : '';
  paperPractice?.renderSources(lesson, session.phase, {
    mode,
    originals: cloudBook?.originals,
    ink: review() ? submitted.reviewInk : inkPages,
    submittedInk: review() ? submittedInk : undefined,
    page: paperPage,
    setMode(next) {
      if (next === answerMode) return;
      answerMode = next;
      if (next === 'ink') loadBooks().catch(() => {});
      touch();
      render();
    },
    setPage(sourceId, page) {
      const previous = paperPage?.questionPage;
      const questionPage =
        sourceId === lesson.paper.questionSourceId ? page : (previous ?? lesson.paper.questionPage);
      paperPage = { sourceId, page, questionPage };
      syncQuestionPage();
      if (previous !== questionPage) {
        $('questions').scrollTop = 0;
        $('original-responses').scrollTop = 0;
      }
      queueCheckpoint();
    },
    changed(key, reviewInk) {
      if (review()) {
        const last = session.attempts.at(-1);
        const updated = { ...last, reviewInk };
        const original = (cloudBook?.originals || bookFor(lesson.paper)?.pages)?.find((p) => p.key === key);
        if (original) updated.sourceVersions = { ...last.sourceVersions, [key]: original.originalHash };
        session.attempts = [...session.attempts.slice(0, -1), updated];
      } else {
        touchedInk.add(key);
        updateSubmission();
      }
      touch();
    },
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
function renderLessonTitle(title) {
  const heading = $('lesson-title');
  const match = /^(\d{4})\s+(.*)$/.exec(title);
  if (!match) {
    heading.textContent = title;
    return;
  }
  heading.replaceChildren(el('span', 'listening-year', match[1]), document.createTextNode(' ' + match[2]));
}

let finishTranscript,
  transcriptFrame = 0;
function renderTranscript() {
  cancelAnimationFrame(transcriptFrame);
  finishTranscript = null;
  clearHighlights();
  wordElements = new Map();
  sentenceElements = new Map();
  const target = $('transcript');
  target.removeAttribute('aria-busy');
  target.replaceChildren();
  $('review-help').hidden = !review();
  if (!review()) {
    const first = session.phase === 'first';
    const guidance = first
      ? '听原音后作答。没听清时，可以在播放器留下时间标记。'
      : '本轮重新作答。首听结果会保留，复测结果单独记录。';
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
    if (lesson.paper) {
      const instructions = el('details', 'listening-paper-instructions');
      instructions.open = Boolean(lesson.paper.questionContainsAnswers);
      instructions.append(el('summary', '', first ? '听前说明' : '复测说明'), el('p', '', guidance), context);
      target.append(instructions);
    } else {
      empty(target, first ? '听前读题' : '无字幕复测', guidance);
      target.append(context);
    }
    return;
  }
  let index = 0;
  const sentences = lesson.sentences;
  const fill = (all = false) => {
    const batch = document.createDocumentFragment();
    let count = 0;
    while (index < sentences.length && (all || count < 80)) {
      const sentence = sentences[index++];
      count += sentence.words.length;
      const row = el('div', 'sentence');
      row.dataset.sentenceId = sentence.id;
      const heading = el('div', 'sentence-meta');
      const sentenceTime = () => sentence.start + (session.timingOffset || 0);
      const time = button(formatTime(sentence.start), () => seekPosition(sentenceTime()), 'sentence-time');
      time.setAttribute('aria-label', `跳到句首 ${formatTime(sentence.start)}`);
      heading.append(time, el('span', 'speaker', sentence.speaker || ''));
      row.addEventListener('click', (event) => {
        if (!event.target.closest('button')) playSubtitle(sentence.start, sentence.end);
      });
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
      batch.append(row);
      sentenceElements.set(sentence.id, row);
    }
    target.append(batch);
    if (index < sentences.length) transcriptFrame = requestAnimationFrame(() => fill());
    else {
      finishTranscript = null;
      target.removeAttribute('aria-busy');
      clearHighlights();
      updatePlayback();
    }
  };
  if (lesson.paper) {
    target.setAttribute('aria-busy', 'true');
    finishTranscript = () => {
      cancelAnimationFrame(transcriptFrame);
      fill(true);
    };
    // Let the submitted result reach the screen before constructing interactive subtitles.
    transcriptFrame = requestAnimationFrame(() => {
      transcriptFrame = requestAnimationFrame(() => fill());
    });
  } else {
    fill(true);
  }
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
    const answered = results.filter((r) => r.answer?.trim());
    const automatic = answered.filter((r) => typeof r.correct === 'boolean' && r.grading !== 'self');
    const matched = automatic.filter((r) => r.correct).length;
    const manual = (last.ink ? results : answered).filter((r) => r.grading === 'self');
    const pending = manual.filter((r) => r.status === 'pending').length;
    const summary = el('div', 'result-summary');
    summary.tabIndex = -1;
    summary.append(
      el(
        'strong',
        '',
        last.ink
          ? `手写交卷 · ${Object.keys(last.ink).length} 页有笔迹`
          : `已答 ${answered.length} 题 · 未答 ${results.length - answered.length} 题`,
      ),
    );
    if (automatic.length)
      summary.append(el('p', '', `已答题中，${matched}/${automatic.length} 题与参考表达匹配。`));
    if (manual.length)
      summary.append(
        el('p', '', `${pending} 题待自核，${manual.length - pending} 题已自核，不计入自动正确率。`),
      );
    if (automatic.some((r) => !r.correct))
      summary.append(el('small', 'fine-print', '未匹配的写法可对照评分参考自核。'));
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
    const label = el('label', 'question-label');
    label.append(
      el('span', 'listening-question-number', `${q.label || q.number}.`),
      document.createTextNode(' ' + q.prompt),
    );
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
      updateSubmission();
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
          !last.ink && !result.answer?.trim()
            ? '本题未作答'
            : result.grading === 'self'
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
        const link = el(
          'a',
          'button-secondary reference-source',
          `${sourcePage.name} · PDF 第 ${q.reference.page} 页`,
        );
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
            const link = el(
              'a',
              'button-secondary reference-source',
              `查看 Data File 第 ${ref.printedPage} 页`,
            );
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
          const link = el('a', 'button-secondary reference-source', `评分参考 · PDF 第 ${ref.page} 页`);
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
      errorReason.append(new Option('选择主要错因', ''));
      for (const [value, label] of listeningErrorLabels) errorReason.append(new Option(label, value));
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
  updateSubmission();
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

function updateSubmission() {
  if (!lesson || !session) return;
  const next = $('continue-question-group'),
    submit = $('submit-answers'),
    note = $('submission-note');
  const pages = taskQuestionPages(lesson);
  const current = pages.findIndex(
    ([page]) => page === (paperPage?.questionPage ?? lesson.paper?.questionPage),
  );
  const nextPage = current >= 0 && pages[current + 1];
  next.hidden = review() || !nextPage;
  submit.hidden = note.hidden = review();
  if (review()) return;
  if (nextPage)
    next.onclick = () => {
      paperPractice.showQuestionPage(nextPage[0]);
      $('question-heading').focus({ preventScroll: true });
      $('question-heading').scrollIntoView({ block: 'start', behavior: 'instant' });
    };
  const ink = lesson.paper && answerMode === 'ink';
  const total = lesson.questions.length;
  const answered = lesson.questions.filter((q) => String(drafts[q.id] || '').trim()).length;
  const remaining = total - answered;
  const label = nextPage ? '提前交整份 Task' : session.phase === 'retest' ? '提交复测答案' : '提交作答';
  const progress = ink
    ? `${Object.keys(inkPages).length} 页有笔迹，请自行核对每题`
    : `已答 ${answered}/${total} 题，${remaining} 题未答`;
  const hint = !hasStarted ? '先播放原音，之后可留空交卷。' : '';
  note.textContent = progress + '。' + hint;
  submit.disabled = !audioReady || !hasStarted;
  submit.classList.toggle('button-primary', !nextPage);
  submit.classList.toggle('button-secondary', !!nextPage);
  if (ink) inkIcon(submit, 'submit', label);
  else {
    submit.classList.remove('ink-icon-control');
    submit.removeAttribute('aria-label');
    submit.textContent = nextPage && !ink ? `${label}（${remaining} 题未答）` : label;
  }
  submit.title = label + '。' + progress;
}

function renderControls() {
  const isReview = review();
  if (document.body.dataset.listeningPhase !== session.phase)
    $('change-paper').setAttribute('aria-expanded', 'false');
  document.body.dataset.listeningPhase = session.phase;
  $('mode-label').textContent = phaseNames[session.phase];
  for (const phase of ['first', 'review', 'retest']) {
    const b = $(`phase-${phase}`);
    b.setAttribute('aria-pressed', String(session.phase === phase));
    b.disabled =
      (phase === 'first' && !!session.attempts.length) || (phase !== 'first' && !session.attempts.length);
  }
  updateSubmission();
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
  $('export-record').disabled = !savedRecord;
  $('follow-toggle').setAttribute('aria-pressed', String(follow));
  $('follow-toggle').textContent = follow ? '正在跟随' : '回到播放位置';
  $('subtitle-adjustment').hidden = !isReview;
  $('follow-toggle').hidden = !isReview;
  $('prev-sentence').hidden = !isReview;
  $('next-sentence').hidden = !isReview;
  $('review-playback-controls').hidden = !isReview;
  $('open-review-marks').disabled = false;
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
  const target = $('saved-records');
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
        async () => {
          if (
            hasUnsavedListening() &&
            !(await confirmAction('恢复学习纪录', '恢复会替换当前尚未保存的练习。', '恢复纪录'))
          )
            return;
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
  if (!wordElements.has(id)) finishTranscript?.();
  wordElements.get(selectedWord)?.classList.remove('is-selected');
  selectedWord = id;
  wordElements.get(id)?.classList.add('is-selected');
  renderInspector();
  const { sentence, word } = wordsById.get(id);
  const start = Number.isFinite(word.start) && word.start < sentence.end ? word.start : sentence.start;
  return playSubtitle(Math.max(sentence.start, start), sentence.end);
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
      button(
        found.word.text,
        () => {
          reviewMarksDialog.close();
          selectWord(id);
        },
        'marked-word',
      ),
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
      button(`${formatTime(moment.time)} · 没听清`, () => {
        reviewMarksDialog.close();
        playRange(start, end);
      }),
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
            reviewMarksDialog.close();
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
async function seekPosition(time, resume = !audio.paused) {
  if (!audioReady || !lesson) return;
  cancelPendingSeek();
  const controller = (pendingSeek = new AbortController());
  stopAt = null;
  loop.enabled = false;
  follow = true;
  clearHighlights();
  if (!review()) navigationUsed = true;
  try {
    await recording.seek(Math.max(0, Math.min(time, lesson.duration, audio.duration)), controller.signal);
    if (controller.signal.aborted) return;
    if (resume && audio.paused) await audio.play();
    if (!resume && !audio.paused) audio.pause();
    updateLoop();
    renderControls();
    updatePlayback();
  } catch (e) {
    if (!controller.signal.aborted) status(e.message, true);
  } finally {
    if (pendingSeek === controller) pendingSeek = null;
  }
}

function showEvidence(q, e, answerOnly = false) {
  if (!guardReview()) return;
  finishTranscript?.();
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
async function playRange(start, end, { repeat = false } = {}) {
  if (!guardReview() || !audioReady) return;
  cancelPendingSeek();
  const controller = new AbortController();
  pendingSeek = controller;
  try {
    const validate = repeat ? validateLoop : validatePlaybackRange;
    const range = validate(start, end, Math.min(lesson.duration, audio.duration));
    audio.pause();
    follow = true;
    clearHighlights();
    renderControls();
    stopAt = null;
    loop = { ...range, enabled: false };
    updateLoop();
    await recording.seek(range.start, controller.signal);
    if (controller.signal.aborted) return;
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
  } else if (stopAt != null && time >= stopAt - 0.025) {
    stopAt = null;
    audio.pause();
  }
  const shownTime = formatTime(seekPreview ?? time);
  if ($('time-current').textContent !== shownTime) $('time-current').textContent = shownTime;
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

let mediaVerification;
function assessMetadata() {
  if (!lesson || !audio.getAttribute('src') || (requestedLessonId && requestedLessonId !== lesson.id)) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  const signal = recording.controller.signal;
  const mismatch = Math.abs(audio.duration - lesson.duration) > Math.max(2, lesson.duration * 0.01);
  const previous = mediaVerification;
  if (
    previous?.signal === signal &&
    (previous.duration === audio.duration || (previous.accepted && !mismatch))
  )
    return;
  const state = (mediaVerification = { signal, duration: audio.duration });
  const finish = (valid, message) => {
    if (signal.aborted || state !== mediaVerification || audio.error) return;
    state.accepted = audioReady = valid;
    $('audio-retry').hidden = valid;
    $('audio-retry').textContent = '重试载入原音';
    status(message, !valid);
    renderControls();
    audio.dispatchEvent(new Event('audio-readiness'));
  };
  if (!mismatch) {
    finish(
      true,
      review() ? '原音已就绪，可以核对本轮作答并回听证据。' : '原音已就绪，可以播放。交卷前隐藏字幕与答案。',
    );
    return;
  }
  audioReady = false;
  renderControls();
  status('浏览器读出的时长与题包有差异，正在核对原音文件。可以继续作答。');
  matchesPackagedRecording(lesson.audio, lesson.duration, signal)
    .then((valid) =>
      finish(
        valid,
        valid
          ? '已核对原音文件，可以播放。此浏览器显示的录音时长与原卷略有差异。'
          : '音频时长与练习包不一致，未能确认是对应原音。请重新载入。',
      ),
    )
    .catch(() => finish(false, '暂时无法核对原音，请检查网络后重试。'));
}
audio.addEventListener('loadedmetadata', assessMetadata);
audio.addEventListener('durationchange', assessMetadata);
audio.addEventListener('canplay', assessMetadata);
audio.addEventListener('error', () => {
  if (audio.getAttribute('src')) {
    audioReady = false;
    $('audio-retry').textContent = '重试载入原音';
    $('audio-retry').hidden = false;
    renderControls();
    status('音频载入失败。请检查网络并重新载入这份原卷。', true);
  }
});
$('audio-retry').onclick = () => {
  if (failedEntry) return chooseLesson(failedEntry);
  if (!lesson?.audio) return;
  cancelPendingSeek();
  $('audio-retry').hidden = true;
  status('正在重新载入原音，已填答案保留。');
  recording.load(lesson.audio);
};
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
  seekPosition(destination, !wasPaused);
}
$('seek').addEventListener('change', commitSeek);
$('seek').addEventListener('pointerup', commitSeek);
$('seek').addEventListener('pointercancel', () => {
  seekPreview = null;
  seekGesturePaused = null;
  updatePlayback();
});
$('review-navigation').addEventListener('click', (event) => {
  const control = event.target.closest('button[data-review-target]');
  if (!control) return;
  const target = control.dataset.reviewTarget;
  if (target === 'transcript' && !$('paper-float-transcript').hidden) {
    if (!transcriptWindow.open) $('paper-float-transcript').click();
    $('transcript').focus({ preventScroll: true });
    return;
  }
  $(target).scrollIntoView({ block: 'start', behavior: 'instant' });
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

$('submit-answers').addEventListener('click', async () => {
  if (!lesson || review()) return;
  if (!hasStarted) {
    status('先播放原音再作答。如果听不出来，也可以保留空白后提交。');
    return;
  }
  const handwritten = lesson.paper && answerMode === 'ink';
  const remaining = lesson.questions.filter((q) => !String(drafts[q.id] || '').trim()).length;
  if (
    taskQuestionPages(lesson).length > 1 &&
    (handwritten ? !$('continue-question-group').hidden : remaining > 0)
  ) {
    const progress = handwritten
      ? `本轮有 ${Object.keys(inkPages).length} 页笔迹，请确认各组已写完。`
      : `整份 Task 共 ${lesson.questions.length} 题，还有 ${remaining} 题未答。`;
    const currentSession = session;
    const accepted = await confirmAction(
      '交整份 Task？',
      progress + '交卷后会显示答案并结束本轮独立作答。',
      '确认交卷',
    );
    if (!accepted || currentSession !== session || review()) return;
  }
  audio.pause();
  session = submitAnswers(lesson, session, handwritten ? {} : drafts, handwritten ? { ink: inkPages } : {});
  const attempt = session.attempts.at(-1);
  if (lesson.paper) {
    const originals = cloudBook?.originals || bookFor(lesson.paper)?.pages || [];
    const written = Object.keys(attempt.ink || {});
    const continued = cloudContinuing && cloudBook?.records[lesson.id]?.attempts.at(-1);
    if (continued?.reviewInk) attempt.reviewInk = structuredClone(continued.reviewInk);
    attempt.sourceVersions = Object.fromEntries(
      originals
        .filter((p) => written.includes(p.key) || attempt.reviewInk?.[p.key])
        .map((p) => [p.key, p.originalHash]),
    );
    if (continued?.phase === 'retest') attempt.phase = 'retest';
  }
  Object.assign(attempt, {
    startedAt: new Date(attemptStart ?? Date.now()).toISOString(),
    elapsedSeconds: attemptStart == null ? 0 : Math.round((Date.now() - attemptStart) / 1000),
    navigationUsed,
    assisted: navigationUsed || (session.attempts.at(-1).phase === 'first' && priorExposure),
    priorExposure: session.attempts.at(-1).phase === 'first' && priorExposure,
  });
  markSeen(exposedLessons, lesson.id);
  touch();
  render();
  status('已提交。先核对这一轮，再听原音证据或关提示复测。');
  const result = $('questions').querySelector('.result-summary');
  result?.focus({ preventScroll: true });
  result?.scrollIntoView({ block: 'center', behavior: 'instant' });
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
      if (phase === 'retest') {
        cloudContinuing = false;
        touchedInk.clear();
        cloudBook = null;
      }
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
$('lesson-select').addEventListener('change', async (event) => {
  const entry = catalogue.find((x) => x.id === event.target.value);
  if (!entry) return;
  if (
    hasUnsavedListening() &&
    !(await confirmAction('切换练习', '切换练习会清空未保存的本次作答与标记。', '切换练习'))
  ) {
    event.target.value = lesson?.id || '';
    return;
  }
  chooseLesson(entry);
});

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
$('open-review-marks').addEventListener('click', () => {
  playerMenu.open = false;
  $('review-marks-status').textContent = '';
  reviewMarksDialog.showModal();
});
reviewMarksDialog.addEventListener('close', () => playerMenuSummary.focus());
reviewMarksDialog.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') event.stopPropagation();
});
document.addEventListener('pointerdown', (event) => {
  if (playerMenu.open && !playerMenu.closest('.player').contains(event.target)) playerMenu.open = false;
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
  if (event.key === 'Escape' && playerMenu.open) {
    event.preventDefault();
    playerMenu.open = false;
    playerMenuSummary.focus();
    return;
  }
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
  if (
    audio.error ||
    (mediaVerification?.signal === recording.controller?.signal && mediaVerification.accepted === false)
  )
    return Promise.reject(new Error('原音尚未通过核对，请重试载入。'));
  return new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      audio.removeEventListener('audio-readiness', ready);
      audio.removeEventListener('error', failed);
      error ? reject(error) : resolve();
    };
    const ready = () => (audioReady ? done() : done(new Error('原音与练习包不匹配。')));
    const failed = () => done(new Error('原音载入失败。'));
    const timer = setTimeout(() => done(new Error('原音尚未准备好，请稍候再试。')), 15000);
    audio.addEventListener('audio-readiness', ready);
    audio.addEventListener('error', failed);
  });
}
export const listeningBridge = {
  prepareCatalogue,
  setWorkspaceReader(fn) {
    getWorkspace = fn;
  },
  async continuePaper(manifest, choice) {
    await prepareCatalogue();
    if (
      hasUnsavedListening() &&
      !(await confirmAction('打开这份答卷？', '打开这份答卷会替换当前听力草稿。', '打开答卷'))
    )
      return false;
    const entry = catalogue.find((e) => e.id === choice.lessonId);
    if (!entry) throw Error('找不到这一版答卷的练习材料。');
    await chooseLesson(entry);
    if (lesson?.id !== entry.id) throw Error('未能打开这一份原卷。');
    cloudBook = manifest;
    cloudContinuing = true;
    touchedInk = new Set();
    const record = manifest.records[choice.lessonId],
      attempt = record?.attempts.at(-1);
    session = createSession(lesson);
    session.marks = structuredClone(record?.marks || {});
    session.moments = structuredClone(record?.moments || []);
    session.timingOffset = record?.timingOffset || 0;
    drafts = Object.fromEntries(
      Object.entries(attempt?.results || {}).map(([id, result]) => [
        id,
        attempt.rawAnswers?.[id] ?? result.answer ?? '',
      ]),
    );
    const own = manifest.originals.filter((p) => p.part === lesson.paper.part);
    inkPages = Object.fromEntries(
      own.filter((p) => manifest.ink[p.key]).map((p) => [p.key, structuredClone(manifest.ink[p.key])]),
    );
    answerMode = attempt ? (attempt.ink ? 'ink' : 'type') : Object.keys(inkPages).length ? 'ink' : 'type';
    priorExposure = !!record || exposureFor(entry.id) !== 'fresh';
    hasStarted = !!record;
    attemptStart = null;
    revision = 0;
    saveRevision = null;
    savedRecord = null;
    const initial = lesson.paper.questionPage;
    paperPage = { sourceId: lesson.paper.questionSourceId, page: initial, questionPage: initial };
    render();
    checkpoint();
    status(record ? '已打开保存版本，修改后提交可保存为新版。' : '已打开同册的新 Task，播放原音后作答。');
    return true;
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
    const fingerprint = (snapshot) =>
      JSON.stringify([
        snapshot.lessonId,
        snapshot.attempts,
        snapshot.marks || {},
        snapshot.moments || [],
        snapshot.timingOffset || 0,
      ]);
    if (savedRecord && fingerprint(savedRecord) === fingerprint(record)) return null;
    const savingSession = session,
      savingRevision = revision;
    return {
      record,
      label: lesson.title,
      paperInfo: activeAccount ? paperSaveInfo(lesson) : null,
      touched: [...touchedInk],
      continuing: cloudContinuing,
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
    if (!paperPractice && !paperCatalogueError) {
      void prepareCatalogue().then(() => {
        if (paperPractice) this.exposePaper({ year, variant, part, task });
      });
      return;
    }
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
    playerMenu.open = false;
    reviewMarksDialog.close();
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
    await prepareCatalogue();
    if (!lessonId) return;
    if (requestedLessonId === lessonId) return activeLessonLoad;
    if (lesson?.id === lessonId) {
      if ((requestedLessonId && requestedLessonId !== lessonId) || failedEntry) {
        ++loadGeneration;
        failedEntry = null;
        activeLessonLoad = null;
        requestedLessonId = null;
        $('audio-retry').hidden = true;
        document.querySelector('.study-grid').inert = false;
        if (lesson.audio) recording.load(lesson.audio);
        paperPractice?.setEntry(lessonId);
        status('已回到原材料，当前作答草稿保留。');
      }
      return;
    }
    const entry = catalogue.find((x) => x.id === lessonId);
    if (!entry) throw new Error('这份材料不在 DSE 目录中。');
    if (
      hasUnsavedListening() &&
      !(await confirmAction('切换听力材料？', '切换材料会替换当前未保存的听力草稿。', '切换材料'))
    )
      return false;
    await chooseLesson(entry);
  },
  async showMode(mode) {
    await prepareCatalogue();
    if (mode === 'papers') {
      if (paperCatalogueError) throw paperCatalogueError;
      return await this.openLesson(paperPractice.selected.id);
    } else {
      return await this.openLesson(
        lesson && !lesson.paper ? lesson.id : catalogue.find((x) => !x.paperPractice).id,
      );
    }
  },
  async openSavedListening({ lessonId, attemptKey, questionId, retest = false }) {
    await prepareCatalogue();
    let record;
    for (const candidate of readSavedRecords().reverse()) {
      if (candidate.lessonId !== lessonId) continue;
      record = listeningRecordThrough(candidate, attemptKey);
      if (record) break;
    }
    if (!record) throw new Error('在当前浏览器找不到这轮已保存的听力作答。');
    if (
      lesson?.id === lessonId &&
      hasUnsavedListening() &&
      !(await confirmAction('恢复已保存的轮次？', '打开已保存的轮次会替换当前未保存的听力练习。', '恢复轮次'))
    )
      return false;
    const loadRequest = playbackRequest;
    if (
      (await this.openLesson(lessonId)) === false ||
      loadRequest !== playbackRequest ||
      lesson?.id !== lessonId
    )
      return false;
    const last = record.attempts.at(-1);
    if (!lesson.questions.every((q) => last.results?.[q.id]))
      throw new Error('这轮旧纪录的题号与当前材料不一致，无法在原卷上还原。');
    const question = questionId && lesson.questions.find((q) => q.id === questionId);
    if (questionId && !question) throw new Error('这道旧题不在当前材料中。');
    const opening = navigateTo('listening', { lessonId });
    const request = playbackRequest;
    await opening;
    if (request !== playbackRequest || document.body.dataset.view !== 'listening' || lesson?.id !== lessonId)
      return false;
    resetPlayer();
    audio.currentTime = 0;
    savedRecord = record;
    session = {
      lessonId,
      phase: retest ? 'retest' : 'review',
      attempts: structuredClone(record.attempts),
      marks: structuredClone(record.marks || {}),
      moments: structuredClone(record.moments || []),
      timingOffset: record.timingOffset || 0,
    };
    cloudContinuing = false;
    cloudBook = null;
    touchedInk.clear();
    drafts = {};
    inkPages = {};
    answerMode = last.ink ? 'ink' : 'type';
    hasStarted = false;
    attemptStart = null;
    navigationUsed = false;
    follow = true;
    priorExposure = true;
    saveRevision = revision = 0;
    paperPage = null;
    if (lesson.paper && question) {
      const range = taskQuestionPages(lesson).find(
        ([, first, end]) => question.number >= first && question.number <= end,
      );
      const page = range?.[0] || lesson.paper.questionPage;
      paperPage = { sourceId: lesson.paper.questionSourceId, page, questionPage: page };
    }
    render();
    status(retest ? '本轮是无提示复测。播放原音后重新作答。' : '已打开本轮保存的原题与作答。');
    if (!question) return true;
    const card = Array.from($('questions').querySelectorAll('[data-question-id]')).find(
      (el) => el.dataset.questionId === questionId,
    );
    if (card) {
      card.tabIndex = -1;
      (retest ? card.querySelector('.question-input') || card : card).focus();
    }
    if (!retest && question.evidence?.length) {
      await waitForAudio();
      if (request === playbackRequest && review() && lesson.id === lessonId)
        showEvidence(question, question.evidence[0]);
    }
    return true;
  },
  async playListening({ lessonId, start, end, wordId, concealed = false } = {}) {
    await prepareCatalogue();
    const request = ++playbackRequest;
    if (lessonId && lesson?.id !== lessonId) {
      const entry = catalogue.find((x) => x.id === lessonId);
      if (!entry) throw new Error('这条旧纪录对应的材料不在当前 DSE 目录中。');
      if (
        hasUnsavedListening() &&
        !(await confirmAction('切换材料并回听？', '切换材料会替换当前未保存的听力草稿。', '切换并回听'))
      )
        throw new Error('已取消切换，当前草稿仍保留。');
      await chooseLesson(entry);
      if (request !== playbackRequest) return;
      if (lesson?.id !== lessonId) throw new Error('未能载入对应原音。');
    }
    await waitForAudio();
    if (request !== playbackRequest) return;
    if (!review()) {
      if (
        hasUnsavedListening() &&
        !(await confirmAction(
          '回听已保存的作答？',
          '回听会结束当前未提交的听力作答，并恢复上次保存的复盘。',
          '继续回听',
        ))
      )
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
    const [practice, originals] = await Promise.all([
      fetch('./papers/practice-catalogue.json').then((response) => {
        if (!response.ok) throw Error('原卷精练目录载入失败，请重试。');
        return response.json();
      }),
      loadPaperCatalogue(),
    ]);
    const entries = practice.lessons
      .filter((e) => ['A', 'B1'].includes(e.part))
      .map((e) => ({ ...e, paperPractice: true }));
    catalogue.push(...entries.filter((e) => !e.missingAudio));
    // Missing-audio entries remain selectable to explain the source gap without playing another paper.
    catalogue.push(...entries.filter((e) => e.missingAudio));
    paperPractice = mountPaperPractice({
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
  listeningEvents.dispatchEvent(new Event('change'));
}
let catalogueRequest;
function prepareCatalogue() {
  if (paperCatalogueError) {
    catalogueRequest = null;
    paperCatalogueError = null;
  }
  if (!catalogueRequest) {
    catalogueRequest = initialiseListening();
    fetch('./content/listening-glossary.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        glossary = Array.isArray(data?.entries) ? data.entries : [];
        if (selectedWord) renderInspector();
      })
      .catch(() => {});
  }
  return catalogueRequest;
}
