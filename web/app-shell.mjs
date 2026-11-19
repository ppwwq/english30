import { listeningBridge } from './app.mjs';
import { studyStore } from './training-core.mjs';
import { createSessionSaver } from './session-save.mjs';

const allowed = new Set(['library', 'today', 'listening', 'reading', 'writing', 'review', 'integrated']);
let training,
  reading,
  papers,
  papersPromise,
  trainingPromise,
  readingPromise,
  current = null,
  listeningMode = 'papers',
  generation = 0;
const trainingHost = document.getElementById('training-host'),
  readingHost = document.getElementById('reading-host'),
  paperHost = document.getElementById('paper-host');
const bridge = {
  ...listeningBridge,
  navigate,
  getReadingRecords: () => reading?.getRecords?.() || [],
  onChange: listeningBridge.onChange,
  requestSave,
  onSessionChange: () => sessionChanged(),
};
let saving = false,
  saveMessage = '';
const saver = createSessionSaver({
  studyStore,
  getListeningSnapshot: () => listeningBridge.getSaveSnapshot(),
});
const saveButton = document.getElementById('session-save');
function hasUnsubmitted() {
  return [
    listeningBridge.getSaveState(),
    reading?.getSaveState?.(),
    training?.getSaveState?.(),
    papers?.getSaveState?.(),
  ].some((state) => state?.hasUnsubmittedChanges ?? state?.hasDraft);
}
function refreshSessionBar() {
  if (saving) return;
  try {
    const plan = saver.prepare();
    const pending = plan.changed;
    const unsubmitted = hasUnsubmitted();
    const saved = current === 'listening' ? listeningBridge.getSaveState().saved : !!saveMessage && !pending;
    saveButton.disabled = !pending;
    document.getElementById('session-save-status').textContent = pending
      ? '已提交，尚未保存'
      : unsubmitted
        ? '当前输入尚未提交'
        : saved
          ? '已保存到此浏览器'
          : '尚未提交';
    document.getElementById('session-save-detail').textContent =
      saveMessage ||
      (unsubmitted
        ? '尚有未提交输入，保存只包含已提交的纪录和标记；请先提交要保留的作答。'
        : pending
          ? `${plan.listening ? `待保存听力：${plan.listening.label}。` : ''}点击保存核对全部暂存内容；当前浏览的资料不会替换这份作答。`
          : '学习纪录只留在当前浏览器，可从「复习与备份」导出。');
  } catch (error) {
    saveButton.disabled = true;
    document.getElementById('session-save-status').textContent = '保存状态暂不可用';
    document.getElementById('session-save-detail').textContent = error.message;
  }
}
async function requestSave() {
  if (saving) return false;
  let plan;
  try {
    plan = saver.prepare();
    if (!plan.changed) {
      saveMessage = '没有新的已提交纪录需要保存。未提交输入不会自动保存。';
      refreshSessionBar();
      return false;
    }
    const items = [];
    if (plan.listening)
      items.push(
        `听力：${plan.listening.label || plan.listening.record.lessonTitle || plan.listening.record.lessonId}，${plan.listening.record.attempts.length} 轮作答及标记`,
      );
    if (plan.study.changed) {
      const saved = new Map(studyStore.getSavedState().records.map((r) => [r.id, JSON.stringify(r)]));
      const changed = plan.study.state.records.filter((r) => saved.get(r.id) !== JSON.stringify(r));
      const labels = { reading: '阅读', integrated: 'B1 综合', writing: '写句', dictation: '短句听写' };
      for (const [module, label] of Object.entries(labels)) {
        const count = changed.filter((r) => r.module === module).length;
        if (count) items.push(`${label}：${count} 条新增或更新纪录`);
      }
      if (!changed.length || plan.study.state.paperMarks.length)
        items.push('其他已暂存的复习标记、手动复习状态及设置');
    }
    if (
      !confirm(
        `准备保存本次学习纪录：\n${items.join('\n')}\n\n未提交的输入不包含。仅写入当前浏览器，不上传云端；保存后回读验证。`,
      )
    )
      return false;
    saving = true;
    saveButton.disabled = true;
    document.getElementById('session-save-status').textContent = '正在保存并回读…';
    await saver.save(plan);
    saveMessage = saver.prepare().changed
      ? '确认时的纪录已完成回读验证；保存期间的新修改尚未保存。'
      : hasUnsubmitted()
        ? '已完成回读验证。尚有未提交输入未保存，请提交后再保存。'
        : '已完成回读验证。可结束本次，或从「复习与备份」继续。';
    return true;
  } catch (error) {
    saveMessage = `保存未完成：${error.message} 请保留当前页面，检查后重试。`;
    return false;
  } finally {
    saving = false;
    refreshSessionBar();
  }
}
saveButton.addEventListener('click', requestSave);
document.getElementById('session-review').addEventListener('click', () => navigate('review'));
listeningBridge.setSaveHandler(requestSave);
const sessionChanged = () => {
  saveMessage = '';
  refreshSessionBar();
};
studyStore.subscribe(sessionChanged);
listeningBridge.onChange(sessionChanged);
window.addEventListener('beforeunload', (event) => {
  if (hasUnsubmitted() || saver.prepare().changed) {
    event.preventDefault();
    event.returnValue = '';
  }
});
async function navigate(view, options = {}) {
  const previousView = current,
    previousMode = listeningMode;
  if (view === 'listening/practice') {
    view = 'listening';
    options = { ...options, mode: 'practice' };
  }
  if (!allowed.has(view)) view = 'library';
  // Existing original-page marks retain their reader deep links.
  if (view === 'listening' && options.paper) view = 'library';
  if (view === 'listening') {
    if (options.lessonId) listeningMode = options.lessonId.startsWith('paper-') ? 'papers' : 'practice';
    else if (['papers', 'practice'].includes(options.mode)) listeningMode = options.mode;
  }
  const request = ++generation;
  current = view;
  document.body.dataset.view = view;
  document.body.dataset.listeningMode = listeningMode;
  const listening = view === 'listening',
    practice = listening && listeningMode === 'practice',
    paperView = view === 'library',
    readingView = ['reading', 'integrated'].includes(view);
  document.getElementById('practice-picker').hidden = !listening || practice;
  document.getElementById('listening-panel').hidden = !listening;
  document.querySelector('.player').hidden = !listening;
  document.querySelector('.lesson-picker').hidden = !practice;
  trainingHost.hidden = listening || readingView || view === 'library';
  readingHost.hidden = !readingView;
  paperHost.hidden = !paperView;
  listeningBridge.pauseListening();
  for (const audio of document.querySelectorAll('audio')) audio.pause();
  reading?.show('hidden');
  papers?.show('hidden');
  window.speechSynthesis?.cancel();
  const primary = view === 'integrated' ? 'listening' : view;
  document.getElementById('session-review').setAttribute('aria-pressed', String(view === 'review'));
  for (const button of document.querySelectorAll('.main-navigation>button'))
    button.setAttribute('aria-pressed', String(button.dataset.view === primary));
  const hash = practice ? '#listening/practice' : `#${view}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  try {
    if (listening) {
      const changed = options.lessonId
        ? await listeningBridge.openLesson(options.lessonId)
        : await listeningBridge.showMode(listeningMode);
      if (request !== generation) return;
      if (changed === false) {
        await navigate(previousView || 'listening', { mode: previousMode });
        return;
      }
      listeningBridge.refreshSaved();
      refreshSessionBar();
      return;
    }
    if (paperView) {
      papers ||= await (papersPromise ||= import('./papers.mjs')
        .then((m) => m.mountPapers({ host: paperHost, bridge }))
        .catch((error) => {
          papersPromise = null;
          throw error;
        }));
      if (request === generation) await papers.show(view, options);
      else if (paperHost.hidden) papers.show('hidden');
    } else if (readingView) {
      reading ||= await (readingPromise ||= import('./reading.mjs')
        .then((m) => m.mountReading({ host: readingHost, bridge }))
        .catch((error) => {
          readingPromise = null;
          throw error;
        }));
      if (request === generation) await reading.show(view, options);
    } else {
      training ||= await (trainingPromise ||= import('./training.mjs')
        .then((m) => m.mountTraining({ host: trainingHost, bridge }))
        .catch((error) => {
          trainingPromise = null;
          throw error;
        }));
      if (request === generation) await training.show(view, options);
    }
    refreshSessionBar();
  } catch (error) {
    if (request !== generation) return;
    if (listening) {
      document.getElementById('status').textContent = error.message;
      return;
    }
    const host = paperView ? paperHost : readingView ? readingHost : trainingHost;
    host.replaceChildren();
    const notice = document.createElement('div');
    notice.className = 'shell-error';
    notice.setAttribute('role', 'alert');
    notice.textContent = `训练内容暂时没有载入：${error.message}`;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button-secondary';
    retry.textContent = '重新载入';
    retry.addEventListener('click', () => navigate(view, options));
    notice.append(document.createElement('br'), retry);
    host.append(notice);
  }
}
for (const button of document.querySelectorAll('.main-navigation>button'))
  button.addEventListener('click', () => navigate(button.dataset.view, { mode: 'papers' }));
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  const target =
    document.body.dataset.view === 'listening'
      ? document.getElementById('questions')
      : !paperHost.hidden
        ? paperHost
        : readingHost.hidden
          ? trainingHost
          : readingHost;
  target.tabIndex = -1;
  target.focus();
  target.scrollIntoView({ block: 'start' });
});
window.addEventListener('hashchange', () =>
  navigate(location.hash.slice(1), location.hash === '#listening' ? { mode: 'papers' } : {}),
);
listeningBridge.setNavigator(navigate);
navigate(location.hash.slice(1) || 'library');
