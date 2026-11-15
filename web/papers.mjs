import { selectPapers, taskOptions, chooseTask } from './paper-core.mjs';
import { PaperPlayer } from './paper-player.mjs';

const timeText = (seconds) =>
  `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;
const variants = { exam: '正式试卷', sample: 'Sample Paper', practice: 'Practice Paper' };
const roles = {
  question: '题卷',
  data: 'Data File',
  script: '听力原稿',
  marking: '评分参考',
  full: '原卷合订本',
  commentary: '考生表现',
  supplement: '附加资料',
};
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export async function mountPapers({ host, bridge }) {
  const response = await fetch('./papers/catalogue.json');
  if (!response.ok) throw new Error('原卷目录未能载入');
  const catalogue = await response.json();
  let selection = { year: 2025, variant: 'exam', paper: 3, part: 'A', task: 1 };
  let activeView = 'library';
  const selections = { library: { ...selection }, listening: { ...selection } };
  let source,
    pageNumber = 1,
    rotation = 0,
    session,
    loadingGeneration = 0,
    review = false,
    follow = true,
    currentSentence = null,
    currentWord = null,
    selectedWord = null;
  const marks = new Map();
  const revealedSources = new Set();
  let selectionBusy = false,
    selectionInterrupted = false;
  host.innerHTML = `
    <section class="paper-heading"><div><h1>我的 Past Papers</h1><p>先选一份卷，再从想听的地方开始。</p></div><span class="paper-count">2012—2025 · Sample / Practice</span></section>
    <form class="paper-filters" aria-label="选择原卷">
      <label>年份<select id="paper-year"></select></label><label>版本<select id="paper-variant"></select></label>
      <label>卷别<select id="paper-paper"><option value="3">Paper 3 · 听力</option><option value="1">Paper 1 · 阅读</option><option value="2">Paper 2 · 写作</option><option value="4">Paper 4 · 说话</option></select></label>
      <label>Part<select id="paper-part"></select></label><label>Task<select id="paper-task"></select></label>
    </form>
    <div id="paper-notice" class="paper-notice" role="status"></div>
    <section id="paper-audio-panel" class="paper-audio-panel" aria-label="原卷录音">
      <div class="paper-transport"><button id="paper-play" type="button" class="button-primary">播放</button><button id="paper-back" type="button" aria-label="后退十秒">−10 秒</button><button id="paper-forward" type="button" aria-label="前进十秒">＋10 秒</button>
      <label class="paper-rate">倍速<select id="paper-rate"><option value="0.75">0.75×</option><option value="0.9">0.9×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option></select></label>
      <button id="paper-task-play" type="button" class="button-secondary">听这个 Task</button><button id="paper-task-loop" type="button" aria-pressed="false">循环 Task</button>
      <button id="paper-review" type="button" class="button-secondary">开始复盘，显示字幕</button></div>
      <div class="paper-progress"><span id="paper-position">0:00</span><input id="paper-seek" type="range" min="0" max="1" step="0.05" value="0" aria-label="原卷录音进度"/><span id="paper-duration">0:00</span></div>
      <div class="paper-audio-status"><span id="paper-audio-status" role="status">选择 Task 后可播放对应原音。</span><button id="paper-clear-range" type="button" hidden>退出片段 / 循环</button></div>
      <audio id="paper-audio" preload="none" playsinline></audio>
    </section>
    <div class="paper-workspace">
      <section id="paper-transcript-panel" class="paper-transcript-panel panel" hidden>
        <div class="panel-header"><h2>听力字幕</h2><button id="paper-follow" type="button" aria-pressed="true">跟随播放</button></div>
        <p id="paper-timing-note" class="paper-fine"></p><div id="paper-transcript" class="paper-transcript" tabindex="0" aria-label="逐词字幕"></div>
        <div id="paper-word-detail" class="paper-word-detail" hidden><strong id="paper-word-text"></strong><button id="paper-word-replay" type="button">听原句</button><button id="paper-word-loop" type="button">循环原句</button><button id="paper-word-mark" type="button">加入复习标记</button></div>
        <details class="paper-evidence"><summary>题目重点与原音证据</summary><div id="paper-evidence-list"></div></details>
        <details class="paper-marks"><summary>本次复习标记 <span id="paper-mark-count">0</span></summary><div id="paper-marks-list"></div><button id="paper-save-marks" class="button-secondary" type="button">导出本次复习标记</button></details>
      </section>
      <section class="paper-reader panel" aria-label="原卷阅读器">
        <div class="paper-reader-heading"><div><h2 id="paper-source-title">原卷</h2><p id="paper-source-path"></p></div><label>题卷版本<select id="paper-source"></select></label></div>
        <div class="paper-page-tools"><button id="paper-prev" type="button" aria-label="上一页">← 上一页</button><label>第 <input id="paper-page" type="number" min="1" value="1" aria-label="原卷页码"/> / <span id="paper-pages">1</span> 页</label><button id="paper-next" type="button" aria-label="下一页">下一页 →</button><button id="paper-zoom" type="button" aria-pressed="false">放大原卷</button><button id="paper-rotate" type="button">旋转 90°</button></div>
        <div id="paper-image-wrap" class="paper-image-wrap"><div id="paper-image-stage"><img id="paper-image" alt="" decoding="async" hidden/></div><p id="paper-image-error" hidden>此页未能载入。<button id="paper-image-retry" type="button">重新载入</button></p></div>
      </section>
    </div>
    <section class="paper-references"><h2>同年资料</h2><p>Data File、原稿、评分参考与合订本保留原文件名称。参考内容由你主动打开。</p><div id="paper-references"></div></section>
    <p id="paper-source-summary" class="paper-fine"></p>`;
  const $ = (id) => host.querySelector(`#${id}`);
  host.querySelector('form').onsubmit = (event) => event.preventDefault();
  const player = new PaperPlayer($('paper-audio'), updatePlayer);
  function updatePlayer(state) {
    $('paper-position').textContent = timeText(state.time);
    $('paper-duration').textContent = timeText(state.duration);
    $('paper-seek').max = state.duration || 1;
    if (!scrubbing) $('paper-seek').value = state.time;
    $('paper-seek').setAttribute('aria-valuetext', `${timeText(state.time)} / ${timeText(state.duration)}`);
    $('paper-play').textContent = state.loading ? '取消载入' : state.playing ? '暂停' : '播放';
    $('paper-task-loop').setAttribute('aria-pressed', String(!!state.range?.loop));
    $('paper-clear-range').hidden = !state.range;
    $('paper-audio-status').textContent =
      state.error ||
      (state.loading
        ? '正在载入录音…'
        : state.range
          ? `${state.range.loop ? '循环' : '片段'} ${timeText(state.range.start)}—${timeText(state.range.end)}`
          : session
            ? '可拖动进度；点字幕听原句，点题号听证据。'
            : '此份材料暂无可播放的录音。');
    if (!state.loading) syncTaskToTime(state.time);
    highlight(state.time);
  }
  function syncTaskToTime(time) {
    if (
      selectionBusy ||
      !session ||
      selection.paper !== 3 ||
      selection.year !== session.year ||
      selection.variant !== session.variant
    )
      return;
    const current = taskRange();
    if (current && time >= current.start && time < current.end) return;
    const next = session.tasks.find(
      (t) =>
        time >= t.range.start &&
        time < t.range.end &&
        (t.part === 'A' || t.part === (selection.part === 'B2' ? 'B2' : 'B1')),
    );
    if (!next || (next.number === Number(selection.task) && next.part === selection.part)) return;
    selection.part = next.part;
    selection.task = next.number;
    $('paper-part').value = next.part;
    options(
      'paper-task',
      taskOptions(catalogue.sources, selection).map((t) => [t, `Task ${t}`]),
      next.number,
    );
    const selected = selectPapers(catalogue.sources, selection),
      target = chooseTask(catalogue.sources, selection, next.number);
    options(
      'paper-source',
      selected.questions.map((s) => [s.id, s.name]),
      target?.sourceId || '',
    );
    showSource(
      catalogue.sources.find((s) => s.id === target?.sourceId),
      target?.page || 1,
    );
    renderReferences(selected.references);
    $('paper-notice').textContent =
      `${selection.year} · ${variants[selection.variant]} · Paper 3 · Part ${next.part} · Task ${next.number}${next.part === 'A' ? '' : ' · Part B 共用同一段谈话'}`;
    renderTranscript();
  }
  let scrubbing = false,
    wasPlaying = false;
  $('paper-seek').addEventListener('pointerdown', () => {
    scrubbing = true;
    wasPlaying = player.playing;
    player.cancel();
  });
  $('paper-seek').addEventListener('input', () => {
    $('paper-position').textContent = timeText(Number($('paper-seek').value));
  });
  $('paper-seek').addEventListener('change', () => {
    const resume = scrubbing ? wasPlaying : player.playing;
    scrubbing = false;
    player.seek(Number($('paper-seek').value), resume);
  });
  $('paper-seek').addEventListener('pointercancel', () => {
    scrubbing = false;
    updatePlayer({ time: player.time, duration: session?.audio?.duration, playing: player.playing });
  });
  $('paper-play').onclick = () => player.toggle();
  $('paper-back').onclick = () => player.seek(player.time - 10);
  $('paper-forward').onclick = () => player.seek(player.time + 10);
  $('paper-rate').onchange = () => {
    $('paper-audio').playbackRate = Number($('paper-rate').value);
  };
  $('paper-clear-range').onclick = () => {
    player.range = null;
    player.emit();
  };
  const taskRange = () =>
    session?.tasks?.find((t) => t.number === Number(selection.task) && t.part === selection.part)?.range;
  $('paper-task-play').onclick = () => {
    const r = taskRange();
    if (r) player.playRange(r.start, r.end);
  };
  $('paper-task-loop').onclick = () => {
    const r = taskRange();
    if (player.range?.loop) {
      player.range = null;
      player.emit();
    } else if (r) player.playRange(r.start, r.end, true);
  };
  $('paper-review').onclick = () => {
    review = !review;
    $('paper-review').textContent = review ? '隐藏字幕，重新听' : '开始复盘，显示字幕';
    renderTranscript();
  };
  $('paper-follow').onclick = () => {
    follow = !follow;
    $('paper-follow').setAttribute('aria-pressed', String(follow));
    if (follow) highlight(player.time, true);
  };
  $('paper-transcript').addEventListener('wheel', () => setFollow(false), { passive: true });
  $('paper-transcript').addEventListener('touchmove', () => setFollow(false), { passive: true });
  function setFollow(value) {
    follow = value;
    $('paper-follow').setAttribute('aria-pressed', String(value));
  }
  function visibleSentences() {
    const r = taskRange();
    return (session?.sentences || []).filter((s) => !r || (s.end > r.start && s.start < r.end));
  }
  function renderTranscript() {
    $('paper-transcript-panel').hidden = !review || selection.paper !== 3;
    host.classList.toggle('paper-with-transcript', review && selection.paper === 3);
    $('paper-word-detail').hidden = true;
    selectedWord = null;
    currentSentence = null;
    currentWord = null;
    const sentences = visibleSentences();
    $('paper-timing-note').textContent =
      session?.timingNote || '字幕按原音生成；无法可靠定位的词按整句重听。原稿可在同年资料中对照。';
    $('paper-transcript').innerHTML = sentences.length
      ? sentences
          .map(
            (s) =>
              `<p class="paper-sentence" data-sentence="${escape(s.id)}"><button class="paper-sentence-time" type="button" data-sentence-replay="${escape(s.id)}" aria-label="重听 ${timeText(s.start)} 原句">${timeText(s.start)}</button><span>${s.words.map((w) => `<button type="button" class="paper-word${marks.has(`${session.id}:${w.id}`) ? ' is-marked' : ''}${w.questionNumbers?.length ? ' is-evidence' : ''}" data-word="${escape(w.id)}" ${w.start === null ? 'title="此词按整句定位"' : ''}>${escape(w.text)}</button>`).join(' ')}</span></p>`,
          )
          .join('')
      : '<p class="paper-empty">这段暂没有可显示的字幕。可先看原卷或打开原稿。</p>';
    const clips = (session?.evidence || []).filter(
      (e) => !selection.task || e.task === Number(selection.task),
    );
    const referenceOnly = (session?.questionIndex || []).filter(
      (q) => q.task === Number(selection.task) && !q.evidenceIds.length,
    );
    $('paper-evidence-list').innerHTML =
      clips
        .map(
          (e) =>
            `<button type="button" class="paper-evidence-row" data-evidence="${escape(e.id)}"><strong>${escape(e.label)}</strong><span>${escape(e.text)}</span><small>听原音证据 · ${timeText(e.start)}—${timeText(e.end)}</small></button>`,
        )
        .join('') +
        referenceOnly
          .map(
            (q) =>
              `<button type="button" class="paper-reference-question" data-question-reference="${escape(q.question)}"><strong>${escape(q.label)}</strong> 查看评分参考 <small>原音证据待核实</small></button>`,
          )
          .join('') ||
      '<p class="paper-fine">该 Task 暂无已核实到小题的证据片段；可点原句重听并对照原稿。</p>';
    highlight(player.time, true);
  }
  $('paper-transcript').onclick = (event) => {
    const wordButton = event.target.closest('[data-word]'),
      sentenceButton = event.target.closest('[data-sentence-replay]');
    if (sentenceButton) {
      const s = session.sentences.find((s) => s.id === sentenceButton.dataset.sentenceReplay);
      if (s) {
        setFollow(true);
        player.playRange(s.start, s.end);
      }
    }
    if (!wordButton) return;
    const sentence = session.sentences.find((s) => s.words.some((w) => w.id === wordButton.dataset.word));
    const word = sentence?.words.find((w) => w.id === wordButton.dataset.word);
    if (!word) return;
    selectedWord = { sentence, word };
    $('paper-word-detail').hidden = false;
    $('paper-word-text').textContent = word.text;
    $('paper-word-mark').textContent = marks.has(`${session.id}:${word.id}`)
      ? '移除复习标记'
      : '加入复习标记';
    for (const e of host.querySelectorAll('.paper-word.is-selected')) e.classList.remove('is-selected');
    wordButton.classList.add('is-selected');
    setFollow(true);
    player.playRange(word.start ?? sentence.start, word.end ?? sentence.end);
  };
  $('paper-word-replay').onclick = () => {
    if (selectedWord) {
      setFollow(true);
      player.playRange(selectedWord.sentence.start, selectedWord.sentence.end);
    }
  };
  $('paper-word-loop').onclick = () => {
    if (selectedWord) {
      setFollow(true);
      player.playRange(selectedWord.sentence.start, selectedWord.sentence.end, true);
    }
  };
  $('paper-word-mark').onclick = () => {
    if (!selectedWord) return;
    const key = `${session.id}:${selectedWord.word.id}`;
    if (marks.has(key)) marks.delete(key);
    else
      marks.set(key, {
        key,
        sessionId: session.id,
        year: selection.year,
        variant: selection.variant,
        task: selection.task,
        part: selection.part,
        word: selectedWord.word.text,
        text: selectedWord.sentence.text,
        start: selectedWord.sentence.start,
        end: selectedWord.sentence.end,
      });
    renderMarks();
    renderTranscript();
  };
  function renderMarks() {
    $('paper-mark-count').textContent = marks.size;
    $('paper-marks-list').innerHTML =
      [...marks.values()]
        .map(
          (m) =>
            `<button type="button" class="paper-mark-row" data-mark="${escape(m.key)}"><strong>${escape(m.word)}</strong> <span>${m.year} · Task ${m.task} · ${timeText(m.start)}</span></button>`,
        )
        .join('') || '<p class="paper-fine">点字幕中的词，可加入本次复习标记。</p>';
  }
  $('paper-marks-list').onclick = async (event) => {
    const m = marks.get(event.target.closest('[data-mark]')?.dataset.mark);
    if (!m) return;
    selection = { year: m.year, variant: m.variant, paper: 3, part: m.part, task: m.task };
    review = true;
    setFollow(true);
    const applied = await applySelection();
    if (applied && session?.id === m.sessionId) {
      $('paper-review').textContent = '隐藏字幕，重新听';
      player.playRange(m.start, m.end);
    }
  };
  $('paper-save-marks').onclick = () => {
    const blob = new Blob(
      [
        JSON.stringify(
          { schemaVersion: 1, type: 'english30-paper-review', marks: [...marks.values()] },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = 'English30-past-paper-review.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('paper-evidence-list').onclick = (event) => {
    const e = session?.evidence?.find(
      (e) => e.id === event.target.closest('[data-evidence]')?.dataset.evidence,
    );
    if (e) {
      setFollow(true);
      player.playRange(e.start, e.end);
      return;
    }
    const q = session?.questionIndex?.find(
      (q) =>
        String(q.question) === event.target.closest('[data-question-reference]')?.dataset.questionReference &&
        q.task === Number(selection.task),
    );
    if (q)
      showSource(
        catalogue.sources.find((s) => s.id === q.sourceId),
        q.page,
        true,
      );
  };
  function highlight(time, force = false) {
    if (!review || !session) return;
    const activeEvidence = new Set(
      (session.evidence || []).filter((e) => time >= e.start && time < e.end).map((e) => e.id),
    );
    for (const node of host.querySelectorAll('[data-evidence]'))
      node.classList.toggle('is-current', activeEvidence.has(node.dataset.evidence));
    const sentence = visibleSentences().find((s) => time >= s.start && time < s.end);
    const word = sentence?.words.find((w) => w.start !== null && time >= w.start && time < w.end);
    if (force || sentence?.id !== currentSentence) {
      for (const node of host.querySelectorAll('.paper-sentence.is-current'))
        node.classList.remove('is-current');
      const node = sentence && host.querySelector(`[data-sentence="${sentence.id}"]`);
      node?.classList.add('is-current');
      if (node && follow) {
        const panel = $('paper-transcript');
        panel.scrollTo({
          top: node.offsetTop - panel.offsetTop - panel.clientHeight * 0.24,
          behavior: 'auto',
        });
      }
      currentSentence = sentence?.id;
    }
    if (force || word?.id !== currentWord) {
      for (const node of host.querySelectorAll('.paper-word.is-playing')) node.classList.remove('is-playing');
      if (word) host.querySelector(`[data-word="${word.id}"]`)?.classList.add('is-playing');
      currentWord = word?.id;
    }
  }
  function options(id, entries, value) {
    $(id).replaceChildren(...entries.map(([key, label]) => new Option(label, String(key))));
    $(id).value = String(value);
  }
  function renderReferences(sources) {
    $('paper-references').innerHTML =
      sources
        .map(
          (s) =>
            `<button type="button" data-source-ref="${s.id}" class="paper-reference"><span>${roles[s.role]}</span><strong>${escape(s.name)}</strong><small>${s.pageCount} 页 ↗</small></button>`,
        )
        .join('') || '<p class="paper-fine">这个年份尚无单独参考文件，可查阅其他 Part 或合订本。</p>';
  }
  async function applySelection(changed) {
    const request = ++loadingGeneration;
    selectionInterrupted = false;
    selectionBusy = true;
    player.range = null;
    selectedWord = null;
    $('paper-word-detail').hidden = true;
    $('paper-transcript').replaceChildren();
    $('paper-evidence-list').replaceChildren();
    for (const id of [
      'paper-play',
      'paper-seek',
      'paper-back',
      'paper-forward',
      'paper-rate',
      'paper-task-play',
      'paper-task-loop',
    ])
      $(id).disabled = true;
    player.cancel();
    const years = [...new Set(catalogue.sources.map((s) => s.year))].sort((a, b) => b - a);
    if (!years.includes(Number(selection.year))) selection.year = years[0];
    options(
      'paper-year',
      years.map((y) => [y, y]),
      selection.year,
    );
    const versions = [
      ...new Set(catalogue.sources.filter((s) => s.year === selection.year).map((s) => s.variant)),
    ];
    if (!versions.includes(selection.variant))
      selection.variant = versions.includes('exam') ? 'exam' : versions[0];
    options(
      'paper-variant',
      versions.map((v) => [v, variants[v]]),
      selection.variant,
    );
    $('paper-paper').value = String(selection.paper);
    const partOrder = [1, 3].includes(selection.paper)
      ? ['A', 'B1', 'B2']
      : selection.paper === 2
        ? ['A', 'B']
        : [''];
    const availableParts = new Set(
      catalogue.sources
        .filter(
          (s) =>
            s.year === selection.year &&
            s.variant === selection.variant &&
            s.paper === selection.paper &&
            s.role === 'question',
        )
        .flatMap((s) => s.parts),
    );
    const parts = partOrder.filter((p) => !p || availableParts.has(p));
    if (!parts.length) parts.push('');
    if (!parts.includes(selection.part)) selection.part = parts[0];
    options(
      'paper-part',
      parts.map((p) => [p, p ? `Part ${p}` : '整卷']),
      selection.part,
    );
    $('paper-part').disabled = parts.length === 1;
    const tasks = selection.paper === 3 ? taskOptions(catalogue.sources, selection) : [];
    if (!tasks.includes(Number(selection.task)) || (changed && changed !== 'task'))
      selection.task = tasks[0] || '';
    options(
      'paper-task',
      tasks.length ? tasks.map((t) => [t, `Task ${t}`]) : [['', '整份题卷']],
      selection.task,
    );
    $('paper-task').disabled = !tasks.length;
    const selected = selectPapers(catalogue.sources, selection);
    options(
      'paper-source',
      selected.questions.map((s) => [s.id, s.name]),
      selected.questions[0]?.id || '',
    );
    const target = chooseTask(catalogue.sources, selection, selection.task);
    const questionSource = catalogue.sources.find((s) => s.id === target?.sourceId) || selected.questions[0];
    showSource(questionSource, target?.page || questionSource?.partPages?.[selection.part] || 1);
    renderReferences(selected.references);
    $('paper-notice').textContent =
      selection.part === 'B2'
        ? 'B2 原件已归档。当前学习范围仍以 A＋B1 为主。'
        : selected.questions.length
          ? `${selection.year} · ${variants[selection.variant]} · Paper ${selection.paper}${selection.part ? ` · Part ${selection.part}` : ''}${selection.task ? ` · Task ${selection.task}` : ''}`
          : '你保存的材料中没有此项独立题卷；同年合订本保留在下方。';
    $('paper-audio-panel').hidden = selection.paper !== 3;
    const key = `${selection.year}-${selection.variant}`;
    if (selection.paper === 3 && key !== session?.id) {
      session = null;
      player.setSource(null);
      const entry = catalogue.sessions.find((s) => s.id === key);
      if (entry) {
        $('paper-audio-status').textContent = '正在载入这年的字幕和录音目录…';
        try {
          const r = await fetch(entry.url);
          if (!r.ok) throw new Error('听力材料未能载入');
          const loaded = await r.json();
          if (request !== loadingGeneration) return;
          session = loaded;
          player.setSource(session.audio);
        } catch (error) {
          if (request === loadingGeneration) {
            $('paper-notice').textContent = error.message + '，重新选择年份可重试。';
          }
        }
      }
    }
    if (request !== loadingGeneration) return;
    if (selection.paper === 3 && !session && catalogue.sessionIssues?.[key])
      $('paper-notice').textContent = catalogue.sessionIssues[key];
    if (selection.paper === 3 && selection.part !== 'A' && session)
      $('paper-notice').textContent += ' · Part B 的 Tasks 共用同一段谈话，请配合各自 Data File。';
    const r = taskRange();
    if (r) {
      await player.seek(r.start, false);
      if (request !== loadingGeneration) return;
    }
    selectionBusy = false;
    for (const id of ['paper-play', 'paper-seek', 'paper-back', 'paper-forward', 'paper-rate'])
      $(id).disabled = !session?.audio;
    for (const id of ['paper-task-play', 'paper-task-loop']) $(id).disabled = !r;
    renderTranscript();
    renderMarks();
    return true;
  }
  for (const key of ['year', 'variant', 'paper', 'part', 'task'])
    $(`paper-${key}`).onchange = () => {
      selection[key] = ['year', 'paper', 'task'].includes(key)
        ? Number($(`paper-${key}`).value)
        : $(`paper-${key}`).value;
      applySelection(key);
    };
  function showSource(next, number = 1, allowReference = false) {
    const answersPage = next?.containsAnswers && Number(number) >= (next.answerStartsPage || 1);
    if (answersPage && !revealedSources.has(next.id)) {
      if (!allowReference && !confirm('此页开始是评分参考或范文。是否现在查看？')) {
        $('paper-page').value = pageNumber;
        return;
      }
      revealedSources.add(next.id);
    }
    source = next;
    pageNumber = Math.min(next?.pages.length || 1, Math.max(1, Number(number) || 1));
    rotation = next?.pages[pageNumber - 1]?.rotation || 0;
    $('paper-source-title').textContent = next ? `${roles[next.role]} · ${next.name}` : '暂无独立题卷';
    $('paper-source-path').textContent = next?.sourcePath || '';
    $('paper-page').value = pageNumber;
    $('paper-page').max = next?.pageCount || 1;
    $('paper-pages').textContent = next?.pageCount || 0;
    $('paper-prev').disabled = !next || pageNumber <= 1;
    $('paper-next').disabled = !next || pageNumber >= next.pages.length;
    $('paper-image-error').hidden = true;
    $('paper-image').hidden = !next;
    if (next) {
      $('paper-image').src = next.pages[pageNumber - 1].src;
      $('paper-image').alt = `${next.name}，PDF 第 ${pageNumber} 页`;
      $('paper-source').value = next.id;
    } else $('paper-image').removeAttribute('src');
    $('paper-image-wrap').scrollTop = 0;
    sizeImage();
  }
  $('paper-source').onchange = () =>
    showSource(catalogue.sources.find((s) => s.id === $('paper-source').value));
  $('paper-prev').onclick = () => showSource(source, pageNumber - 1);
  $('paper-next').onclick = () => showSource(source, pageNumber + 1);
  $('paper-page').onchange = () => showSource(source, $('paper-page').value);
  $('paper-zoom').onclick = () => {
    const zoom = $('paper-zoom').getAttribute('aria-pressed') !== 'true';
    $('paper-zoom').setAttribute('aria-pressed', String(zoom));
    $('paper-zoom').textContent = zoom ? '适合宽度' : '放大原卷';
    $('paper-image-wrap').classList.toggle('is-zoomed', zoom);
    sizeImage();
  };
  function sizeImage() {
    const image = $('paper-image'),
      stage = $('paper-image-stage'),
      p = source?.pages[pageNumber - 1];
    if (!p) return;
    const width = stage.clientWidth,
      ratio = p.height / p.width,
      sideways = rotation % 180 !== 0;
    const imageWidth = sideways ? width / ratio : width,
      imageHeight = imageWidth * ratio;
    stage.style.height = `${sideways ? imageWidth : imageHeight}px`;
    image.style.width = `${imageWidth}px`;
    image.style.transformOrigin = '0 0';
    image.style.transform =
      rotation === 90
        ? `translateX(${imageHeight}px) rotate(90deg)`
        : rotation === 180
          ? `translate(${imageWidth}px,${imageHeight}px) rotate(180deg)`
          : rotation === 270
            ? `translateY(${imageWidth}px) rotate(270deg)`
            : 'none';
  }
  $('paper-rotate').onclick = () => {
    rotation = (rotation + 90) % 360;
    sizeImage();
  };
  new ResizeObserver(sizeImage).observe($('paper-image-stage'));
  $('paper-image').onload = sizeImage;
  $('paper-image').onerror = () => {
    $('paper-image-error').hidden = false;
  };
  $('paper-image-retry').onclick = () => showSource(source, pageNumber, true);
  $('paper-references').onclick = (event) => {
    const next = catalogue.sources.find(
      (s) => s.id === event.target.closest('[data-source-ref]')?.dataset.sourceRef,
    );
    if (!next) return;
    if (
      ['marking', 'script', 'full', 'commentary'].includes(next.role) &&
      !confirm('这份参考资料可能显示答案或原稿。是否现在打开？')
    )
      return;
    showSource(next, 1, true);
    host.querySelector('.paper-reader-heading')?.scrollIntoView({ block: 'nearest' });
  };
  $('paper-source-summary').textContent =
    `已整理 ${catalogue.sources.length} 份原件。页面按原 PDF 页码保留；重复版本按原文件名称区分。个人练习纪录只保存在当前浏览器。`;
  await applySelection();
  return {
    async show(view) {
      if (view === 'hidden') {
        ++loadingGeneration;
        selectionInterrupted ||= selectionBusy;
        selectionBusy = false;
        player.cancel();
        return;
      }
      const listening = view === 'listening';
      host.classList.toggle('paper-listening', listening);
      host.querySelector('.paper-heading h1').textContent = listening
        ? 'Past Paper 听力'
        : '我的 Past Papers';
      host.querySelector('.paper-heading p').textContent = listening
        ? '选择原卷的年份、Part 和 Task，题页、原音与字幕一起练。'
        : '先选一份卷，再从想听的地方开始。';
      $('paper-paper').closest('label').hidden = listening;
      $('paper-paper').disabled = listening;
      if (view !== activeView) {
        selections[activeView] = { ...selection };
        selection = { ...selections[view] };
        activeView = view;
        if (listening) selection.paper = 3;
        await applySelection();
      } else if (
        selectionInterrupted ||
        (!session &&
          selection.paper === 3 &&
          catalogue.sessions.some((s) => s.id === `${selection.year}-${selection.variant}`))
      ) {
        await applySelection();
      }
    },
    pause: () => player.cancel(),
  };
}
