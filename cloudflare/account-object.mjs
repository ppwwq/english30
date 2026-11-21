import { createAccountApi } from './account-api.mjs';
import { createPrivateFiles } from './private-files.mjs';

// Account metadata and private files share the English30 SQLite namespace.
export class EnglishAccounts {
  constructor(ctx, env) {
    this.ctx = ctx;
    const sql = ctx.storage.sql;
    const db = {
      run: (q, ...args) => sql.exec(q, ...args),
      one: (q, ...args) => sql.exec(q, ...args).toArray()[0],
      all: (q, ...args) => sql.exec(q, ...args).toArray(),
      transaction: (callback) => ctx.storage.transactionSync(callback),
    };
    this.api = createAccountApi(db, createPrivateFiles(db), (path) =>
      env.ASSETS.fetch(new Request('https://assets.internal' + path)),
    );
  }
  async fetch(req) {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 86400000);
    return this.api.fetch(req);
  }
  async alarm() {
    try {
      await this.api.cleanup();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 86400000);
    }
  }
}
