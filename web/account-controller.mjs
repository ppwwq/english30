import { activeAccount, scopedKey } from './account-scope.mjs';
import {
  accountOpened,
  accountClosed,
  allowLogin,
  logoutLocally,
  pageHasAccount,
  withIdentityLock,
} from './account-session.mjs';
import { emptyBackup, learningDelta, applyLearningDelta } from './account-learning.mjs';
import { validateBackup, LISTENING_KEY, STUDY_KEY } from './training-core.mjs';
import { handwrittenImage, typedImages, paperSaveInfo } from './account-render.mjs';
import { putJob, putJobs, jobsFor, removeJob } from './account-queue.mjs';
import {
  clearReadingStorage,
  packReadingPaperInk,
  readReadingInkFile,
  unpackReadingPaperInk,
} from './reading-paper-storage.mjs';

const user = activeAccount,
  changed = () => window.dispatchEvent(new Event('english30-account-change'));
const UUID = () => crypto.randomUUID();
const versionPath = (id, v) => '/api/papers/' + id + '/versions/' + v;
const isReading = (record) => record.module === 'reading' && !!record.details?.readingPaper;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
import { loadBooks, bookFor, bookPageEdits } from './answer-books.mjs';
export function createAccountController({ studyStore, enterPaper, enterReading, canSwitch }) {
  let pending = 0,
    conflict = null,
    uploading,
    offline = !!globalThis.english30Identity?.offline,
    expired = false,
    initialized = false,
    latestCloud,
    restoring,
    workspace = null;
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
  const readingOpened = new Map(Object.entries(tab('reading-book-resume') || {}));
  function rememberReading(recordId, version) {
    readingOpened.delete(recordId);
    if (version) readingOpened.set(recordId, { version });
    setTab('reading-book-resume', Object.fromEntries([...readingOpened].slice(-8)));
  }
  const duringUpload = (action) =>
    navigator.locks ? navigator.locks.request('english30-upload-' + user.id, action) : action();
  function markExpired() {
    if (expired) return;
    expired = true;
    changed();
  }
  async function api(path, { method = 'GET', data, raw, paper } = {}) {
    if (user && !pageHasAccount()) throw Error('本机账号已切换。');
    const headers = {};
    if (user) headers['X-English30-Owner'] = user.id;
    if (paper) headers['X-English30-Paper'] = paper;
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
    if (user && !pageHasAccount()) throw Error('本机账号已切换。');
    if (user && r.status === 401 && !/^\/api\/account\/(login|register|recover)$/.test(path)) {
      markExpired();
      throw Object.assign(Error('账号会话已过期，请在「我的答卷」重新登录。'), { status: 401 });
    }
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
    if (!expired && !(await canSwitch())) throw Error('已保留当前练习。');
    return withIdentityLock(async () => {
      await allowLogin();
      const result = await api('/api/account/' + route, { method: 'POST', data });
      if (expired && user?.id === result.user.id) {
        expired = false;
        changed();
        void restoreLearning(false).catch(() => {});
        return result;
      }
      accountOpened(result.user);
      if (result.recoveryCode)
        sessionStorage.setItem(
          'english30-recovery-once',
          JSON.stringify({ id: result.user.id, code: result.recoveryCode }),
        );
      location.reload();
      return result;
    });
  }
  async function counts() {
    if (!user) return;
    const jobs = await jobsFor(user.id);
    pending = jobs.length;
    const failed = jobs.find((j) => j.conflict || j.readingConflict);
    conflict = failed ? { paperId: failed.readingConflict || failed.paper.id } : null;
    changed();
  }
  const hashBytes = async (bytes) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  async function uploadBlob(blob, route, paper) {
    const hash = await hashBytes(await blob.arrayBuffer());
    const url = '/api/' + route + '/' + hash,
      r = await fetch(url, {
        method: 'HEAD',
        cache: 'no-store',
        headers: { 'X-English30-Owner': user.id, ...(paper ? { 'X-English30-Paper': paper } : {}) },
      });
    if (r.status === 404) await api(url, { method: 'PUT', raw: blob, paper });
    else if (!r.ok) {
      if (r.status === 401) markExpired();
      throw Error('页图状态未能核实，请重新登录后再试。');
    }
    return hash;
  }
  async function packRecord(record, files, paper) {
    const attempts = [];
    for (const a of record.attempts) {
      const packed = { ...a };
      for (const field of ['ink', 'reviewInk']) {
        if (!a[field]) continue;
        delete packed[field];
        const refs = {};
        for (const [key, strokes] of Object.entries(a[field])) {
          const blob = new Blob([JSON.stringify({ [key]: strokes })], { type: 'application/json' });
          const hash = await hashBytes(await blob.arrayBuffer());
          if (!files.has(hash)) {
            await uploadBlob(blob, 'ink', paper);
            files.add(hash);
          }
          refs[key] = hash;
        }
        packed[field + 'Files'] = refs;
      }
      attempts.push(packed);
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
  function storeBackup(value, protectReadingEdits = false) {
    const b = validateBackup(value),
      previous = studyStore.exportBackup();
    // Preserve newer unsaved UI changes while acknowledging the restored baseline.
    const live = studyStore.getState(),
      draftDelta = learningDelta(previous, { ...previous, study: live });
    let protectedReading = false;
    if (protectReadingEdits) {
      const edited = new Set(draftDelta.sets.records.filter(isReading).map(({ id }) => id));
      const incoming = new Map(b.study.records.map((r) => [r.id, r]));
      for (const record of previous.study.records) {
        if (edited.has(record.id) && !same(record, incoming.get(record.id))) {
          incoming.set(record.id, record);
          protectedReading = true;
        }
      }
      if (protectedReading) b.study.records = [...incoming.values()];
    }
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
    const merged = applyLearningDelta(b, draftDelta).study;
    if (!same(live, merged)) studyStore.replaceState(merged);
    if (!same(previous.study, b.study)) studyStore.ackSave({ state: b.study });
    return protectedReading;
  }
  async function restoreLearning(force = true) {
    if (restoring) return restoring;
    const operation = async () => {
      if (uploading) await uploading.catch(() => {});
      return duringUpload(async () => {
        const { backup, hash } = await api('/api/learning');
        if (!backup) return false;
        if (!force && latestCloud === hash) return true;
        let b = validateBackup(backup);
        for (const job of await jobsFor(user.id))
          if (job.delta && job.localReady) b = applyLearningDelta(b, job.delta);
        latestCloud = storeBackup(b, true) ? undefined : hash;
        return true;
      });
    };
    restoring = operation().finally(() => (restoring = null));
    return restoring;
  }
  async function readingId(id) {
    const direct = id.slice(2);
    if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(direct) && id.startsWith('a-')) return direct;
    const h = await hashBytes(new TextEncoder().encode(user.id + '/reading/' + id));
    return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
  }
  function readingJob(record, previous) {
    return { record, previous, saveId: UUID(), opened: readingOpened.get(record.id) };
  }
  function capture(plan, combined = false) {
    if (!user) return null;
    const previous = studyStore.exportBackup(),
      next = structuredClone(previous);
    if (plan.study.changed) next.study = plan.study.state;
    if (plan.listening) next.listening.push(plan.listening.record);
    const job = { saveId: UUID(), created: Date.now(), owner: user.id, delta: learningDelta(previous, next) };
    const readingPapers = job.delta.sets.records.filter(isReading).map((r) =>
      readingJob(
        r,
        previous.study.records.find(({ id }) => id === r.id),
      ),
    );
    if (readingPapers.length) job.readingPapers = readingPapers;
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
  async function prepareOriginals(p, prior) {
    const books = await loadBooks();
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
    return { originals, missing };
  }
  async function shipPaper(job, files) {
    const p = job.paper;
    const source = p.fork?.id || p.id;
    const uploadImage = (blob) => uploadBlob(blob, 'images', source);
    let prior;
    if (p.base || p.fork) {
      const baseId = p.fork?.id || p.id,
        baseVersion = p.fork?.version || p.base;
      try {
        prior = await api(versionPath(baseId, baseVersion));
      } catch (error) {
        // A queued copy may have lost its source before its first version was created.
        if (error.status === 404 && !error.code && p.copySource)
          await api('/api/papers/' + p.copySource + '/versions');
        throw error;
      }
    } else await api('/api/papers/' + p.id + '/versions');
    const { originals, missing } = await prepareOriginals(p, prior);
    const pages = new Map(originals.map((page) => [page.key, page]));
    const attempt = p.record.attempts.at(-1),
      images = {};
    for (const { key, page, strokes, reusable } of bookPageEdits(prior, p.record, p.touched, originals)) {
      if (missing.has(page.master)) continue;
      if (!strokes?.length) continue;
      if (reusable) {
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
      data: { ...p, record: await packRecord(p.record, files, source), info: undefined, images, appendices },
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
  async function shipReading(p, files) {
    const { record } = p;
    const lessonId = record.taskId;
    const [, edition, part] = lessonId.split(':');
    const book = `reading-${edition}-${part}`;
    const id = await readingId(record.id);
    const [current] = await api('/api/papers/' + id + '/versions');
    const prior = current ? await api(versionPath(id, current.version)) : null;
    const latest = prior?.records[lessonId];
    const opened = p.opened?.version;
    if (same(latest, record)) {
      rememberReading(record.id);
      return;
    }
    if (current && (p.previous ? !same(latest, p.previous) : opened !== current.version))
      throw Object.assign(Error('另一台设备已保存新版。'), { code: 'VERSION_CONFLICT', paperId: id });
    if (current && opened && opened !== current.version)
      throw Object.assign(Error('当前打开的是旧版答卷。'), { code: 'VERSION_CONFLICT', paperId: id });
    const { originals, missing } = await prepareOriginals({ book }, prior);
    const details = record.details.readingPaper;
    const images = {},
      appendices = [],
      ink = {};
    for (const field of ['inkFiles', 'reviewInkFiles']) {
      for (const [key, hash] of Object.entries(details[field] || {})) {
        const blob = await readReadingInkFile(hash);
        const data = JSON.parse(await blob.text());
        if (!Array.isArray(data[key])) throw Error('阅读笔迹与页表不符。');
        (ink[key] ||= []).push(...data[key]);
        if (!files.has(hash)) {
          if (hash !== (await uploadBlob(blob, 'ink', id))) throw Error('阅读笔迹摘要不符。');
          files.add(hash);
        }
      }
    }
    for (const page of originals) {
      const strokes = ink[page.key];
      if (!strokes?.length || missing.has(page.master)) continue;
      if (
        prior?.pictures[page.key] &&
        ['inkFiles', 'reviewInkFiles'].every(
          (field) => latest.details.readingPaper[field]?.[page.key] === details[field]?.[page.key],
        )
      )
        images[page.key] = prior.pictures[page.key];
      else
        images[page.key] = await uploadBlob(
          await handwrittenImage(page, strokes, '/api/books/master/' + page.master),
          'images',
          id,
        );
    }
    await typedImages({ paper: 1, part }, record, async (blob, after) =>
      appendices.push({ hash: await uploadBlob(blob, 'images', id), after }),
    );
    const result = await api('/api/papers', {
      method: 'POST',
      data: {
        id,
        base: current?.version || 0,
        saveId: p.saveId,
        book,
        task: 0,
        lessonId,
        record,
        images,
        appendices,
      },
    });
    const verified = await api(versionPath(id, result.version));
    if (verified.pages.length !== result.pages || !same(verified.records[lessonId], record))
      throw Error('云端阅读答卷回读不一致。');
    rememberReading(record.id);
  }
  async function ship(job) {
    if (!job.localReady && !job.imported) {
      if (job.delta) storeBackup(applyLearningDelta(studyStore.exportBackup(), job.delta));
      job.localReady = true;
      await putJob(job);
    }
    const files = new Set();
    let skipped = false;
    const p = job.paper;
    if (p) {
      try {
        await shipPaper(job, files);
      } catch (error) {
        if (error.code !== 'PAPER_DELETED') throw error;
        skipped = true;
        if (binding?.id === p.id || binding?.id === p.fork?.id) {
          binding = null;
          workspace = null;
          setTab('answer-book', null);
        }
      }
    }
    if (job.delta) {
      const delta = structuredClone(job.delta);
      const paper = p && { id: p.id, source: p.fork?.id, lesson: p.lessonId, stamp: p.record.savedAt };
      if (skipped)
        delta.sets.listening = delta.sets.listening.filter(
          (r) => r.lessonId !== paper.lesson || r.savedAt !== paper.stamp,
        );
      for (const reading of job.readingPapers || []) {
        if (reading.uploaded) continue;
        try {
          await shipReading(reading, files);
          reading.uploaded = true;
          await putJob(job);
        } catch (error) {
          if (error.code !== 'PAPER_DELETED') {
            error.readingRecordId = reading.record.id;
            throw error;
          }
          delta.sets.records = delta.sets.records.filter(({ id }) => id !== reading.record.id);
          skipped = true;
        }
      }
      for (const group of [delta.sets, delta.removed])
        for (const [i, record] of group.listening.entries())
          group.listening[i] = await packRecord(record, files);
      const r = await api('/api/learning', { method: 'POST', data: { saveId: job.saveId, delta, paper } });
      const verified = await api('/api/learning/receipts/' + job.saveId);
      if (r.hash !== verified.hash) throw Error('云端学习记录回读不一致。');
      skipped ||= !!r.omitted;
    }
    await removeJob(job.saveId);
    return skipped;
  }
  async function flush(options = {}) {
    if (uploading) {
      const current = await uploading;
      if (!options.saveId) return current;
      return flush(options);
    }
    const operation = async () => {
      let copy = options.asCopy === true;
      let skipped = 0;
      let processed = 0;
      let checked = false;
      let paperError;
      const blocked = new Set();
      const blockedRead = new Set();
      const jobs = await jobsFor(user.id);
      for (const job of jobs) {
        if (
          (job.paper && blocked.has(job.paper.id)) ||
          job.readingPapers?.some((p) => blockedRead.has(p.record.id))
        )
          continue;
        if (job.conflict && copy) {
          const previous = job.paper,
            newId = UUID();
          job.paper = { ...previous, id: newId, base: 0, fork: { id: previous.id, version: previous.base } };
          const moved = [job];
          for (const later of jobs) {
            if (later !== job && later.paper?.id === previous.id && later.paper.base > previous.base) {
              later.paper.id = newId;
              later.paper.copySource = previous.id;
              later.paper.base -= previous.base;
              moved.push(later);
            }
          }
          job.conflict = false;
          copy = false;
          await putJobs(moved);
        }
        if (job.readingConflict && copy) {
          const reading = job.readingPapers.find((p) => p.conflict);
          const oldId = reading.record.id,
            nextId = 'a-' + UUID();
          const asCopy = (r) => ({
            ...r,
            id: nextId,
            details: {
              ...r.details,
              readingPaper: { ...r.details.readingPaper, copyOf: r.details.readingPaper.copyOf || oldId },
            },
          });
          for (const other of jobs) {
            if (other.created < job.created) continue;
            for (const p of other.readingPapers || [])
              if (p.record.id === oldId) {
                other.delta.sets.records = other.delta.sets.records.map((r) =>
                  r.id === oldId ? asCopy(r) : r,
                );
                p.record = asCopy(p.record);
                p.previous = p === reading || !p.previous ? undefined : asCopy(p.previous);
                p.opened = undefined;
                p.conflict = false;
              }
          }
          rememberReading(oldId);
          delete job.readingConflict;
          copy = false;
          await putJobs(jobs.filter((j) => j.readingPapers?.some((p) => p.record.id === nextId)));
        }
        try {
          if (await ship(job)) skipped++;
          processed++;
          if (job.saveId === options.saveId) checked = true;
        } catch (e) {
          if (e.code === 'VERSION_CONFLICT') {
            const reading = job.readingPapers?.find((p) => p.record.id === e.readingRecordId);
            if (reading) {
              job.readingConflict = e.paperId;
              reading.conflict = true;
            } else job.conflict = true;
            await putJob(job);
          }
          if (job.readingConflict) {
            blockedRead.add(e.readingRecordId);
            paperError ||= e;
            continue;
          }
          if (job.paper && (e.code === 'VERSION_CONFLICT' || e.status === 404)) {
            blocked.add(job.paper.id);
            paperError ||= e;
            continue;
          }
          throw e;
        }
      }
      if (paperError) throw paperError;
      return { skipped, processed, ...(options.saveId ? { checked } : {}) };
    };
    uploading = duringUpload(operation)
      .then((result) => {
        if (result.processed) {
          window.dispatchEvent(new CustomEvent('english30-account-synced', { detail: result }));
          setTimeout(() => void restoreLearning(false).catch(() => {}), 0);
        }
        return result;
      })
      .finally(async () => {
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
    await restoreLearning(false);
    const existing = new Set(studyStore.getSavedState().records.map(({ id }) => id));
    const readingPapers = [];
    const records = [];
    for (const r of g.study.records) {
      if (!isReading(r)) {
        records.push(r);
        continue;
      }
      if (existing.has(r.id)) continue;
      const { ink, reviewInk, inkFiles, reviewInkFiles, ...details } = r.details.readingPaper;
      const pages = await unpackReadingPaperInk(
        { ink, reviewInk, inkFiles, reviewInkFiles },
        guest ? null : user.id,
      );
      const files = await packReadingPaperInk(pages);
      const record = { ...r, details: { ...r.details, readingPaper: { ...details, ...files } } };
      records.push(record);
      readingPapers.push(readingJob(record));
    }
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
      const written = new Set([...Object.keys(last.ink || {}), ...Object.keys(last.reviewInk || {})]),
        verified = [...written].filter((k) =>
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
          touched: verified.filter((key) => last.ink?.[key]),
          legacyInk: verified.length < written.size,
        },
      });
    }
    await stage({
      saveId: await deterministic('guest/' + fingerprint),
      owner: user.id,
      created: Date.now(),
      delta: learningDelta(emptyBackup(), { ...g, study: { ...g.study, records } }),
      readingPapers,
      imported: true,
    });
    await flush();
    await restoreLearning();
    localStorage.setItem(marker, fingerprint);
  }
  return {
    state: () => ({ user, pending, conflict, offline, expired }),
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
      if (!user || initialized) return;
      initialized = true;
      const sync = () => {
        if (!document.hidden && !expired && pageHasAccount()) void restoreLearning(false).catch(() => {});
      };
      window.addEventListener('focus', sync);
      window.addEventListener('online', sync);
      window.addEventListener('english30-account-expired', markExpired);
      document.addEventListener('visibilitychange', sync);
      setInterval(sync, 60_000);
      await counts();
      void restoreLearning(false).catch(() => {});
      if (binding?.version && !pending) {
        try {
          const m = await api(versionPath(binding.id, binding.version));
          if (binding?.id === m.id) workspace = m;
        } catch {}
      }
      await loadBooks().catch(() => {});
    },
    list: () => api('/api/papers'),
    versions: (id) => api('/api/papers/' + id + '/versions'),
    detail: (id, v) => api(versionPath(id, v)),
    imageUrl: (id, v, n) => versionPath(id, v) + '/pages/' + n + '/image?viewer=' + user.id,
    pdfUrl: (id, v) => versionPath(id, v) + '/pdf?viewer=' + user.id,
    login: (name, password) => authenticate('login', { name, password }),
    register: (name, password) => authenticate('register', { name, password }),
    recover: (name, code, password) => authenticate('recover', { name, code, password }),
    async logout() {
      if (!(await canSwitch())) throw Error('已保留当前练习。');
      logoutLocally(user.id);
    },
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
      const m = await api(versionPath(id, v));
      if (m.paper === 1) {
        const record = Object.values(m.records)[0];
        const entered = await enterReading({
          year: m.year,
          variant: m.variant,
          part: m.part,
          recordId: record.id,
          record,
        });
        if (entered !== false) rememberReading(record.id, Number(v));
        return;
      }
      const choice = m.taskChoices.find((c) => c.task === Number(task || m.lastTask));
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
      const jobs = await jobsFor(user.id);
      const reading = await Promise.all(
        jobs.flatMap((j) => (j.readingPapers || []).map((p) => readingId(p.record.id))),
      );
      if (jobs.some((j) => j.paper?.id === id) || reading.includes(id))
        throw Error('请先完成这份卷的待上传保存。');
      await api('/api/papers/' + id, { method: 'DELETE' });
      if (binding?.id === id) {
        binding = null;
        workspace = null;
        setTab('answer-book', null);
      }
      await restoreLearning().catch(() => {});
    },
    async deleteAccount(password) {
      if (!(await canSwitch())) throw Error('已保留当前练习。');
      await api('/api/account/delete', { method: 'POST', data: { password } });
      for (const job of await jobsFor(user.id)) await removeJob(job.saveId);
      for (const storage of [sessionStorage, localStorage])
        for (const k of Object.keys(storage)) if (k.startsWith(scopedKey(''))) storage.removeItem(k);
      await clearReadingStorage(user.id).catch(() => {});
      accountClosed();
      location.reload();
    },
  };
}
