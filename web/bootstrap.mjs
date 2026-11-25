import { resolveAccountIdentity } from './account-session.mjs';
import { showViewLoading } from './view-loading.mjs';

// Home links are usable while the account request is pending. The full workspace
// reads account-scoped drafts and therefore starts only once the owner is known.
function showPublicRoute() {
  const view = location.hash.slice(1) || 'home';
  const home = view === 'home';
  document.body.dataset.view = view;
  document.getElementById('home-panel').hidden = !home;
  document.getElementById('home-back').hidden = home;
  showViewLoading(view);
}
showPublicRoute();
window.addEventListener('hashchange', showPublicRoute);
try {
  globalThis.english30Identity = await resolveAccountIdentity();
  await import('./app-shell.mjs');
} catch {
  const notice = document.getElementById('view-loading');
  if (notice) {
    notice.hidden = false;
    notice.textContent = '页面未能载入。';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button-secondary';
    retry.textContent = '重新载入';
    retry.addEventListener('click', () => location.reload());
    notice.append(' ', retry);
  }
} finally {
  window.removeEventListener('hashchange', showPublicRoute);
}
