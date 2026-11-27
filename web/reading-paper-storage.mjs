import { activeAccount, scopedKey } from './account-scope.mjs';
import { validatePaperInk } from './core.mjs';

const draftKey = scopedKey('english30-reading-paper-tab');
let opening;

function database() {
  return (opening ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('english30-reading-paper', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('ink');
      request.result.createObjectStore('draft');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    opening = null;
    throw error;
  }));
}

async function access(name, mode, run) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const result = run(tx.objectStore(name));
    tx.oncomplete = () => resolve(result.result);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('阅读卷面未能写入浏览器。'));
  });
}

function tabKey(create) {
  let id = sessionStorage.getItem(draftKey);
  if (!id && create) {
    id = crypto.randomUUID();
    sessionStorage.setItem(draftKey, id);
  }
  return id && draftKey + ':' + id;
}

export async function readReadingDraft() {
  const key = tabKey(false);
  return key ? access('draft', 'readonly', (store) => store.get(key)) : null;
}

export async function writeReadingDraft(value) {
  const key = tabKey(!!value);
  if (key) await access('draft', 'readwrite', (store) => (value ? store.put(value, key) : store.delete(key)));
}

const hashPattern = /^[a-f0-9]{64}$/;
const hashBlob = async (blob) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

export async function readReadingInkFile(hash, owner = activeAccount?.id) {
  if (!hashPattern.test(hash)) throw new Error('阅读笔迹编号无效。');
  const key = scopedKey(hash, owner);
  const local = await access('ink', 'readonly', (store) => store.get(key));
  if (local) return typeof local === 'string' ? new Blob([local], { type: 'application/json' }) : local;
  if (!owner) throw new Error('浏览器内缺少这页阅读笔迹。');
  const result = await fetch('/api/ink/' + hash, {
    cache: 'no-store',
    headers: { 'X-English30-Owner': owner },
  });
  if (!result.ok) throw new Error('云端阅读笔迹未能取回，请联网后重试。');
  const blob = await result.blob();
  if ((await hashBlob(blob)) !== hash) throw new Error('阅读笔迹校验不一致。');
  const text = await blob.text();
  await access('ink', 'readwrite', (store) => store.put(text, key));
  return blob;
}

export async function packReadingPaperInk({ ink, reviewInk }, owner = activeAccount?.id) {
  async function pack(pages) {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(validatePaperInk(pages || {})).map(async ([key, strokes]) => {
          const text = JSON.stringify({ [key]: strokes });
          const blob = new Blob([text], { type: 'application/json' });
          const hash = await hashBlob(blob);
          await access('ink', 'readwrite', (store) => store.put(text, scopedKey(hash, owner)));
          return [key, hash];
        }),
      ),
    );
  }
  const [inkFiles, reviewInkFiles] = await Promise.all([pack(ink), pack(reviewInk)]);
  return { inkFiles, reviewInkFiles };
}

export async function unpackReadingPaperInk(details = {}, owner = activeAccount?.id) {
  async function unpack(field) {
    const files = details[field + 'Files'];
    if (!files) return validatePaperInk(details[field] || {});
    const entries = await Promise.all(
      Object.entries(files).map(async ([key, hash]) => {
        const pages = validatePaperInk(JSON.parse(await (await readReadingInkFile(hash, owner)).text()));
        if (!Object.hasOwn(pages, key) || Object.keys(pages).length !== 1)
          throw new Error('阅读笔迹与卷面页码不匹配。');
        return [key, pages[key]];
      }),
    );
    return Object.fromEntries(entries);
  }
  const [ink, reviewInk] = await Promise.all([unpack('ink'), unpack('reviewInk')]);
  return { ink, reviewInk };
}

export async function portableReadingBackup(backup) {
  const records = await Promise.all(
    backup.study.records.map(async (record) => {
      const details = record.details?.readingPaper;
      if (!details) return record;
      const { inkFiles, reviewInkFiles, ...other } = details;
      return {
        ...record,
        details: { ...record.details, readingPaper: { ...other, ...(await unpackReadingPaperInk(details)) } },
      };
    }),
  );
  return { ...backup, study: { ...backup.study, records } };
}
