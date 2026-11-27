import { studyStore } from './training-core.mjs';
import { paperDrillSentences, createPaperDrill } from './paper-study-core.mjs';

const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const clock = (value) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;

export function mountPaperStudy({
  host,
  play,
  cancel,
  conceal,
  isExposed,
  idPrefix = '',
  onChange = () => {},
  onSentenceChange = () => {},
  formatTime = clock,
}) {
  let session,
    selection,
    sentences = [],
    active,
    generation = 0;
  const drafts = new Map();
  host.innerHTML = `<details id="paper-drill" class="paper-drill">
    <summary>短句听写 · 先听再对照</summary>
    <div class="paper-drill-body">
      <p>先写出听到的词，再找漏听的位置。复测时关掉提示；同一句练熟后，换一句检查。</p>
      <label for="paper-drill-sentence">这个 Task 的短句</label><select id="paper-drill-sentence"></select>
      <p id="paper-drill-meta" class="paper-fine"></p>
      <div class="paper-drill-actions"><button type="button" id="paper-drill-play" class="button-secondary">重听这一句</button><button type="button" id="paper-drill-pause">暂停单句</button><button type="button" id="paper-drill-next">换下一句</button></div>
      <label for="paper-drill-answer">写下听到的内容，没听清的地方留空</label>
      <textarea id="paper-drill-answer" rows="3" maxlength="2000" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
      <div class="paper-drill-actions"><button type="button" id="paper-drill-submit" class="button-primary">对照这句听写</button><button type="button" id="paper-drill-blank">查看原句（提示）</button></div>
      <p id="paper-drill-message" role="status"></p>
      <section id="paper-drill-feedback" class="paper-drill-feedback" hidden>
        <h3>对照原句</h3><p id="paper-drill-reference" lang="en"></p><div id="paper-drill-diff"></div>
        <p class="paper-fine">这里只核对字幕字词，忽略大小写与标点，不代表 DSE 得分或完整理解。若字幕与原音不符，可标为待核实。</p>
        <label for="paper-drill-error">这次主要卡在哪里</label><select id="paper-drill-error">
          <option value="">选择自己的卡点</option><option>认识但听不出</option><option>词义不认识</option><option>漏听词尾或数字</option><option>拼写</option><option>整句意思不明</option><option>原稿可能有误</option><option>已听清并理解</option>
        </select><div class="paper-drill-actions"><button type="button" id="paper-drill-record-error">记录卡点</button><button type="button" id="paper-drill-retest" class="button-secondary">关提示再测</button></div>
      </section>
    </div></details>`;
  if (idPrefix) {
    for (const node of host.querySelectorAll('[id]')) node.id = idPrefix + node.id;
    for (const node of host.querySelectorAll('[for]')) node.htmlFor = idPrefix + node.htmlFor;
  }
  const $ = (id) => host.querySelector(`#${idPrefix}${id}`);
  function message(text) {
    $('paper-drill-message').textContent = text;
  }
  function make(sentenceId, retest = false) {
    return {
      drill: createPaperDrill({
        session,
        selection,
        sentenceId,
        previous: studyStore.getState().records,
        exposed: !retest && isExposed(sentenceId),
        retest,
      }),
      answer: '',
      outcome: null,
      recordId: null,
      error: '',
      revealed: false,
      retest,
    };
  }
  const key = (id) => `${session.id}:${selection.part}:${selection.task}:${id}`;
  function choose(id, retest = false, activeChoice = true) {
    generation++;
    if (activeChoice) cancel();
    if (!sentences.some((s) => s.id === id)) id = sentences[0]?.id;
    active = id ? (retest ? make(id, true) : drafts.get(key(id)) || make(id)) : null;
    if (active) drafts.set(key(id), active);
    if (activeChoice && active?.retest && !active.outcome) conceal();
    render();
    onSentenceChange(active?.drill.sentence);
    onChange();
  }
  function render() {
    const sentence = active?.drill.sentence;
    $('paper-drill-sentence').replaceChildren(
      ...sentences.map(
        (s) =>
          new Option(
            `${formatTime(s.start)} · ${(s.end - s.start).toFixed(1)} 秒 · ${s.words.length} 词`,
            s.id,
          ),
      ),
    );
    if (sentence) $('paper-drill-sentence').value = sentence.id;
    $('paper-drill-meta').textContent = sentence
      ? `${session.year} · Part ${selection.part} · Task ${selection.task}。点播放仅听这一句；重复听或使用非 1× 速度会记作辅助练习。`
      : selection?.part === 'B2'
        ? '短句训练目前只练 Part A＋B1。B2 原件仍可查看。'
        : '这个 Task 暂无适合自动听写的可靠短句。可用逐句复盘；不会把定位不稳的字幕当标准答案。';
    for (const id of ['paper-drill-play', 'paper-drill-pause', 'paper-drill-next', 'paper-drill-sentence'])
      $(id).disabled = !sentence;
    for (const id of ['paper-drill-answer', 'paper-drill-submit', 'paper-drill-blank'])
      $(id).disabled = !sentence || !!active.outcome;
    $('paper-drill-answer').value = active?.answer || '';
    const revealed = !!active?.outcome || !!active?.revealed;
    $('paper-drill-feedback').hidden = !revealed;
    $('paper-drill-reference').textContent = revealed ? sentence.text : '';
    $('paper-drill-error').disabled = !active?.outcome;
    $('paper-drill-record-error').disabled = !active?.outcome;
    $('paper-drill-diff').replaceChildren();
    message('');
    if (!active?.outcome) return;
    const result = active.outcome.result;
    const labels = { missing: '漏写', extra: '多写', replace: '不同' };
    $('paper-drill-diff').innerHTML = result.correct
      ? '<p>字词与参考一致。再确认自己能说出整句意思。</p>'
      : Object.entries(labels)
          .map(([kind, label]) => {
            const differences = result.differences.filter((d) => d.kind === kind);
            if (!differences.length) return '';
            return `<p><strong>${label}</strong> <span lang="en">${differences
              .map((d) =>
                kind === 'replace'
                  ? `${escape(d.actual)} → ${escape(d.expected)}`
                  : escape(d.expected || d.actual),
              )
              .join(' · ')}</span></p>`;
          })
          .join('');
    $('paper-drill-error').value = active.error;
    const r = active.outcome.record;
    message(
      `${r.assisted ? '辅助练习' : r.phase === 'retest' ? '关提示复测' : '本次首答'}已暂存。选择卡点后，点页首“保存本次学习纪录”保留。`,
    );
  }
  $('paper-drill-sentence').onchange = () => choose($('paper-drill-sentence').value);
  $('paper-drill-answer').oninput = () => {
    if (active) active.answer = $('paper-drill-answer').value;
    onChange();
  };
  $('paper-drill-next').onclick = () => {
    const index = sentences.findIndex((s) => s.id === active?.drill.sentence.id);
    choose(sentences[(index + 1) % sentences.length]?.id);
  };
  $('paper-drill-play').onclick = async () => {
    if (!active) return;
    const attempt = active,
      request = generation;
    $('paper-drill-play').disabled = true;
    const played = await play(attempt.drill.sentence);
    if (request !== generation) return;
    $('paper-drill-play').disabled = false;
    if (played.ok) {
      attempt.drill.played(played.rate);
      message('听完后写下你听到的内容，再提交对照。');
    } else message('录音尚未播放，请再点“听这一句”。');
  };
  function submit(blank = false) {
    if (!active || active.outcome) return;
    try {
      if (studyStore.getState().records.length >= 10000)
        throw new Error('学习纪录已达 10,000 条，本次未提交。请先导出完整备份，再整理浏览器中的旧纪录。');
      if (blank) active.answer = '';
      const outcome = active.drill.submit(active.answer);
      active.recordId = studyStore.addAttempt(outcome.record);
      active.outcome = outcome;
      cancel();
      render();
      onChange();
    } catch (error) {
      message(error.message);
    }
  }
  $('paper-drill-submit').onclick = () => submit();
  $('paper-drill-blank').onclick = () => {
    if (!active) return;
    active.drill.reveal();
    active.revealed = true;
    cancel();
    render();
    message('已显示原句。本轮属于有提示练习；查看提示不会自动提交或保存作答。');
    onChange();
  };
  $('paper-drill-pause').onclick = () => {
    cancel();
    message('已暂停。点“重听这一句”从句首再听。');
  };
  $('paper-drill-record-error').onclick = () => {
    if (!active?.recordId) return;
    const error = $('paper-drill-error').value;
    if (!error) return message('先选择最主要的卡点。');
    const state = studyStore.getState(),
      record = state.records.find((r) => r.id === active.recordId);
    if (!record) return message('这条记录已不在当前会话，请重新练习。');
    active.error = error;
    record.errorTypes = error === '已听清并理解' ? [] : [error];
    record.selfCheck = error === '原稿可能有误' ? 'pending' : error === '已听清并理解' ? 'correct' : 'retry';
    if (error === '原稿可能有误') {
      delete record.correct;
      delete record.total;
    } else {
      record.correct = active.outcome.record.correct;
      record.total = 1;
    }
    studyStore.replaceState(state);
    message(
      error === '原稿可能有误'
        ? '已标为待核实，暂不计入正确率。请对照同年原稿；保存后保留。'
        : '卡点已暂存，保存后保留。',
    );
  };
  $('paper-drill-retest').onclick = () => {
    choose(active.drill.sentence.id, true);
    $('paper-drill-answer').focus();
  };
  return {
    setContext(nextSession, nextSelection) {
      generation++;
      session = nextSession;
      selection = { ...nextSelection };
      sentences = paperDrillSentences(session, selection);
      const oldId = active?.drill.sentence.id;
      active = null;
      if (session) choose(sentences.some((s) => s.id === oldId) ? oldId : sentences[0]?.id, false, false);
      else render();
    },
    suspend() {
      generation++;
      $('paper-drill-play').disabled = !active;
    },
    expose(scope = 'task') {
      if (!session) return;
      const prefix =
        scope === 'session' ? `${session.id}:` : `${session.id}:${selection.part}:${selection.task}:`;
      for (const [draftKey, draft] of drafts)
        if (draftKey.startsWith(prefix) && !draft.outcome) draft.drill.reveal();
    },
    getSaveState() {
      return { hasDraft: [...drafts.values()].some((d) => d.answer.trim() && !d.outcome) };
    },
    open(sentenceId, { retest = true } = {}) {
      if (!sentences.some((s) => s.id === sentenceId)) {
        $('paper-drill').open = true;
        message('此标记原句的定位或长度暂不适合自动听写，可先用字幕复盘重听。');
        return false;
      }
      choose(sentenceId, retest);
      $('paper-drill').open = true;
      $('paper-drill').scrollIntoView({ block: 'start', behavior: 'smooth' });
      return true;
    },
  };
}
