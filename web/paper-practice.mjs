// Original sources share the focused player; this module only selects and displays documents.
export function mountPaperPractice({ entries, sources, onSelect, onLibrary, onIntegrated }) {
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
  let sourceKey = '';
  function renderSources(lesson, phase) {
    const target = document.getElementById('practice-sources');
    target.hidden = !lesson?.paper;
    if (!lesson?.paper) {
      target.replaceChildren();
      sourceKey = '';
      return;
    }
    const key = `${lesson.id}:${phase}`;
    if (key === sourceKey) return;
    sourceKey = key;
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
      for (const s of related.filter((s) => refs.has(s.id) || s.role === 'marking')) {
        if (!documents.some((d) => d.id === s.id)) documents.push(s);
      }
    }
    target.replaceChildren();
    const details = document.createElement('details');
    // The question is the default work area; full diagrams/Data File stay one action away.
    details.open = phase !== 'review' && lesson.paper.part !== 'A';
    const summary = document.createElement('summary');
    summary.textContent = phase === 'review' ? '查看原题与评分参考' : '原卷题页与 Data File';
    details.append(summary);
    const notice = document.createElement('p');
    notice.className = 'fine-print';
    notice.textContent =
      original?.containsAnswers && phase !== 'review'
        ? '这份扫描件混有答案，首答与复测期间收起；提交后可对照。'
        : '原题保留原卷版面；页码为扫描文件页码。';
    details.append(notice);
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
      wrap.append(image, error);
      let page = 1;
      function show(number) {
        const source = documents.find((s) => s.id === select.value);
        page = Math.max(1, Math.min(source.pages.length, Number(number) || 1));
        pageInput.max = String(source.pages.length);
        pageInput.value = String(page);
        count.textContent = `/ ${source.pages.length}`;
        previous.disabled = page === 1;
        next.disabled = page === source.pages.length;
        image.src = source.pages[page - 1].src;
        image.alt = `${source.name} 第 ${page} 页`;
        error.hidden = true;
        wrap.scrollTop = 0;
      }
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
      toolbar.append(select, previous, pageInput, count, next);
      details.append(toolbar, wrap);
      show(select.value === paper.questionSourceId ? paper.questionPage : 1);
    }
    if (phase === 'review') {
      const library = document.createElement('button');
      library.type = 'button';
      library.className = 'button-text';
      library.textContent = '在「我的原卷」查看完整文件';
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
  };
}
