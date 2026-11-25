import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { audioDigestHeaders, wantsAudioDigest } from './cloudflare/audio-identity.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
let accounts;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
};
const server = http.createServer(async (req, res) => {
  try {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (/^\/api\/(account|papers|learning|images|ink|books)(\/|$)/.test(route)) {
      accounts ||= import('./scripts/local-accounts.mjs').then((m) =>
        m.createLocalAccounts(
          root,
          process.env.ENGLISH30_ACCOUNT_DIR || path.join(root, '..', '.local', 'accounts'),
        ),
      );
      return await (
        await accounts
      )(req, res);
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405);
      return res.end();
    }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    const headers = {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (wantsAudioDigest(req.method, pathname, req.headers['x-english30-verify-audio'])) {
      res.writeHead(200, { ...headers, ...(await audioDigestHeaders(await readFile(file))) });
      return res.end();
    }
    let start = 0,
      end = info.size - 1,
      status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!match) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
        return res.end();
      }
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
      if (start > end || start >= info.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    createReadStream(file, { start, end })
      .on('error', () => res.destroy())
      .pipe(res);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});
const port = Number(process.env.PORT || 4173),
  host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`English30: http://${host}:${server.address().port}`));
