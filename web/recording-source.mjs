function mediaEvent(audio, name, signal, start) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      audio.removeEventListener(name, ready);
      audio.removeEventListener('error', failed);
      signal.removeEventListener('abort', cancelled);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error('录音载入失败，请重试。'));
    const cancelled = () => finish(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('录音定位超时，请重试。')), 15000);
    audio.addEventListener(name, ready);
    audio.addEventListener('error', failed);
    signal.addEventListener('abort', cancelled, { once: true });
    try {
      start();
    } catch (error) {
      finish(error);
    }
  });
}

// Prefer native HTTP streaming. Only hosts that cannot seek need a full local copy.
export class RecordingSource {
  constructor(audio) {
    this.audio = audio;
  }
  clear() {
    this.controller?.abort();
    this.controller = new AbortController();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.blobURL) URL.revokeObjectURL(this.blobURL);
    this.blobURL = null;
    this.url = null;
  }
  load(url) {
    this.clear();
    this.url = new URL(url, document.baseURI).href;
    this.audio.src = this.url;
    this.audio.load();
  }
  ready(url, signal) {
    return mediaEvent(this.audio, 'loadedmetadata', signal, () => this.load(url));
  }
  async seek(time, signal) {
    const audio = this.audio;
    const source = this.url;
    signal.throwIfAborted();
    if (!source) throw new Error('原音尚未准备好。');
    if (!audio.seeking && Math.abs(audio.currentTime - time) < 0.00001) return;
    const seek = () =>
      mediaEvent(audio, 'seeked', signal, () => {
        audio.currentTime = time;
      });
    const ranges = audio.seekable;
    let reachable = time === 0;
    for (let i = 0; i < ranges.length; i++)
      if (time >= ranges.start(i) && time <= ranges.end(i) + 0.03) reachable = true;
    if (this.blobURL || reachable) {
      await seek();
      if (Math.abs(audio.currentTime - time) <= 0.18) return;
      if (this.blobURL) throw new Error('未能定位到指定时间，请重试。');
    }
    const response = await fetch(source, { signal });
    if (!response.ok) throw new Error('原音载入失败，请重试。');
    const data = await response.blob();
    signal.throwIfAborted();
    if (this.url !== source) throw new DOMException('Aborted', 'AbortError');
    this.blobURL = URL.createObjectURL(data);
    await mediaEvent(audio, 'loadedmetadata', signal, () => {
      audio.src = this.blobURL;
      audio.load();
    });
    await seek();
    if (Math.abs(audio.currentTime - time) > 0.18) throw new Error('未能定位到指定时间，请重试。');
  }
}

let hashManifest;
export async function matchesPackagedRecording(src, duration, signal) {
  const url = new URL(src, document.baseURI);
  if (url.origin !== location.origin || !url.pathname.startsWith('/audio/paper-')) return false;
  hashManifest ??= fetch(new URL('./papers/practice-audio.json', import.meta.url))
    .then(async (response) => {
      if (!response.ok) throw new Error('原音清单载入失败。');
      return (await response.json()).audio;
    })
    .catch((error) => {
      hashManifest = null;
      throw error;
    });
  const expected = (await hashManifest).find((item) => new URL(item.src, document.baseURI).href === url.href);
  if (!expected || Math.abs(expected.duration - duration) > 0.01) return false;
  const headers = await fetch(url, {
    method: 'HEAD',
    cache: 'no-store',
    headers: { 'X-English30-Verify-Audio': '1' },
    signal,
  });
  const digest = headers.headers.get('X-English30-Audio-SHA256'),
    etag = headers.headers.get('ETag');
  if (headers.ok && digest && /^"[^"]+"$/.test(etag || '') && headers.headers.has('Content-Length'))
    return digest === expected.sha256 && Number(headers.headers.get('Content-Length')) === expected.bytes;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('原音核对失败。');
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== expected.bytes) return false;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (n) => n.toString(16).padStart(2, '0')).join('') === expected.sha256;
}
