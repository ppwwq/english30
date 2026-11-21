import { DatabaseSync } from 'node:sqlite';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createAccountApi } from '../cloudflare/account-api.mjs';

export async function createLocalAccounts(root, directory) {
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, 'accounts.sqlite'));
  database.exec('PRAGMA journal_mode=WAL');
  const db = {
    one: (q, ...args) => database.prepare(q).get(...args),
    all: (q, ...args) => database.prepare(q).all(...args),
    run: (q, ...args) => database.prepare(q).run(...args),
    transaction(fn) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const value = fn();
        database.exec('COMMIT');
        return value;
      } catch (e) {
        database.exec('ROLLBACK');
        throw e;
      }
    },
  };
  const filename = (key) => path.join(directory, 'objects', ...key.split('/'));
  const bucket = {
    async put(key, bytes) {
      const file = filename(key),
        temp = file + '.' + crypto.randomUUID() + '.tmp';
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(temp, new Uint8Array(bytes));
      await rename(temp, file);
    },
    async get(key) {
      const file = filename(key);
      try {
        await stat(file);
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
      return {
        get body() {
          return Readable.toWeb(createReadStream(file));
        },
        async arrayBuffer() {
          const b = await readFile(file);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
        },
      };
    },
    async delete(keys) {
      await Promise.all(
        [keys].flat().map(async (key) => {
          try {
            await unlink(filename(key));
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
          }
        }),
      );
    },
  };
  const api = createAccountApi(db, bucket, async (name) => {
    try {
      return new Response(await readFile(path.join(root, name)));
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  const cleanup = setInterval(
    () => api.cleanup().catch(() => console.error('Account cleanup deferred')),
    3600000,
  );
  cleanup.unref();
  return async (req, res) => {
    const init = { method: req.method, headers: req.headers };
    if (!['GET', 'HEAD'].includes(req.method)) {
      init.body = Readable.toWeb(req);
      init.duplex = 'half';
    }
    const reply = await api.fetch(new Request('http://' + req.headers.host + req.url, init));
    res.writeHead(reply.status, Object.fromEntries(reply.headers));
    if (reply.body)
      Readable.fromWeb(reply.body)
        .on('error', () => res.destroy())
        .pipe(res);
    else res.end();
  };
}
