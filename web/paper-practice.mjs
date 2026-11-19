import { mountPaperInk } from './paper-ink.mjs';

export function mountPaperPractice({
  entries,
  sources,
  onSelect,
  onLibrary,
  onIntegrated,
  onReference,
  transcriptWindow,
}) {
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
    const action = document.getElementById('practice-integrated');
    if (action)
      action.hidden = !(
        selected.year === 2025 &&
        selected.variant === 'exam' &&
        selected.part === 'B1' &&
        selected.task === 6
      );
  }
  const integrated = document.createElement('button');
  integrated.type = 'button';
  integrated.id = 'practice-integrated';
  integrated.className = 'button-secondary';
  integrated.textContent = '做这题的 B1 综合训练';
  integrated.onclick = () => onIntegrated?.();
  host.append(integrated);
  sync();
  let sourceKey = '',
    displayedInk,
    openQuestionPage;
  const openMarking = document.getElementById('open-marking-page');
  function renderSources(lesson, phase, writing) {
    const target = document.getElementById('practice-sources');
    target.hidden = !lesson?.paper;
    if (!lesson?.paper) {
      openMarking.hidden = true;
      openMarking.onclick = null;
      openQuestionPage = null;
      target.replaceChildren();
      sourceKey = '';
      return;
    }
    const key = `${lesson.id}:${phase}:${writing?.mode || ''}`;
    if (key === sourceKey && displayedInk === writing?.ink) return;
    openMarking.hidden = true;
    openMarking.onclick = null;
    openQuestionPage = null;
    sourceKey = key;
    displayedInk = writing?.ink;
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
    const details = document.createElement(writingSheet ? 'section' : 'details');
    if (writingSheet) details.className = 'paper-writing-sheet';
    // The question is the default work area; full diagrams/Data File stay one action away.
    details.open = true;
    const summary = document.createElement(writingSheet ? 'h2' : 'summary');
    if (writingSheet) summary.className = 'sr-only';
    summary.textContent = phase === 'review' ? '原卷与评分参考' : '原卷题页与 Data File';
    details.append(summary);
    const notice = document.createElement('p');
    notice.className = 'fine-print';
    notice.textContent =
      original?.containsAnswers && phase !== 'review'
        ? '这份扫描件混有答案，首答与复测期间收起；提交后可对照。'
        : '原题保留原卷版面；页码为扫描文件页码。';
    details.append(notice);
    if (writing && phase !== 'review' && documents.includes(original)) {
      const modes = document.createElement('div');
      modes.className = 'paper-answer-modes';
      for (const [mode, label] of [
        ['type', '打字作答'],
        ['ink', '手写作答'],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.setAttribute('aria-pressed', String(mode === writing.mode));
        button.onclick = () => writing.setMode(mode);
        modes.append(button);
      }
      if (writing.mode === 'ink') {
        const focus = document.createElement('button');
        focus.type = 'button';
        const syncFocus = (expanded) => {
          document.body.dataset.paperFocus = String(expanded);
          focus.textContent = expanded ? '收起书写区' : '展开书写区';
          focus.setAttribute('aria-expanded', String(expanded));
        };
        syncFocus(true);
        focus.onclick = () => syncFocus(document.body.dataset.paperFocus !== 'true');
        modes.append(focus);
      }
      details.append(modes);
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
      previous.textContent = '上一页';
      const next = document.createElement('button');
      next.type = 'button';
      next.textContent = '下一页';
      const zoom = document.createElement('button');
      zoom.type = 'button';
      zoom.textContent = '放大题页';
      zoom.setAttribute('aria-pressed', 'false');
      const pageInput = document.createElement('input');
      pageInput.type = 'number';
      pageInput.min = '1';
      pageInput.id = 'practice-page';
      pageInput.setAttribute('aria-label', '原卷页码');
      const count = document.createElement('span');
      const wrap = document.createElement('div');
      wrap.className = 'practice-page-wrap';
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
        zoom.textContent = enlarged ? '适合宽度' : '放大题页';
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
      const ink = writing?.mode === 'ink' ? mountPaperInk(stage, inkTools, writing) : null;
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
        image.src = scan.src;
        image.alt = `${source.name} 第 ${page} 页`;
        if (source.role === 'marking' && phase === 'review') onReference?.(paper);
        ink?.show(source === original ? source.id + ':' + page : null);
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
        if (
          matchMedia('(max-width: 759px)').matches &&
          !target.querySelector('dialog[open]') &&
          !openMarking.hidden
        )
          openMarking.scrollIntoView({ block: 'center', behavior: 'instant' });
        if (!target.querySelector('dialog[open]') && !openMarking.hidden)
          openMarking.focus({ preventScroll: true });
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
      if (phase === 'review') {
        const expand = document.createElement('button');
        expand.type = 'button';
        expand.textContent = '展开原卷';
        const dialog = document.createElement('dialog');
        dialog.className = 'practice-page-dialog';
        dialog.setAttribute('aria-label', '原卷大图');
        target.append(dialog);
        expand.onclick = () => {
          if (dialog.open) return dialog.close();
          dialog.append(details);
          details.open = true;
          expand.textContent = '返回核对';
          dialog.showModal();
          transcriptWindow.paperDialogChanged();
          expand.focus();
        };
        dialog.onclose = () => {
          target.append(details);
          transcriptWindow.paperDialogChanged();
          expand.textContent = '展开原卷';
          expand.focus();
        };
        toolbar.append(expand);
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
        questionButton.onclick = () => {
          select.value = paper.questionSourceId;
          show(paper.questionPage);
        };
        toolbar.append(dataButton, questionButton);
      }
      if (phase === 'review' && lesson.sentences?.length) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.id = 'paper-float-transcript';
        toggle.textContent = '浮动字幕';
        toggle.setAttribute('aria-pressed', String(transcriptWindow.open));
        toggle.onclick = () => transcriptWindow.toggle();
        toolbar.append(toggle);
      }
      details.append(toolbar, inkTools, wrap);
      const remembered = writing?.page;
      if (remembered && documents.some((s) => s.id === remembered.sourceId)) {
        select.value = remembered.sourceId;
        show(remembered.page);
      } else show(select.value === paper.questionSourceId ? paper.questionPage : 1);
    }
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
