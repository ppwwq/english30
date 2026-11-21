export const day = 86400000;
export function need(condition, message, status = 400, extra = {}) {
  if (!condition) throw Object.assign(new Error(message), { status, ...extra });
}
export async function sha(value) {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return hex(await crypto.subtle.digest('SHA-256', data));
}
const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
const secret = () => hex(crypto.getRandomValues(new Uint8Array(24)));
export function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}
export async function readBytes(request, max) {
  need(Number(request.headers.get('Content-Length') || 0) <= max, '这次保存的数据太大。', 413);
  const reader = request.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader)
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > max) {
        await reader.cancel();
        need(false, '这次保存的数据太大。', 413);
      }
      chunks.push(value);
    }
  const bytes = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return bytes;
}
export async function body(request, max = 8 * 1024 * 1024) {
  need(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', '需要 JSON 请求。', 415);
  const data = await readBytes(request, max);
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    need(false, '数据格式有误。');
  }
}
async function passwordHash(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', iterations: 100000, salt: enc.encode(salt) },
      key,
      256,
    ),
  );
}
const equal = (a, b) =>
  a?.length === b?.length &&
  [...a].reduce((diff, c, i) => diff | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;
export function accountAuth(db) {
  const { one, run, transaction } = db;
  const cookie = (req, token, age) =>
    'english30_session=' +
    token +
    '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' +
    age +
    (new URL(req.url).protocol === 'https:' ? '; Secure' : '');
  async function identify(req) {
    const token = req.headers.get('Cookie')?.match(/(?:^|;\s*)english30_session=([a-f0-9]{48})(?:;|$)/)?.[1];
    return (
      token &&
      one(
        'SELECT u.id,u.name FROM sessions s JOIN users u ON u.id=s.owner WHERE s.token=? AND s.expires>?',
        await sha(token),
        Date.now(),
      )
    );
  }
  async function action(req, route, user) {
    if (route === 'me' && req.method === 'GET') return json({ user: user || null });
    if (req.method !== 'POST') return null;
    if (route === 'logout') {
      const token = req.headers.get('Cookie')?.match(/(?:^|;\s*)english30_session=([a-f0-9]{48})/)?.[1];
      if (token) run('DELETE FROM sessions WHERE token=?', await sha(token));
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(req, '', 0) });
    }
    if (!['login', 'register', 'recover'].includes(route)) return null;
    const input = await body(req, 4096);
    const name = String(input.name || '')
      .normalize('NFKC')
      .trim()
      .toLowerCase();
    need(/^[\p{L}\p{N}_.-]{3,32}$/u.test(name), '用户名需要 3–32 个字母、数字、汉字或 . _ -。');
    need(
      typeof input.password === 'string' && input.password.length >= 10 && input.password.length <= 128,
      '密码需要 10–128 个字符。',
    );
    const now = Date.now(),
      ip = req.headers.get('CF-Connecting-IP') || 'local',
      bucket = Math.floor(now / (15 * 60000));
    const key = await sha(route + ':' + ip + ':' + bucket);
    run(
      'INSERT INTO limits VALUES (?,?,1) ON CONFLICT(id) DO UPDATE SET count=count+1',
      key,
      now + 15 * 60000,
    );
    need(
      one('SELECT count FROM limits WHERE id=?', key).count <= (route === 'register' ? 12 : 60),
      '尝试次数较多，请稍后再试。',
      429,
    );
    const existing = one('SELECT * FROM users WHERE name=?', name);
    let id = existing?.id,
      recoveryCode;
    if (route === 'register' || route === 'recover') {
      if (route === 'register') need(!existing, '这个用户名已被使用。', 409);
      if (route === 'recover')
        need(
          existing && equal(existing.recovery, await sha(String(input.code || '').trim())),
          '用户名或恢复码有误。',
          403,
        );
      const salt = secret(),
        digest = await passwordHash(input.password, salt);
      recoveryCode = secret();
      const recovery = await sha(recoveryCode);
      if (route === 'register') {
        id = crypto.randomUUID();
        need(!one('SELECT id FROM users WHERE name=?', name), '这个用户名已被使用。', 409);
        run('INSERT INTO users VALUES (?,?,?,?,?)', id, name, salt, digest, recovery);
      } else {
        transaction(() => {
          need(
            one('SELECT recovery FROM users WHERE id=?', id)?.recovery === existing.recovery,
            '恢复码已经更新。',
            409,
          );
          run('UPDATE users SET salt=?,password=?,recovery=? WHERE id=?', salt, digest, recovery, id);
          run('DELETE FROM sessions WHERE owner=?', id);
        });
      }
    } else {
      const digest = await passwordHash(input.password, existing?.salt || 'english30-auth-placeholder');
      need(existing && equal(existing.password, digest), '用户名或密码有误。', 401);
      need(
        one('SELECT password FROM users WHERE id=?', id)?.password === digest,
        '密码已更新，请重新登录。',
        401,
      );
    }
    const token = secret();
    run('INSERT INTO sessions VALUES (?,?,?)', await sha(token), id, now + 30 * day);
    return json({ user: { id, name }, recoveryCode }, 200, { 'Set-Cookie': cookie(req, token, 30 * 86400) });
  }
  async function verifyPassword(owner, password) {
    const row = one('SELECT * FROM users WHERE id=?', owner);
    need(
      row &&
        typeof password === 'string' &&
        password.length <= 128 &&
        equal(row.password, await passwordHash(password, row.salt)),
      '密码有误。',
      403,
    );
  }
  return { identify, action, verifyPassword };
}
