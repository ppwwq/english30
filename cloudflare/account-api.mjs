import { accountAuth, body, day, json, need, readBytes, sha } from './account-auth.mjs';
import { paperPdf, jpegSize } from './paper-pdf.mjs';
import { validatePaperInk } from '../web/core.mjs';
import { validateListeningRecords } from '../web/training-core.mjs';
import { applyLearningDelta, emptyBackup } from '../web/account-learning.mjs';

const schema = [
  'CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE,salt TEXT,password TEXT,recovery TEXT)',
  'CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,owner TEXT,expires INTEGER)',
  'CREATE TABLE IF NOT EXISTS limits(id TEXT PRIMARY KEY,expires INTEGER,count INTEGER)',
  'CREATE TABLE IF NOT EXISTS versions(owner TEXT,paper TEXT,v INTEGER,saved TEXT,summary TEXT,manifest TEXT,PRIMARY KEY(owner,paper,v))',
  'CREATE TABLE IF NOT EXISTS receipts(owner TEXT,kind TEXT,id TEXT,result TEXT,PRIMARY KEY(owner,kind,id))',
  'CREATE TABLE IF NOT EXISTS members(owner TEXT,paper TEXT,lesson TEXT,stamp TEXT,PRIMARY KEY(owner,paper,lesson,stamp))',
  'CREATE TABLE IF NOT EXISTS learning(owner TEXT PRIMARY KEY,hash TEXT)',
  'CREATE TABLE IF NOT EXISTS objects(path TEXT PRIMARY KEY,owner TEXT,bytes INTEGER,created INTEGER,width INTEGER,height INTEGER)',
  'CREATE INDEX IF NOT EXISTS object_owner ON objects(owner)',
  'CREATE TABLE IF NOT EXISTS refs(owner TEXT,paper TEXT,v INTEGER,path TEXT,PRIMARY KEY(owner,paper,v,path))',
  'CREATE INDEX IF NOT EXISTS refs_path ON refs(path)',
  'CREATE TABLE IF NOT EXISTS missing_masters(hash TEXT PRIMARY KEY)',
  'CREATE TABLE IF NOT EXISTS masters(hash TEXT PRIMARY KEY)',
];
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const privatePath = (owner, hash) => 'users/' + owner + '/' + hash;
const masterPath = (hash) => 'originals/' + hash;
const bytesToRead = async (o) => {
  need(o, '已保存文件暂时无法读取，请重试。', 503);
  return o.arrayBuffer();
};
const secure = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
export function createAccountApi(db, bucket, assets) {
  const { one, all, run, transaction } = db;
  for (const sql of schema) run(sql);
  const auth = accountAuth(db);
  let bookPromise;
  async function books() {
    return (bookPromise ||= assets('/papers/answer-books.json')
      .then(async (r) => {
        need(r.ok, '答题册页表未载入。', 503);
        return r.json();
      })
      .catch((e) => {
        bookPromise = null;
        throw e;
      }));
  }
  const receipt = (owner, kind, id) =>
    JSON.parse(
      one('SELECT result FROM receipts WHERE owner=? AND kind=? AND id=?', owner, kind, id)?.result || 'null',
    );
  const acknowledge = (owner, kind, id, result) =>
    run('INSERT INTO receipts VALUES (?,?,?,?)', owner, kind, id, JSON.stringify(result));
  const head = (owner, id) =>
    one('SELECT * FROM versions WHERE owner=? AND paper=? ORDER BY v DESC LIMIT 1', owner, id);
  function version(owner, id, v) {
    const row = one('SELECT * FROM versions WHERE owner=? AND paper=? AND v=?', owner, id, Number(v));
    need(row, '找不到这份答卷或版本。', 404);
    return row;
  }
  async function loadJson(owner, hash) {
    const bytes = await bytesToRead(await bucket.get(privatePath(owner, hash)));
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async function put(owner, data, hash, size = {}) {
    const path = privatePath(owner, hash);
    if (!one('SELECT path FROM objects WHERE path=?', path)) {
      const used = one('SELECT COALESCE(SUM(bytes),0) AS n FROM objects WHERE owner=?', owner).n;
      need(used + data.byteLength <= 256 * 1024 * 1024, '账号文件空间已满，请清理不需要的答卷。', 413);
      await bucket.put(path, data);
      run(
        'INSERT OR IGNORE INTO objects VALUES (?,?,?,?,?,?)',
        path,
        owner,
        data.byteLength,
        Date.now(),
        size.width || 0,
        size.height || 0,
      );
    }
    return hash;
  }
  async function putJson(owner, value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return put(owner, bytes, await sha(bytes));
  }
  const addRef = (owner, paper, v, path) =>
    run('INSERT OR IGNORE INTO refs VALUES (?,?,?,?)', owner, paper, v, path);
  async function cleanup(limit = 128) {
    run('DELETE FROM limits WHERE expires<?', Date.now());
    run('DELETE FROM sessions WHERE expires<?', Date.now());
    const garbage = all(
      'SELECT path,owner FROM objects WHERE created<? AND NOT EXISTS (SELECT 1 FROM refs WHERE refs.path=objects.path) LIMIT ?',
      Date.now() - day,
      limit,
    );
    if (garbage.length) {
      transaction(() => {
        for (const item of garbage) run('DELETE FROM objects WHERE path=?', item.path);
      });
      try {
        await bucket.delete(garbage.map((item) => item.path));
      } catch (error) {
        for (const item of garbage)
          run('INSERT OR IGNORE INTO objects VALUES (?,?,?,?,?,?)', item.path, item.owner, 0, 0, 0, 0);
        throw error;
      }
    }
    const unused = all(
      "SELECT hash FROM masters WHERE NOT EXISTS (SELECT 1 FROM refs WHERE path='originals/'||hash) AND NOT EXISTS (SELECT 1 FROM objects WHERE owner='@freeze' AND path='pin/'||hash AND created>?) LIMIT ?",
      Date.now() - day,
      limit,
    );
    for (const { hash } of unused) {
      run('DELETE FROM masters WHERE hash=?', hash);
      await bucket.delete(masterPath(hash));
    }
  }
  async function freeze(input) {
    const b = (await books())[input.book];
    need(b && Array.isArray(input.hashes) && input.hashes.length <= 8, '题册页表无效。');
    const missing = [];
    for (const hash of new Set(input.hashes)) {
      need(
        [...b.pages, ...(b.data || [])].some((p) => p.master === hash),
        '原页不属于这本答题册。',
      );
      if (!one('SELECT hash FROM masters WHERE hash=?', hash)) {
        const r = await assets('/papers/print/' + hash + '.jpg');
        if (r.status === 404) {
          run('INSERT OR IGNORE INTO missing_masters VALUES (?)', hash);
          missing.push(hash);
          continue;
        }
        need(r.ok, '原图暂时无法读取，请重试。', 503);
        const bytes = await r.arrayBuffer();
        need((await sha(bytes)) === hash, '原图版本核对失败。', 503);
        await bucket.put(masterPath(hash), bytes);
        run('INSERT OR IGNORE INTO masters VALUES (?)', hash);
        run('DELETE FROM missing_masters WHERE hash=?', hash);
      }
      run(
        'INSERT OR REPLACE INTO objects VALUES (?,?,?,?,?,?)',
        'pin/' + hash,
        '@freeze',
        0,
        Date.now(),
        0,
        0,
      );
    }
    return json({ ok: true, missing });
  }
  async function unpackRecord(owner, record) {
    need(Array.isArray(record?.attempts), '听力作答格式无效。');
    for (const a of record.attempts) {
      if (!a.inkFiles) continue;
      a.ink = {};
      for (const [key, h] of Object.entries(a.inkFiles)) {
        need(/^[\w-]+:[1-9]\d*$/.test(key) && digest.test(h), '笔迹页引用无效。');
        const data = await loadJson(owner, h);
        need(Array.isArray(data[key]), '笔迹与页表不符。');
        a.ink[key] = data[key];
      }
      delete a.inkFiles;
    }
    return record;
  }
  async function savePaper(owner, input) {
    const { id, base, saveId, book, lessonId, task } = input;
    need(uuid.test(id) && uuid.test(saveId) && Number.isInteger(base) && base >= 0, '答卷版本无效。');
    const done = receipt(owner, 'paper', saveId);
    if (done) return done;
    const old = head(owner, id);
    const conflict = () =>
      need((head(owner, id)?.v || 0) === base, '另一台设备已保存新版。', 409, {
        code: 'VERSION_CONFLICT',
        paperId: id,
      });
    conflict();
    let prior = null;
    if (old) prior = await loadJson(owner, old.manifest);
    else if (input.fork) {
      const row = version(owner, input.fork.id, input.fork.version);
      prior = await loadJson(owner, row.manifest);
    }
    const catalogue = await books();
    const keys = String(book).split('+');
    need(
      keys.length === 1 ||
        (keys.length === 2 && keys[0].endsWith('-A') && keys[1] === keys[0].slice(0, -1) + 'B1'),
      '答题册组合无效。',
    );
    need(
      keys.every((k) => Object.hasOwn(catalogue, k)) && (!prior || prior.book === book),
      '答题册来源不符。',
    );
    const selected = keys.map((k) => catalogue[k]);
    const originals = prior?.originals || [
      ...selected.flatMap((b) => b.pages),
      ...(input.includeData ? selected.flatMap((b) => b.data || []) : []),
    ];
    const choices = prior?.taskChoices || selected.flatMap((b) => b.taskChoices);
    need(
      choices.some((c) => c.task === task && c.lessonId === lessonId),
      'Task 与题册不符。',
    );
    const inkFiles = [...new Set(input.record.attempts.flatMap((a) => Object.values(a.inkFiles || {})))];
    const [record] = validateListeningRecords([await unpackRecord(owner, input.record)]);
    need(record.lessonId === lessonId, '作答材料不符。');
    const attempt = record.attempts.at(-1);
    const currentPart = (/-([ab]1?)-task-/i.exec(lessonId)?.[1] || '').toUpperCase();
    const records = { ...prior?.records, [lessonId]: record };
    const ink = { ...prior?.ink },
      pictures = { ...prior?.pictures };
    const originalMap = new Map(originals.map((p) => [p.key, p]));
    const pageImage = (hash) => {
      need(digest.test(hash), '页图摘要无效。');
      const size = one('SELECT width,height FROM objects WHERE path=?', privatePath(owner, hash));
      need(size?.width > 0 && size.height > 0, '整页图尚未完整上传。', 409);
      return size;
    };
    for (const key of input.touched || []) {
      const p = originalMap.get(key);
      need(p && p.part === currentPart && attempt.ink, '笔迹页不属于本次提交。');
      const strokes = attempt.ink[key];
      if (!strokes?.length) {
        delete ink[key];
        delete pictures[key];
        continue;
      }
      if (!one('SELECT hash FROM masters WHERE hash=?', p.master)) {
        ink[key] = strokes;
        delete pictures[key];
        continue;
      }
      const hash = input.images?.[key],
        size = pageImage(hash);
      need(size.width === p.width && size.height === p.height, '整页图尺寸与原卷不符。');
      ink[key] = strokes;
      pictures[key] = hash;
    }
    const appendices = { ...prior?.appendices };
    need(Array.isArray(input.appendices) && input.appendices.length <= 120, '打字附页无效。');
    appendices[lessonId] = input.appendices.map((p, i) => {
      need(p.after === null || originalMap.get(p.after)?.part === currentPart, '附页定位无效。');
      const size = pageImage(p.hash);
      return {
        kind: 'typed',
        after: p.after,
        hash: p.hash,
        task,
        label: 'Task ' + task + ' · 打字答案 ' + (i + 1),
        ...size,
      };
    });
    const added = Object.values(appendices)
      .flat()
      .sort((a, b) => a.task - b.task);
    const pages = originals.flatMap((p) => [
      {
        ...p,
        kind: p.attachment ? 'data' : 'original',
        missing: !one('SELECT hash FROM masters WHERE hash=?', p.master),
        hash: pictures[p.key] || null,
      },
      ...added.filter((a) => a.after === p.key),
    ]);
    pages.push(...added.filter((a) => a.after === null));
    const savedAt = new Date().toISOString(),
      v = base + 1,
      part = selected.map((b) => b.part).join('+');
    const summary = {
      id,
      year: selected[0].year,
      variant: selected[0].variant,
      part,
      version: v,
      savedAt,
      title:
        selected[0].year +
        ' ' +
        ({ exam: '正式卷', practice: '练习卷' }[selected[0].variant] || '') +
        ' · Paper 3 · ' +
        part,
      tasks: choices.filter((c) => records[c.lessonId]).map((c) => c.task),
      phase: attempt.phase === 'retest' ? 'retest' : attempt.assisted ? 'assisted' : 'first',
      missing: pages.some((p) => p.missing),
      legacyInk: !!input.legacyInk || !!prior?.legacyInk,
    };
    const manifest = {
      ...summary,
      book,
      originals,
      taskChoices: choices,
      lastTask: task,
      records,
      ink,
      pictures,
      appendices,
      pages,
    };
    const hash = await putJson(owner, manifest);
    const result = { id, version: v, pages: pages.length, savedAt };
    return transaction(() => {
      if (receipt(owner, 'paper', saveId)) return receipt(owner, 'paper', saveId);
      conflict();
      need(one('SELECT id FROM users WHERE id=?', owner), '账号已退出。', 401);
      run('INSERT INTO versions VALUES (?,?,?,?,?,?)', owner, id, v, savedAt, JSON.stringify(summary), hash);
      for (const p of pages)
        if (p.master) {
          if (p.missing)
            need(
              one('SELECT hash FROM missing_masters WHERE hash=?', p.master),
              '题册原图尚未核实，请重试。',
              409,
            );
          else addRef(owner, id, v, masterPath(p.master));
        }
      for (const r of Object.values(records))
        run('INSERT OR IGNORE INTO members VALUES (?,?,?,?)', owner, id, r.lessonId, r.savedAt);
      for (const h of new Set([hash, ...inkFiles, ...Object.values(pictures), ...added.map((p) => p.hash)]))
        addRef(owner, id, v, privatePath(owner, h));
      acknowledge(owner, 'paper', saveId, result);
      return result;
    });
  }
  async function learning(owner, input) {
    need(uuid.test(input.saveId), '无效的保存编号。');
    if (receipt(owner, 'learning', input.saveId)) return receipt(owner, 'learning', input.saveId);
    for (const group of [input.delta.sets, input.delta.removed])
      for (const record of group.listening) await unpackRecord(owner, record);
    for (let i = 0; i < 4; i++) {
      const done = receipt(owner, 'learning', input.saveId);
      if (done) return done;
      const old = one('SELECT hash FROM learning WHERE owner=?', owner)?.hash;
      const previous = old ? await loadJson(owner, old) : emptyBackup();
      const next = applyLearningDelta(previous, input.delta);
      const hash = await putJson(owner, next);
      const readback = await bytesToRead(await bucket.get(privatePath(owner, hash)));
      need((await sha(readback)) === hash, '云端学习记录回读不一致。', 503);
      const result = transaction(() => {
        const replay = receipt(owner, 'learning', input.saveId);
        if (replay) return replay;
        if (one('SELECT hash FROM learning WHERE owner=?', owner)?.hash !== old) return null;
        need(one('SELECT id FROM users WHERE id=?', owner), '账号已退出。', 401);
        run('INSERT OR REPLACE INTO learning VALUES (?,?)', owner, hash);
        run("DELETE FROM refs WHERE owner=? AND paper='learning'", owner);
        addRef(owner, 'learning', 0, privatePath(owner, hash));
        const result = { ok: true, hash };
        acknowledge(owner, 'learning', input.saveId, result);
        return result;
      });
      if (result) return result;
    }
    need(false, '其他设备正在保存，请重试。', 409);
  }
  async function handle(req) {
    const url = new URL(req.url),
      parts = url.pathname.replace(/^\/api\//, '').split('/'),
      [route, id, sub, v, item, n, action] = parts;
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD') {
      need(
        (!req.headers.has('Origin') || req.headers.get('Origin') === url.origin) &&
          req.headers.get('Sec-Fetch-Site') !== 'cross-site',
        '不接受跨站操作。',
        403,
      );
    }
    const user = await auth.identify(req);
    if (route === 'account' && id === 'logout' && user && req.headers.has('X-English30-Owner'))
      need(req.headers.get('X-English30-Owner') === user.id, '当前账号已切换，请刷新。', 409);
    if (route === 'account' && ['me', 'login', 'logout', 'register', 'recover'].includes(id)) {
      return (await auth.action(req, id, user)) || json({ error: '请求方式有误。' }, 405);
    }
    need(user, '请先登录账号。', 401);
    const owner = user.id;
    if (url.searchParams.has('viewer'))
      need(url.searchParams.get('viewer') === owner, '当前账号已切换，请刷新。', 409);
    if (req.headers.has('X-English30-Owner') || (method !== 'GET' && method !== 'HEAD'))
      need(req.headers.get('X-English30-Owner') === owner, '当前账号已切换，请刷新。', 409);
    if (route === 'books' && id === 'master' && digest.test(sub) && method === 'GET') {
      need(one('SELECT hash FROM masters WHERE hash=?', sub), '原页版本尚未冻结。', 404);
      const file = await bucket.get(masterPath(sub));
      need(file, '无法读取冻结原图。', 503);
      return new Response(file.body, { headers: { ...secure, 'Content-Type': 'image/jpeg' } });
    }
    if (route === 'books' && id === 'freeze' && method === 'POST') return freeze(await body(req, 8192));
    if (['images', 'ink'].includes(route) && digest.test(id)) {
      const path = privatePath(owner, id);
      if (method === 'HEAD')
        return new Response(null, {
          status: one('SELECT path FROM objects WHERE path=?', path) ? 200 : 404,
          headers: secure,
        });
      if (method === 'PUT') {
        const bytes = await readBytes(req, 12 * 1024 * 1024);
        let size = {};
        if (route === 'images') {
          size = jpegSize(bytes);
          need(
            size && size.width > 0 && size.height > 0 && size.width * size.height <= 32000000,
            '页图格式无效。',
          );
        } else {
          let ink;
          try {
            ink = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            need(false, '笔迹格式无效。');
          }
          validatePaperInk(ink);
          need(Object.keys(ink).length === 1, '每次上传一页笔迹。');
        }
        need((await sha(bytes)) === id, '页图摘要不符。');
        await put(owner, bytes, id, size);
        return json({ ok: true });
      }
    }
    if (route === 'learning') {
      if (id === 'receipts' && uuid.test(sub) && method === 'GET') {
        const r = receipt(owner, 'learning', sub);
        need(r, '尚未收到这次保存。', 404);
        return json(r);
      }
      if (method === 'POST') return json(await learning(owner, await body(req)));
      if (method === 'GET') {
        const hash = one('SELECT hash FROM learning WHERE owner=?', owner)?.hash;
        return json({ hash: hash || null, backup: hash ? await loadJson(owner, hash) : null });
      }
    }
    if (route === 'papers') {
      if (!id && method === 'POST') return json(await savePaper(owner, await body(req)));
      if (!id && method === 'GET') {
        const entries = all(
          'SELECT s.summary FROM versions s JOIN (SELECT paper,MAX(v) v FROM versions WHERE owner=? GROUP BY paper) h ON h.paper=s.paper AND h.v=s.v WHERE s.owner=? ORDER BY s.saved DESC',
          owner,
          owner,
        ).map((r) => JSON.parse(r.summary));
        return json(
          entries.filter((p) =>
            ['year', 'part', 'paper'].every(
              (k) => !url.searchParams.has(k) || String(k === 'paper' ? 3 : p[k]) === url.searchParams.get(k),
            ),
          ),
        );
      }
      if (uuid.test(id) && sub === 'versions' && method === 'GET') {
        if (!v)
          return json(
            all(
              'SELECT v AS version,saved AS savedAt FROM versions WHERE owner=? AND paper=? ORDER BY v DESC',
              owner,
              id,
            ),
          );
        const row = version(owner, id, v);
        if (item === 'pdf') {
          const manifest = await loadJson(owner, row.manifest);
          const pdf = await paperPdf(manifest.pages, async (p) =>
            bytesToRead(await bucket.get(p.hash ? privatePath(owner, p.hash) : masterPath(p.master))),
          );
          version(owner, id, v);
          return new Response(pdf, {
            headers: {
              ...secure,
              'Content-Type': 'application/pdf',
              'Content-Disposition': 'attachment; filename="English30-' + id + '-v' + v + '.pdf"',
            },
          });
        }
        const manifest = await loadJson(owner, row.manifest);
        if (!item) return json(manifest);
        if (item === 'pages' && action === 'ink') {
          const p = manifest.pages[Number(n) - 1];
          need(p?.kind === 'original', '此页没有可编辑笔迹。', 404);
          return json({
            schemaVersion: 1,
            renderer: 'perfect-freehand-1',
            key: p.key,
            strokes: manifest.ink[p.key] || [],
          });
        }
        if (item === 'pages' && action === 'image') {
          const p = manifest.pages[Number(n) - 1];
          need(p && !p.missing, '此页缺少已核实的原图。', 404);
          const file = await bucket.get(p.hash ? privatePath(owner, p.hash) : masterPath(p.master));
          need(file, '页图暂时无法读取。', 503);
          return new Response(file.body, { headers: { ...secure, 'Content-Type': 'image/jpeg' } });
        }
      }
      if (uuid.test(id) && !sub && method === 'DELETE') {
        need(head(owner, id), '找不到这份答卷。', 404);
        await remove(owner, id);
        return json({ ok: true });
      }
    }
    if (route === 'account' && id === 'delete' && method === 'POST') {
      await auth.verifyPassword(owner, (await body(req, 2048)).password);
      await remove(owner, null);
      return json({ ok: true }, 200, {
        'Set-Cookie': 'english30_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict',
      });
    }
    return json({ error: '找不到此入口。' }, 404);
  }
  async function remove(owner, paper) {
    let previousHash, nextHash;
    if (paper) {
      previousHash = one('SELECT hash FROM learning WHERE owner=?', owner)?.hash;
      if (previousHash) {
        const backup = await loadJson(owner, previousHash);
        const exclusive = all(
          'SELECT m.lesson,m.stamp FROM members m WHERE m.owner=? AND m.paper=? AND NOT EXISTS (SELECT 1 FROM members other WHERE other.owner=m.owner AND other.paper<>m.paper AND other.lesson=m.lesson AND other.stamp=m.stamp)',
          owner,
          paper,
        );
        const keys = new Set(exclusive.map((r) => r.lesson + ':' + r.stamp));
        backup.listening = backup.listening.filter((r) => !keys.has(r.lessonId + ':' + r.savedAt));
        nextHash = await putJson(owner, backup);
      }
    }
    transaction(() => {
      if (paper) {
        need(
          one('SELECT hash FROM learning WHERE owner=?', owner)?.hash === previousHash,
          '另一台设备正在保存，请重试删除。',
          409,
        );
        if (nextHash) {
          run('UPDATE learning SET hash=? WHERE owner=?', nextHash, owner);
          run("DELETE FROM refs WHERE owner=? AND paper='learning'", owner);
          addRef(owner, 'learning', 0, privatePath(owner, nextHash));
        }
        run('DELETE FROM members WHERE owner=? AND paper=?', owner, paper);
        run('DELETE FROM versions WHERE owner=? AND paper=?', owner, paper);
        run('DELETE FROM refs WHERE owner=? AND paper=?', owner, paper);
        run(
          "DELETE FROM receipts WHERE owner=? AND kind='paper' AND json_extract(result,'$.id')=?",
          owner,
          paper,
        );
      } else {
        for (const table of ['versions', 'refs', 'learning', 'receipts', 'sessions', 'members'])
          run('DELETE FROM ' + table + ' WHERE owner=?', owner);
        run('DELETE FROM users WHERE id=?', owner);
      }
      run(
        'UPDATE objects SET created=0 WHERE owner=? AND NOT EXISTS (SELECT 1 FROM refs WHERE refs.path=objects.path)',
        owner,
      );
    });
    maintenanceRequested = true;
  }
  let active = 0,
    maintenance,
    maintenanceRequested = false;
  function scheduleCleanup() {
    maintenanceRequested = true;
    if (active || maintenance) return maintenance || Promise.resolve();
    maintenanceRequested = false;
    maintenance = cleanup().finally(() => {
      maintenance = null;
    });
    return maintenance;
  }
  return {
    async fetch(req) {
      if (maintenance) await maintenance;
      active++;
      try {
        return await handle(req);
      } catch (e) {
        const status =
          e.status ||
          (e instanceof TypeError || /格式|备份|记录|纪录|作答|笔迹|复习|自核|答案|无效/.test(e.message)
            ? 400
            : 500);
        if (status === 500) console.error('Account storage request failed', e.name);
        return json(
          {
            error: status === 500 ? '账号服务暂时无法完成请求。' : e.message,
            code: e.code,
            paperId: e.paperId,
          },
          status,
        );
      } finally {
        active--;
        if (maintenanceRequested && !active) await scheduleCleanup();
      }
    },
    cleanup: scheduleCleanup,
  };
}
