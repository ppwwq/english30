import { listeningBridge } from './app.mjs';

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
};
async function navigate(view, options = {}) {
  if (view === 'listening/practice') {
    view = 'listening';
    options = { ...options, mode: 'practice' };
  }
  if (!allowed.has(view)) view = 'library';
  if (view === 'listening') {
    if (options.lessonId) listeningMode = 'practice';
    else if (['papers', 'practice'].includes(options.mode)) listeningMode = options.mode;
  }
  const request = ++generation;
  current = view;
  document.body.dataset.view = view;
  document.body.dataset.listeningMode = listeningMode;
  const listening = view === 'listening',
    practice = listening && listeningMode === 'practice',
    paperView = view === 'library' || (listening && !practice),
    readingView = ['reading', 'integrated'].includes(view);
  document.getElementById('listening-modes').hidden = !listening;
  for (const button of document.querySelectorAll('button[data-listening-mode]'))
    button.setAttribute('aria-pressed', String(button.dataset.listeningMode === listeningMode));
  document.getElementById('listening-mode-note').textContent = practice
    ? '短段作答、错因复盘，也可以导入自己的练习包。'
    : '按年份、Part 和 Task 选择原卷，直接听原音、看题页。';
  document.getElementById('listening-panel').hidden = !practice;
  document.querySelector('.player').hidden = !practice;
  document.querySelector('.lesson-picker').hidden = !practice;
  document.querySelector('.import-menu').hidden = !practice;
  trainingHost.hidden = listening || readingView || view === 'library';
  readingHost.hidden = !readingView;
  paperHost.hidden = !paperView;
  listeningBridge.pauseListening();
  for (const audio of document.querySelectorAll('audio')) audio.pause();
  reading?.show('hidden');
  papers?.show('hidden');
  window.speechSynthesis?.cancel();
  const primary = view === 'review' ? 'writing' : view === 'integrated' ? 'reading' : view;
  for (const button of document.querySelectorAll('.main-navigation>button'))
    button.setAttribute('aria-pressed', String(button.dataset.view === primary));
  const hash = practice ? '#listening/practice' : `#${view}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  try {
    if (practice) {
      if (options.lessonId) await listeningBridge.openLesson(options.lessonId);
      listeningBridge.refreshSaved();
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
  } catch (error) {
    if (request !== generation) return;
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
  button.addEventListener('click', () => navigate(button.dataset.view));
for (const button of document.querySelectorAll('button[data-listening-mode]'))
  button.addEventListener('click', () => navigate('listening', { mode: button.dataset.listeningMode }));
document.querySelector('.skip-link').addEventListener('click', (event) => {
  event.preventDefault();
  const target =
    document.body.dataset.view === 'listening' && listeningMode === 'practice'
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
