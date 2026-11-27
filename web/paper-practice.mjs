import { activeAccount } from './account-scope.mjs';
import { bookFor, loadBooks } from './answer-books.mjs';
import { mountPaperInk } from './paper-ink.mjs';
import { inkIcon } from './ink-icons.mjs';
import { mountPaperGestures, mountPaperZoom } from './paper-zoom.mjs';

function bindResizeGrip(grip, { value, minimum, maximum, set, direction = 1 }) {
  const limit = (next) => Math.round(Math.max(minimum, Math.min(maximum(), next)));
  const update = () => {
    grip.setAttribute('aria-valuemin', String(minimum));
    grip.setAttribute('aria-valuemax', String(maximum()));
    grip.setAttribute('aria-valuenow', String(limit(value())));
  };
  const resize = (next) => {
    set(limit(next));
    update();
  };
  let drag;
  grip.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    grip.focus({ preventScroll: true });
    grip.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, y: event.clientY, value: value() };
  });
  grip.addEventListener('pointermove', (event) => {
    if (drag?.pointer === event.pointerId) resize(drag.value + direction * (event.clientY - drag.y));
  });
  grip.addEventListener('lostpointercapture', () => {
    drag = undefined;
  });
  grip.addEventListener('keydown', (event) => {
    const values = {
      ArrowUp: value() - 16 * direction,
      ArrowDown: value() + 16 * direction,
      Home: minimum,
      End: maximum(),
    };
    if (!Object.hasOwn(values, event.key)) return;
    event.preventDefault();
    resize(values[event.key]);
  });
  return update;
}

function mountWorkspaceResize() {
  const grip = document.getElementById('paper-workspace-resize');
  if (!grip) return () => {};
  const regions = ['paper-title-space', 'paper-controls-space'].map((id) => document.getElementById(id));
  const height = ({ firstElementChild: content }) =>
    content.offsetHeight + (parseFloat(getComputedStyle(content).marginBlockEnd) || 0);
  const maximum = () => regions.reduce((sum, region) => sum + height(region), 0);
  let lift = 0;
  function apply() {
    let remaining = grip.hidden ? 0 : lift;
    for (const region of regions) {
      const size = height(region);
      const shrink = Math.min(size, remaining);
      region.style.blockSize = shrink ? `${size - shrink}px` : '';
      region.toggleAttribute('data-compressed', shrink > 0);
      region.inert = size > 0 && shrink === size;
      const clippedAt = shrink && !region.inert ? region.getBoundingClientRect().bottom : Infinity;
      for (const control of region.querySelectorAll('button, select, a[href], input, summary')) {
        control.inert = control.getBoundingClientRect().bottom > clippedAt + 0.5;
      }
      remaining -= shrink;
    }
  }
  const update = bindResizeGrip(grip, {
    value: () => Math.min(lift, maximum()),
    minimum: 0,
    maximum,
    direction: -1,
    set(next) {
      lift = next;
      apply();
    },
  });
  const observe = new ResizeObserver(() => {
    if (grip.hidden) return;
    apply();
    update();
  });
  for (const region of regions) observe.observe(region.firstElementChild);
  return (visible, reset = false) => {
    if (reset) lift = 0;
    grip.hidden = !visible;
    apply();
    if (visible) update();
  };
}

export function mountPaperPractice({ entries, sources, onSelect, onLibrary, onIntegrated, onReference }) {
  const host = document.getElementById('practice-picker');
  const fields = ['year', 'variant', 'part', 'task'];
  const labels = { year: '年份', variant: '卷别', part: 'Part', task: 'Task' };
  const names = { exam: '正式试卷', practice: 'Practice', sample: 'Sample' };
  let selected = entries.find((e) => e.year === 2025 && e.part === 'A' && e.task === 1) || entries[0];
  const selects = {};
  for (const field of fields) {
    const label = document.createElement('label');
    label.textContent = labels[field];
    const select = document.createElement('select');
    select.id = `practice-${field}`;
    selects[field] = select;
    label.append(select);
    host.append(label);
    select.addEventListener('change', async () => {
      const previous = selected;
      const index = fields.indexOf(field);
      const candidates = entries.filter((e) =>
        fields.slice(0, index + 1).every((f) => String(e[f]) === selects[f].value),
      );
      selected =
        candidates.find((e) => fields.slice(index + 1).every((f) => String(e[f]) === String(previous[f]))) ||
        candidates[0];
      sync();
      if ((await onSelect(selected)) === false) {
        selected = previous;
        sync();
      }
    });
  }
  function sync() {
    fields.forEach((field, index) => {
      const matches = entries.filter((e) => fields.slice(0, index).every((f) => e[f] === selected[f]));
      const values = [...new Set(matches.map((e) => e[field]))];
      if (field === 'year') values.sort((a, b) => b - a);
      if (field === 'task') values.sort((a, b) => a - b);
      selects[field].replaceChildren(
        ...values.map(
          (v) =>
            new Option(
              names[v] || (field === 'part' ? `Part ${v}${v === 'B2' ? ' · 参考' : ''}` : String(v)),
              String(v),
            ),
        ),
      );
      selects[field].value = String(selected[field]);
    });
  }
  const integrated = document.createElement('button');
  integrated.type = 'button';
  integrated.id = 'practice-integrated';
  integrated.className = 'button-secondary';
  integrated.textContent = 'B1 综合训练 · 2025 Task 6';
  integrated.onclick = () => onIntegrated?.();
  host.append(integrated);
  sync();
  const showWorkspaceResize = mountWorkspaceResize();
  let sourceKey = '',
    displayedInk,
    displayedSubmission,
    openQuestionPage,
    previewHeight,
    writingHeight,
    previewObserver,
    mountedInk;
  function previewResize(target, wrap, writingSheet) {
    const grip = document.createElement('div');
    grip.className = 'paper-preview-resize';
    grip.tabIndex = 0;
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-label', writingSheet ? '调整手写原卷下沿' : '调整原卷预览高度');
    grip.setAttribute('aria-orientation', 'horizontal');
    grip.setAttribute('aria-controls', wrap.id);
    const minimum = 160;
    const maximum = () => {
      const height = window.visualViewport?.height || innerHeight;
      return Math.max(minimum, Math.floor(writingSheet ? height * 0.95 : Math.min(640, height * 0.75)));
    };
    const apply = (height) => {
      target.dataset.previewResized = '';
      target.style.setProperty('--paper-preview-height', `${height}px`);
    };
    const update = bindResizeGrip(grip, {
      value: () => wrap.getBoundingClientRect().height,
      minimum,
      maximum,
      set(next) {
        if (writingSheet) writingHeight = next;
        else previewHeight = next;
        apply(next);
      },
    });
    const rememberedHeight = writingSheet ? writingHeight : previewHeight;
    if (rememberedHeight !== undefined) apply(rememberedHeight);
    previewObserver = new ResizeObserver(update);
    previewObserver.observe(wrap);
    previewObserver.observe(document.documentElement);
    return grip;
  }
  const openMarking = document.getElementById('open-marking-page');
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.body.dataset.view !== 'listening')
      return;
    const exit = document.querySelector('.paper-writing-sheet .paper-focus-toggle[aria-expanded="true"]');
    if (!exit?.getClientRects().length) return;
    // Touching a menu on iPad may leave keyboard focus outside its controls.
    const menu = exit
      .closest('.paper-writing-sheet')
      .querySelector('button[aria-controls][aria-expanded="true"]');
    const control = menu || exit;
    event.preventDefault();
    control.click();
    control.focus({ preventScroll: true });
  });
  function renderSources(lesson, phase, writing) {
    const target = document.getElementById('practice-sources');
    const modeSlot = document.getElementById('paper-mode-slot');
    target.hidden = !lesson?.paper;
    if (!lesson?.paper) {
      showWorkspaceResize(false, true);
      delete document.body.dataset.paperFocus;
      previewObserver?.disconnect();
      mountedInk?.destroy();
      mountedInk = null;
      delete target.dataset.previewResized;
      modeSlot.replaceChildren();
      openMarking.hidden = true;
      openMarking.onclick = null;
      openQuestionPage = null;
      target.replaceChildren();
      sourceKey = '';
      return;
    }
    const key = `${lesson.id}:${phase}:${writing?.mode || ''}`;
    if (key === sourceKey && displayedInk === writing?.ink && displayedSubmission === writing?.submittedInk)
      return;
    previewObserver?.disconnect();
    mountedInk?.destroy();
    mountedInk = null;
    delete target.dataset.previewResized;
    modeSlot.replaceChildren();
    openMarking.hidden = true;
    openMarking.onclick = null;
    openQuestionPage = null;
    const sameWorkspace = sourceKey === key;
    sourceKey = key;
    displayedInk = writing?.ink;
    displayedSubmission = writing?.submittedInk;
    const paper = lesson.paper;
    const related = sources.filter(
      (s) => s.year === paper.year && s.variant === paper.variant && (s.paper === 3 || s.paper === null),
    );
    const original = sources.find((s) => s.id === paper.questionSourceId);
    const documents = [];
    if (original && (phase === 'review' || !original.containsAnswers)) documents.push(original);
    for (const s of related.filter(
      (s) => s.role === 'data' && (!s.parts.length || s.parts.includes(paper.part)),
    )) {
      if (!s.containsAnswers || phase === 'review') documents.push(s);
    }
    if (phase === 'review') {
      const refs = new Set((paper.referencePages || []).map((p) => p.sourceId));
      for (const s of related.filter((s) => refs.has(s.id) || (!refs.size && s.role === 'marking'))) {
        if (!documents.some((d) => d.id === s.id)) documents.push(s);
      }
    }
    target.replaceChildren();
    const writingSheet = writing?.mode === 'ink' && phase !== 'review';
    if (!writingSheet) delete document.body.dataset.paperFocus;
    if (!writingSheet || !sameWorkspace) showWorkspaceResize(false, true);
    const details = document.createElement(writingSheet ? 'section' : 'details');
    if (writingSheet) details.className = 'paper-writing-sheet';
    const reviewing = !!writing && phase === 'review';
    if (reviewing) details.className = 'paper-review-sheet';
    // The question is the default work area; full diagrams/Data File stay one action away.
    details.open = true;
    const summary = document.createElement(writingSheet ? 'h2' : 'summary');
    summary.textContent = phase === 'review' ? '原卷与评分参考' : '原卷题页与 Data File';
    if (writingSheet) {
      summary.className = 'paper-focus-context';
      const variant = paper.variant === 'exam' ? '' : ' ' + names[paper.variant];
      summary.textContent = `${paper.year}${variant} Part ${paper.part} · Task ${paper.task}`;
    }
    details.append(summary);
    const notice = document.createElement('p');
    notice.className = 'fine-print';
    const mixedAnswers = original?.containsAnswers && phase !== 'review';
    notice.textContent = mixedAnswers
      ? '这份扫描件混有答案，首答与复测期间收起；提交后可对照。'
      : '原题保留原卷版面；页码为扫描文件页码。';
    if (mixedAnswers) details.append(notice);
    if (writing && phase !== 'review' && documents.includes(original)) {
      const modes = document.createElement('div');
      modes.className = 'paper-answer-modes';
      modes.setAttribute('role', 'group');
      modes.setAttribute('aria-label', '作答方式');
      for (const [mode, label] of [
        ['type', '打字作答'],
        ['ink', '手写作答'],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        inkIcon(button, mode === 'type' ? 'keyboard' : 'write', label, mode === 'type' ? '打字' : '手写');
        button.setAttribute('aria-pressed', String(mode === writing.mode));
        button.onclick = () => writing.setMode(mode);
        modes.append(button);
      }
      if (writing.mode === 'ink') {
        const focus = document.createElement('button');
        focus.type = 'button';
        focus.className = 'paper-focus-toggle';
        const syncFocus = (expanded) => {
          document.body.dataset.paperFocus = String(expanded);
          showWorkspaceResize(!expanded);
          const label = expanded ? '退出全屏' : '全屏书写';
          inkIcon(focus, expanded ? 'collapse' : 'expand', label, label);
          focus.setAttribute('aria-expanded', String(expanded));
        };
        syncFocus(!sameWorkspace || document.body.dataset.paperFocus === 'true');
        focus.onclick = () => {
          const viewport = details.querySelector('.practice-page-wrap');
          const stage = viewport.firstElementChild;
          const left = viewport.scrollLeft / (stage.offsetWidth || 1);
          const top = viewport.scrollTop / (stage.offsetHeight || 1);
          const expanded = document.body.dataset.paperFocus !== 'true';
          syncFocus(expanded);
          viewport.scrollTo({
            left: left * stage.offsetWidth,
            top: top * stage.offsetHeight,
            behavior: 'instant',
          });
          if (!expanded) focus.focus({ preventScroll: true });
        };
        modes.append(focus);
      }
      (writingSheet ? details : modeSlot).append(modes);
    }
    if (documents.length) {
      const toolbar = document.createElement('div');
      toolbar.className = 'practice-document-tools';
      const select = document.createElement('select');
      select.id = 'practice-document';
      select.setAttribute('aria-label', '选择原题或评分参考');
      for (const s of documents) {
        const option = new Option(
          `${s.role === 'marking' ? '评分参考 · ' : s.role === 'data' ? 'Data File · ' : ''}${s.name}`,
          s.id,
        );
        if (s.role !== 'question' && s.role !== 'data') option.dataset.reference = 'true';
        select.append(option);
      }
      const previous = document.createElement('button');
      previous.type = 'button';
      inkIcon(previous, 'prev', '上一页');
      const next = document.createElement('button');
      next.type = 'button';
      inkIcon(next, 'next', '下一页');
      const zoom = document.createElement('button');
      zoom.type = 'button';
      inkIcon(zoom, 'zoom', '放大题页');
      zoom.setAttribute('aria-pressed', 'false');
      const pageInput = document.createElement('input');
      pageInput.type = 'number';
      pageInput.min = '1';
      pageInput.id = 'practice-page';
      pageInput.setAttribute('aria-label', '原卷页码');
      const count = document.createElement('span');
      const wrap = document.createElement('div');
      wrap.className = 'practice-page-wrap';
      wrap.id = 'paper-preview';
      wrap.tabIndex = 0;
      wrap.setAttribute('role', 'region');
      wrap.setAttribute('aria-label', '原卷页图');
      const image = document.createElement('img');
      image.id = 'practice-image';
      image.decoding = 'async';
      const error = document.createElement('p');
      error.hidden = true;
      error.textContent = '题页未能载入，请换页重试。';
      const stage = document.createElement('div');
      stage.className = 'paper-page-stage';
      stage.append(image);
      wrap.append(stage, error);
      function setZoom(enlarged) {
        wrap.classList.toggle('is-zoomed', enlarged);
        const label = enlarged ? '适合宽度' : '放大题页';
        inkIcon(zoom, enlarged ? 'fit' : 'zoom', label);
        zoom.setAttribute('aria-pressed', String(enlarged));
      }
      zoom.onclick = () => setZoom(!wrap.classList.contains('is-zoomed'));
      let page = 1;
      let shownSource, returnView;
      const back = document.createElement('button');
      back.type = 'button';
      back.hidden = true;
      back.textContent = '返回题页';
      const inkTools = document.createElement('div');
      inkTools.className = 'ink-tools';
      const editor = reviewing
        ? {
            ...writing,
            changed(key, pages) {
              displayedInk = pages;
              writing.changed(key, pages);
            },
          }
        : writing;
      const ink = (mountedInk =
        reviewing || writing?.mode === 'ink' ? mountPaperInk(stage, inkTools, editor, reviewing) : null);
      function show(number, view) {
        const source = documents.find((s) => s.id === select.value);
        if (source.role === 'marking' && shownSource && shownSource.role !== 'marking') {
          returnView = {
            sourceId: shownSource.id,
            page,
            left: wrap.scrollLeft,
            top: wrap.scrollTop,
            zoom: wrap.classList.contains('is-zoomed'),
          };
          setZoom(false);
        }
        shownSource = source;
        page = Math.max(1, Math.min(source.pages.length, Number(number) || 1));
        pageInput.max = String(source.pages.length);
        pageInput.value = String(page);
        count.textContent = `/ ${source.pages.length}`;
        previous.disabled = page === 1;
        next.disabled = page === source.pages.length;
        const scan = source.pages[page - 1];
        image.width = scan.width;
        image.height = scan.height;
        const frozen =
          source === original && writing?.originals?.find((p) => p.key === source.id + ':' + page);
        image.src = frozen ? '/api/books/master/' + frozen.master : scan.src;
        image.alt = `${source.name} 第 ${page} 页`;
        if (source.role === 'marking' && phase === 'review') onReference?.(paper);
        const frozenBook = writing?.originals || bookFor(paper)?.pages;
        const writable =
          source === original &&
          (!activeAccount ||
            frozenBook?.some(
              (p) => !p.attachment && p.key === source.id + ':' + page && p.part === paper.part,
            ));
        ink?.show(writable ? source.id + ':' + page : null);
        if (writingSheet && activeAccount) {
          const readOnlyPage = source === original && !writable;
          notice.classList.toggle('paper-read-only', readOnlyPage);
          notice.hidden = !readOnlyPage;
          if (readOnlyPage) notice.textContent = '此页用于查阅。回到本 Part 的题页即可继续书写。';
        }
        if ((activeAccount || reviewing) && !frozenBook && ink && original)
          loadBooks()
            .then(() => {
              if (activeAccount && bookFor(paper) && image.isConnected && shownSource === source) show(page);
            })
            .catch(() => {});

        writing?.setPage(source.id, page);
        error.hidden = true;
        if (view) setZoom(view.zoom);
        wrap.scrollTo(view?.left || 0, view?.top || 0);
        back.hidden = source.role !== 'marking' || !writing;
        back.textContent =
          returnView && returnView.sourceId === paper.dataFile?.sourceId ? '返回 Data File' : '返回题页';
        openMarking.setAttribute('aria-pressed', String(source.role === 'marking'));
      }
      if (documents.includes(original))
        openQuestionPage = (number) => {
          details.open = true;
          select.value = original.id;
          show(number);
        };
      image.onerror = () => {
        error.hidden = false;
      };
      select.onchange = () =>
        show(
          select.value === paper.questionSourceId
            ? paper.questionPage
            : paper.referencePages?.find((r) => r.sourceId === select.value)?.page || 1,
        );
      previous.onclick = () => show(page - 1);
      next.onclick = () => show(page + 1);
      pageInput.onchange = () => show(pageInput.value);
      if (phase === 'review') {
        const documentRow = document.createElement('div');
        documentRow.className = 'practice-document-row';
        documentRow.append(back, select);
        toolbar.append(documentRow);
      } else toolbar.append(select);
      toolbar.append(previous, pageInput, count, next, zoom);
      back.onclick = () => {
        select.value = returnView?.sourceId || paper.questionSourceId;
        show(returnView?.page || writing?.page?.questionPage || paper.questionPage, returnView);
        if (matchMedia('(max-width: 759px)').matches && !openMarking.hidden)
          openMarking.scrollIntoView({ block: 'center', behavior: 'instant' });
        if (!openMarking.hidden) openMarking.focus({ preventScroll: true });
      };
      if (phase === 'review' && writing) {
        const references = paper.referencePages?.filter((ref) =>
          documents.some((s) => s.id === ref.sourceId && s.role === 'marking' && s.pages[ref.page - 1]),
        );
        if (references?.length) {
          openMarking.hidden = false;
          openMarking.onclick = () => {
            if (shownSource?.role === 'marking') {
              back.click();
              return;
            }
            const questions = document.getElementById('questions');
            const top = questions.getBoundingClientRect().top;
            const card = Array.from(questions.querySelectorAll('[data-question-id]:not([hidden])')).find(
              (node) => node.getBoundingClientRect().bottom > top + 1,
            );
            const questionRef = lesson.questions.find((q) => q.id === card?.dataset.questionId)?.reference;
            const reference =
              references.find(
                (ref) => ref.sourceId === questionRef?.sourceId && ref.page === questionRef.page,
              ) || references[0];
            details.open = true;
            select.value = reference.sourceId;
            show(reference.page);
            if (matchMedia('(max-width: 759px)').matches) {
              back.focus({ preventScroll: true });
              back.scrollIntoView({ block: 'start', behavior: 'instant' });
            }
          };
        }
      }
      if (paper.dataFile && documents.some((s) => s.id === paper.dataFile.sourceId)) {
        const dataButton = document.createElement('button');
        dataButton.type = 'button';
        dataButton.textContent = 'Data File';
        dataButton.onclick = () => {
          select.value = paper.dataFile.sourceId;
          show(paper.dataFile.page);
        };
        const questionButton = document.createElement('button');
        questionButton.type = 'button';
        questionButton.textContent = '回到原题';
        if (writingSheet) {
          inkIcon(dataButton, 'data', 'Data File', 'Data File');
          inkIcon(questionButton, 'paper', '回到原题', '回到原题');
        }
        questionButton.onclick = () => {
          select.value = paper.questionSourceId;
          show(paper.questionPage);
        };
        toolbar.append(dataButton, questionButton);
      }
      if (writingSheet) {
        const header = document.createElement('div');
        header.className = 'paper-writing-header';
        const modes = details.querySelector('.paper-answer-modes');
        header.append(summary, toolbar);
        if (modes) {
          modes.prepend(mountPaperZoom(wrap, stage, zoom));
          header.append(modes);
        }
        details.append(header, notice);
      } else {
        if (ink) mountPaperGestures(wrap, stage);
        details.append(toolbar);
      }
      details.append(inkTools, wrap);
      details.append(previewResize(target, wrap, writingSheet));
      const remembered = writing?.page;
      if (remembered && documents.some((s) => s.id === remembered.sourceId)) {
        select.value = remembered.sourceId;
        show(remembered.page);
      } else show(select.value === paper.questionSourceId ? paper.questionPage : 1);
    }
    if (!writingSheet && !mixedAnswers) details.append(notice);
    if (phase === 'review') {
      const library = document.createElement('button');
      library.type = 'button';
      library.className = 'button-text';
      library.textContent = '在原卷资料库查看完整文件';
      library.onclick = () => onLibrary(paper);
      details.append(library);
    }
    target.append(details);
  }
  return {
    get selected() {
      return selected;
    },
    setEntry(id) {
      const entry = entries.find((e) => e.id === id);
      if (entry) {
        selected = entry;
        sync();
      }
    },
    renderSources,
    showQuestionPage(number) {
      openQuestionPage?.(number);
    },
    sourcePage(reference) {
      const source = sources.find((s) => s.id === reference?.sourceId);
      return source?.pages[reference.page - 1]
        ? { ...source.pages[reference.page - 1], name: source.name }
        : null;
    },
    renderUnavailable(entry) {
      const original = sources.find(
        (s) =>
          s.year === entry.year &&
          s.variant === entry.variant &&
          s.paper === 3 &&
          s.role === 'question' &&
          s.tasks?.some((t) => t.part === entry.part && t.number === entry.task),
      );
      const task = original?.tasks.find((t) => t.part === entry.part && t.number === entry.task);
      const marking = sources.find(
        (s) =>
          s.year === entry.year && s.variant === entry.variant && s.role === 'marking' && s.paper === null,
      );
      renderSources(
        {
          id: entry.id,
          paper: {
            year: entry.year,
            variant: entry.variant,
            part: entry.part,
            task: entry.task,
            questionSourceId: original?.id,
            questionPage: task?.page || 1,
            referencePages: marking
              ? [
                  {
                    sourceId: marking.id,
                    page: { 1: 9, 2: 10, 3: 11, 4: 11, 5: 12, 6: 13, 7: 15 }[entry.task] || 1,
                  },
                ]
              : [],
          },
        },
        'review',
      );
    },
  };
}
