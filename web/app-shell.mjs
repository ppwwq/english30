import { confirmAction, dismissConfirmation } from './confirmation.mjs';
import { listeningBridge } from './app.mjs';
import { studyStore } from './training-core.mjs';
import { createSessionSaver } from './session-save.mjs';
import { showViewLoading } from './view-loading.mjs';
import { loadPaperCatalogue } from './paper-catalogue.mjs';

import { createAccountController } from './account-controller.mjs';
import { confirmAccountSave } from './account-confirm.mjs';
import { mountAccountView } from './account-view.mjs';
const accountHost = document.getElementById('account-host');
let accountView;
const account = createAccountController({
  studyStore,
  canSwitch: () =>
    !saving &&
    (!(hasUnsubmitted() || saver.prepare().changed) ||
      confirmAction('切换账号', '切换账号将关闭当前练习，未保存的输入可能丢失。', '切换账号')),
  async enterPaper(manifest, choice) {
    if (!(await listeningBridge.continuePaper(manifest, choice))) return false;
    await navigate('listening', { lessonId: choice.lessonId });
    return true;
  },
});
listeningBridge.setWorkspaceReader((info) => account.workspaceFor(info));
const homeAvatar = document.getElementById('home-avatar');
const guestIcon = homeAvatar.querySelector('svg');
function refreshHomeAvatar() {
  const { user } = account.state();
  const label = user ? `我的答卷（${user.name}）` : '登录账号';
  homeAvatar.setAttribute('aria-label', label);
  homeAvatar.title = label;
  homeAvatar.replaceChildren(user ? Array.from(user.name)[0].toLocaleUpperCase() : guestIcon);
}
refreshHomeAvatar();
const allowed = new Set([
  'account',
  'home',
  'library',
  'today',
  'listening',
  'reading',
  'writing',
  'review',
  'integrated',
]);
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
  saveMessage = '',
  cloudStatus = '';
const saver = createSessionSaver({
  studyStore,
  getListeningSnapshot: () => listeningBridge.getSaveSnapshot(),
});
const saveButton = document.getElementById('session-save');
const saveBar = document.querySelector('.session-savebar');
const saveState = saveBar.querySelector('.session-state');
const appHeader = document.querySelector('.app-header');
const homePanel = document.getElementById('home-panel');
document.addEventListener('pointerdown', (event) => {
  if (saveState.open && appHeader.contains(saveState) && !saveState.contains(event.target))
    saveState.open = false;
});
saveState.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && saveState.open && appHeader.contains(saveState)) {
    saveState.open = false;
    saveState.querySelector('summary').focus();
  }
});
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
    const queued = account.state().pending;
    saveBar.hidden = current === 'account' && !pending && !unsubmitted && !queued && !saveMessage;
    const saved = current === 'listening' ? listeningBridge.getSaveState().saved : !!saveMessage && !pending;
    saveButton.disabled = !pending;
    document.getElementById('session-save-status').textContent = pending
      ? '已提交，尚未保存'
      : queued
        ? '已存本机，云端待完成'
        : unsubmitted
          ? '当前输入尚未提交'
          : saved
            ? cloudStatus || '已保存到此浏览器'
            : '尚未提交';
    document.getElementById('session-save-detail').textContent =
      saveMessage ||
      (queued ? '有 ' + queued + ' 次已确认的保存待上传，可从「我的答卷」重试。' : '') ||
      (unsubmitted
        ? '尚有未提交输入，保存只包含已提交的纪录和标记；请先提交要保留的作答。'
        : pending
          ? `${plan.listening ? `待保存听力：${plan.listening.label}。` : ''}点击保存核对全部暂存内容；当前浏览的资料不会替换这份作答。`
          : account.state().user
            ? '确认保存后，可在「我的答卷」取回。'
            : '学习纪录只留在当前浏览器，可从「复习与备份」导出。');
  } catch (error) {
    saveBar.hidden = false;
    saveButton.disabled = true;
    saveState.open = true;
    document.getElementById('session-save-status').textContent = '保存状态暂不可用';
    document.getElementById('session-save-detail').textContent = error.message;
  }
}
async function requestSave() {
  if (saving) return false;
  let plan,
    job,
    staged = false,
    localSaved = false;
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
    saving = true;
    const { user } = account.state();
    if (user) {
      job = account.capture(plan);
      const decision = await confirmAccountSave({
        name: user.name,
        items,
        job,
        combinedAvailable: !!job.paper && job.paper.base === 0,
      });
      if (!decision) return false;
      if (decision.combined && job.paper)
        job.paper.book = job.paper.info.sessionId + '-A+' + job.paper.info.sessionId + '-B1';
      if (job.paper) job.paper.includeData = decision.includeData;
      await account.stage(job);
      staged = true;
    } else if (
      !(await confirmAction(
        '保存本次学习纪录',
        `${items.join('\n')}\n\n仅保存已提交的内容到当前浏览器，保存后回读验证。未提交的输入仍留在草稿中。`,
        '确认保存',
      ))
    )
      return false;
    saveButton.disabled = true;
    document.getElementById('session-save-status').textContent = '正在保存并回读…';
    await saver.save(plan);
    localSaved = true;
    if (job) {
      await account.localConfirmed(job);
      cloudStatus = '已存本机，云端待完成';
      document.getElementById('session-save-status').textContent = '已存本机，正在上传答卷…';
      const result = await account.retry({ saveId: job.saveId });
      cloudStatus = result.skipped
        ? '已存本机，原云端答卷已删除'
        : result.checked === false
          ? '已在其他标签处理'
          : '已存云端';
    }
    saveMessage = saver.prepare().changed
      ? '确认时的纪录已完成回读验证；保存期间的新修改尚未保存。'
      : hasUnsubmitted()
        ? '已完成回读验证。尚有未提交输入未保存，请提交后再保存。'
        : '已完成回读验证。可结束本次，或从「复习与备份」继续。';
    if (job)
      saveMessage =
        (cloudStatus === '已存云端'
          ? '已存云端，已回读核对。可从「我的答卷」取回。'
          : cloudStatus === '已在其他标签处理'
            ? '这次保存已在其他标签处理，可到「我的答卷」核对。'
            : '其他设备已删除待传答卷，已保留本机记录，其余保存已处理。') +
        (saver.prepare().changed ? ' 之后的新修改尚未保存。' : '');
    return true;
  } catch (error) {
    if (staged && !localSaved) await account.cancel(job);
    if (localSaved && job) {
      saveState.open = true;
      cloudStatus = '已存本机，云端待完成';
      saveMessage = error.message + ' 请到「我的答卷」重试上传。';
      return false;
    }
    saveMessage = `保存未完成：${error.message} 请保留当前页面，检查后重试。`;
    saveState.open = true;
    return false;
  } finally {
    saving = false;
    refreshSessionBar();
  }
}
saveButton.addEventListener('click', requestSave);
document.getElementById('session-review').addEventListener('click', () => navigate('review'));
const sessionChanged = () => {
  saveMessage = '';
  refreshSessionBar();
};
function refreshAccountState() {
  refreshHomeAvatar();
  refreshSessionBar();
}
window.addEventListener('english30-account-change', refreshAccountState);
window.addEventListener('english30-account-synced', ({ detail }) => {
  if (detail.skipped) {
    cloudStatus = '已存本机，原云端答卷已删除';
    saveMessage = '其他设备已删除待传答卷，其余保存已处理。';
  } else {
    cloudStatus = '已存云端';
    saveMessage = '已存云端，已回读核对。';
  }
  refreshSessionBar();
});
studyStore.subscribe(sessionChanged);
listeningBridge.onChange(sessionChanged);
window.addEventListener('beforeunload', (event) => {
  if (hasUnsubmitted() || saver.prepare().changed) {
    event.preventDefault();
    event.returnValue = '';
  }
});
async function navigate(view, options = {}) {
  dismissConfirmation();
  const previousView = current,
    previousMode = listeningMode;
  if (view === 'listening/practice') {
    view = 'listening';
    options = { ...options, mode: 'practice' };
  }
  if (view === 'papers') view = 'library';
  if (!allowed.has(view)) view = 'home';
  // Existing original-page marks retain their reader deep links.
  if (view === 'listening' && options.paper) view = 'library';
  if (view === 'listening') {
    if (options.lessonId) listeningMode = options.lessonId.startsWith('paper-') ? 'papers' : 'practice';
    else if (['papers', 'practice'].includes(options.mode)) listeningMode = options.mode;
  }
  const request = ++generation;
  showViewLoading(view);
  current = view;
  document.body.dataset.view = view;
  document.body.dataset.listeningMode = listeningMode;
  const listening = view === 'listening',
    practice = listening && listeningMode === 'practice',
    paperView = view === 'library',
    readingView = ['reading', 'integrated'].includes(view);
  const home = view === 'home',
    accountPage = view === 'account';
  accountHost.hidden = !accountPage;
  if (!home) {
    if (saveBar.parentElement !== appHeader) appHeader.append(saveBar);
  } else if (saveBar.parentElement === appHeader) homePanel.after(saveBar);
  if (view !== previousView) saveState.open = home;
  homePanel.hidden = !home;
  homeAvatar.hidden = !home;
  document.getElementById('home-back').hidden = home;
  document.getElementById('change-paper').setAttribute('aria-expanded', 'false');
  document.getElementById('practice-picker').hidden = !listening || practice;
  const listeningPanel = document.getElementById('listening-panel');
  listeningPanel.hidden = !listening;
  listeningPanel.inert = listening;
  document.querySelector('.player').hidden = !listening;
  document.querySelector('.lesson-picker').hidden = !practice;
  trainingHost.hidden = accountPage || home || listening || readingView || paperView;
  readingHost.hidden = !readingView;
  paperHost.hidden = !paperView;
  listeningBridge.pauseListening();
  for (const audio of document.querySelectorAll('audio')) audio.pause();
  reading?.show('hidden');
  papers?.show('hidden');
  window.speechSynthesis?.cancel();
  document.getElementById('session-review').setAttribute('aria-pressed', String(view === 'review'));
  const hash = practice ? '#listening/practice' : `#${view}`;
  if (location.hash !== hash) {
    if (!previousView || options.replace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
  }
  if (previousView && previousView !== view) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    document.getElementById(home ? 'home-title' : 'home-back').focus({ preventScroll: true });
  }
  try {
    if (accountPage) {
      refreshSessionBar();
      if (!accountView) accountView = mountAccountView(accountHost, account);
      else await accountView.refresh();
      if (previousView === 'home' && request === generation) accountView.focusLogin();
      return;
    }
    if (home) {
      refreshSessionBar();
      return;
    }
    if (listening) {
      const changed = options.lessonId
        ? await listeningBridge.openLesson(options.lessonId)
        : await listeningBridge.showMode(listeningMode);
      if (request !== generation) return;
      if (changed === false) {
        await navigate(previousView || 'home', { mode: previousMode, replace: true });
        return;
      }
      listeningBridge.refreshSaved();
      refreshSessionBar();
      return;
    }
    if (paperView) {
      papers ||= await (papersPromise ||= Promise.all([import('./papers.mjs'), loadPaperCatalogue()])
        .then(([m, catalogue]) => m.mountPapers({ host: paperHost, bridge, catalogue }))
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
      if (view === 'review' || view === 'today') void listeningBridge.prepareCatalogue();
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
      const status = document.getElementById('status');
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'button-secondary';
      retry.textContent = '重新载入';
      retry.addEventListener('click', () => navigate(view, options));
      status.replaceChildren(error.message, ' ', retry);
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
  } finally {
    if (request === generation) {
      listeningPanel.inert = false;
      showViewLoading(null);
    }
  }
}
const changePaper = document.getElementById('change-paper');
changePaper.addEventListener('click', () => {
  const expanded = changePaper.getAttribute('aria-expanded') !== 'true';
  changePaper.setAttribute('aria-expanded', String(expanded));
  if (expanded) document.getElementById('practice-year')?.focus();
});
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  let target =
    current === 'account'
      ? accountHost
      : current === 'home'
        ? document.getElementById('home-title')
        : current === 'listening'
          ? document.getElementById('questions')
          : !paperHost.hidden
            ? paperHost
            : readingHost.hidden
              ? trainingHost
              : readingHost;
  if (current === 'listening' && !target.getClientRects().length)
    target =
      document.querySelector('#practice-sources .practice-page-wrap') ||
      document.getElementById('listening-panel');
  if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
  target.focus();
  target.scrollIntoView({ block: 'start' });
});
window.addEventListener('hashchange', () =>
  navigate(location.hash.slice(1), location.hash === '#listening' ? { mode: 'papers' } : {}),
);
// Handle ordinary home links in the same click, including touch and keyboard.
// Modified clicks keep the browser's native open-in-new-tab behavior.
homePanel.querySelector('.main-navigation').addEventListener('click', (event) => {
  const link = event.target.closest('a[data-view]');
  if (
    !link ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigate(link.dataset.view, link.dataset.view === 'listening' ? { mode: 'papers' } : {});
});
listeningBridge.setNavigator(navigate);
account
  .init()
  .catch(() => {})
  .finally(refreshAccountState);
navigate(location.hash.slice(1) || 'home');
