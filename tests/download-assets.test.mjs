import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadAssets } from '../scripts/download-assets.mjs';

const file = {
  path: 'audio/example.mp3',
  size: 5,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
};
const manifest = {
  schemaVersion: 1,
  baseUrl: 'https://philip.eng30.workers.dev/',
  files: [file],
};

test('restoring media verifies bytes and a rerun reuses the complete local file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'english30-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let requests = 0;
  const fetchImpl = async (url, options) => {
    requests++;
    assert.equal(String(url), 'https://philip.eng30.workers.dev/audio/example.mp3');
    assert.equal(options.redirect, 'error');
    return new Response('hello');
  };
  assert.deepEqual(await downloadAssets({ root, manifest, fetchImpl }), {
    downloaded: 1,
    reused: 0,
    bytes: 5,
  });
  assert.equal(await fs.readFile(path.join(root, file.path), 'utf8'), 'hello');
  assert.deepEqual(await downloadAssets({ root, manifest, fetchImpl }), {
    downloaded: 0,
    reused: 1,
    bytes: 0,
  });
  assert.equal(requests, 1);
});

test('the complete manifest is validated before network access or filesystem writes', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'english30-paths-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'web');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response('hello');
  };
  for (const candidate of [
    '../outside.mp3',
    '/outside.mp3',
    'audio\\outside.mp3',
    'https://example.com/a.mp3',
    'audio/%2e%2e/a.mp3',
    'audio/test.mjs',
  ]) {
    await assert.rejects(
      downloadAssets({
        root,
        manifest: { ...manifest, files: [file, { ...file, path: candidate }] },
        fetchImpl,
      }),
      /Invalid media path/,
    );
  }
  await assert.rejects(
    downloadAssets({ root, manifest: { ...manifest, baseUrl: 'https://example.com/' }, fetchImpl }),
    /Unexpected media origin/,
  );
  await assert.rejects(
    downloadAssets({ root, manifest: { ...manifest, files: [file, file] }, fetchImpl }),
    /Duplicate media path/,
  );
  assert.equal(calls, 0);
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
});

test('linked directories cannot redirect downloaded media outside the selected root', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'english30-links-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'web');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'example.mp3'), 'keep');
  try {
    await fs.symlink(outside, path.join(root, 'audio'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip('This host does not allow creating test links; link rejection requires a permitted host.');
    return;
  }
  await assert.rejects(
    downloadAssets({ root, manifest, fetchImpl: async () => new Response('hello') }),
    /Symbolic link/,
  );
  assert.equal(await fs.readFile(path.join(outside, 'example.mp3'), 'utf8'), 'keep');
});

test('a failed integrity check preserves existing content and leaves no partial asset', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'english30-integrity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'audio'));
  await fs.writeFile(path.join(root, file.path), 'keep');
  await assert.rejects(
    downloadAssets({ root, manifest, fetchImpl: async () => new Response('wrong') }),
    /checksum mismatch/,
  );
  assert.equal(await fs.readFile(path.join(root, file.path), 'utf8'), 'keep');
  assert.deepEqual(await fs.readdir(path.join(root, 'audio')), ['example.mp3']);
});
