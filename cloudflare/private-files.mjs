// Keep each SQLite row below the Durable Objects SQL row-size limit.
const partBytes = 512 * 1024;

export function createPrivateFiles(db) {
  db.run(`CREATE TABLE IF NOT EXISTS file_parts (
    path TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL,
    PRIMARY KEY (path, part)
  ) WITHOUT ROWID`);

  return {
    put(path, value) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      db.transaction(() => {
        db.run('DELETE FROM file_parts WHERE path=?', path);
        const parts = Math.max(1, Math.ceil(bytes.length / partBytes));
        for (let part = 0; part < parts; part++) {
          const offset = part * partBytes;
          const data = bytes.slice(offset, offset + partBytes);
          db.run('INSERT INTO file_parts(path,part,data) VALUES (?,?,?)', path, part, data);
        }
      });
    },
    get(path) {
      const rows = db.all('SELECT data FROM file_parts WHERE path=? ORDER BY part', path);
      if (!rows.length) return null;
      return new Response(new Blob(rows.map((row) => row.data)));
    },
    delete(paths) {
      db.transaction(() => {
        for (const path of Array.isArray(paths) ? paths : [paths]) {
          db.run('DELETE FROM file_parts WHERE path=?', path);
        }
      });
    },
  };
}
