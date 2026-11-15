import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const baseUrl = 'https://english30-listening.philipwwq.workers.dev/';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function rejectLinks(root, destination) {
  const relative = path.relative(root, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid media path');
  let current = root;
  for (const segment of ['', ...relative.split(path.sep)]) {
    if (segment) current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error(`Symbolic link in media path: ${current}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function downloadAssets({
  root,
  manifest,
  fetchImpl = fetch,
  concurrency = 4,
  onProgress = () => {},
}) {
  if (manifest?.baseUrl !== baseUrl) throw new Error('Unexpected media origin');
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files))
    throw new Error('Invalid media manifest');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== 'string' ||
      !/^[a-zA-Z0-9._/-]+\.(mp3|wav|webp|png|jpg|jpeg|pdf)$/.test(entry.path) ||
      entry.path.split('/').some((part) => !part || part.startsWith('.'))
    )
      throw new Error('Invalid media path');
    if (seen.has(entry.path)) throw new Error('Duplicate media path');
    seen.add(entry.path);
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      entry.size > 25 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error('Invalid media size or checksum');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16)
    throw new Error('Invalid concurrency');
  root = path.resolve(root);
  const result = { downloaded: 0, reused: 0, bytes: 0 };
  let cursor = 0;
  await fs.mkdir(root, { recursive: true });
  await Promise.all(
    Array.from({ length: Math.min(concurrency, manifest.files.length) }, async () => {
      while (cursor < manifest.files.length) {
        const entry = manifest.files[cursor++];
        const destination = path.join(root, entry.path);
        await rejectLinks(root, destination);
        let existing;
        try {
          existing = await fs.readFile(destination);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (existing?.length === entry.size && digest(existing) === entry.sha256) {
          result.reused++;
        } else {
          const response = await fetchImpl(new URL(entry.path, baseUrl), {
            redirect: 'error',
            signal: AbortSignal.timeout(90000),
          });
          if (!response.ok) throw new Error(`${entry.path}: HTTP ${response.status}`);
          const chunks = [];
          let length = 0;
          for await (const chunk of response.body || []) {
            length += chunk.byteLength;
            if (length > entry.size)
              throw new Error(`${entry.path}: media checksum mismatch (oversized response)`);
            chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks);
          if (bytes.length !== entry.size || digest(bytes) !== entry.sha256)
            throw new Error(`${entry.path}: media checksum mismatch`);
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await rejectLinks(root, destination);
          const temporary = `${destination}.download-${randomUUID()}`;
          try {
            await fs.writeFile(temporary, bytes, { flag: 'wx' });
            await fs.rename(temporary, destination);
          } finally {
            await fs.unlink(temporary).catch((error) => {
              if (error.code !== 'ENOENT') throw error;
            });
          }
          result.downloaded++;
          result.bytes += bytes.length;
        }
        onProgress({ ...result, total: manifest.files.length });
      }
    }),
  );
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'assets-manifest.json'), 'utf8'));
  console.log(`Checking ${manifest.files.length} media files. Existing verified files will be reused.`);
  const result = await downloadAssets({
    root: path.join(project, 'web'),
    manifest,
    onProgress(progress) {
      const complete = progress.downloaded + progress.reused;
      if (complete % 100 === 0 || complete === progress.total)
        console.log(`${complete}/${progress.total} checked (${progress.downloaded} downloaded)`);
    },
  });
  console.log(JSON.stringify(result));
}
