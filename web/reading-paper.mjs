import { confirmAction } from './confirmation.mjs';
import { validatePaperInk } from './core.mjs';
import { inkIcon } from './ink-icons.mjs';
import { mountPaperInk } from './paper-ink.mjs';
import { markSeen, seenMaterials } from './paper-recovery.mjs';
import { mountPaperZoom } from './paper-zoom.mjs';
import { buildReadingPaperCatalogue } from './reading-paper-catalogue.mjs';
import { mountReadingPaperWindows } from './reading-paper-windows.mjs';
import { studyStore } from './training-core.mjs';

const variants = { exam: '正式卷', practice: 'Practice Paper', sample: 'Sample Paper' };
const titles = { text: '阅读原文', question: '题答卷', mixed: '阅读原卷', reference: '评分参考' };
const taskKey = (paper, part) => `reading-paper:${paper.year}-${paper.variant}:${part.id}`;

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
  const seen = seenMaterials();
  const appHeader = document.querySelector('.app-header');
  const skipLink = document.querySelector('.skip-link');
  const pending = () =>
    !!attempt &&
    !attempt.recordId &&
    (Object.keys(attempt.ink).length > 0 || Object.values(attempt.answers).some((answer) => answer.trim()));
  const updateSession = () => bridge.onSessionChange?.();
  const fresh = (phase = 'first') => ({ phase, answers: {}, ink: {}, reviewInk: {}, recordId: null });

  function loadAttempt() {
    const record = studyStore
      .getState()
      .records.findLast(({ module, taskId }) => module === 'reading' && taskId === taskKey(paper, part));
    attempt = record
      ? {
          ...fresh(record.phase),
          answers: record.answers || {},
          ink: record.details?.readingPaper?.ink || {},
          reviewInk: record.details?.readingPaper?.reviewInk || {},
          recordId: record.id,
          assisted: record.assisted,
        }
      : fresh();
  }

  function recordData() {
    return {
      module: 'reading',
      taskId: taskKey(paper, part),
      phase: attempt.phase,
      assisted: attempt.assisted,
      answers: attempt.answers,
      source: `${paper.year} HKDSE English Language Paper 1 · ${variants[paper.variant]} · Part ${part.id}`,
      details: {
        readingPaper: { ink: validatePaperInk(attempt.ink), reviewInk: validatePaperInk(attempt.reviewInk) },
      },
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
      <footer class="reading-paper-actions"></footer>
    </section>`;
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
          attempt = fresh('retest');
          render();
          updateSession();
          revealAnswer();
        }),
      );
    } else {
      const submit = button(
        '交卷',
        () => {
          if (!pending()) return;
          if (attempt.phase === 'first') {
            const currentSeen = seenMaterials();
            attempt.assisted = [taskKey(paper, part), `reading-paper:${paper.year}-${paper.variant}`].some(
              (id) => seen.has(id) || currentSeen.has(id),
            );
          }
          attempt.recordId = studyStore.addAttempt(recordData());
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
    question.onchange = showAnswer;
    showAnswer();
    field.oninput = () => {
      const wasPending = pending();
      if (field.value.trim()) attempt.answers[question.value] = field.value;
      else delete attempt.answers[question.value];
      refreshSubmission(wasPending);
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
          const state = studyStore.getState();
          state.records = state.records.map((record) =>
            record.id === attempt.recordId ? { ...record, ...recordData() } : record,
          );
          studyStore.replaceState(state);
        } else {
          attempt.ink = pages;
          refreshSubmission();
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
      },
    );
    useMode(part.questions.length ? mode : 'ink');

    function useMode(next) {
      mode = next;
      hand.setAttribute('aria-pressed', String(mode === 'ink'));
      type.setAttribute('aria-pressed', String(mode === 'typed'));
      answer.hidden = mode !== 'typed';
      ink.show(mode === 'ink' ? pageId : null);
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

  async function change(options, field) {
    const requestedYear = Number(options.year ?? paper?.year ?? years[0]);
    const candidates = papers.filter(({ year }) => year === requestedYear);
    const nextPaper =
      candidates.find(({ variant }) => variant === (options.variant ?? 'exam')) ??
      candidates[0] ??
      paper ??
      papers[0];
    const nextPart = nextPaper?.parts.find(({ id }) => id === (options.part ?? 'A')) ?? nextPaper?.parts[0];
    if (!nextPaper || !nextPart || (nextPaper === paper && nextPart === part)) return;
    if (
      pending() &&
      !(await confirmAction('切换阅读卷', '当前作答还未交卷。切换会清除这份草稿。', '切换试卷'))
    ) {
      syncSelectors();
      return;
    }
    paper = nextPaper;
    part = nextPart;
    positions = {};
    activeKind = null;
    loadAttempt();
    render();
    updateSession();
    if (field) host.querySelector(`[data-choice=${field}]`)?.focus({ preventScroll: true });
  }

  return {
    async show(options = {}) {
      if (!papers.length) render();
      else if (!paper || options.year || options.variant || options.part) await change(options);
    },
    hide() {
      endComparison(true);
      renderFocus(false);
    },
    hasUnsubmitted: pending,
    discardUnsubmitted() {
      if (!pending()) return;
      attempt = fresh(attempt.phase);
      render();
      updateSession();
    },
    clear() {
      this.hide();
      ink?.destroy();
      host.replaceChildren();
      paper = part = attempt = ink = null;
    },
  };
}
