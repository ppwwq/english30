import { activeAccount, scopedKey } from './account-scope.mjs';
import { emptyBackup, learningDelta, applyLearningDelta } from './account-learning.mjs';
import { validateBackup, LISTENING_KEY, STUDY_KEY } from './training-core.mjs';
import { handwrittenImage, typedImages, paperSaveInfo } from './account-render.mjs';
import { putJob, jobsFor, removeJob } from './account-queue.mjs';

const user = activeAccount,
  changed = () => window.dispatchEvent(new Event('english30-account-change'));
const UUID = () => crypto.randomUUID();
const versionPath = (id, v) => '/api/papers/' + id + '/versions/' + v;
import { loadBooks, bookFor } from './answer-books.mjs';
export function createAccountController({ studyStore, enterPaper, canSwitch }) {
  let pending = 0,
    conflict = null,
    uploading,
    offline = !!globalThis.english30Identity?.offline,
    workspace = null;
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('english30-login') : null;
  channel?.addEventListener('message', () => location.reload());
  function tab(key) {
    try {
      return JSON.parse(sessionStorage.getItem(scopedKey(key)));
    } catch {
      return null;
    }
  }
  function setTab(key, value) {
    if (value == null) sessionStorage.removeItem(scopedKey(key));
    else sessionStorage.setItem(scopedKey(key), JSON.stringify(value));
  }
  let binding = tab('answer-book');
  async function api(path, { method = 'GET', data, raw } = {}) {
    const headers = {};
    if (user) headers['X-English30-Owner'] = user.id;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try {
      r = await fetch(path, {
        method,
        cache: 'no-store',
        headers,
        body: raw ?? (data === undefined ? undefined : JSON.stringify(data)),
      });
    } catch {
      offline = true;
      throw Error('暂时无法连接账号服务。');
    }
    offline = false;
    const out = await r.json().catch(() => ({}));
    if (!r.ok)
      throw Object.assign(Error(out.error || '账号服务未能完成请求。'), {
        status: r.status,
        code: out.code,
        paperId: out.paperId,
      });
    return out;
  }
  async function authenticate(route, data) {
    if (!canSwitch()) throw Error('已保留当前练习。');
    const result = await api('/api/account/' + route, { method: 'POST', data });
    if (result.recoveryCode)
      sessionStorage.setItem(
        'english30-recovery-once',
        JSON.stringify({ id: result.user.id, code: result.recoveryCode }),
      );
    if (result.user) sessionStorage.setItem('english30-tab-account', JSON.stringify(result.user));
    else sessionStorage.removeItem('english30-tab-account');
    channel?.postMessage('changed');
    location.reload();
    return result;
  }
  async function counts() {
    if (!user) return;
    const jobs = await jobsFor(user.id);
    pending = jobs.length;
    const failed = jobs.find((j) => j.conflict);
    conflict = failed ? { paperId: failed.paper.id } : null;
    changed();
  }
  const hashBytes = async (bytes) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  async function uploadBlob(blob, route) {
    const hash = await hashBytes(await blob.arrayBuffer());
    const url = '/api/' + route + '/' + hash,
      r = await fetch(url, { method: 'HEAD', cache: 'no-store', headers: { 'X-English30-Owner': user.id } });
    if (r.status === 404) await api(url, { method: 'PUT', raw: blob });
    else if (!r.ok) throw Error('页图状态未能核实，请重新登录后再试。');
    return hash;
  }
  const uploadImage = (blob) => uploadBlob(blob, 'images');
  async function packRecord(record, files) {
    const attempts = [];
    for (const a of record.attempts) {
      if (!a.ink) {
        attempts.push(a);
        continue;
      }
      const { ink, ...rest } = a,
        inkFiles = {};
      for (const [key, strokes] of Object.entries(ink)) {
        const blob = new Blob([JSON.stringify({ [key]: strokes })], { type: 'application/json' });
        const hash = await hashBytes(await blob.arrayBuffer());
        if (!files.has(hash)) {
          await uploadBlob(blob, 'ink');
          files.add(hash);
        }
        inkFiles[key] = hash;
      }
      attempts.push({ ...rest, inkFiles });
    }
    return { ...record, attempts };
  }
  function guestBackup() {
    const data = emptyBackup(),
      s = localStorage.getItem('english30-study-v1'),
      l = localStorage.getItem('english30-records-v1');
    if (s) data.study = JSON.parse(s);
    if (l) data.listening = JSON.parse(l);
    return validateBackup(data);
  }
  function countBackup(b) {
    return (
      b.listening.length +
      b.study.records.length +
      b.study.paperMarks.length +
      b.study.personalExercises.length +
      Object.keys(b.study.reviews).length
    );
  }
  function storeBackup(value) {
    const b = validateBackup(value),
      previous = studyStore.exportBackup();
    // Preserve newer unsaved UI changes while acknowledging the restored baseline.
    const live = studyStore.getState(),
      draftDelta = learningDelta(previous, { ...previous, study: live });
    const entries = [
      [STUDY_KEY, JSON.stringify(b.study)],
      [LISTENING_KEY, JSON.stringify(b.listening)],
    ];
    const before = entries.map(([k]) => localStorage.getItem(k));
    try {
      for (const [k, text] of entries) {
        localStorage.setItem(k, text);
        if (localStorage.getItem(k) !== text) throw Error('取回记录未通过回读。');
      }
    } catch (error) {
      for (const [i, [k]] of entries.entries()) {
        if (before[i] === null) localStorage.removeItem(k);
        else localStorage.setItem(k, before[i]);
      }
      throw error;
    }
    studyStore.replaceState(applyLearningDelta(b, draftDelta).study);
    studyStore.ackSave({ state: b.study });
  }
  async function restoreLearning() {
    const cloud = (await api('/api/learning')).backup;
    if (!cloud) return false;
    let b = validateBackup(cloud);
    for (const job of await jobsFor(user.id)) if (job.delta) b = applyLearningDelta(b, job.delta);
    storeBackup(b);
    return true;
  }
  function capture(plan, combined = false) {
    if (!user) return null;
    const previous = studyStore.exportBackup(),
      next = structuredClone(previous);
    if (plan.study.changed) next.study = plan.study.state;
    if (plan.listening) next.listening.push(plan.listening.record);
    const job = { saveId: UUID(), created: Date.now(), owner: user.id, delta: learningDelta(previous, next) };
    const info = plan.listening?.paperInfo;
    if (info) {
      const record = plan.listening.record,
        a = record.attempts.at(-1),
        partKey = info.sessionId + '-' + info.part;
      const match =
        binding &&
        binding.book.split('+').includes(partKey) &&
        (binding.attemptId === a.id ||
          plan.listening.continuing ||
          (a.phase !== 'retest' && binding.lastTask !== info.task));
      const book = match
        ? binding.book
        : combined
          ? info.sessionId + '-A+' + info.sessionId + '-B1'
          : partKey;
      const id = match ? binding.id : UUID(),
        base = match ? binding.version : 0;
      job.paper = {
        id,
        base,
        book,
        task: info.task,
        lessonId: record.lessonId,
        record,
        info,
        hasSeparateData: !!bookFor({ sessionId: info.sessionId, part: 'B1' })?.data?.length,
        touched: a.ink ? [...new Set([...Object.keys(a.ink), ...(plan.listening.touched || [])])] : [],
        saveId: job.saveId,
      };
    }
    return job;
  }
  async function stage(job) {
    await putJob(job);
    await counts();
  }
  function bind(paper, version) {
    binding = {
      id: paper.id,
      version,
      book: paper.book,
      lastTask: paper.task,
      attemptId: paper.record.attempts.at(-1).id,
    };
    setTab('answer-book', binding);
  }
  async function ship(job) {
    if (!job.localReady && !job.imported) {
      // A crash after the confirmed intent was queued may precede the local write.
      // Replay only its changes, then verify local persistence before any upload.
      if (job.delta) storeBackup(applyLearningDelta(studyStore.exportBackup(), job.delta));
      job.localReady = true;
      await putJob(job);
    }
    const files = new Set();
    if (job.paper) {
      const p = job.paper,
        books = await loadBooks();
      let prior;
      if (p.base || p.fork) {
        const baseId = p.fork?.id || p.id,
          baseVersion = p.fork?.version || p.base;
        prior = await api(versionPath(baseId, baseVersion));
      }
      const originals =
        prior?.originals ||
        p.book.split('+').flatMap((k) => [...books[k].pages, ...(p.includeData ? books[k].data || [] : [])]);
      const missing = new Set();
      for (const key of p.book.split('+')) {
        const pages = [...books[key].pages, ...(p.includeData || prior ? books[key].data || [] : [])];
        const hashes = prior
          ? prior.pages
              .filter((page) => page.missing && page.master && pages.some((q) => q.master === page.master))
              .map((page) => page.master)
          : pages.map((page) => page.master);
        for (let i = 0; i < hashes.length; i += 8) {
          const r = await api('/api/books/freeze', {
            method: 'POST',
            data: { book: key, hashes: hashes.slice(i, i + 8) },
          });
          for (const h of r.missing || []) missing.add(h);
        }
      }
      const pages = new Map(originals.map((page) => [page.key, page]));
      const attempt = p.record.attempts.at(-1),
        images = {};
      for (const key of p.touched) {
        const page = pages.get(key);
        if (!page) throw Error('笔迹里有不属于当前题册的原页；本机记录已保留。');
        if (missing.has(page.master)) continue;
        const strokes = attempt.ink?.[key];
        if (!strokes?.length) continue;
        if (prior?.pictures[key] && JSON.stringify(prior.ink[key]) === JSON.stringify(strokes)) {
          images[key] = prior.pictures[key];
          continue;
        }
        images[key] = await uploadImage(
          await handwrittenImage(page, strokes, '/api/books/master/' + page.master),
        );
      }
      const appendices = [];
      await typedImages(p.info, attempt, async (blob, after) =>
        appendices.push({ hash: await uploadImage(blob), after: pages.has(after) ? after : null }),
      );
      const result = await api('/api/papers', {
        method: 'POST',
        data: { ...p, record: await packRecord(p.record, files), info: undefined, images, appendices },
      });
      const verified = await api(versionPath(result.id, result.version));
      if (
        verified.pages.length !== result.pages ||
        verified.records[p.lessonId]?.attempts.at(-1)?.id !== attempt.id
      )
        throw Error('云端答卷回读不一致。');
      if (!job.imported && (!binding || binding.id === p.id || binding.id === p.fork?.id)) {
        if (!binding || binding.version <= result.version || binding.id !== p.id) bind(p, result.version);
        workspace = verified;
      }
    }
    if (job.delta) {
      const delta = structuredClone(job.delta);
      for (const group of [delta.sets, delta.removed])
        for (const [i, record] of group.listening.entries())
          group.listening[i] = await packRecord(record, files);
      const r = await api('/api/learning', { method: 'POST', data: { saveId: job.saveId, delta } });
      const verified = await api('/api/learning/receipts/' + job.saveId);
      if (r.hash !== verified.hash) throw Error('云端学习记录回读不一致。');
    }
    await removeJob(job.saveId);
  }
  async function flush(options = {}) {
    if (uploading) return uploading;
    const operation = async () => {
      let copy = options.asCopy === true;
      const jobs = await jobsFor(user.id);
      for (const job of jobs) {
        if (job.conflict && copy) {
          const previous = job.paper,
            newId = UUID();
          job.paper = { ...previous, id: newId, base: 0, fork: { id: previous.id, version: previous.base } };
          for (const later of jobs) {
            if (later !== job && later.paper?.id === previous.id && later.paper.base > previous.base) {
              later.paper.id = newId;
              later.paper.base -= previous.base;
              await putJob(later);
            }
          }
          job.conflict = false;
          copy = false;
          await putJob(job);
        }
        try {
          await ship(job);
        } catch (e) {
          if (e.code === 'VERSION_CONFLICT') {
            job.conflict = true;
            await putJob(job);
          }
          throw e;
        }
      }
    };
    const drain = () =>
      navigator.locks ? navigator.locks.request('english30-upload-' + user.id, operation) : operation();
    uploading = drain().finally(async () => {
      uploading = null;
      await counts();
    });
    return uploading;
  }
  async function importBackup(input, guest = false) {
    const g = validateBackup(input),
      fingerprint = await hashBytes(new TextEncoder().encode(JSON.stringify([g.study, g.listening])));
    const marker = scopedKey(guest ? 'imported-guest' : 'imported-backup');
    if (localStorage.getItem(marker) === fingerprint) return;
    const deterministic = async (key) => {
      const h = await hashBytes(new TextEncoder().encode(user.id + '/' + key));
      return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
    };
    for (const record of g.listening) {
      if (!/^paper-\d{4}-(exam|practice)-(a|b1)-task-\d+$/.test(record.lessonId)) continue;
      const r = await fetch('./papers/practice/' + record.lessonId + '.json');
      if (!r.ok) continue;
      const info = paperSaveInfo(await r.json()),
        last = record.attempts.at(-1),
        key = record.lessonId + '/' + record.savedAt;
      const id = await deterministic('paper/' + key),
        saveId = await deterministic('save/' + key);
      const pages = (await loadBooks())[info.sessionId + '-' + info.part].pages;
      const written = Object.keys(last.ink || {}),
        verified = written.filter((k) =>
          pages.some((p) => p.key === k && p.originalHash === last.sourceVersions?.[k]),
        );
      await stage({
        saveId,
        owner: user.id,
        created: Date.now(),
        imported: true,
        paper: {
          id,
          saveId,
          base: 0,
          book: info.sessionId + '-' + info.part,
          record,
          lessonId: record.lessonId,
          task: info.task,
          info,
          touched: verified,
          legacyInk: verified.length < written.length,
        },
      });
    }
    await stage({
      saveId: await deterministic('guest/' + fingerprint),
      owner: user.id,
      created: Date.now(),
      delta: learningDelta(emptyBackup(), g),
      imported: true,
    });
    await flush();
    await restoreLearning();
    localStorage.setItem(marker, fingerprint);
  }
  return {
    state: () => ({ user, pending, conflict, offline }),
    capture,
    stage,
    async localConfirmed(job) {
      job.localReady = true;
      await putJob(job);
      if (job.paper) bind(job.paper, job.paper.base + 1);
    },
    async cancel(job) {
      await removeJob(job.saveId);
      await counts();
    },
    retry: flush,
    async init() {
      if (!user) return;
      await counts();
      if (binding?.version && !pending) {
        try {
          const m = await api(versionPath(binding.id, binding.version));
          if (binding?.id === m.id) workspace = m;
        } catch {}
      }
      await loadBooks().catch(() => {});
      if (!localStorage.getItem(STUDY_KEY) && !localStorage.getItem(LISTENING_KEY))
        await restoreLearning().catch(() => {});
    },
    list: () => api('/api/papers'),
    versions: (id) => api('/api/papers/' + id + '/versions'),
    detail: (id, v) => api(versionPath(id, v)),
    imageUrl: (id, v, n) => versionPath(id, v) + '/pages/' + n + '/image?viewer=' + user.id,
    pdfUrl: (id, v) => versionPath(id, v) + '/pdf?viewer=' + user.id,
    login: (name, password) => authenticate('login', { name, password }),
    register: (name, password) => authenticate('register', { name, password }),
    recover: (name, code, password) => authenticate('recover', { name, code, password }),
    logout: () => authenticate('logout', {}),
    takeRecoveryCode() {
      const s = sessionStorage.getItem('english30-recovery-once');
      sessionStorage.removeItem('english30-recovery-once');
      try {
        const receipt = JSON.parse(s);
        return receipt?.id === user?.id ? receipt?.code : null;
      } catch {
        return null;
      }
    },
    guestCount: async () => {
      const g = guestBackup();
      const f = await hashBytes(new TextEncoder().encode(JSON.stringify([g.study, g.listening])));
      return localStorage.getItem(scopedKey('imported-guest')) === f ? 0 : countBackup(g);
    },
    importGuest: () => importBackup(guestBackup(), true),
    importBackup,
    restoreLearning,
    async resume(id, v, task) {
      const m = await api(versionPath(id, v)),
        choice = m.taskChoices.find((c) => c.task === Number(task || m.lastTask));
      if (!choice) throw Error('这个 Task 暂时不能继续。');
      if (!(await enterPaper(m, choice))) return;
      workspace = m;
      binding = {
        id,
        version: Number(v),
        book: m.book,
        lastTask: choice.task,
        attemptId: m.records[choice.lessonId]?.attempts.at(-1)?.id,
      };
      setTab('answer-book', binding);
    },
    workspaceFor(info) {
      return workspace &&
        binding?.id === workspace.id &&
        binding.book.split('+').includes(info.sessionId + '-' + info.part)
        ? workspace
        : null;
    },
    deletePaper: async (id) => {
      if ((await jobsFor(user.id)).some((j) => j.paper?.id === id))
        throw Error('请先完成这份卷的待上传保存。');
      await api('/api/papers/' + id, { method: 'DELETE' });
      if (binding?.id === id) {
        binding = null;
        workspace = null;
        setTab('answer-book', null);
      }
    },
    async deleteAccount(password) {
      if (!canSwitch()) throw Error('已保留当前练习。');
      await api('/api/account/delete', { method: 'POST', data: { password } });
      for (const job of await jobsFor(user.id)) await removeJob(job.saveId);
      for (const storage of [sessionStorage, localStorage])
        for (const k of Object.keys(storage)) if (k.startsWith(scopedKey(''))) storage.removeItem(k);
      sessionStorage.removeItem('english30-tab-account');
      channel?.postMessage('changed');
      location.reload();
    },
  };
}
