import { confirmAction } from './confirmation.mjs';
import { studyStore } from './training-core.mjs';

const copy = (value) => JSON.parse(JSON.stringify(value));
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const normal = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
export function countWords(value) {
  return String(value ?? '').match(/[A-Za-z0-9]+(?:[’'-][A-Za-z0-9]+)*/g)?.length || 0;
}
export function readingElapsed(clock, now = Date.now()) {
  return (
    Math.max(0, Number(clock.elapsed) || 0) +
    (clock.runningSince == null ? 0 : Math.max(0, (now - clock.runningSince) / 1000))
  );
}
export function evidenceFeedback(selected, alternatives = []) {
  const picked = [...new Set(selected)];
  if (!picked.length) return { status: 'missing', message: '还没有选原文证据。' };
  const sufficient = alternatives
    .filter((ids) => ids.every((id) => picked.includes(id)))
    .sort((a, b) => a.length - b.length)[0];
  if (sufficient)
    return {
      status: picked.length === sufficient.length ? 'sufficient' : 'wide',
      message:
        picked.length === sufficient.length
          ? '已覆盖一组参考证据。请核对它是否支持你写的答案。'
          : '已覆盖参考要点；可再缩短范围，保留直接支持答案的句块。',
    };
  const overlap = alternatives.some((ids) => ids.some((id) => picked.includes(id)));
  return {
    status: overlap ? 'incomplete' : 'different',
    message: overlap
      ? '已找到部分依据，还需要补上另一处信息。'
      : '与参考定位不同；先核对题目要求，再比较原文。',
  };
}
export function evaluateReading(set, answers = {}, evidence = {}, submitted = false) {
  if (!submitted) return null;
  const valid = new Set(set.paragraphs.flatMap((p) => p.segments.map((s) => s.id)));
  return Object.fromEntries(
    set.questions.map((q) => {
      const raw = answers[q.id];
      let answer, matchedPoints;
      if (q.type === 'multi') {
        const values = (Array.isArray(raw) ? raw : []).map(normal).filter(Boolean),
          groups = new Set();
        for (const value of values) {
          const i = q.answerGroups.findIndex((group) => group.some((a) => normal(a) === value));
          if (i >= 0) groups.add(i);
        }
        matchedPoints = groups.size;
        answer = !values.length ? 'unanswered' : matchedPoints >= q.required ? 'matched' : 'review';
      } else {
        const value = normal(raw);
        answer = !value
          ? 'unanswered'
          : q.answers.some((a) => normal(a) === value)
            ? 'matched'
            : q.type === 'choice'
              ? 'mismatch'
              : 'review';
      }
      return [
        q.id,
        {
          answer,
          ...(matchedPoints == null ? {} : { matchedPoints }),
          evidence: evidenceFeedback(
            (evidence[q.id] || []).filter((id) => valid.has(id)),
            q.evidenceSets,
          ),
        },
      ];
    }),
  );
}
const statusText = {
  matched: '与参考匹配',
  mismatch: '需要修正',
  review: '合理改写请自核',
  unanswered: '未作答',
};
function readingSummary(results, selfCheck = {}) {
  const entries = Object.entries(results || {});
  return {
    matched: entries.filter(([, r]) => r.answer === 'matched').length,
    selfConfirmed: entries.filter(([id, r]) => r.answer === 'review' && selfCheck[id] === 'yes').length,
    pending: entries.filter(([id, r]) => r.answer === 'review' && !selfCheck[id]).length,
    needsPractice: entries.filter(
      ([id, r]) =>
        ['mismatch', 'unanswered'].includes(r.answer) || (r.answer === 'review' && selfCheck[id] === 'no'),
    ).length,
  };
}
const clockText = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const baseSession = (phase) => ({
  answers: {},
  evidence: {},
  selfCheck: {},
  errors: {},
  submitted: false,
  phase,
  clock: { elapsed: 0, runningSince: null },
  activeQuestion: null,
  paraphrase: '',
  capturedParaphrase: '',
});
const integratedSession = (phase = 'first') => ({
  notes: '',
  draft: '',
  to: '',
  subject: '',
  sourceChoices: {},
  checklist: {},
  confirmed: {},
  submitted: false,
  phase,
  clock: { elapsed: 0, runningSince: null },
  speed: 1,
  loop: false,
  audioPosition: 0,
  plays: 0,
  assisted: false,
});
const integratedWork = (session) =>
  JSON.stringify([session.to, session.subject, session.draft, session.notes, session.sourceChoices]);

export function mountReading({ host, bridge = {} }) {
  if (!host) throw new Error('Reading needs a host element.');
  const stylesheet = new URL('./reading.css', import.meta.url).href;
  const existingStyles = Array.from(document.querySelectorAll('link[rel~="stylesheet"]'));
  if (!existingStyles.some((link) => link.href === stylesheet)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = stylesheet;
    document.head.append(link);
  }
  let content = null,
    integrated = null,
    view = 'reading',
    notice = '',
    loadError = '';
  let state = {
    schemaVersion: 1,
    setId: 'reading-2025-a',
    taskId: 'integrated-2025-b1-t6',
    reading: {},
    integrated: {},
  };
  const getSet = () => content.sets.find((s) => s.id === state.setId) || content.sets[0];
  const getTask = () => integrated.tasks.find((t) => t.id === state.taskId) || integrated.tasks[0];
  const getR = () =>
    (state.reading[getSet().id] ??= baseSession(
      getRecords().some((r) => r.taskId === getSet().id) ? 'retest' : 'first',
    ));
  const getI = () =>
    (state.integrated[getTask().id] ??= integratedSession(
      getRecords().some((r) => r.taskId === getTask().id) ? 'retest' : 'first',
    ));
  function getRecords() {
    return studyStore.getState().records.filter((r) => ['reading', 'integrated'].includes(r.module));
  }
  function startClock(session, allowReview = false) {
    if ((!session.submitted || allowReview) && session.clock.runningSince == null)
      session.clock.runningSince = Date.now();
  }
  function pauseClock(session) {
    session.clock.elapsed = readingElapsed(session.clock);
    session.clock.runningSince = null;
  }
  function stopMedia() {
    const a = host.querySelector('audio');
    if (a) {
      if (integrated) {
        getI().audioPosition = a.currentTime || 0;
      }
      a.pause();
    }
  }
  function pauseAll() {
    for (const s of [...Object.values(state.reading), ...Object.values(state.integrated)])
      if (s.clock) pauseClock(s);
    stopMedia();
  }
  function feedbackHTML(q, r, s) {
    if (!s.submitted) return '';
    const reference = q.type === 'multi' ? q.answerGroups.map((g) => g[0]).join(' / ') : q.answers[0];
    return `<div class="rd-feedback"><strong>${statusText[r.answer]}</strong><p><span class="rd-small">参考要点</span> ${esc(reference)}${q.type === 'multi' ? `（任选 ${q.required} 项）` : ''}</p><p>${esc(q.explanation)}</p><p class="rd-bridge">${q.bridge.map(esc).join('<br>')}</p><p>${esc(r.evidence.message)}</p><button type="button" data-rd-action="show-evidence" data-q="${q.id}">查看参考证据</button>${r.answer === 'review' ? `<label class="rd-selfcheck">我的改写是否完整覆盖参考意思？<select data-rd-self="${q.id}"><option value="">选择自核结果</option><option value="yes" ${s.selfCheck[q.id] === 'yes' ? 'selected' : ''}>是，意思完整准确</option><option value="no" ${s.selfCheck[q.id] === 'no' ? 'selected' : ''}>否，需要修正</option></select></label>` : ''}<label class="rd-selfcheck">本题最主要的卡点<select data-rd-error="${q.id}"><option value="">暂不分类</option>${['证据定位', '同义改写', '指代', '词义', '词形／拼写', '漏要点'].map((e) => `<option ${s.errors[q.id] === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label></div>`;
  }
  function renderPassage() {
    const set = getSet(),
      s = getR(),
      q = set.questions.find((q) => q.id === s.activeQuestion) || set.questions[0];
    s.activeQuestion = q.id;
    const picked = new Set(s.evidence[q.id] || []),
      best = [...q.evidenceSets].sort(
        (a, b) => b.filter((id) => picked.has(id)).length - a.filter((id) => picked.has(id)).length,
      )[0],
      reference = new Set(s.referenceQuestion === q.id && s.submitted ? best : []);
    return `<div class="rd-passage-head"><span class="rd-kicker">${esc(set.part)} · 原文</span><h3>${esc(set.title)}</h3></div><div class="rd-evidence-context" data-rd-evidence-context><p id="rd-evidence-help"><strong>当前题目 · 原题 ${esc(q.number)}</strong></p><p class="rd-current-prompt" lang="en">${esc(q.prompt)}</p><div class="rd-evidence-actions"><span class="rd-small">已选 ${picked.size} 个句块${reference.size ? ' · 青柠边框为参考证据' : ' · 点原文选择／取消'}</span><button type="button" data-rd-action="return-question">返回本题</button></div></div>${set.paragraphs.map((p) => `<section class="rd-paragraph ${p.id === 'b0' ? 'rd-menu-source' : ''}"><h4>${esc(p.label)}</h4><div lang="en">${p.segments.map((seg) => `<button type="button" class="rd-sentence ${picked.has(seg.id) ? 'is-picked' : ''} ${reference.has(seg.id) ? 'is-reference' : ''}" data-rd-segment="${seg.id}" aria-pressed="${picked.has(seg.id)}" ${s.submitted ? 'aria-disabled="true"' : ''}>${esc(seg.text)}${picked.has(seg.id) ? '<span class="rd-selection-label"> 已选</span>' : ''}${reference.has(seg.id) ? '<span class="rd-selection-label"> 参考</span>' : ''}</button>`).join(' ')}</div></section>`).join('')}`;
  }
  const standaloneReview = bridge.requestSave
    ? ''
    : '<button type="button" data-rd-action="open-review">复习与备份</button>';
  function renderReading() {
    const oldPassageScroll = host.querySelector('#rd-passage')?.scrollTop || 0;
    const focused = document.activeElement,
      focusAttribute = ['data-rd-segment', 'data-rd-self'].find((name) => focused?.hasAttribute(name)),
      focusValue = focusAttribute ? focused.getAttribute(focusAttribute) : null;
    const set = getSet(),
      s = getR(),
      results = evaluateReading(set, s.answers, s.evidence, s.submitted);
    s.activeQuestion ??= set.questions[0].id;
    const summary = readingSummary(results, s.selfCheck);
    host.innerHTML = `<section class="rd-workspace" aria-label="阅读练习"><header class="rd-heading"><div><h1>阅读练习</h1><p>先答题，再圈证据，最后对照原文与改写。</p></div><label>选择短题组<select data-rd-set>${content.sets.map((x) => `<option value="${x.id}" ${x.id === set.id ? 'selected' : ''}>2025 · ${x.part} · ${esc(x.title)}</option>`).join('')}</select></label></header><p class="rd-source">${esc(set.scope)}</p><div class="rd-toolbar"><span class="rd-phase">${s.submitted ? '复盘' : s.phase === 'retest' ? '独立复测' : '首次作答'}</span><span data-rd-clock aria-live="off"></span><button type="button" data-rd-action="clock" ${s.submitted ? 'disabled' : ''}>${s.clock.runningSince == null ? '开始／继续计时' : '暂停计时'}</button><button type="button" data-rd-action="reset">关提示再测</button></div><div class="rd-notice" role="status">${esc(notice)}</div><div class="rd-reading-grid"><article class="rd-paper rd-passage" id="rd-passage">${renderPassage()}</article><section class="rd-questions" aria-label="阅读题目">${set.questions.map((q) => `<article class="rd-question ${s.activeQuestion === q.id ? 'is-active' : ''}" id="rd-question-${q.id}"><div class="rd-question-title"><span><strong>原题 ${esc(q.number)}</strong> · ${esc(q.skill)}</span><button type="button" data-rd-action="select-question" data-q="${q.id}" aria-pressed="${s.activeQuestion === q.id}">${s.submitted ? '对照原文' : '为本题选证据'}</button></div><p lang="en">${esc(q.prompt)}</p>${q.type === 'choice' ? `<fieldset ${s.submitted ? 'disabled' : ''}><legend class="rd-sr-only">原题 ${esc(q.number)} 答案</legend>${q.options.map((option) => `<label class="rd-option"><input type="radio" name="rd-${q.id}" data-rd-answer="${q.id}" value="${option[0]}" ${s.answers[q.id] === option[0] ? 'checked' : ''}><span lang="en">${esc(option)}</span></label>`).join('')}</fieldset>` : q.type === 'multi' ? Array.from({ length: q.required }, (_, i) => `<label class="rd-input-label">第 ${i + 1} 个短语<input autocomplete="off" spellcheck="false" data-rd-answer="${q.id}" data-index="${i}" value="${esc(s.answers[q.id]?.[i] || '')}" ${s.submitted ? 'disabled' : ''}></label>`).join('') : `<label class="rd-input-label">你的答案<input autocomplete="off" spellcheck="false" data-rd-answer="${q.id}" value="${esc(s.answers[q.id] || '')}" ${s.submitted ? 'disabled' : ''}></label>`}<small>已选 ${(s.evidence[q.id] || []).length} 个证据句块</small>${s.submitted ? feedbackHTML(q, results[q.id], s) : ''}</article>`).join('')}<div class="rd-submit-block">${s.submitted ? `<div class="rd-result-summary" data-rd-result-summary><span>参考匹配 <strong>${summary.matched}</strong></span><span>自核正确 <strong>${summary.selfConfirmed}</strong></span><span>待自核 <strong>${summary.pending}</strong></span><span>需重练／未作答 <strong>${summary.needsPractice}</strong></span></div><p class="rd-small">参考匹配与自核分开记录，不合成正确率或 DSE 分数。证据选择另行反馈。</p><div class="rd-bottom-actions">${bridge.requestSave ? '' : '<button type="button" class="rd-primary" data-rd-action="save">保存本次学习纪录</button>'}<button type="button" data-rd-action="reset">关提示再测</button>${standaloneReview}<button type="button" data-rd-action="open-library">去原卷库练习</button></div><p class="rd-small">同题复测只检验当场修正；暂无未练过的同类验证材料。原卷库保留年份、卷别与题号，可选另一份原卷独立练习。</p>` : `<button type="button" class="rd-primary" data-rd-action="submit">提交答案与证据</button><p class="rd-small">提交后才显示参考要点、同义桥与解释。</p>`}</div></section></div>${s.submitted ? `<section class="rd-paper rd-breakdown"><h3>拆开一句，再用自己的话说</h3><p lang="en">${esc(set.breakdown.sentence)}</p><div class="rd-clause-list">${set.breakdown.parts.map((p) => `<p><strong>${esc(p.label)}</strong><span lang="en">${esc(p.text)}</span></p>`).join('')}</div><label>用中文或英文复述句意<textarea data-rd-paraphrase rows="2">${esc(s.paraphrase)}</textarea></label><button type="button" data-rd-action="submit-paraphrase">提交句意复述</button><p class="rd-small">提交后才会纳入本次学习纪录。</p><details><summary>核对句意与本组表达</summary><p>${esc(set.breakdown.meaning)}</p>${set.breakdown.vocabulary.map((v) => `<p>${esc(v)}</p>`).join('')}</details></section>` : ''}<details class="rd-provenance"><summary>原卷来源与训练范围</summary><p>${esc(set.source)}</p><p>这里只显示本题组所需的原文；参考答案来自同年评分参考，中文解释与句块证据为训练辅助。</p></details></section>`;
    host.querySelector('#rd-passage').scrollTop = oldPassageScroll;
    if (focusAttribute && focusValue)
      host.querySelector(`[${focusAttribute}="${CSS.escape(focusValue)}"]`)?.focus({ preventScroll: true });
    updateClock();
  }
  function sourceCardsHTML(task, s) {
    if (!s.submitted && s.phase === 'retest')
      return '<p class="rd-small">先按任务要求自己筛选信息；提交后再逐项核对来源。</p>';
    s.activeField ||= task.sourceFields.find((f) => !s.confirmed[f.id])?.id || task.sourceFields[0].id;
    const controls = s.submitted
      ? `<div class="rd-source-controls"><label>当前核对项<select data-rd-source-step>${task.sourceFields.map((f, index) => `<option value="${f.id}" ${f.id === s.activeField ? 'selected' : ''}>${index + 1}. ${esc(f.label)}${s.confirmed[f.id] ? ' · 已自核' : ''}</option>`).join('')}</select></label><div><button type="button" data-rd-action="source-prev">上一项</button><span data-rd-source-position></span><button type="button" data-rd-action="source-next">下一项</button></div></div>`
      : '';
    return `<section id="rd-source-check" tabindex="-1"><h4>${s.submitted ? '逐项核对，再修改自己的句子' : '给每项信息标来源'}</h4><p class="rd-small">${s.submitted ? '先处理缺漏和不确定项；自核不代表官方评分。每项都可回到资料和自己的邮件。' : '有支架练习：按实际使用的材料选择，可多选；提交后才显示参考组合。'}</p>${controls}<div class="rd-source-grid ${s.submitted ? 'is-review' : ''}">${task.sourceFields
      .map(
        (f) =>
          `<div class="rd-source-row" data-rd-source-card="${f.id}" ${s.submitted && f.id !== s.activeField ? 'hidden' : ''}><strong>${esc(f.label)}</strong><div>${[
            ['audio', '录音'],
            ['df4', 'DF4'],
            ['df7', 'DF7'],
            ['df8', 'DF8'],
          ]
            .map(
              ([id, label]) =>
                `<label><input type="checkbox" data-rd-source="${f.id}" value="${id}" ${(s.sourceChoices[f.id] || []).includes(id) ? 'checked' : ''}>${label}</label>`,
            )
            .join(
              '',
            )}</div>${s.submitted ? `<div class="rd-own-draft"><strong>我的邮件 · 找出涉及这一项的句子</strong><p lang="en">${esc(s.draft)}</p><button type="button" data-rd-action="edit-draft">修改我的邮件</button></div><div class="rd-source-result"><p lang="en">${esc(f.answer)}</p><p><strong>参考来源：${f.sources.map((id) => (id === 'audio' ? '录音' : id.toUpperCase())).join(' + ')}</strong></p><p>${esc(f.why)}</p><div class="rd-source-links">${f.sources.map((id) => `<button type="button" data-rd-action="source-link" data-source="${id}">${id === 'audio' ? '回到录音与笔记' : '查看 ' + id.toUpperCase()}</button>`).join('')}</div><label><input type="checkbox" data-rd-confirmed="${f.id}" ${s.confirmed[f.id] ? 'checked' : ''}>我的邮件已准确包含这一项</label></div>` : ''}</div>`,
      )
      .join('')}</div></section>`;
  }
  function updateSourceStep({ move = 0, selected } = {}) {
    const task = getTask(),
      s = getI();
    const current = Math.max(
      0,
      task.sourceFields.findIndex((f) => f.id === s.activeField),
    );
    const index = selected
      ? task.sourceFields.findIndex((f) => f.id === selected)
      : Math.max(0, Math.min(task.sourceFields.length - 1, current + move));
    s.activeField = task.sourceFields[Math.max(0, index)].id;
    for (const card of host.querySelectorAll('[data-rd-source-card]'))
      card.hidden = s.submitted && card.dataset.rdSourceCard !== s.activeField;
    const select = host.querySelector('[data-rd-source-step]');
    if (select) select.value = s.activeField;
    const position = host.querySelector('[data-rd-source-position]');
    if (position) position.textContent = `${Math.max(0, index) + 1} / ${task.sourceFields.length}`;
    const previous = host.querySelector('[data-rd-action="source-prev"]'),
      next = host.querySelector('[data-rd-action="source-next"]');
    if (previous) previous.disabled = index <= 0;
    if (next) next.disabled = index >= task.sourceFields.length - 1;
  }
  function goToRegion(id, { returnToCheck = false, edit = false } = {}) {
    const target = host.querySelector(`#${CSS.escape(id)}`);
    if (!target) return;
    if (target.tagName === 'DETAILS') target.open = true;
    const back = host.querySelector('[data-rd-action="back-to-check"]');
    if (back) back.hidden = !returnToCheck;
    if (edit) host.querySelector('#rd-draft')?.focus({ preventScroll: true });
    else {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    target.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  function renderIntegrated() {
    stopMedia();
    const task = getTask(),
      s = getI();
    host.innerHTML = `<section class="rd-workspace rd-integrated-workspace" aria-label="B1 综合运用"><header class="rd-heading"><div><span class="rd-kicker">${task.year} Paper 3 · B1 · Task ${task.taskNumber}</span><h1>把信息写进邀请邮件</h1><p>任务要求、录音笔记、Data File 放在同一个工作台。</p></div><button type="button" data-rd-action="integrated-reset">关提示再测</button></header>
<div class="rd-toolbar"><span class="rd-phase">${s.submitted ? '自改与来源核对' : s.phase === 'retest' ? '关提示同题复测' : '有支架练习'}</span><span data-rd-clock aria-live="off"></span><button type="button" data-rd-action="integrated-clock" ${s.submitted ? 'disabled' : ''}>${s.clock.runningSince == null ? '开始／继续计时' : '暂停计时'}</button><span class="rd-small">建议 ${task.minutes} 分钟；精选资料训练，不是完整新题检验</span></div>
<nav class="rd-workbench-nav" aria-label="B1 工作区"><button type="button" data-rd-action="jump-region" data-region="rd-task-brief">任务要求</button><button type="button" data-rd-action="jump-region" data-region="rd-integrated-audio">录音与资料</button><button type="button" data-rd-action="jump-region" data-region="rd-composition">我的邮件</button>${s.submitted ? '<button type="button" data-rd-action="jump-region" data-region="rd-source-check">逐项核对</button>' : ''}<button type="button" class="rd-primary" data-rd-action="back-to-check" hidden>返回当前核对项</button></nav>
<div class="rd-notice" role="status">${esc(notice)}</div><section class="rd-paper rd-task-brief" id="rd-task-brief"><h3>任务要求</h3><p lang="en">${esc(task.prompt)}</p><p lang="en">${esc(task.situation)}</p><p lang="en">${esc(task.taskBrief)}</p></section>
<div class="rd-integrated-grid"><section class="rd-paper rd-audio-notes" id="rd-integrated-audio"><h3>录音与自己的笔记</h3><p>${esc(task.audio.label)} · 完整会议节选 8:42</p><p class="rd-small">${s.phase === 'retest' && !s.submitted ? '按任务要求独立记录信息。' : esc(task.audio.note)} 音频准备好后，可拖动进度、调速或整段循环。</p><audio controls preload="auto" playsinline aria-label="2025 B1 原录音"></audio><p data-rd-audio-status role="status">正在准备完整音频…</p><div class="rd-audio-tools"><label>速度<select data-rd-speed>${[0.75, 0.85, 1, 1.25].map((v) => `<option value="${v}" ${s.speed === v ? 'selected' : ''}>${v}×</option>`).join('')}</select></label><label><input type="checkbox" data-rd-loop ${s.loop ? 'checked' : ''}>循环这段录音</label><button type="button" data-rd-action="audio-retry" hidden>重试加载音频</button></div><label>${s.phase === 'retest' ? '自己的录音笔记' : '听到的日期、地点、演讲内容、后续活动'}<textarea rows="7" data-rd-integrated="notes" placeholder="写下自己的笔记。">${esc(s.notes)}</textarea></label>${s.submitted ? `<details class="rd-transcript"><summary>核对原音逐字稿节选</summary><p class="rd-small">官方 Track 8 节选；省略处标 …。本页用于核对信息，未制作逐词时间轴。</p>${task.transcriptExtracts.map((t) => `<h4>${esc(t.label)}</h4><p lang="en">${esc(t.text)}</p>`).join('')}</details>` : ''}</section>
<section class="rd-paper rd-data-file"><h3>Data File</h3>${task.sources.map((source, i) => `<details id="rd-data-${source.id}" ${i === 0 ? 'open' : ''}><summary>${esc(source.label)}</summary>${source.paragraphs.map((p) => `<p lang="en">${esc(p)}</p>`).join('')}${source.image ? `<a href="${esc(new URL(source.image, import.meta.url).href)}" target="_blank" rel="noopener"><img src="${esc(new URL(source.image, import.meta.url).href)}" alt="${esc(source.imageAlt)}" loading="lazy"></a>` : ''}${source.note ? `<p class="rd-small">${esc(source.note)}</p>` : ''}</details>`).join('')}</section></div>
<section class="rd-paper rd-composition" id="rd-composition"><div class="rd-draft-heading"><h3>写出你的邮件</h3><span data-rd-words>${countWords(s.draft)} 词 / 原题要求约 ${task.targetWords} 词</span></div><div class="rd-email-fields"><label>To<input data-rd-integrated="to" value="${esc(s.to)}" autocomplete="off"></label><label>From<input value="Nico Lin" readonly></label><label>Subject<input data-rd-integrated="subject" value="${esc(s.subject)}" autocomplete="off"></label></div><label class="rd-sr-only" for="rd-draft">邀请邮件正文</label><textarea id="rd-draft" rows="10" data-rd-integrated="draft" lang="en" spellcheck="false" placeholder="先自己写。提交后再核对信息与语言清单。">${esc(s.draft)}</textarea>
${sourceCardsHTML(task, s)}
${s.submitted ? `<details class="rd-language-review"><summary>人称、时态与语气自核</summary><div class="rd-language-checks">${task.languageChecks.map((c) => `<label><input type="checkbox" data-rd-language="${c.id}" ${s.checklist[c.id] ? 'checked' : ''}><span><strong>${esc(c.label)}</strong> ${esc(c.text)}</span></label>`).join('')}</div><p class="rd-small">${esc(task.feedbackNote)}</p></details>` : ''}
<div class="rd-bottom-actions"><button type="button" class="rd-primary" data-rd-action="integrated-submit">${s.submitted ? '提交自改版本' : '提交作答，开始核对'}</button>${bridge.requestSave ? '' : `<button type="button" data-rd-action="integrated-save" ${s.submitted ? '' : 'disabled'}>保存本次学习纪录</button>`}${s.submitted ? `<button type="button" data-rd-action="integrated-reset">关提示再测</button>${standaloneReview}<button type="button" data-rd-action="open-library">去原卷库练习</button>` : ''}<button type="button" data-rd-action="copy-draft">复制我的邮件</button></div><p class="rd-small">提交后暂存本次作答；明确保存才写入此浏览器。未提交的修订不包含在保存中。</p>${s.submitted ? '<p class="rd-small">同题复测只检验当场修正；暂无未练过的同类验证材料。原卷库保留年份、卷别、Part 与 Task，可选另一份原卷独立练习。</p>' : ''}</section>
<details class="rd-provenance"><summary>来源与记录说明</summary><p>${esc(task.source)}</p><p>原录音从用户整段文件第 6297–6819 秒提取，保留完整教师会议；本任务仅使用其中相关信息。学生调查为原卷扫描页。首次稿与提交后的自改版本分开记录。</p><p>这是精选 Data File 的方法训练；关提示同题复测也不等于未见材料检验。作答暂存在本次页面内，明确保存并回读后才保留。</p></details></section>`;
    updateSourceStep();
    updateClock();
    prepareAudio();
  }
  function prepareAudio() {
    const a = host.querySelector('audio');
    if (!a) return;
    const session = getI(),
      status = host.querySelector('[data-rd-audio-status]');
    const resumeAt = session.audioPosition;
    const retry = host.querySelector('[data-rd-action="audio-retry"]');
    a.onloadedmetadata = () => {
      if (resumeAt > 0 && resumeAt < a.duration) a.currentTime = resumeAt;
      a.playbackRate = session.speed;
      a.loop = session.loop;
      status.textContent = '原录音已就绪，可播放或拖动进度。';
    };
    a.onplay = () => {
      session.plays++;
      session.assisted ||= session.plays > 1;
      startClock(session);
    };
    a.ontimeupdate = () => {
      if (a.isConnected && a.readyState >= 1) session.audioPosition = a.currentTime;
    };
    a.onerror = () => {
      status.textContent = '浏览器未能播放这段音频，请重试。';
      retry.hidden = false;
    };
    retry.hidden = true;
    status.textContent = '正在准备原音，可以先阅读任务。';
    a.preload = 'metadata';
    a.src = new URL(getTask().audio.src, import.meta.url).href;
    a.load();
  }
  function updateClock() {
    if (!content || !integrated || view === 'hidden') return;
    const session = view === 'integrated' ? getI() : getR(),
      minutes = view === 'integrated' ? getTask().minutes : getSet().minutes,
      seconds = readingElapsed(session.clock);
    const element = host.querySelector('[data-rd-clock]');
    if (element)
      element.textContent = `已用 ${clockText(seconds)}${seconds > minutes * 60 ? ' · 已超过建议时长' : ` / 建议 ${minutes} 分钟`}`;
    const button = host.querySelector('[data-rd-action="clock"],[data-rd-action="integrated-clock"]');
    if (button) button.textContent = session.clock.runningSince == null ? '开始／继续计时' : '暂停计时';
  }
  function readingRecord() {
    const set = getSet(),
      s = getR(),
      results = evaluateReading(set, s.answers, s.evidence, true);
    const summary = readingSummary(results, s.selfCheck);
    return {
      module: 'reading',
      taskId: set.id,
      phase: s.phase,
      answers: copy(s.answers),
      elapsedSeconds: Math.round(readingElapsed(s.clock)),
      assisted: false,
      selfCheck: copy(s.selfCheck),
      errorTypes: [...new Set(Object.values(s.errors).filter(Boolean))],
      source: set.source,
      details: {
        evidence: copy(s.evidence),
        results,
        pending: summary.pending,
        matching: summary,
        errors: copy(s.errors),
        paraphrase: s.capturedParaphrase || '',
        title: set.title,
        unit: '练习项目，非官方分数',
      },
    };
  }
  function refreshReadingRecord() {
    const s = getR();
    if (!s.recordId) return;
    const all = studyStore.getState();
    const next = readingRecord();
    all.records = all.records.map((r) =>
      r.id === s.recordId ? { ...next, id: r.id, createdAt: r.createdAt } : r,
    );
    studyStore.replaceState(all);
  }
  function submitReading() {
    const s = getR();
    if (s.submitted) return;
    pauseClock(s);
    s.submitted = true;
    s.recordId = studyStore.addAttempt(readingRecord());
    notice = '已提交。参考要点现在开放；记录暂存，尚未保存到本机。';
    render();
  }
  function submitIntegrated() {
    const task = getTask(),
      s = getI();
    if (!s.draft.trim()) {
      notice = '先写下自己的邮件初稿，再提交核对。';
      host.querySelector('.rd-notice').textContent = notice;
      host.querySelector('[data-rd-integrated="draft"]').focus();
      return false;
    }
    pauseClock(s);
    stopMedia();
    const reviewing = s.submitted;
    s.submitted = true;
    s.capturedDraft = s.draft;
    s.capturedTo = s.to;
    s.capturedSubject = s.subject;
    const totalElapsed = readingElapsed(s.clock);
    s.recordId = studyStore.addAttempt({
      module: 'integrated',
      taskId: task.id,
      phase: reviewing ? 'review' : s.phase,
      answers: { to: s.to, subject: s.subject, draft: s.draft },
      elapsedSeconds: Math.round(Math.max(0, totalElapsed - (s.lastSubmittedElapsed || 0))),
      assisted: reviewing || s.phase === 'first' || s.assisted || s.speed !== 1 || s.loop,
      source: task.source,
      selfCheck: copy(s.checklist),
      errorTypes: [],
      details: {
        title: '2025 B1 Task 6 · Invitation email',
        notes: s.notes,
        draft: s.draft,
        sourceChoices: copy(s.sourceChoices),
        confirmed: copy(s.confirmed),
        checklist: copy(s.checklist),
        wordCount: countWords(s.draft),
        automaticMarking: false,
        supportMode: s.phase === 'retest' ? 'concealed-same-task' : 'guided-practice',
      },
    });
    s.lastSubmittedElapsed = totalElapsed;
    s.capturedWork = integratedWork(s);
    notice = reviewing
      ? '自改版本已单独暂存；首次稿仍保留。'
      : '初稿已提交。逐项核对信息来源，再检查人称、时态与语气。';
    render();
    return true;
  }
  function refreshIntegratedChecks() {
    const s = getI();
    if (!s.recordId) return;
    const all = studyStore.getState();
    all.records = all.records.map((r) =>
      r.id === s.recordId
        ? {
            ...r,
            selfCheck: copy(s.checklist),
            details: { ...r.details, confirmed: copy(s.confirmed), checklist: copy(s.checklist) },
          }
        : r,
    );
    studyStore.replaceState(all);
  }
  function sessionSaveState(kind, s) {
    const isIntegrated = kind === 'integrated';
    const label = isIntegrated ? 'B1 综合' : '阅读练习';
    if (!s) return { label, submitted: false, hasDraft: false, hasUnsubmittedChanges: false };
    const hasDraft = isIntegrated
      ? [s.to, s.subject, s.draft, s.notes].some((value) => value.trim()) ||
        Object.values(s.sourceChoices).some((ids) => ids.length)
      : Object.values(s.answers)
          .flat()
          .some((value) => String(value).trim()) || Object.values(s.evidence).some((ids) => ids.length);
    return {
      label,
      submitted: s.submitted,
      hasDraft,
      hasUnsubmittedChanges: s.submitted
        ? isIntegrated
          ? integratedWork(s) !== s.capturedWork
          : s.paraphrase !== (s.capturedParaphrase || '')
        : !!hasDraft,
    };
  }
  function currentSaveState() {
    return sessionSaveState(view, state[view]?.[view === 'integrated' ? state.taskId : state.setId]);
  }
  async function saveRecord() {
    const saveState = currentSaveState();
    if (!saveState.submitted) {
      notice = '请先提交作答；尚未提交的输入不会保存。';
      render();
      return false;
    }
    if (view === 'integrated') refreshIntegratedChecks();
    else refreshReadingRecord();
    const exclusion = saveState.hasUnsubmittedChanges ? '当前修订尚未提交，不包含在保存中。' : '';
    if (bridge.requestSave) {
      const result = await bridge.requestSave();
      if (result !== false) {
        notice = `已保存已提交的学习纪录到此浏览器，并回读确认。${exclusion}`;
        render();
      }
      return result;
    }
    try {
      const snapshot = studyStore.prepareSave();
      const pending = snapshot.state.records.length - studyStore.getSavedState().records.length;
      const summary = `${saveState.label}：已提交的作答、证据及自核结果。\n${exclusion}\n一并保存学习台暂存改动（新增 ${Math.max(0, pending)} 条练习），只写入此浏览器并回读确认。`;
      if (!(await confirmAction('保存本次学习纪录', summary, '确认保存'))) return false;
      studyStore.save(snapshot);
      notice = `已保存到此浏览器，并回读确认。${exclusion}可从“复习与备份”继续。`;
      render();
      return true;
    } catch (e) {
      notice = `保存未完成：${e.message}`;
      render();
      return false;
    }
  }
  function render() {
    if (view === 'hidden') return;
    if (loadError) {
      host.innerHTML = `<section class="rd-workspace"><h2>练习暂时无法加载</h2><p role="alert">${esc(loadError)}</p><button data-rd-action="reload">重试加载</button></section>`;
      return;
    }
    if (!content || !integrated) {
      host.innerHTML = '<section class="rd-workspace"><p role="status">正在准备原卷练习…</p></section>';
      return;
    }
    if (view === 'integrated') renderIntegrated();
    else renderReading();
    bridge.onSessionChange?.();
  }
  host.addEventListener('input', (event) => {
    const el = event.target;
    if (el.matches('[data-rd-answer]')) {
      const s = getR();
      if (s.submitted) return;
      startClock(s);
      const id = el.dataset.rdAnswer;
      if (el.dataset.index != null) {
        s.answers[id] ??= [];
        s.answers[id][Number(el.dataset.index)] = el.value;
      } else s.answers[id] = el.value;
    }
    if (el.matches('[data-rd-paraphrase]')) {
      getR().paraphrase = el.value;
    }
    if (el.matches('[data-rd-integrated]')) {
      const s = getI();
      s[el.dataset.rdIntegrated] = el.value;
      startClock(s, true);
      const counter = host.querySelector('[data-rd-words]');
      if (counter) counter.textContent = `${countWords(s.draft)} 词 / 原题要求约 ${getTask().targetWords} 词`;
      for (const preview of host.querySelectorAll('.rd-own-draft p')) preview.textContent = s.draft;
    }
  });
  host.addEventListener('input', () => bridge.onSessionChange?.());
  host.addEventListener('change', (event) => {
    const el = event.target;
    if (el.matches('[data-rd-source-step]')) updateSourceStep({ selected: el.value });
    if (el.matches('[data-rd-set]')) {
      pauseClock(getR());
      state.setId = el.value;
      notice = '';
      render();
    }
    if (el.matches('[data-rd-self]')) {
      getR().selfCheck[el.dataset.rdSelf] = el.value;
      refreshReadingRecord();
      render();
    }
    if (el.matches('[data-rd-error]')) {
      getR().errors[el.dataset.rdError] = el.value;
      refreshReadingRecord();
    }
    if (el.matches('[data-rd-speed]')) {
      const s = getI();
      s.speed = Number(el.value);
      s.assisted ||= s.speed !== 1;
      host.querySelector('audio').playbackRate = s.speed;
    }
    if (el.matches('[data-rd-loop]')) {
      getI().loop = el.checked;
      getI().assisted ||= el.checked;
      host.querySelector('audio').loop = el.checked;
    }
    if (el.matches('[data-rd-source]')) {
      const s = getI(),
        id = el.dataset.rdSource;
      const selected = new Set(s.sourceChoices[id] || []);
      el.checked ? selected.add(el.value) : selected.delete(el.value);
      s.sourceChoices[id] = [...selected];
    }
    if (el.matches('[data-rd-language]')) {
      getI().checklist[el.dataset.rdLanguage] = el.checked;
      refreshIntegratedChecks();
    }
    if (el.matches('[data-rd-confirmed]')) {
      getI().confirmed[el.dataset.rdConfirmed] = el.checked;
      refreshIntegratedChecks();
    }
  });
  host.addEventListener('change', () => bridge.onSessionChange?.());
  host.addEventListener('click', async (event) => {
    const segment = event.target.closest('[data-rd-segment]');
    if (segment) {
      const s = getR();
      if (s.submitted) return;
      startClock(s);
      const picked = new Set(s.evidence[s.activeQuestion] || []);
      picked.has(segment.dataset.rdSegment)
        ? picked.delete(segment.dataset.rdSegment)
        : picked.add(segment.dataset.rdSegment);
      s.evidence[s.activeQuestion] = [...picked];
      renderReading();
      bridge.onSessionChange?.();
      return;
    }
    const button = event.target.closest('[data-rd-action]');
    if (!button) return;
    const action = button.dataset.rdAction;
    if (action === 'reload') {
      await load();
      return;
    }
    if (!content || !integrated) return;
    if (action === 'clock' || action === 'integrated-clock') {
      const s = action === 'clock' ? getR() : getI();
      s.clock.runningSince == null ? startClock(s) : pauseClock(s);
      button.textContent = s.clock.runningSince == null ? '开始／继续计时' : '暂停计时';
      updateClock();
    }
    if (action === 'select-question' || action === 'show-evidence') {
      getR().activeQuestion = button.dataset.q;
      getR().referenceQuestion = action === 'show-evidence' ? button.dataset.q : null;
      renderReading();
      if (action === 'show-evidence') {
        const passage = host.querySelector('#rd-passage');
        const target = passage.querySelector('.is-reference');
        if (target)
          passage.scrollTop = Math.max(
            0,
            target.getBoundingClientRect().top -
              passage.getBoundingClientRect().top +
              passage.scrollTop -
              passage.clientHeight / 3,
          );
      }
      if (innerWidth < 850)
        host.querySelector('#rd-passage').scrollIntoView({
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        });
    }
    if (action === 'return-question') {
      const target = host.querySelector(`#rd-question-${CSS.escape(getR().activeQuestion)}`);
      const answer = target?.querySelector('input:not(:disabled),textarea:not(:disabled)');
      if (answer) answer.focus({ preventScroll: true });
      else if (target) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
      target?.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
    if (action === 'jump-region') goToRegion(button.dataset.region);
    if (action === 'source-link')
      goToRegion(
        button.dataset.source === 'audio' ? 'rd-integrated-audio' : `rd-data-${button.dataset.source}`,
        { returnToCheck: true },
      );
    if (action === 'edit-draft') goToRegion('rd-composition', { returnToCheck: true, edit: true });
    if (action === 'back-to-check') goToRegion('rd-source-check');
    if (action === 'source-prev' || action === 'source-next') {
      updateSourceStep({ move: action === 'source-prev' ? -1 : 1 });
      goToRegion('rd-source-check');
    }
    if (action === 'open-review') bridge.navigate?.('review');
    if (action === 'open-library') bridge.navigate?.('library');
    if (action === 'submit') submitReading();
    if (action === 'submit-paraphrase') {
      getR().capturedParaphrase = getR().paraphrase;
      refreshReadingRecord();
      notice = '句意复述已提交。可保存本次学习纪录，或关提示再测。';
      render();
    }
    if (action === 'reset') {
      if (
        await confirmAction('重新开始此题组？', '本页当前答案会清空，已提交的学习记录会保留。', '开始复测')
      ) {
        state.reading[getSet().id] = baseSession('retest');
        notice = '已关闭参考信息，请独立作答。';
        render();
      }
    }
    if (action === 'integrated-reset') {
      if (await confirmAction('重新练习此任务？', '当前草稿会清空，已提交的版本会保留。', '开始复测')) {
        stopMedia();
        state.integrated[getTask().id] = integratedSession();
        getI().phase = 'retest';
        notice = '已关闭逐字稿与参考要点。';
        render();
      }
    }
    if (action === 'save' || action === 'integrated-save') saveRecord();
    if (action === 'integrated-submit') submitIntegrated();
    if (action === 'audio-retry') {
      prepareAudio();
    }
    if (action === 'copy-draft') {
      const s = getI(),
        text = `To: ${s.to}\nFrom: Nico Lin\nSubject: ${s.subject}\n\n${s.draft}`;
      try {
        await navigator.clipboard.writeText(text);
        notice = '已复制你的邮件。';
      } catch {
        notice = '浏览器未允许复制，请长按正文选择并复制。';
      }
      host.querySelector('.rd-notice').textContent = notice;
    }
  });
  async function load() {
    loadError = '';
    render();
    try {
      const response = await Promise.all(
        ['reading.json', 'integrated.json'].map(async (path) => {
          const r = await fetch(new URL(`./content/${path}`, import.meta.url));
          if (!r.ok) throw new Error(`原卷内容加载失败 (${r.status})`);
          return r.json();
        }),
      );
      [content, integrated] = response;
      render();
    } catch (e) {
      loadError = e.message;
      render();
    }
  }
  const timer = setInterval(updateClock, 500);
  void load();
  return {
    show(next, options = {}) {
      pauseAll();
      view = next;
      if (options.taskId) {
        if (next === 'reading') state.setId = options.taskId;
        else if (next === 'integrated') state.taskId = options.taskId;
        if (options.kind === 'retest') {
          if (next === 'reading') state.reading[options.taskId] = baseSession('retest');
          if (next === 'integrated') {
            state.integrated[options.taskId] = integratedSession();
            state.integrated[options.taskId].phase = 'retest';
          }
        }
        if (options.kind === 'review') {
          const record = getRecords().findLast((r) => r.taskId === options.taskId && r.module === next);
          if (record && next === 'reading')
            state.reading[options.taskId] = {
              ...baseSession(record.phase),
              answers: copy(record.answers || {}),
              evidence: copy(record.details?.evidence || {}),
              selfCheck: copy(record.selfCheck || {}),
              errors: copy(record.details?.errors || {}),
              submitted: true,
              recordId: record.id,
              clock: { elapsed: record.elapsedSeconds || 0, runningSince: null },
              paraphrase: record.details?.paraphrase || '',
              capturedParaphrase: record.details?.paraphrase || '',
            };
          if (record && next === 'integrated')
            state.integrated[options.taskId] = {
              ...integratedSession(),
              notes: record.details?.notes || '',
              draft: record.answers?.draft || record.details?.draft || '',
              to: record.answers?.to || '',
              subject: record.answers?.subject || '',
              capturedDraft: record.answers?.draft || record.details?.draft || '',
              capturedTo: record.answers?.to || '',
              capturedSubject: record.answers?.subject || '',
              sourceChoices: copy(record.details?.sourceChoices || {}),
              confirmed: copy(record.details?.confirmed || {}),
              checklist: copy(record.details?.checklist || {}),
              submitted: true,
              recordId: record.id,
              phase: record.phase,
              clock: { elapsed: record.elapsedSeconds || 0, runningSince: null },
              lastSubmittedElapsed: record.elapsedSeconds || 0,
            };
          if (record && next === 'integrated')
            state.integrated[options.taskId].capturedWork = integratedWork(state.integrated[options.taskId]);
        }
      }
      notice = '';
      render();
    },
    getRecords,
    getSaveState() {
      const current = currentSaveState();
      current.hasUnsubmittedChanges = ['reading', 'integrated'].some((kind) =>
        Object.values(state[kind]).some((session) => sessionSaveState(kind, session).hasUnsubmittedChanges),
      );
      return current;
    },
    saveCurrent: saveRecord,
    getState() {
      pauseAll();
      return copy(state);
    },
    restoreState(data) {
      if (data?.schemaVersion === 1 && data.reading && data.integrated) {
        pauseAll();
        state = copy(data);
        for (const s of [...Object.values(state.reading), ...Object.values(state.integrated)])
          if (s.clock) s.clock.runningSince = null;
        render();
      }
    },
    destroy() {
      pauseAll();
      clearInterval(timer);
    },
  };
}
