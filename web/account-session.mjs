import { dismissConfirmation } from './confirmation.mjs';

const deviceKey = 'english30-browser-session';
const tabKey = 'english30-tab-account';
const epochKey = 'english30-tab-epoch';
let timer,
  watching = false,
  masked = false;
let pageEpoch;

function device() {
  return JSON.parse(localStorage.getItem(deviceKey) || '{}');
}
function forgetTab() {
  sessionStorage.removeItem(tabKey);
  sessionStorage.removeItem(epochKey);
  sessionStorage.removeItem('english30-recovery-once');
}
function rememberTab(user, epoch) {
  sessionStorage.setItem(tabKey, JSON.stringify(user));
  sessionStorage.setItem(epochKey, epoch || '');
}
function changeDevice(owner, pending = false) {
  const state = { owner, pending, epoch: crypto.randomUUID() };
  localStorage.setItem(deviceKey, JSON.stringify(state));
  return state;
}
export const withIdentityLock = (action) =>
  navigator.locks ? navigator.locks.request('english30-session-change', action) : action();

function hideAccount(message) {
  dismissConfirmation();
  masked = true;
  document.title = 'English30';
  const main = document.createElement('main');
  main.className = 'account-host';
  const heading = document.createElement('h1');
  heading.textContent = '账号已在本机关闭';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.textContent = message;
  const home = document.createElement('a');
  home.className = 'button-secondary';
  home.href = location.pathname;
  home.textContent = '返回主页';
  main.append(heading, status, home);
  document.body.replaceChildren(main);
  window.scrollTo(0, 0);
}
async function finishLogout() {
  const state = device();
  if (!state.pending) return true;
  let response;
  let confirmed = false;
  try {
    response = await fetch('/api/account/logout', {
      method: 'POST',
      headers: { 'X-English30-Owner': state.owner },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) confirmed = (await response.json()).ok === true;
  } catch {}
  if (device().epoch !== state.epoch) return false;
  // A different authenticated owner already replaced this browser's old cookie.
  if (confirmed || response?.status === 409) {
    localStorage.setItem(deviceKey, JSON.stringify({ ...state, owner: null, pending: false }));
    clearTimeout(timer);
    return true;
  }
  clearTimeout(timer);
  timer = setTimeout(retryLogout, 30000);
  return false;
}
function retryLogout() {
  void withIdentityLock(finishLogout)
    .then((done) => {
      if (done && masked) location.reload();
    })
    .catch(() => {});
}
export async function allowLogin() {
  if (!(await finishLogout())) throw Error('本机已退出。请联网完成上次退出，再登录账号。');
}
export function accountOpened(user) {
  const state = changeDevice(user.id);
  rememberTab(user, state.epoch);
}
export function accountClosed() {
  changeDevice(null);
  forgetTab();
}
export function pageHasAccount() {
  const state = device();
  return !masked && !state.pending && state.epoch === pageEpoch;
}
export function logoutLocally(owner) {
  const state = device();
  if (state.epoch !== pageEpoch && state.epoch) {
    forgetTab();
    hideAccount('浏览器账号已切换。');
    location.reload();
    return;
  }
  changeDevice(owner, true);
  forgetTab();
  hideAccount('本机已退出。连接账号服务后会结束服务器会话。');
  retryLogout();
}
function watch() {
  if (watching) return;
  watching = true;
  const changed = () => {
    const state = device();
    if (state.epoch !== pageEpoch && !masked) {
      forgetTab();
      hideAccount(state.pending ? '本机已退出。连接账号服务后会结束服务器会话。' : '浏览器账号已切换。');
      if (state.pending) retryLogout();
      else location.reload();
    } else if (masked && !state.pending) location.reload();
  };
  window.addEventListener('storage', (event) => {
    if (event.key === deviceKey || event.key === null) changed();
  });
  window.addEventListener('pageshow', changed);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) changed();
  });
  window.addEventListener('online', retryLogout);
}
export async function resolveAccountIdentity() {
  let user = null;
  try {
    const state = device();
    pageEpoch = state.epoch;
    watch();
    if (state.pending) {
      forgetTab();
      retryLogout();
      return { user: null, offline: true };
    }
    const response = await fetch('/api/account/me', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('offline');
    ({ user } = await response.json());
    if (device().epoch !== pageEpoch) return { user: null, offline: true };
    if ((state.owner || null) !== (user?.id || null)) pageEpoch = changeDevice(user?.id || null).epoch;
    if (user) rememberTab(user, pageEpoch);
    else forgetTab();
    return { user, offline: false };
  } catch {
    try {
      const state = device();
      const previous = JSON.parse(sessionStorage.getItem(tabKey));
      if (
        !state.pending &&
        (sessionStorage.getItem(epochKey) || '') === (state.epoch || '') &&
        (!state.epoch || state.owner === previous?.id)
      )
        user = previous;
    } catch {}
    return { user, offline: true };
  }
}
