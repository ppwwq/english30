import { confirmAction } from './confirmation.mjs';
import {
  studyStore,
  compareSentence,
  planForDay,
  dateKey,
  summariseRecords,
  isTargetedStructureAttempt,
  listeningAttempts,
  listeningQuestionReviews,
  validateStudyState,
} from './training-core.mjs';
import { listeningErrorLabels } from './core.mjs';

const create = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};
const action = (text, fn, className = 'button-quiet') => {
  const b = create('button', className, text);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
};
const field = (
  label,
  value,
  change,
  { id, rows = 3, maxLength = 4000, type = 'textarea', placeholder = '' } = {},
) => {
  const wrap = create('label', 'training-field');
  wrap.append(create('span', '', label));
  const input = create(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type;
  if (id) input.id = id;
  input.value = value || '';
  input.maxLength = maxLength;
  input.rows = rows;
  input.placeholder = placeholder;
  input.addEventListener('input', () => change(input.value));
  wrap.append(input);
  return wrap;
};
const countWords = (text) => (String(text).match(/[A-Za-z]+(?:['’][A-Za-z]+)?|\d+/g) || []).length;
const dayAfter = (date, n) =>
  new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const moduleLabel = {
  listening: '听力',
  writing: '写句',
  dictation: '听写',
  reading: '阅读',
  integrated: 'B1 综合',
};
const phaseLabel = { first: '独立首答', review: '辅助练习', retest: '同题复测' };

export async function mountTraining({ host, bridge }) {
  let content = { exercises: [], paragraphs: [] },
    loadError = '',
    view = 'today',
    mode = 'sentence',
    message = '',
    messageError = false;
  let selectedDate = dateKey(),
    exerciseId = 'opportunities',
    sentencePhase = 'first',
    step = 0,
    answers = ['', '', '', ''],
    attempted = false,
    revealed = false,
    hinted = false,
    manualAccepted = false,
    result = null,
    checks = {};
  let dictationId = '',
    dictationAnswer = '',
    dictationResult = null,
    dictationRevealed = false,
    dictationMode = 'first';
  let paragraphId = 'club-advice',
    paragraphDraft = '',
    paragraphRevision = '',
    paragraphSubmitted = false,
    paragraphPhase = 'first',
    paragraphChecks = {},
    paperId = '2025-p2-a-q1',
    paperPrompt = '',
    paperSource = '',
    paperAudience = '',
    paperPurpose = '',
    paragraphStarted = Date.now();
  let reviewFilter = 'all',
    reviewType = 'all';
  const reviewLessons = new Map(),
    requestedReviewLessons = new Set();
  const writingWorkspaces = new Map();
  let sentenceCaptured = [null, null, null, null],
    dictationCaptured = null,
    paragraphCaptured = null;
  const sentenceWork = (index) =>
    JSON.stringify({ answer: answers[index], checks: index === 3 ? checks : {} });
  const paragraphWork = () =>
    JSON.stringify({
      draft: paragraphDraft,
      revision: paragraphRevision,
      checks: paragraphChecks,
      ...(mode === 'paper2'
        ? { prompt: paperPrompt, source: paperSource, audience: paperAudience, purpose: paperPurpose }
        : {}),
    });
  function captureWork() {
    if (mode === 'sentence') sentenceCaptured[step] = sentenceWork(step);
    else if (mode === 'dictation') dictationCaptured = dictationAnswer;
    else paragraphCaptured = paragraphWork();
    bridge.onSessionChange?.();
  }
  function getSaveState() {
    const items = answers.map((answer, index) => ({
      hasDraft: !!answer.trim(),
      work: sentenceWork(index),
      captured: sentenceCaptured[index],
    }));
    items.push({ hasDraft: !!dictationAnswer.trim(), work: dictationAnswer, captured: dictationCaptured });
    for (const kind of ['paragraph', 'paper2']) {
      const workspace =
        mode === kind
          ? {
              draft: paragraphDraft,
              revision: paragraphRevision,
              work: paragraphWork(),
              captured: paragraphCaptured,
            }
          : writingWorkspaces.get(kind);
      if (workspace)
        items.push({
          hasDraft: !!(workspace.draft?.trim() || workspace.revision?.trim()),
          work: workspace.work,
          captured: workspace.captured,
        });
    }
    return {
      label: '写句与听写',
      submitted: items.some((item) => item.captured !== null && item.captured !== undefined),
      hasDraft: items.some((item) => item.hasDraft),
      hasUnsubmittedChanges: items.some(
        (item) => (item.hasDraft || item.captured != null) && item.work !== item.captured,
      ),
    };
  }
  host.addEventListener('input', () => bridge.onSessionChange?.());
  host.addEventListener('change', () => bridge.onSessionChange?.());
  function setMode(next) {
    if (next === mode) return;
    if (mode === 'paragraph' || mode === 'paper2')
      writingWorkspaces.set(mode, {
        draft: paragraphDraft,
        revision: paragraphRevision,
        submitted: paragraphSubmitted,
        phase: paragraphPhase,
        checks: paragraphChecks,
        started: paragraphStarted,
        captured: paragraphCaptured,
        work: paragraphWork(),
      });
    mode = next;
    if (next === 'paragraph' || next === 'paper2') {
      const workspace = writingWorkspaces.get(next);
      paragraphDraft = workspace?.draft || '';
      paragraphRevision = workspace?.revision || '';
      paragraphSubmitted = workspace?.submitted || false;
      paragraphPhase = workspace?.phase || 'first';
      paragraphCaptured = workspace?.captured ?? null;
      paragraphChecks = workspace?.checks || {};
      paragraphStarted = workspace?.started || Date.now();
    }
  }
  const notice = (text, error = false) => {
    message = text;
    messageError = error;
    renderNotice();
  };
  const listening = () =>
    bridge.getListeningState?.() || { lesson: null, session: null, savedRecords: [], catalogue: [] };
  const allExercises = () => [...content.exercises, ...studyStore.getState().personalExercises];
  const exercise = () => allExercises().find((e) => e.id === exerciseId) || allExercises()[0];
  const refresh = () => render();
  studyStore.subscribe(refresh);
  bridge.onChange?.(() => {
    if (view === 'today' || view === 'review') render();
  });
  try {
    const response = await fetch('./content/writing.json');
    if (!response.ok) throw new Error('写句材料暂未载入。');
    content = await response.json();
    const initialPaper = content.paper2?.find((p) => p.id === paperId);
    if (initialPaper) {
      paperPrompt = initialPaper.prompt;
      paperSource = initialPaper.source;
    }
  } catch (e) {
    loadError = e.message;
  }

  function renderNotice() {
    const n = host.querySelector('#training-status');
    if (n) {
      n.textContent = message;
      n.classList.toggle('is-error', messageError);
    }
  }
  function navigate(next, options) {
    bridge.pauseListening?.();
    bridge.navigate(next, options);
  }
  function resetExercise(id, phase = 'first') {
    exerciseId = id;
    sentencePhase = phase;
    step = 0;
    answers = ['', '', '', ''];
    sentenceCaptured = [null, null, null, null];
    attempted = false;
    revealed = false;
    hinted = false;
    manualAccepted = false;
    dictationRevealed = false;
    result = null;
    checks = {};
    render();
  }
  async function save() {
    if (bridge.requestSave) return bridge.requestSave();
    if (!studyStore.hasUnsaved()) {
      notice('当前学习纪录已经保存。');
      return;
    }
    try {
      const snapshot = studyStore.prepareSave();
      const count = snapshot.state.records.length - studyStore.getSavedState().records.length;
      const summary = `${count} 条新增练习，以及当前原卷标记、错句、复习结果和训练安排。\n仅写入当前浏览器，包含阅读等模块已提交但未保存的记录。保存后会回读验证。`;
      if (!(await confirmAction('保存本次学习纪录', summary, '确认保存'))) return;
      studyStore.save(snapshot);
      notice('学习纪录已写入当前浏览器，并回读验证成功。');
    } catch (e) {
      notice(`保存未完成：${e.message}`, true);
    }
  }
  function render() {
    host.replaceChildren();
    host.classList.add('training-host');
    const status = create('p', 'status training-status', message);
    status.id = 'training-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.classList.toggle('is-error', messageError);
    host.append(status);
    if (studyStore.loadError)
      host.append(
        create('p', 'training-warning', `已有学习数据未能读取：${studyStore.loadError}。请保留已有备份。`),
      );
    if (loadError)
      host.append(create('p', 'training-warning', loadError + ' 可重新打开页面，个人记录仍可查看。'));
    if (view === 'today') renderToday();
    else if (view === 'review') renderReview();
    else renderWriting();
    if (!bridge.requestSave) {
      const toolbar = create('div', 'training-savebar');
      const unsaved = studyStore.hasUnsaved();
      const saveButton = action('保存本次学习纪录', save, 'button-secondary');
      saveButton.id = 'training-save';
      saveButton.disabled = !unsaved;
      toolbar.append(
        create('p', 'fine-print', unsaved ? '本次修改尚未保存。' : '学习记录只在你明确保存后保留。'),
        saveButton,
      );
      host.append(toolbar);
    }
    bridge.onSessionChange?.();
  }
  function heading(title, description) {
    const h = create('header', 'training-heading');
    h.append(create('h1', '', title), create('p', '', description));
    host.append(h);
  }
  function finishActions(container) {
    const end = create('div', 'training-finish');
    end.append(
      create('p', '', '已提交的作答会出现在复习卡。请用页面上方的「保存本次学习纪录」保留本次记录。'),
      action('结束本次', () => navigate('review'), 'button-secondary'),
    );
    container.append(end);
  }
  function renderToday() {
    const state = studyStore.getState(),
      plan = planForDay(state.settings.startDate, selectedDate, state.settings.minutes);
    heading(
      '今日训练',
      `${plan.finished ? '本轮 30 天已结束，可调整开始日期开启下一轮。' : `第 ${plan.day} 天 · ${plan.focus}`} 听力优先，少量新材料加旧卡点复测。`,
    );
    const settings = create('details', 'training-settings');
    settings.append(create('summary', '', '调整训练安排'));
    let start = state.settings.startDate,
      minutes = state.settings.minutes;
    const settingsBody = create('div', 'training-settings-body');
    settingsBody.append(
      field('开始日期', start, (v) => (start = v), { type: 'date', id: 'training-start-date' }),
    );
    const minutesLabel = create('label', 'training-field');
    minutesLabel.append(create('span', '', '每天可用时间'));
    const select = create('select');
    select.id = 'training-budget';
    select.append(new Option('60 分钟', 60), new Option('30 分钟', 30));
    select.value = minutes;
    select.addEventListener('change', () => (minutes = Number(select.value)));
    minutesLabel.append(select);
    settingsBody.append(
      minutesLabel,
      action(
        '应用安排',
        () => {
          try {
            studyStore.setSettings({ startDate: start, minutes });
            notice('安排已应用；点保存本次学习纪录后保留到下次。');
          } catch (e) {
            notice(e.message, true);
          }
        },
        'button-secondary',
      ),
    );
    settings.append(settingsBody);
    const materials = listening().catalogue || [];
    const freshMaterial = materials.find(
      (item) => item.paperPractice && !item.missingAudio && item.exposure === 'fresh',
    );
    const listeningSuggestion = freshMaterial
      ? `建议新材料：${freshMaterial.title}。`
      : materials.length
        ? '现有材料都已有练习或重叠内容；今天可以选择一份原卷复测。'
        : '';
    const tasks = create('ol', 'training-agenda');
    const task = (title, time, detail, button, fn) => {
      if (!time) return;
      const li = create('li');
      const number = create('span', 'training-minutes', String(time));
      number.append(create('small', '', ' 分钟'));
      const text = create('div');
      text.append(create('h2', '', title), create('p', '', detail));
      li.append(number, text, action(button, fn, 'button-primary'));
      tasks.append(li);
    };
    task(
      '一段原音，听清关键信息',
      plan.minutes.listening,
      listeningSuggestion +
        (plan.day <= 7
          ? '先用约 60–90 秒新原音；做题后精听，选 3 个最影响理解的词块。'
          : plan.b1
            ? '今天可做 B1：将录音笔记与 Data File 信息合并。'
            : '按无字幕表现逐步连听 2–3 分钟，保留新材料作迁移检查。'),
      plan.b1 ? '进入 B1 综合' : '开始听力',
      () =>
        navigate(
          plan.b1 ? 'integrated' : 'listening',
          plan.b1 ? undefined : freshMaterial ? { lessonId: freshMaterial.id } : undefined,
        ),
    );
    task(
      '阅读：先选证据，再对照',
      plan.minutes.reading,
      '先独立答题并圈最短充分依据；提交后才看原文改写和解释。',
      '开始阅读',
      () => navigate('reading'),
    );
    task(
      plan.writingDay && state.settings.minutes === 60 ? '写一段完整表达' : '修一组自己的错句',
      plan.minutes.writing,
      plan.writingDay
        ? '80–120 词初稿 → 自查 → 改稿。写作替换当天练句，不额外叠加。'
        : '找错、跟打、遮文写句，再换人物或情境独立写。',
      '开始写作',
      () => {
        setMode(plan.writingDay ? 'paragraph' : 'sentence');
        navigate('writing');
        render();
      },
    );
    const due = reviewItems().filter((i) => i.dueDate <= dateKey());
    task(
      '复测旧卡点',
      plan.minutes.review,
      due.length
        ? `${due.length} 个项目已到复习日。先回忆，再回原音或原题。`
        : '暂无到期项目。可复测已保存的卡词、时间标记和错句。',
      '查看复习',
      () => navigate('review'),
    );
    const calendar = create('section', 'training-calendar');
    calendar.append(
      create('h2', '', '30 天安排'),
      create(
        'p',
        'fine-print',
        '选一天查看重点。日历中的“已保存”只表示该日有学习纪录，不代表整天训练已完成。',
      ),
    );
    const days = create('div', 'training-day-grid');
    const learned = new Set(studyStore.getSavedState().records.map((r) => dateKey(new Date(r.createdAt))));
    for (const r of listening().savedRecords || []) if (r.savedAt) learned.add(dateKey(new Date(r.savedAt)));
    for (let d = 0; d < 30; d++) {
      const date = dayAfter(state.settings.startDate, d);
      const b = action(
        `第 ${d + 1} 天`,
        () => {
          selectedDate = date;
          render();
          host.querySelector('.training-day[aria-pressed="true"]')?.focus({ preventScroll: true });
        },
        'training-day',
      );
      b.setAttribute('aria-pressed', String(date === selectedDate));
      b.title = `${date}${learned.has(date) ? ' · 有已保存纪录' : ''}`;
      if (learned.has(date)) b.append(create('small', '', '已保存'));
      days.append(b);
    }
    calendar.append(days);
    const schedule = create('div', 'study-schedule');
    const daily = create('section', 'study-agenda');
    daily.setAttribute('aria-label', '当天的练习');
    daily.append(tasks);
    const planner = create('div', 'study-planner');
    planner.append(settings, calendar);
    schedule.append(daily, planner);
    host.append(schedule);
    renderStats();
  }
  function renderWriting() {
    heading(
      '写句与复习',
      '从自己的错误出发，先写出来，再看提示。自由表达由你按任务自核，不把逐字不同当成错误。',
    );
    const layout = create('div', 'study-writing-layout');
    const tools = create('div', 'study-writing-tools');
    const work = create('div', 'study-writing-work');
    const modes = create('div', 'training-tabs');
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', '写作练习类型');
    for (const [id, title] of [
      ['sentence', '错句与换境'],
      ['dictation', '原句听写'],
      ['paragraph', '短段落'],
      ['paper2', 'Paper 2 任务'],
    ]) {
      const b = action(title, () => {
        bridge.pauseListening?.();
        setMode(id);
        if (!paragraphDraft) paragraphStarted = Date.now();
        render();
        host.querySelector('[data-training-mode][aria-pressed="true"]')?.focus({ preventScroll: true });
      });
      b.setAttribute('aria-pressed', String(mode === id));
      b.dataset.trainingMode = id;
      modes.append(b);
    }
    modes.append(action('待复习与备份', () => navigate('review'), 'button-secondary'));
    tools.append(modes);
    layout.append(tools, work);
    host.append(layout);
    if (mode === 'sentence') renderSentence(work, tools);
    else if (mode === 'dictation') renderDictation(work);
    else renderParagraph(work);
  }
  function renderSentence(work, tools) {
    const e = exercise();
    if (!e) {
      work.append(create('p', '', '暂无写句材料。可在下面添加自己的错句。'));
      renderPersonalForm(work);
      return;
    }
    const row = create('label', 'training-field');
    row.append(create('span', '', '今天练哪一个结构'));
    const select = create('select');
    select.id = 'writing-exercise';
    for (const ex of allExercises()) select.append(new Option(ex.title || ex.meaning || ex.id, ex.id));
    select.value = e.id;
    select.addEventListener('change', () => resetExercise(select.value));
    row.append(select);
    tools.append(row);
    const progress = create('ol', 'writing-steps');
    ['自己修句', '可选跟打', '关提示复测', '换境检验'].forEach((title, i) => {
      const li = create('li', '', `${i + 1} ${title}`);
      if (i === step) li.setAttribute('aria-current', 'step');
      progress.append(li);
    });
    tools.append(progress);
    const sheet = create('section', 'training-paper');
    sheet.append(create('h2', '', e.title || '个人错句'));
    sheet.append(
      create('p', 'training-practice-kind', '指定结构练习 · 题目已提示目标结构，不作为未见题的无提示诊断。'),
    );
    if (step === 0) {
      sheet.append(
        create('p', 'fine-print', e.source || content.sourceNote),
        create('p', 'training-english original-sentence', e.original),
        create('p', '', e.meaning),
      );
    }
    if (step === 1)
      sheet.append(
        create('p', '', '看清句意和结构，跟打一次。'),
        create('p', 'training-english reference-sentence', e.target),
      );
    if (step === 2) {
      sheet.append(
        create('p', '', '参考句已遮住。先听或看意思，再写出目标句。'),
        create('p', '', e.meaning),
        action('听参考句', () => speak(e.target), 'button-secondary'),
      );
    }
    if (step === 3)
      sheet.append(
        create('p', '', e.transfer || '改变人物、时间或主题，用这个结构独立写一句新句。'),
        create('p', 'fine-print', `可用关键词：${e.keywords || '请自行选择合适词语'}`),
      );
    sheet.append(
      field(
        step === 0 ? '你的修改' : step === 1 ? '跟打目标句' : step === 2 ? '凭回忆写出句子' : '你的新句子',
        answers[step],
        (v) => (answers[step] = v),
        { id: 'writing-answer', rows: 3, maxLength: 4000 },
      ),
    );
    if (step === 3) {
      const list = create('fieldset', 'training-checklist');
      list.append(create('legend', '', '写完后自己核对'));
      for (const [key, label] of [
        ['meaning', '表达了题目要求的新意思'],
        ['structure', '使用目标结构，主语与动词完整'],
        ['form', '人称、时态、单复数和拼写已检查'],
      ])
        list.append(checkField(label, !!checks[key], (v) => (checks[key] = v), key));
      sheet.append(list);
    }
    const submit = action(
      step === 3 ? '提交自核结果' : '提交作答',
      () => {
        if (!answers[step].trim()) {
          notice('先写下你的句子，再提交。', true);
          return;
        }
        if (step === 3 && !Object.values(checks).some(Boolean)) {
          notice('请至少核对一项，再记录自己的判断。', true);
          return;
        }
        try {
          result = step === 3 ? null : compareSentence(e.target, answers[step]);
          if (step === 0 && !result.correct)
            for (const alternative of e.alternatives || []) {
              const r = compareSentence(alternative, answers[step]);
              if (r.correct) {
                result = r;
                break;
              }
            }
          attempted = true;
          const exact = step === 1 || step === 2;
          studyStore.addAttempt({
            module: 'writing',
            taskId: e.id,
            phase: step === 0 ? sentencePhase : step === 1 ? 'review' : 'retest',
            assisted: step === 1 || hinted || revealed,
            answers: { sentence: answers[step] },
            correct: step === 3 ? undefined : result.correct ? 1 : exact ? 0 : undefined,
            total: step === 3 ? undefined : 1,
            selfCheck:
              step === 3
                ? Object.values(checks).filter(Boolean).length === 3
                  ? 'correct'
                  : 'retry'
                : result.correct
                  ? 'correct'
                  : 'pending',
            errorTypes: result && !result.correct ? [e.errorType || '句式'] : [],
            source: e.source || '针对个人错误结构的教学练习',
            details: {
              stage: step,
              meaning: e.meaning,
              practiceKind: 'targeted-structure',
              checks: step === 3 ? checks : undefined,
            },
          });
          captureWork();
          notice(step === 3 ? '新句已记录为自核结果，尚未保存。' : '本次作答已记录在当前会话。');
        } catch (err) {
          notice(err.message, true);
        }
      },
      'button-primary',
    );
    submit.id = 'writing-submit';
    sheet.append(submit);
    if (attempted) {
      const feedback = create('div', 'training-feedback');
      if (step === 3)
        feedback.append(
          create('p', '', '自由造句没有按参考句逐字评分。请按上面的三项清单继续自改；未核对项会提醒你重练。'),
        );
      else if (result?.correct) feedback.append(create('p', '', '这次目标表达核对一致。'));
      else if (step === 0)
        feedback.append(create('p', '', '与参考改句不完全相同，先查看结构提示；合理改写可自行确认。'));
      else renderDiff(feedback, result);
      if (step === 0) {
        feedback.append(
          action('查看结构提示', () => {
            hinted = true;
            render();
          }),
        );
        if (hinted)
          feedback.append(
            create('p', '', e.hint || '检查句子的主语、谓语与目标搭配。'),
            action('揭示参考改法', () => {
              revealed = true;
              render();
            }),
          );
        if (revealed || result?.correct)
          feedback.append(
            create('p', 'training-english reference-sentence', e.target),
            create('p', '', e.explanation || '这是一种参考改法。'),
          );
        if (!result?.correct)
          feedback.append(
            action('我的改写合理，标为自核正确', () => {
              manualAccepted = true;
              studyStore.addAttempt({
                module: 'writing',
                taskId: e.id,
                phase: 'review',
                assisted: true,
                answers: { sentence: answers[0] },
                selfCheck: 'correct',
                details: { stage: 0, manual: true, practiceKind: 'targeted-structure' },
              });
              captureWork();
              revealed = true;
              notice('已记录自核判断；自动匹配结果不会改成官方判分。');
            }),
          );
      }
      if (step === 2 && result && !result.correct)
        feedback.append(
          action(dictationRevealed ? '参考句已显示' : '显示目标句', () => {
            dictationRevealed = true;
            render();
          }),
        );
      if (step === 2 && dictationRevealed) feedback.append(create('p', 'training-english', e.target));
      if (step === 0 && (result?.correct || manualAccepted)) {
        const transfer = action(
          '换情境检验',
          () => {
            step = 3;
            answers[3] = '';
            attempted = false;
            revealed = hinted = dictationRevealed = false;
            result = null;
            checks = {};
            render();
          },
          'button-primary',
        );
        transfer.id = 'writing-transfer';
        feedback.append(
          create('p', '', '这一句已核对。换一个情境检查能否运用；需要时仍可选择跟打。'),
          transfer,
        );
      }
      if (step < 3 && (step > 0 || revealed || result?.correct)) {
        const next = action(
          step === 0 ? '可选：看句跟打' : step === 1 ? '关提示再测' : '换情境检验',
          () => {
            step++;
            attempted = false;
            revealed = false;
            hinted = false;
            dictationRevealed = false;
            result = null;
            render();
          },
          'button-secondary',
        );
        next.id = 'writing-next';
        feedback.append(next);
      } else if (step === 3) {
        feedback.append(action('关提示再测', () => resetExercise(e.id, 'retest'), 'button-secondary'));
        finishActions(feedback);
      }
      sheet.append(feedback);
    }
    work.append(sheet);
    renderPersonalForm(work);
  }
  function checkField(label, checked, onChange, id) {
    const wrap = create('label', 'training-checkbox');
    const input = create('input');
    input.type = 'checkbox';
    input.checked = checked;
    if (id) input.dataset.check = id;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, create('span', '', label));
    return wrap;
  }
  function renderDiff(target, r) {
    if (!r) return;
    target.append(create('p', '', r.correct ? '字词核对一致。' : '按目标原句核对，下面是需要检查的位置：'));
    const list = create('ul', 'training-differences');
    for (const d of r.differences.slice(0, 16))
      list.append(
        create(
          'li',
          '',
          d.kind === 'missing'
            ? `漏写：${d.expected}`
            : d.kind === 'extra'
              ? `多写：${d.actual}`
              : `${d.actual} → ${d.expected}`,
        ),
      );
    target.append(list);
  }
  function renderPersonalForm(work) {
    const details = create('details', 'training-settings');
    details.append(create('summary', '', '加入自己的错句'));
    const form = create('form', 'training-personal-form');
    let original = '',
      target = '',
      meaning = '';
    form.append(
      field('原句', original, (v) => (original = v), { maxLength: 2000 }),
      field('已核对的参考改句', target, (v) => (target = v), { maxLength: 2000 }),
      field('意思或情境', meaning, (v) => (meaning = v), { maxLength: 1000 }),
    );
    const b = create('button', 'button-secondary', '加入当前练习');
    b.type = 'submit';
    form.append(b);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!original.trim() || !target.trim() || !meaning.trim()) {
        notice('请填原句、参考改句和意思。', true);
        return;
      }
      try {
        const id = studyStore.addExercise({
          original: original.trim(),
          target: target.trim(),
          meaning: meaning.trim(),
          title: meaning.trim().slice(0, 40),
          transfer: '改变主语和情境，用这个结构写一句新的表达。',
        });
        resetExercise(id);
        notice('个人错句已加入本次练习；明确保存后才会保留。');
      } catch (e) {
        notice(e.message, true);
      }
    });
    details.append(form);
    work.append(details);
  }
  function dictationSentences() {
    const state = listening();
    return (state.lesson?.sentences || [])
      .filter((s) => s.words?.length)
      .map((s) => ({
        id: s.id,
        text: s.text || s.words.map((w) => w.text).join(' '),
        start: s.start,
        end: s.end,
        lessonId: state.lesson.id,
      }));
  }
  function renderDictation(work) {
    const sentences = dictationSentences();
    if (!sentences.length) {
      const empty = create('section', 'training-paper');
      const options = create('div', 'training-actions');
      options.append(
        action('完成一组原题', () => navigate('listening', { mode: 'papers' }), 'button-primary'),
        action(
          '打开原卷选一句听写',
          () => navigate('library', { paper: bridge.getLesson?.()?.paper }),
          'button-secondary',
        ),
      );
      empty.append(
        create('h2', '', '还没有可听写的原句'),
        create('p', '', '做完一组原题并进入复盘后，就能在这里听写原句。也可以到原卷选一句开始。'),
        options,
      );
      work.append(empty);
      return;
    }
    const chosen = sentences.find((s) => s.id === dictationId) || sentences[0];
    dictationId = chosen.id;
    const sheet = create('section', 'training-paper');
    sheet.append(
      create('h2', '', '用自己的原音听写'),
      create(
        'p',
        'fine-print',
        '选项只显示时间，不提前显示目标句。提交后按原句检查拼写；合理意译可自行判断。',
      ),
    );
    const label = create('label', 'training-field');
    label.append(create('span', '', '选择已复盘的句子'));
    const select = create('select');
    select.id = 'dictation-sentence';
    for (const [i, s] of sentences.entries())
      select.append(new Option(`第 ${i + 1} 句 · ${s.start.toFixed(1)}–${s.end.toFixed(1)} 秒`, s.id));
    select.value = chosen.id;
    select.addEventListener('change', () => {
      bridge.pauseListening?.();
      dictationId = select.value;
      dictationAnswer = '';
      dictationResult = null;
      dictationRevealed = false;
      dictationMode = 'first';
      dictationCaptured = null;
      render();
    });
    label.append(select);
    sheet.append(label);
    const controls = create('div', 'training-actions');
    controls.append(
      action(
        '听原音',
        () => {
          bridge.playListening({
            lessonId: chosen.lessonId,
            start: chosen.start,
            end: chosen.end,
            concealed: true,
          });
        },
        'button-secondary',
      ),
      action('暂停', () => bridge.pauseListening?.()),
    );
    sheet.append(
      controls,
      field('你听到的句子', dictationAnswer, (v) => (dictationAnswer = v), {
        id: 'dictation-answer',
        maxLength: 4000,
      }),
    );
    const submit = action(
      '提交作答',
      () => {
        if (!dictationAnswer.trim()) {
          notice('先写下听到的内容。', true);
          return;
        }
        try {
          dictationResult = compareSentence(chosen.text, dictationAnswer);
          studyStore.addAttempt({
            module: 'dictation',
            taskId: `${chosen.lessonId}:${chosen.id}`,
            phase: dictationMode,
            assisted: dictationRevealed,
            answers: { sentence: dictationAnswer },
            correct: dictationResult.correct ? 1 : 0,
            total: 1,
            errorTypes: dictationResult.correct ? [] : ['听写拼写或漏词'],
            source: '已复盘的 past paper 原音',
            details: {
              sentence: chosen.text,
              lessonId: chosen.lessonId,
              start: chosen.start,
              end: chosen.end,
            },
          });
          captureWork();
          notice('听写已核对；尚未写入正式学习纪录。');
        } catch (e) {
          notice(e.message, true);
        }
      },
      'button-primary',
    );
    submit.id = 'dictation-submit';
    sheet.append(submit);
    if (dictationResult) {
      const feedback = create('div', 'training-feedback');
      renderDiff(feedback, dictationResult);
      feedback.append(
        action('显示原句', () => {
          dictationRevealed = true;
          render();
        }),
      );
      if (dictationRevealed) feedback.append(create('p', 'training-english', chosen.text));
      feedback.append(
        action(
          '关提示再测',
          () => {
            dictationAnswer = '';
            dictationResult = null;
            dictationRevealed = false;
            dictationMode = 'retest';
            dictationCaptured = null;
            render();
          },
          'button-secondary',
        ),
      );
      finishActions(feedback);
      sheet.append(feedback);
    }
    work.append(sheet);
  }
  function speak(text) {
    if (!('speechSynthesis' in window)) {
      notice('这个浏览器没有朗读功能，可按中文意思完成默写。');
      return;
    }
    const voices = speechSynthesis.getVoices();
    const voice = voices.find((v) => /^en[-_]GB$/i.test(v.lang));
    if (!voice) {
      notice('当前设备没有可用的英式英语声音，请按中文意思默写，或使用原音听写。');
      return;
    }
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = 'en-GB';
    utterance.rate = 0.9;
    utterance.onerror = () => notice('朗读未能开始，可按中文意思继续练习。', true);
    speechSynthesis.speak(utterance);
  }
  function renderParagraph(work) {
    const paper = mode === 'paper2';
    const actualTask = content.paper2?.find((p) => p.id === paperId);
    const paperTaskId =
      actualTask?.id ||
      `paper2-custom-${Array.from(paperSource + paperPrompt)
        .reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, 0)
        .toString(36)}`;
    const prompt = content.paragraphs.find((p) => p.id === paragraphId) || content.paragraphs[0];
    const sheet = create('section', 'training-paper');
    sheet.append(create('h2', '', paper ? 'Paper 2 原卷任务' : '80–120 词短段落'));
    if (paper) {
      const taskLabel = create('label', 'training-field');
      taskLabel.append(create('span', '', '选择原卷任务'));
      const taskSelect = create('select');
      taskSelect.id = 'paper2-task';
      for (const task of content.paper2 || []) taskSelect.append(new Option(task.title, task.id));
      taskSelect.append(new Option('粘贴其他原题', 'custom'));
      taskSelect.value = actualTask ? paperId : 'custom';
      taskSelect.addEventListener('change', async () => {
        if (
          (paragraphDraft || paragraphRevision) &&
          !(await confirmAction(
            '切换写作题目？',
            '切换题目将清空当前输入，已提交的学习纪录仍保留。',
            '切换题目',
          ))
        ) {
          taskSelect.value = paperId;
          return;
        }
        paperId = taskSelect.value;
        const chosen = content.paper2?.find((p) => p.id === paperId);
        paperSource = chosen?.source || '';
        paperPrompt = chosen?.prompt || '';
        paperAudience = '';
        paperPurpose = '';
        paragraphDraft = '';
        paragraphRevision = '';
        paragraphSubmitted = false;
        paragraphPhase = 'first';
        paragraphCaptured = null;
        paragraphChecks = {};
        paragraphStarted = Date.now();
        render();
      });
      taskLabel.append(taskSelect);
      sheet.append(taskLabel);
      sheet.append(
        create(
          'p',
          'fine-print',
          '按实际原卷任务独立写作。Paper 2 的 Part A／B 与 P1／P3 的 A+B1 不同。这里不生成代写范文，也不输出官方等级。',
        ),
      );
      if (actualTask) {
        sheet.append(create('p', 'fine-print', actualTask.source));
        const original = create('div', 'paper2-source-grid');
        original.append(create('p', 'paper2-prompt-text', actualTask.prompt));
        const figure = create('figure', 'paper2-source-image');
        const link = create('a');
        link.href = actualTask.sourceImage;
        link.target = '_blank';
        link.rel = 'noopener';
        const img = create('img');
        img.src = actualTask.sourceImage;
        img.alt =
          '2025 Paper 2 第 2 页原题：852 Teen Art Club，附绘画、摄影、陶艺和联系方式的宣传单。轻点查看完整原页。';
        link.append(img);
        figure.append(link, create('figcaption', 'fine-print', '轻点原页放大，保留题目图像与上下文。'));
        original.append(figure);
        sheet.append(original);
      } else
        sheet.append(
          field('年份、Part、题号或来源', paperSource, (v) => (paperSource = v), {
            type: 'text',
            id: 'paper2-source',
            maxLength: 300,
          }),
          field('原题任务与要求', paperPrompt, (v) => (paperPrompt = v), {
            id: 'paper2-prompt',
            maxLength: 6000,
            rows: 5,
          }),
        );
      sheet.append(
        field('读者是谁', paperAudience, (v) => (paperAudience = v), { type: 'text', maxLength: 300 }),
        field('写作目的', paperPurpose, (v) => (paperPurpose = v), { type: 'text', maxLength: 300 }),
      );
    } else if (prompt) {
      const label = create('label', 'training-field');
      label.append(create('span', '', '本次题目'));
      const select = create('select');
      for (const p of content.paragraphs) select.append(new Option(p.title, p.id));
      select.value = paragraphId;
      select.addEventListener('change', () => {
        paragraphId = select.value;
        paragraphDraft = '';
        paragraphRevision = '';
        paragraphSubmitted = false;
        paragraphPhase = 'first';
        paragraphCaptured = null;
        paragraphChecks = {};
        paragraphStarted = Date.now();
        render();
      });
      label.append(select);
      sheet.append(
        label,
        create('p', '', prompt.prompt),
        create('p', 'fine-print', `读者：${prompt.audience} · 目的：${prompt.purpose} · 教学练习题`),
      );
    }
    const info = create('p', 'training-timer');
    const updateCount = () => {
      info.textContent = `${countWords(paragraphDraft)} 词 · 已用 ${Math.floor((Date.now() - paragraphStarted) / 60000)} 分钟${paper ? (actualTask ? ` · 原题约 ${actualTask.wordTarget} 词` : ' · 以原题字数与时间要求为准') : ' · 目标 80–120 词'}`;
    };
    updateCount();
    sheet.append(
      create(
        'p',
        'training-practice-kind',
        paragraphPhase === 'retest'
          ? '同题复测 · 旧稿已隐藏，重新完成自己的表达。'
          : paragraphPhase === 'review'
            ? '查看上次作答 · 已显示旧稿，本轮属于辅助复盘。'
            : '先独立作答，提交后再自核。',
      ),
    );
    sheet.append(
      field(
        '独立初稿',
        paragraphDraft,
        (v) => {
          paragraphDraft = v;
          updateCount();
        },
        { id: 'paragraph-draft', rows: 10, maxLength: 20000 },
      ),
      info,
    );
    const button = action(
      '提交作答',
      () => {
        if (!paragraphDraft.trim() || (paper && (!paperPrompt.trim() || !paperSource.trim()))) {
          notice(paper ? '先填原题来源、任务和你的初稿。' : '先完成初稿再进入自查。', true);
          return;
        }
        paragraphSubmitted = true;
        studyStore.addAttempt({
          module: 'writing',
          taskId: paper ? paperTaskId : `paragraph-${paragraphId}`,
          phase: paragraphPhase,
          assisted: paragraphPhase === 'review',
          answers: { draft: paragraphDraft },
          elapsedSeconds: Math.round((Date.now() - paragraphStarted) / 1000),
          selfCheck: 'pending',
          source: paper ? paperSource : '教学短段落',
          details: {
            kind: paper ? 'paper2' : 'paragraph',
            paperId: paper ? paperId : undefined,
            prompt: paper ? paperPrompt : prompt.prompt,
            audience: paper ? paperAudience : prompt.audience,
            purpose: paper ? paperPurpose : prompt.purpose,
            wordCount: countWords(paragraphDraft),
          },
        });
        captureWork();
        notice('初稿已保留在本次会话；现在选择最值得改的 2–3 类问题。');
      },
      'button-primary',
    );
    button.id = 'paragraph-submit';
    sheet.append(button);
    if (paragraphSubmitted) {
      const check = create('fieldset', 'training-checklist');
      check.append(create('legend', '', '对照任务逐项自查'));
      const items = paper
        ? actualTask?.checks || [
            '所有任务信息均已覆盖',
            '格式、读者和语气符合原题',
            '每段有清楚中心和支持细节',
            '人称、时态和句子结构一致',
            '复查拼写、单复数与目标错误',
          ]
        : prompt.checks;
      for (const [i, text] of items.entries())
        check.append(checkField(text, !!paragraphChecks[i], (v) => (paragraphChecks[i] = v), String(i)));
      sheet.append(
        check,
        field('修改稿（保留初稿供对照）', paragraphRevision, (v) => (paragraphRevision = v), {
          id: 'paragraph-revision',
          rows: 10,
          maxLength: 20000,
        }),
      );
      sheet.append(
        action(
          '提交修改稿与自核',
          () => {
            if (!paragraphRevision.trim()) {
              notice('先写出修改稿，再记录。', true);
              return;
            }
            studyStore.addAttempt({
              module: 'writing',
              taskId: paper ? paperTaskId : `paragraph-${paragraphId}`,
              phase: 'review',
              assisted: true,
              answers: { draft: paragraphDraft, revision: paragraphRevision },
              source: paper ? paperSource : '教学短段落',
              selfCheck: items.every((_, i) => paragraphChecks[i]) ? 'correct' : 'retry',
              details: {
                kind: paper ? 'paper2' : 'paragraph',
                paperId: paper ? paperId : undefined,
                checks: paragraphChecks,
                wordCount: countWords(paragraphRevision),
                source: paperSource,
                prompt: paper ? paperPrompt : prompt.prompt,
                audience: paper ? paperAudience : prompt.audience,
                purpose: paper ? paperPurpose : prompt.purpose,
              },
            });
            captureWork();
            notice('初稿、修改稿与自查已记录，点保存后保留。可换题独立检验，而不只重复抄改稿。');
          },
          'button-secondary',
        ),
      );
      finishActions(sheet);
    }
    work.append(sheet);
  }
  function reviewItems(current = listening(), attempts = listeningAttempts(current.savedRecords)) {
    const state = studyStore.getState();
    const items = [];
    for (const m of state.paperMarks)
      items.push({
        id: `paper-mark:${m.key}`,
        type: 'listening',
        title: m.word,
        detail: `${m.year} 原卷 · Part ${m.part} · Task ${m.task} · 回听时字幕跟随`,
        createdAt: m.createdAt,
        paper: m,
        paperReplay: true,
      });
    const questionReviews = listeningQuestionReviews(attempts);
    const questionLessons = new Set(questionReviews.map(({ attempt }) => attempt.taskId));
    if (current.lesson?.sentences?.length) reviewLessons.set(current.lesson.id, current.lesson);
    const latest = new Map();
    for (const r of current.savedRecords || []) latest.set(r.lessonId, r);
    for (const r of latest.values()) {
      const lesson = reviewLessons.get(r.lessonId);
      const descriptor = (current.catalogue || []).find((x) => x.id === r.lessonId);
      if (
        !lesson &&
        descriptor?.url &&
        !requestedReviewLessons.has(r.lessonId) &&
        (questionLessons.has(r.lessonId) || Object.keys(r.marks || {}).length)
      ) {
        requestedReviewLessons.add(r.lessonId);
        fetch(descriptor.url)
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            if (data?.id === r.lessonId) reviewLessons.set(r.lessonId, data);
            if (view === 'review' || view === 'today') render();
          })
          .catch(() => {});
      }
      for (const [wordId, type] of Object.entries(r.marks || {})) {
        const word = lesson?.sentences?.flatMap((s) => s.words).find((w) => w.id === wordId);
        items.push({
          id: `listen:${r.lessonId}:${wordId}`,
          type: 'listening',
          title: word?.text || '已标记的词语',
          detail: `${type === 'heard' ? '认识，但听不出' : '不认识／语境义'} · ${r.lessonTitle || descriptor?.title || r.lessonId}`,
          createdAt: r.savedAt,
          play: { lessonId: r.lessonId, wordId },
        });
      }
      for (const m of r.moments || [])
        items.push({
          id: `moment:${r.lessonId}:${Math.round(m.time * 100)}`,
          type: 'listening',
          title: `${Math.floor(m.time / 60)}:${String(Math.floor(m.time % 60)).padStart(2, '0')} · 没听清`,
          detail: r.lessonTitle || r.lessonId,
          createdAt: r.savedAt,
          play: { lessonId: r.lessonId, start: Math.max(0, m.time - 4), end: m.time + 2 },
        });
    }
    for (const { id, questionId, attempt, errorType } of questionReviews) {
      const descriptor = current.catalogue?.find((entry) => entry.id === attempt.taskId);
      const question = reviewLessons.get(attempt.taskId)?.questions?.find((q) => q.id === questionId);
      const label =
        question?.label ||
        (question?.number ? `Q${question.number}` : questionId.replace(/^q(\d+)$/i, 'Q$1'));
      const title = attempt.title || descriptor?.title || attempt.taskId;
      items.push({
        id,
        type: 'listening',
        title: title.endsWith(label) ? title : `${title} · ${label}`,
        detail: question?.prompt || '已标记这道题需要巩固。',
        focus: listeningErrorLabels.get(errorType) || errorType,
        focusLabel: '错因',
        createdAt: attempt.createdAt,
        savedQuestion: { lessonId: attempt.taskId, attemptKey: attempt.attemptKey, questionId },
      });
    }
    const taskRecords = new Map(),
      taskErrors = new Map();
    for (const r of state.records) {
      const key = `${r.module}:${r.taskId}`;
      taskRecords.set(key, r);
      if (r.errorTypes?.length) taskErrors.set(key, [...new Set(r.errorTypes)].slice(0, 3));
    }
    for (const [id, r] of taskRecords) {
      const e = allExercises().find((x) => x.id === r.taskId);
      const paragraph = content.paragraphs.find((p) => `paragraph-${p.id}` === r.taskId);
      const paper = content.paper2?.find((p) => p.id === r.taskId);
      items.push({
        id,
        type: r.module,
        title:
          e?.title ||
          paragraph?.title ||
          paper?.title ||
          r.details?.title ||
          (r.module === 'dictation'
            ? `原音听写 · ${Number(r.details?.start || 0).toFixed(1)} 秒`
            : r.details?.kind === 'paper2'
              ? r.source || 'Paper 2 原题'
              : r.taskId),
        detail:
          r.selfCheck === 'correct'
            ? '上次自核：已检查；这次仍需关提示作答'
            : r.correct === r.total && r.total
              ? '上次核对一致；关提示再测'
              : '先独立回忆，再对照原材料',
        createdAt: r.createdAt,
        record: r,
        paper: r.details?.paper,
        focus: taskErrors.get(id)?.join('、') || (e ? e.meaning : ''),
        focusLabel: taskErrors.has(id) ? '待巩固卡点' : '练习重点',
      });
    }
    return items
      .map((i) => ({
        ...i,
        dueDate: state.reviews[i.id]?.dueDate || dayAfter(dateKey(new Date(i.createdAt)), 1),
        level: state.reviews[i.id]?.level || 0,
      }))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }
  function renderReview() {
    heading('复习与学习记录', '先关提示作答，再核对卡点。同题复测与新材料表现分别看；手动标记只代表自评。');
    const filters = create('div', 'training-tabs');
    for (const [id, title] of [
      ['all', '全部项目'],
      ['due', '今天到期'],
    ]) {
      const b = action(title, () => {
        reviewFilter = id;
        render();
        host.querySelector('.study-review [aria-pressed="true"]')?.focus({ preventScroll: true });
      });
      b.setAttribute('aria-pressed', String(reviewFilter === id));
      filters.append(b);
    }
    const workspace = create('div', 'study-review-workspace');
    const review = create('section', 'study-review');
    review.setAttribute('aria-label', '复习项目');
    const type = create('select');
    type.setAttribute('aria-label', '复习类型');
    for (const [id, title] of [
      ['all', '全部类型'],
      ['listening', '听力卡点'],
      ['writing', '写句'],
      ['dictation', '原音听写'],
      ['reading', '阅读'],
      ['integrated', 'B1 综合'],
    ])
      type.append(new Option(title, id));
    type.value = reviewType;
    type.addEventListener('change', () => {
      reviewType = type.value;
      render();
      host.querySelector('.study-review select')?.focus({ preventScroll: true });
    });
    filters.append(type);
    review.append(filters);
    const list = create('div', 'training-review-list');
    const current = listening();
    const attempts = listeningAttempts(current.savedRecords);
    const items = reviewItems(current, attempts).filter(
      (i) =>
        (reviewFilter !== 'due' || i.dueDate <= dateKey()) && (reviewType === 'all' || i.type === reviewType),
    );
    if (!items.length)
      list.append(
        create('p', 'empty-copy', '当前没有这一类待复习项目。先完成并保存听力卡词、写句或阅读练习。'),
      );
    for (const item of items) {
      const row = create('article', 'training-review-row');
      const text = create('div');
      text.append(
        create('h2', '', item.title),
        ...(item.focus ? [create('p', 'training-review-focus', `${item.focusLabel}：${item.focus}`)] : []),
        create('p', '', item.detail),
        create(
          'p',
          'fine-print',
          `${item.dueDate <= dateKey() ? '已到期' : '下次'}：${item.dueDate} · ${item.type === 'listening' ? '听力' : moduleLabel[item.type]}`,
        ),
      );
      const controls = create('div', 'training-actions');
      const openItem = async (concealed = true) => {
        try {
          if (item.savedQuestion)
            await bridge.openSavedListening({ ...item.savedQuestion, retest: concealed });
          else if (item.paper)
            await bridge.navigate('listening', { paper: item.paper, paperReplay: !!item.paperReplay });
          else if (item.play) await bridge.playListening(item.play);
          else if (item.type === 'writing') {
            setMode(
              item.record.details?.kind === 'paper2'
                ? 'paper2'
                : item.record.details?.kind === 'paragraph'
                  ? 'paragraph'
                  : 'sentence',
            );
            if (mode === 'sentence') resetExercise(item.record.taskId, 'retest');
            else {
              const r = item.record;
              if (mode === 'paragraph') paragraphId = r.taskId.replace(/^paragraph-/, '');
              else {
                paperId =
                  r.details?.paperId ||
                  (content.paper2?.some((p) => p.id === r.taskId) ? r.taskId : 'custom');
                paperSource = r.source || r.details?.source || '';
                paperPrompt = r.details?.prompt || '';
                paperAudience = r.details?.audience || '';
                paperPurpose = r.details?.purpose || '';
              }
              paragraphDraft = concealed ? '' : r.answers?.draft || r.answers?.revision || '';
              paragraphRevision = concealed ? '' : r.answers?.revision || '';
              paragraphSubmitted = !concealed;
              paragraphPhase = concealed ? 'retest' : 'review';
              paragraphChecks = concealed ? {} : r.details?.checks || {};
              paragraphStarted = Date.now();
              paragraphCaptured = concealed ? null : paragraphWork();
            }
            navigate('writing');
          } else if (item.type === 'dictation') {
            const d = item.record.details;
            await bridge.playListening({
              lessonId: d.lessonId,
              start: d.start,
              end: d.end,
              concealed: true,
            });
            bridge.pauseListening?.();
            setMode('dictation');
            dictationId = item.record.taskId.slice(`${d.lessonId}:`.length);
            dictationAnswer = '';
            dictationResult = null;
            dictationRevealed = false;
            dictationMode = 'retest';
            dictationCaptured = null;
            navigate('writing');
          } else
            navigate(item.type === 'integrated' ? 'integrated' : 'reading', {
              taskId: item.record.taskId,
              kind: 'retest',
            });
        } catch (error) {
          notice(error.message, true);
        }
      };
      controls.append(
        action(
          item.play || item.paperReplay ? '回原音复习' : '关提示再测',
          () => openItem(true),
          'button-primary',
        ),
      );
      if (item.savedQuestion)
        controls.append(action('回原题复盘', () => openItem(false), 'button-secondary'));
      if (item.type === 'writing' && ['paragraph', 'paper2'].includes(item.record?.details?.kind))
        controls.append(action('查看上次作答', () => openItem(false), 'button-secondary'));
      const manual = create('details', 'training-manual-review');
      manual.append(create('summary', '', '仅手动标记（自评）'));
      manual.append(
        create('p', 'fine-print', '未完成作答也可以留自评，但不会计作已完成复测。'),
        action('仍需重练', () => {
          studyStore.markReviewed(item.id, 'again');
          notice('自评已暂存，下一次设为明天；这不代表已完成复测。明确保存后保留。');
        }),
        action('已能独立回忆', () => {
          studyStore.markReviewed(item.id, 'remembered');
          notice('自评已暂存并拉开下次间隔；这不代表新题已掌握。明确保存后保留。');
        }),
      );
      controls.append(manual);
      row.append(text, controls);
      list.append(row);
    }
    review.append(list);
    workspace.append(review);
    renderBackup(workspace);
    host.append(workspace);
    renderStats(current, attempts);
  }
  function renderStats(current = listening(), uniqueAttempts = listeningAttempts(current.savedRecords)) {
    const saved = studyStore.getSavedState();
    const section = create('section', 'training-statistics');
    section.append(
      create('h2', '', '已保存的练习记录'),
      create(
        'p',
        'fine-print',
        '首次独立作答、指定结构练习、辅助练习和同题复测分开。次数只表示练过，不代表能力或 DSE 等级；尚未保存的修改不计入。新材料表现仍需用未练过的材料检验。',
      ),
    );
    const groups = [
      ['听力', summariseRecords(uniqueAttempts)],
      ['阅读', summariseRecords(saved.records.filter((r) => r.module === 'reading'))],
      ['B1 综合', summariseRecords(saved.records.filter((r) => r.module === 'integrated'))],
      [
        '写句与听写',
        summariseRecords(saved.records.filter((r) => ['writing', 'dictation'].includes(r.module))),
      ],
    ];
    const table = create('table', 'training-table');
    const head = create('thead');
    const hr = create('tr');
    for (const label of ['项目', '独立首答', '指定结构首答', '辅助练习', '同题复测'])
      hr.append(create('th', '', label));
    head.append(hr);
    table.append(head);
    const body = create('tbody');
    for (const [name, s] of groups) {
      const tr = create('tr');
      tr.append(create('th', '', name));
      for (const key of ['first', 'targeted', 'assisted', 'retest']) {
        const g = s[key];
        tr.append(
          create(
            'td',
            '',
            g.attempts
              ? `${g.attempts} 次${g.total ? ` · ${g.correct}/${g.total} 项核对一致` : ''}`
              : '尚无记录',
          ),
        );
      }
      body.append(tr);
    }
    table.append(body);
    const scroll = create('div', 'training-table-scroll');
    scroll.append(table);
    section.append(scroll);
    const errors = summariseRecords([...saved.records, ...uniqueAttempts]).errors;
    if (Object.keys(errors).length) {
      const p = create('p', '');
      p.textContent =
        '已记录错因：' +
        Object.entries(errors)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${listeningErrorLabels.get(k) || k} ${v} 次`)
          .join(' · ');
      section.append(p);
    }
    const recent = create('details', 'training-history');
    const history = [...saved.records, ...uniqueAttempts].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    recent.append(create('summary', '', `查看最近已保存纪录（${history.length} 条）`));
    const ol = create('ol');
    const more = action('查看更早纪录', appendHistory);
    function appendHistory() {
      const start = ol.children.length;
      for (const r of history.slice(start, start + 12)) {
        const title =
          r.title ||
          r.details?.title ||
          (r.module === 'listening' && current.catalogue?.find((entry) => entry.id === r.taskId)?.title) ||
          r.taskId;
        const row = create(
          'li',
          '',
          `${dateKey(new Date(r.createdAt))} · ${moduleLabel[r.module]} · ${r.assisted ? '辅助练习' : r.phase === 'first' && isTargetedStructureAttempt(r) ? '指定结构首答' : phaseLabel[r.phase]} · ${title}${r.selfCheck ? ' · ' + ({ correct: '自核已检查', retry: '需重练', pending: '待自核' }[r.selfCheck] || r.selfCheck) : ''}`,
        );
        if (r.module === 'listening')
          row.append(
            ' ',
            action('查看这轮作答', async () => {
              try {
                await bridge.openSavedListening({ lessonId: r.taskId, attemptKey: r.attemptKey });
              } catch (error) {
                notice(error.message, true);
              }
            }),
          );
        ol.append(row);
      }
      more.hidden = ol.children.length >= history.length;
    }
    appendHistory();
    recent.append(ol, more);
    section.append(recent);
    host.append(section);
  }
  function renderBackup(workspace) {
    const section = create('section', 'training-backup');
    section.append(
      create('h2', '', '完整备份'),
      create('p', 'fine-print', '备份包含已保存的学习纪录和听力标记。'),
    );
    const buttons = create('div', 'training-actions');
    const exportButton = action(
      '导出已保存的完整备份',
      () => {
        try {
          const data = studyStore.exportBackup();
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
          );
          const a = create('a');
          a.href = url;
          a.download = `English30-backup-${dateKey()}.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          notice(
            studyStore.hasUnsaved() ? '已导出上次保存的数据；本次未保存修改未包含。' : '已导出完整学习备份。',
          );
        } catch (e) {
          notice(e.message, true);
        }
      },
      'button-secondary',
    );
    exportButton.id = 'training-export';
    buttons.append(exportButton);
    section.append(buttons);
    workspace.append(section);
  }
  render();
  return {
    show(next) {
      if (!['today', 'writing', 'review'].includes(next)) throw new Error('未知训练页面');
      bridge.pauseListening?.();
      window.speechSynthesis?.cancel();
      view = next;
      render();
    },
    getState: () => studyStore.getState(),
    getSaveState,
    saveCurrent: save,
    restoreState(data) {
      studyStore.replaceState(validateStudyState(data));
    },
    openWriting(id) {
      setMode('sentence');
      view = 'writing';
      resetExercise(id);
    },
  };
}
