import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.mjs';

function fixture() {
  const env = {
    RELEASE: 'test-release',
    ASSETS: {
      async fetch(request) {
        const audio = ['/papers/audio/test.mp3', '/audio/paper-2025-exam-a-task-1.mp3'].includes(
          new URL(request.url).pathname,
        );
        return new Response(request.method === 'HEAD' ? null : audio ? '0123456789' : 'public library', {
          headers: {
            'Content-Type': audio ? 'audio/mpeg' : 'text/html',
            // Native Assets omits length on HEAD, unlike its GET response.
            ...(request.method === 'HEAD' ? {} : { 'Content-Length': audio ? '10' : '14' }),
            ETag: '"audio-v1"',
          },
        });
      },
    },
  };
  return (path, init) => worker.fetch(new Request('https://english.test' + path, init), env);
}

test('Cloudflare library is public but the former private upload API is unavailable', async () => {
  const call = fixture();
  assert.equal(await (await call('/')).text(), 'public library');
  assert.deepEqual(await (await call('/api/health')).json(), { ok: true, release: 'test-release' });
  assert.equal((await call('/api/assets/status')).status, 404);
  assert.equal((await call('/api/assets/upload', { method: 'POST' })).status, 404);
  assert.equal((await call('/papers/audio/test.mp3', { method: 'POST' })).status, 405);
});

test('Safari audio probes and seeking return exact byte ranges even when Assets returns the full file', async () => {
  const call = fixture();
  for (const [range, expected, contentRange] of [
    ['bytes=0-1', '01', 'bytes 0-1/10'],
    ['bytes=3-5', '345', 'bytes 3-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=8-100', '89', 'bytes 8-9/10'],
  ]) {
    const response = await call('/papers/audio/test.mp3', { headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(response.headers.get('Content-Length'), String(expected.length));
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.equal(await response.text(), expected);
  }
});

test('HEAD, unsatisfiable ranges and stale If-Range preserve HTTP semantics', async () => {
  const call = fixture();
  const head = await call('/papers/audio/test.mp3', { method: 'HEAD', headers: { Range: 'bytes=0-1' } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '10');
  assert.equal(await head.text(), '');
  for (const range of ['bytes=10-', 'bytes=5-3', 'bytes=-0']) {
    const response = await call('/papers/audio/test.mp3', { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('Content-Range'), 'bytes */10');
    assert.equal(await response.text(), '');
  }
  for (const validator of ['"old-audio"', 'W/"audio-v1"']) {
    const response = await call('/papers/audio/test.mp3', {
      headers: { Range: 'bytes=3-5', 'If-Range': validator },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '0123456789');
  }
  const fresh = await call('/papers/audio/test.mp3', {
    headers: { Range: 'bytes=3-5', 'If-Range': '"audio-v1"' },
  });
  assert.equal(fresh.status, 206);
  assert.equal(await fresh.text(), '345');
});

test('duration verification returns the actual clip digest and size without downloading its body', async () => {
  const call = fixture();
  const path = '/audio/paper-2025-exam-a-task-1.mp3';
  const response = await call(path, { method: 'HEAD', headers: { 'X-English30-Verify-Audio': '1' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Length'), '10');
  assert.equal(response.headers.get('ETag'), '"audio-v1"');
  assert.equal(
    response.headers.get('X-English30-Audio-SHA256'),
    '84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882',
  );
  assert.equal(await response.text(), '');
  assert.equal((await call(path, { method: 'HEAD' })).headers.has('X-English30-Audio-SHA256'), false);
});
