const cache = 'english30-tab-account';
let previous = null;
try {
  previous = JSON.parse(sessionStorage.getItem(cache));
} catch {}
let user,
  offline = false;
try {
  const response = await fetch('/api/account/me', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('offline');
  ({ user } = await response.json());
  if (user) sessionStorage.setItem(cache, JSON.stringify(user));
  else sessionStorage.removeItem(cache);
} catch {
  user = previous;
  offline = true;
}
globalThis.english30Identity = { user, offline };
await import('./app-shell.mjs');
