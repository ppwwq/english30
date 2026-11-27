import { confirmAction } from './confirmation.mjs';
import { validatePaperInk } from './core.mjs';
import { inkIcon } from './ink-icons.mjs';
import { mountPaperInk } from './paper-ink.mjs';
import { markSeen, seenMaterials } from './paper-recovery.mjs';
import { mountPaperZoom } from './paper-zoom.mjs';
import { buildReadingPaperCatalogue } from './reading-paper-catalogue.mjs';
import {
  packReadingPaperInk,
  readReadingDraft,
  unpackReadingPaperInk,
  writeReadingDraft,
} from './reading-paper-storage.mjs';
import { mountReadingPaperWindows } from './reading-paper-windows.mjs';
import { studyStore } from './training-core.mjs';

const variants = { exam: '正式卷', practice: 'Practice Paper', sample: 'Sample Paper' };
const titles = { text: '阅读原文', question: '题答卷', mixed: '阅读原卷', reference: '评分参考' };
const taskKey = (paper, part) => `reading-paper:${paper.year}-${paper.variant}:${part.id}`;
const readingErrors = ['定位不到依据', '理解有误', '答案不完整', '用词或拼写', '其他'];

function button(text, action, className = 'button-secondary') {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = text;
  node.onclick = action;
  return node;
}

function setOptions(select, options, value) {
  select.replaceChildren(...options.map(([id, label]) => new Option(label, id)));
  select.value = value;
}

function createDocument(kind) {
  const section = document.createElement('section');
  section.className = 'reading-paper-document';
  section.dataset.kind = kind;
  section.innerHTML = `<header class="reading-paper-document-heading">
    <h2>${titles[kind]}</h2><div class="reading-paper-paging">
      <select aria-label="${titles[kind]}页码" data-page></select>
    </div>
  </header>
  <div class="practice-page-wrap reading-paper-page" role="region" tabindex="-1" aria-label="${titles[kind]}" data-reading-paper-skip>
    <div class="paper-page-stage"><img draggable="false" decoding="async" /></div>
    <p class="reading-paper-image-error" role="status" hidden></p>
  </div>`;
  const heading = section.querySelector('header');
  const paging = section.querySelector('.reading-paper-paging');
  const select = paging.querySelector('select');
  const wrap = section.querySelector('.reading-paper-page');
  const stage = wrap.querySelector('.paper-page-stage');
  const img = stage.querySelector('img');
  const error = wrap.querySelector('p');
  let pages = [],
    onPage,
    index = 0;
  const prev = button('', () => turn(index - 1));
  const next = button('', () => turn(index + 1));
  const zoom = button('');
  inkIcon(prev, 'prev', '上一页');
  inkIcon(next, 'next', '下一页');
  paging.prepend(prev);
  paging.append(next, mountPaperZoom(wrap, stage, zoom, `reading-paper-zoom-${kind}`));
  select.onchange = () => turn(Number(select.value));
  img.onerror = () => {
    error.textContent = '这页未能载入。';
    error.append(
      ' ',
      button('重试', () => turn(index)),
    );
    error.hidden = false;
  };

  function turn(position) {
    index = Math.max(0, Math.min(position, pages.length - 1));
    const page = pages[index];
    select.value = String(index);
    prev.disabled = index === 0;
    next.disabled = index === pages.length - 1;
    error.hidden = true;
    img.alt = `${titles[kind]} · 第 ${index + 1} 页`;
    img.width = page.width;
    img.height = page.height;
    if (page.rotation) {
      stage.style.aspectRatio = `${page.height} / ${page.width}`;
      img.style.cssText = `position:absolute; top:50%; left:50%; width:${(100 * page.width) / page.height}%;
        max-width:none; transform:translate(-50%, -50%) rotate(${page.rotation}deg)`;
    } else {
      stage.style.aspectRatio = '';
      img.removeAttribute('style');
    }
    img.src = new URL(page.src, import.meta.url).href;
    wrap.scrollTo(0, 0);
    onPage?.(page, index);
  }
  return {
    section,
    heading,
    paging,
    wrap,
    stage,
    setPages(list, position = 0, callback) {
      pages = list;
      onPage = callback;
      setOptions(
        select,
        pages.map((_, i) => [i, `${i + 1} / ${pages.length}`]),
        String(position),
      );
      turn(position);
    },
  };
}

export function mountReadingPaper({ host, bridge = {}, catalogue }) {
  const papers = buildReadingPaperCatalogue(catalogue.sources);
  const years = [...new Set(papers.map((item) => item.year))].sort((a, b) => b - a);
  let paper, part, attempt, articleKind, answerKind, activeKind, ink, focusButton;
  let comparison, launchComparison;
  let positions = {},
    mode = 'ink',
    focused = false;
  let recordWrites = Promise.resolve(),
    recordVersion = '',
    loadVersion = 0,
    reviewTimer;
  let visible = false,
    draftLoading,
    cachedDraft,
    pinnedRecord = false,
    selectedRecordId,
    notice = '';
  const seen = seenMaterials();
  const appHeader = document.querySelector('.app-header');
  const skipLink = document.querySelector('.skip-link');
  const hasDraftAnswers = (value) =>
    !!value &&
    !value.recordId &&
    (Object.keys(value.ink).length > 0 || Object.values(value.answers).some((answer) => answer.trim()));
  const pending = () => hasDraftAnswers(attempt);
  const updateSession = () => bridge.onSessionChange?.();
  const fresh = (phase = 'first') => ({
    phase,
    answers: {},
    ink: {},
    reviewInk: {},
    checks: {},
    recordId: null,
  });
  const findRecord = (selectedPaper, selectedPart, recordId) =>
    studyStore
      .getState()
      .records.filter(
        ({ id, module, taskId }) =>
          module === 'reading' &&
          taskId === taskKey(selectedPaper, selectedPart) &&
          (!recordId || id === recordId),
      )
      .reduce((latest, record) => (!latest || record.createdAt >= latest.createdAt ? record : latest), null);
  async function loadAttempt(record) {
    if (!record) return fresh();
    const details = record.details?.readingPaper;
    return {
      ...fresh(record.phase),
      answers: record.answers || {},
      ...(await unpackReadingPaperInk(details)),
      checks: details?.checks || {},
      copyOf: details?.copyOf,
      recordId: record.id,
      createdAt: record.createdAt,
      assisted: record.assisted,
    };
  }

  function setNotice(message) {
    notice = message;
    const status = host.querySelector('.reading-paper-status');
    if (status) {
      status.textContent = notice;
      status.hidden = !notice;
    }
  }

  function checkpoint() {
    if (!attempt) return;
    const saved =
      attempt.recordId && studyStore.getSavedState().records.find(({ id }) => id === attempt.recordId);
    const draft = structuredClone({
      year: paper.year,
      variant: paper.variant,
      part: part.id,
      attempt,
      positions,
      mode,
      activeKind,
      dirty:
        !!attempt.recordId &&
        !pinnedRecord &&
        (attempt.needsWrite || recordVersion !== JSON.stringify(saved)),
      savedVersion: JSON.stringify(saved || null),
    });
    void writeReadingDraft(draft).catch(() => setNotice('浏览器未能暂存阅读草稿，请保留页面。'));
  }

  function recordData(state, selectedPaper, selectedPart, files) {
    const checks = Object.values(state.checks);
    return {
      module: 'reading',
      taskId: taskKey(selectedPaper, selectedPart),
      phase: state.phase,
      assisted: !!state.assisted,
      answers: state.answers,
      source: `${selectedPaper.year} HKDSE English Language Paper 1 · ${variants[selectedPaper.variant]} · Part ${selectedPart.id}`,
      correct: null,
      selfCheck: checks.some(({ status }) => status === 'retry')
        ? 'retry'
        : checks.length === selectedPart.questions.length
          ? 'correct'
          : 'pending',
      errorTypes: [...new Set(checks.map(({ error }) => error).filter(Boolean))],
      details: {
        readingPaper: { ...files, checks: state.checks, ...(state.copyOf ? { copyOf: state.copyOf } : {}) },
      },
    };
  }

  function storeAttempt({
    inkChanged = true,
    working = attempt,
    selectedPaper = paper,
    selectedPart = part,
  } = {}) {
    working.createdAt ||= new Date().toISOString();
    const changes = structuredClone(working);
    const id = working.recordId || `a-${crypto.randomUUID()}`;
    const revision = (working.revision = (working.revision || 0) + 1);
    working.needsWrite = true;
    if (working === attempt) checkpoint();
    recordWrites = recordWrites
      .catch(() => {})
      .then(async () => {
        const old = findRecord(selectedPaper, selectedPart, id);
        const oldFiles = old?.details?.readingPaper;
        const files =
          !inkChanged && oldFiles?.inkFiles && oldFiles?.reviewInkFiles
            ? { inkFiles: oldFiles.inkFiles, reviewInkFiles: oldFiles.reviewInkFiles }
            : await packReadingPaperInk(changes);
        const record = {
          ...old,
          ...recordData(changes, selectedPaper, selectedPart, files),
          id,
          createdAt: old?.createdAt || changes.createdAt,
        };
        working.recordId = id;
        if (working.revision === revision) working.needsWrite = false;
        if (working === attempt) {
          pinnedRecord = false;
          recordVersion = JSON.stringify(record);
          setNotice('');
        }
        if (old) {
          const state = studyStore.getState();
          state.records = state.records.map((item) => (item.id === id ? record : item));
          studyStore.replaceState(state);
        } else studyStore.addAttempt(record);
        if (working === attempt) checkpoint();
      });
    void recordWrites.catch((error) => setNotice(`${error.message} 请保留当前页面后重试暂存。`));
    return recordWrites;
  }

  function flushReviewInk() {
    if (!reviewTimer) return false;
    clearTimeout(reviewTimer);
    reviewTimer = undefined;
    void storeAttempt();
    return true;
  }

  function recoveredAttempt(draft, record) {
    const changed = draft.savedVersion !== JSON.stringify(record || null);
    if (!changed) return { value: draft.attempt, copied: false };
    return {
      value: {
        ...draft.attempt,
        copyOf: draft.attempt.recordId,
        recordId: `a-${crypto.randomUUID()}`,
        createdAt: new Date().toISOString(),
      },
      copied: true,
    };
  }

  function render() {
    endComparison(false);
    renderFocus(false);
    ink?.destroy();
    ink = null;
    focusButton = null;
    launchComparison = null;
    if (!paper || !part) {
      host.innerHTML = '<p class="reading-paper-notice" role="status">暂未载入可作答的阅读原卷。</p>';
      return;
    }
    articleKind = part.pages.some(({ kind }) => kind === 'text') ? 'text' : null;
    answerKind = part.pages.some(({ kind }) => kind === 'question') ? 'question' : 'mixed';
    if (!part.pages.some(({ kind }) => kind === answerKind)) answerKind = null;
    const kinds = [articleKind, answerKind].filter(Boolean);
    if (!kinds.includes(activeKind)) activeKind = kinds[0];
    const submitted = !!attempt.recordId;
    host.innerHTML = `<section class="reading-paper-workspace" aria-labelledby="reading-paper-title">
      <header class="reading-paper-heading">
        <h1 id="reading-paper-title">阅读原卷 <span>Paper 1</span></h1>
        <a class="reading-paper-training" href="#reading" data-view="reading">证据专项练习</a>
      </header>
      <div class="reading-paper-controls">
        <label>年份 <select data-choice="year"></select></label>
        <label>卷别 <select data-choice="variant"></select></label>
        <label>Part <select data-choice="part"></select></label>
        <span class="reading-paper-phase">${submitted ? '复盘' : attempt.phase === 'retest' ? '无提示复测' : '作答中'}</span>
      </div>
      <nav class="reading-paper-tabs" aria-label="阅读卷面"></nav>
      <div class="reading-paper-documents"></div>
      <p class="reading-paper-status" role="status" hidden></p>
      <footer class="reading-paper-actions"></footer>
    </section>`;
    setNotice(notice);
    syncSelectors();
    for (const select of host.querySelectorAll('[data-choice]')) {
      select.onchange = () => {
        const field = select.dataset.choice;
        void change(
          {
            year: field === 'year' ? Number(select.value) : paper.year,
            variant: field === 'year' ? 'exam' : field === 'variant' ? select.value : paper.variant,
            part: field === 'part' ? select.value : part.id,
          },
          field,
        );
      };
    }
    const tabs = host.querySelector('.reading-paper-tabs');
    tabs.hidden = kinds.length < 2;
    const documents = host.querySelector('.reading-paper-documents');
    for (const kind of kinds) {
      const view = createDocument(kind);
      documents.append(view.section);
      const tab = button(titles[kind], () => activate(kind));
      tab.dataset.kind = kind;
      tabs.append(tab);
      if (kind === answerKind) mountAnswer(view, submitted);
      else
        view.setPages(
          part.pages.filter((page) => page.kind === kind),
          positions[kind],
          (_page, position) => {
            positions[kind] = position;
            checkpoint();
          },
        );
    }
    activate(activeKind);
    const actions = host.querySelector('.reading-paper-actions');
    if (submitted) {
      if (part.references.length) {
        launchComparison = button('对答案', startComparison, 'button-primary');
        actions.append(launchComparison);
      } else actions.append('本卷暂无评分参考');
      actions.append(
        button('关提示，再测一次', () => {
          flushReviewInk();
          attempt = fresh('retest');
          recordVersion = '';
          pinnedRecord = false;
          selectedRecordId = undefined;
          render();
          updateSession();
          revealAnswer();
        }),
      );
      if (part.questions.length) actions.append(mountChecks());
    } else {
      const submit = button(
        '交卷',
        async () => {
          if (!pending()) return;
          if (attempt.phase === 'first') {
            const currentSeen = seenMaterials();
            attempt.assisted = [taskKey(paper, part), `reading-paper:${paper.year}-${paper.variant}`].some(
              (id) => seen.has(id) || currentSeen.has(id),
            );
          }
          const working = attempt;
          const workspace = host.firstElementChild;
          workspace.inert = true;
          try {
            await storeAttempt();
          } catch {
            if (!working.recordId) recordWrites = Promise.resolve();
            return;
          } finally {
            workspace.inert = false;
          }
          if (working !== attempt) return;
          render();
          updateSession();
          host.querySelector('.reading-paper-actions button')?.focus({ preventScroll: true });
        },
        'button-primary',
      );
      submit.dataset.readingPaperSubmit = '';
      submit.disabled = !pending();
      actions.append(submit);
    }
  }

  function mountChecks() {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'reading-paper-checks';
    fieldset.innerHTML = `<legend>逐题自核</legend>
      <label>题号 <select data-check-question></select></label>
      <label>结果 <select data-check-result><option value="">待自核</option>
        <option value="correct">已核对</option><option value="retry">需重练</option></select></label>
      <label data-error-label hidden>错因 <select data-check-error></select></label>`;
    const question = fieldset.querySelector('[data-check-question]');
    const result = fieldset.querySelector('[data-check-result]');
    const error = fieldset.querySelector('[data-check-error]');
    setOptions(
      question,
      part.questions.map(({ number }) => [number, `第 ${number} 题`]),
      String(positions.checkNumber ?? positions.questionNumber ?? part.questions[0].number),
    );
    setOptions(error, [['', '选择错因'], ...readingErrors.map((value) => [value, value])], '');
    function sync() {
      const check = attempt.checks[question.value];
      positions.checkNumber = question.value;
      result.value = check?.status || '';
      error.value = check?.error || '';
      error.parentElement.hidden = result.value !== 'retry';
    }
    function changed() {
      if (result.value)
        attempt.checks[question.value] = {
          status: result.value,
          ...(result.value === 'retry' && error.value ? { error: error.value } : {}),
        };
      else delete attempt.checks[question.value];
      sync();
      if (!flushReviewInk()) void storeAttempt({ inkChanged: false });
    }
    question.onchange = () => {
      sync();
      checkpoint();
    };
    result.onchange = error.onchange = changed;
    sync();
    return fieldset;
  }

  function syncSelectors() {
    const elm = (id) => host.querySelector(`[data-choice=${id}]`);
    setOptions(
      elm('year'),
      years.map((year) => [year, year]),
      String(paper.year),
    );
    setOptions(
      elm('variant'),
      papers.filter((item) => item.year === paper.year).map(({ variant }) => [variant, variants[variant]]),
      paper.variant,
    );
    setOptions(
      elm('part'),
      paper.parts.map(({ id }) => [id, id]),
      part.id,
    );
  }

  function mountAnswer(view, submitted) {
    const tools = document.createElement('div');
    tools.className = 'ink-tools';
    view.heading.after(tools);
    focusButton = button('', () => renderFocus(!focused));
    focusButton.classList.add('reading-paper-focus');
    inkIcon(focusButton, 'expand', '放大题答卷');
    focusButton.setAttribute('aria-expanded', 'false');
    view.paging.append(focusButton);
    const answer = document.createElement('div');
    answer.className = 'reading-paper-typed';
    answer.innerHTML = `<label>题号 <select data-question></select></label>
      <textarea aria-label="打字作答" lang="en" rows="3" maxlength="4000" spellcheck="false"></textarea>`;
    const question = answer.querySelector('select');
    const field = answer.querySelector('textarea');
    setOptions(
      question,
      part.questions.map(({ number }) => [number, `第 ${number} 题`]),
      String(positions.questionNumber ?? part.questions[0]?.number),
    );
    field.readOnly = submitted;
    field.placeholder = '多个小题可按 (i)、(ii) 分行填写';
    const showAnswer = () => {
      positions.questionNumber = question.value;
      field.value = attempt.answers[question.value] || '';
      field.setAttribute('aria-label', `第 ${question.value} 题打字作答`);
    };
    question.onchange = () => {
      showAnswer();
      checkpoint();
    };
    showAnswer();
    field.oninput = () => {
      const wasPending = pending();
      if (field.value.trim()) attempt.answers[question.value] = field.value;
      else delete attempt.answers[question.value];
      refreshSubmission(wasPending);
      checkpoint();
    };
    view.section.append(answer);
    const rack = document.createElement('div');
    rack.className = 'reading-paper-modes';
    rack.setAttribute('role', 'group');
    rack.setAttribute('aria-label', '作答方式');
    const hand = button(submitted ? '卷面' : '手写', () => useMode('ink'));
    const type = button(submitted ? '打字答案' : '打字', () => useMode('typed'));
    rack.append(hand, type);
    if (part.questions.length) view.heading.after(rack);

    let pageId;
    const writing = {
      ink: submitted ? attempt.reviewInk : attempt.ink,
      submittedInk: attempt.ink,
      changed(_id, pages) {
        if (submitted) {
          attempt.reviewInk = pages;
          attempt.revision = (attempt.revision || 0) + 1;
          attempt.needsWrite = true;
          checkpoint();
          updateSession();
          clearTimeout(reviewTimer);
          reviewTimer = setTimeout(flushReviewInk, 700);
        } else {
          attempt.ink = pages;
          refreshSubmission();
          checkpoint();
        }
      },
    };
    ink = mountPaperInk(view.stage, tools, writing, submitted, 'reading-paper-');
    view.setPages(
      part.pages.filter(({ kind }) => kind === answerKind),
      positions[answerKind],
      (page, position) => {
        pageId = page.id;
        positions[answerKind] = position;
        ink.show(mode === 'ink' ? pageId : null);
        checkpoint();
      },
    );
    useMode(part.questions.length ? mode : 'ink');

    function useMode(next) {
      mode = next;
      hand.setAttribute('aria-pressed', String(mode === 'ink'));
      type.setAttribute('aria-pressed', String(mode === 'typed'));
      answer.hidden = mode !== 'typed';
      ink.show(mode === 'ink' ? pageId : null);
      checkpoint();
    }
  }

  function refreshSubmission(wasPending) {
    const submit = host.querySelector('[data-reading-paper-submit]');
    const before = wasPending ?? !submit?.disabled;
    if (submit) submit.disabled = !pending();
    if (before !== pending()) updateSession();
  }

  function startComparison() {
    if (!attempt.recordId || !part.references.length || comparison) return;
    renderFocus(false);
    const desktop = host.querySelector('.reading-paper-documents');
    const views = [...desktop.children].map((section) => ({
      section,
      kind: section.dataset.kind,
      title: titles[section.dataset.kind],
    }));
    const reader = createDocument('reference');
    const showReference = (index, start = 0) => {
      const reference = part.references[index];
      positions.referenceSource = index;
      reader.section.title = reference.label;
      reader.setPages(reference.pages, start, (_page, position) => {
        positions.reference = position;
        checkpoint();
      });
      markSeen(seen, taskKey(paper, part));
      if (reference.mixed) markSeen(seen, `reading-paper:${paper.year}-${paper.variant}`);
    };
    if (part.references.length > 1) {
      const source = document.createElement('select');
      source.className = 'reading-paper-reference-source';
      source.setAttribute('aria-label', '评分资料');
      setOptions(
        source,
        part.references.map(({ label }, i) => [i, label]),
        String(positions.referenceSource ?? 0),
      );
      source.onchange = () => showReference(Number(source.value));
      reader.heading.append(source);
    }
    views.push({ section: reader.section, kind: 'reference', title: titles.reference });
    const toolbar = document.createElement('div');
    toolbar.className = 'reading-paper-window-actions';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', '对答案视窗');
    launchComparison.before(toolbar);
    launchComparison.hidden = true;
    host.dataset.comparing = 'true';
    desktop.classList.add('reading-paper-comparison');
    desktop.setAttribute('role', 'region');
    desktop.setAttribute('aria-label', '对答案');
    const windows = mountReadingPaperWindows({ desktop, toolbar, views });
    comparison = { desktop, windows, toolbar };
    toolbar.append(
      button('重置布局', () => windows.reset()),
      button('结束对答案', () => endComparison(true, true)),
    );
    showReference(positions.referenceSource ?? 0, positions.reference);
    windows.focusReference();
  }

  function endComparison(restore, focusLauncher = false) {
    if (!comparison) return;
    const { desktop, windows, toolbar } = comparison;
    comparison = null;
    delete host.dataset.comparing;
    desktop.classList.remove('reading-paper-comparison');
    desktop.removeAttribute('role');
    desktop.removeAttribute('aria-label');
    windows.destroy(restore);
    toolbar.remove();
    launchComparison.hidden = false;
    if (focusLauncher) launchComparison.focus({ preventScroll: true });
  }

  function activate(kind) {
    activeKind = kind;
    if (kind) host.dataset.activeDocument = kind;
    for (const tab of host.querySelectorAll('.reading-paper-tabs button'))
      tab.setAttribute('aria-pressed', String(tab.dataset.kind === kind));
    checkpoint();
  }

  function renderFocus(next) {
    if (next === focused) return;
    focused = next;
    host.dataset.focused = String(next);
    if (appHeader) appHeader.inert = next;
    if (skipLink) skipLink.inert = next;
    if (next) activate(answerKind);
    focusButton?.setAttribute('aria-expanded', String(next));
    if (focusButton)
      inkIcon(focusButton, next ? 'collapse' : 'expand', next ? '退出放大题答卷' : '放大题答卷');
  }

  host.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && focused && !event.defaultPrevented) {
      renderFocus(false);
      focusButton?.focus({ preventScroll: true });
    }
  });

  function revealAnswer() {
    activate(answerKind);
    host
      .querySelector(`[data-kind="${answerKind}"] [data-reading-paper-skip]`)
      ?.focus({ preventScroll: true });
  }

  async function change(options, field, cached) {
    const requestedYear = Number(options.year ?? cached?.year ?? paper?.year ?? years[0]);
    const candidates = papers.filter(({ year }) => year === requestedYear);
    const nextPaper =
      candidates.find(({ variant }) => variant === (options.variant ?? cached?.variant ?? 'exam')) ??
      candidates[0] ??
      paper ??
      papers[0];
    const nextPart =
      nextPaper?.parts.find(({ id }) => id === (options.part ?? cached?.part ?? 'A')) ?? nextPaper?.parts[0];
    if (!nextPaper || !nextPart) return;
    if (nextPaper === paper && nextPart === part && !options.kind) {
      await refreshFromStore();
      return;
    }
    if (
      options.kind &&
      (nextPaper.year !== requestedYear ||
        nextPaper.variant !== options.variant ||
        nextPart.id !== options.part)
    )
      throw new Error('此阅读原卷暂不可用。');
    const restore =
      !options.kind &&
      cached?.year === nextPaper.year &&
      cached.variant === nextPaper.variant &&
      cached.part === nextPart.id
        ? cached
        : null;
    if (
      (pending() || (!restore && hasDraftAnswers(cached?.attempt))) &&
      !(await confirmAction('切换阅读卷', '当前作答还未交卷。切换会清除这份草稿。', '切换试卷'))
    ) {
      if (host.querySelector('[data-choice=year]')) syncSelectors();
      return false;
    }
    if (!visible) return false;
    flushReviewInk();
    const version = ++loadVersion;
    const workspace = host.querySelector('.reading-paper-workspace');
    if (workspace) workspace.inert = true;
    try {
      let copied = false;
      if (!restore && cached?.dirty && cached.attempt.recordId) {
        const savedPaper = papers.find(
          (item) => item.year === cached.year && item.variant === cached.variant,
        );
        const savedPart = savedPaper?.parts.find((item) => item.id === cached.part);
        if (savedPart) {
          const old = findRecord(savedPaper, savedPart, cached.attempt.recordId);
          const recovered = recoveredAttempt(cached, old);
          copied = recovered.copied;
          await storeAttempt({
            working: recovered.value,
            selectedPaper: savedPaper,
            selectedPart: savedPart,
          });
        }
      }
      const localRecord = findRecord(nextPaper, nextPart, options.recordId || restore?.attempt?.recordId);
      const versionRecord = options.record;
      if (
        versionRecord &&
        (versionRecord.id !== options.recordId || versionRecord.taskId !== taskKey(nextPaper, nextPart))
      )
        throw new Error('答卷版本与所选阅读卷不符。');
      const record = versionRecord || localRecord;
      const recovered = restore?.dirty && restore.attempt.recordId ? recoveredAttempt(restore, record) : null;
      copied ||= !!recovered?.copied;
      if (options.kind === 'review' && options.recordId && !record) throw new Error('未找到这轮阅读作答。');
      const restored =
        options.kind === 'retest'
          ? fresh('retest')
          : recovered?.value ||
            (restore?.attempt && !restore.attempt.recordId ? restore.attempt : await loadAttempt(record));
      if (version !== loadVersion) return;
      paper = nextPaper;
      part = nextPart;
      positions = restore?.positions || {};
      activeKind = restore?.activeKind || null;
      mode = restore?.mode === 'typed' ? 'typed' : mode;
      attempt = restored;
      recordVersion = JSON.stringify(record || null);
      pinnedRecord = !!versionRecord && recordVersion !== JSON.stringify(localRecord || null);
      selectedRecordId = options.kind === 'review' ? options.recordId : undefined;
      if (recovered) await storeAttempt();
      if (version !== loadVersion) return;
      cachedDraft = null;
      if (copied) setNotice('原答卷已有新版，本机草稿保留为待保存副本。');
      render();
      updateSession();
      if (options.kind === 'retest') revealAnswer();
      if (field) host.querySelector(`[data-choice=${field}]`)?.focus({ preventScroll: true });
      return true;
    } finally {
      if (workspace) workspace.inert = false;
    }
  }

  async function refreshFromStore() {
    if (
      !paper ||
      !attempt ||
      pinnedRecord ||
      pending() ||
      attempt.needsWrite ||
      (!attempt.recordId && attempt.phase === 'retest')
    )
      return;
    const current = attempt,
      version = loadVersion;
    const currentRecord = current.recordId && findRecord(paper, part, current.recordId);
    const savedRecord =
      current.recordId && studyStore.getSavedState().records.find(({ id }) => id === current.recordId);
    const recordId =
      selectedRecordId || (JSON.stringify(currentRecord) !== JSON.stringify(savedRecord) && current.recordId);
    const record = findRecord(paper, part, recordId);
    const signature = JSON.stringify(record || null);
    if (signature === recordVersion) {
      checkpoint();
      return;
    }
    if (!visible || (current.recordId && !record)) return;
    const loaded = await loadAttempt(record);
    if (
      !visible ||
      version !== loadVersion ||
      current !== attempt ||
      pending() ||
      current.needsWrite ||
      signature !== JSON.stringify(findRecord(paper, part, recordId) || null)
    )
      return;
    attempt = loaded;
    recordVersion = signature;
    render();
  }

  studyStore.subscribe(() =>
    queueMicrotask(() => {
      void refreshFromStore().catch((error) => setNotice(error.message));
    }),
  );

  return {
    async show(options = {}) {
      visible = true;
      if (!papers.length) render();
      else if (!paper || options.year || options.variant || options.part || options.kind) {
        await (draftLoading ||= readReadingDraft()
          .then((draft) => {
            if (draft?.attempt) {
              validatePaperInk(draft.attempt.ink);
              validatePaperInk(draft.attempt.reviewInk);
              cachedDraft = draft;
            }
          })
          .catch(() => setNotice('暂存的阅读草稿未能载入。')));
        if (!visible) return false;
        return change(options, undefined, cachedDraft);
      } else await refreshFromStore();
    },
    hide() {
      visible = false;
      loadVersion++;
      flushReviewInk();
      endComparison(true);
      renderFocus(false);
    },
    checkpoint,
    async readyToSave() {
      flushReviewInk();
      try {
        await recordWrites;
      } catch (error) {
        if (!attempt?.recordId || !attempt.needsWrite) throw error;
        await storeAttempt();
      }
    },
    hasPendingRecord: () => !!attempt?.recordId && !!attempt.needsWrite,
    hasUnsubmitted: pending,
    discardUnsubmitted() {
      if (!pending()) return;
      attempt = fresh(attempt.phase);
      recordVersion = '';
      pinnedRecord = false;
      selectedRecordId = undefined;
      render();
      updateSession();
    },
  };
}
